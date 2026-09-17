import Foundation

// The pull-request inbox: the two questions the panel answers when nothing is
// waiting for a decision.
//
//   1. Which open pull requests are waiting for my review?
//   2. Which open pull requests that I already reviewed need another look?
//
// Everything here is pure except `PullRequestInbox.load`, which is pure apart
// from one injected closure. That is deliberate: the only authenticated host
// available to this project is a company GitHub Enterprise server, so nothing
// in this package may reach the network — not in a test, and not while it is
// being written. The fixtures the tests drive this with are written from
// GitHub's published GraphQL schema, and the first run against the real server
// is the first real test. That is why every failure path below produces a
// sentence naming what it could not make sense of.

/// One pull request, as the panel lists it.
public struct InboxPullRequest: Sendable, Equatable, Identifiable {
    /// The URL is the identity: a pull request cannot appear twice under one,
    /// and nothing else in the selection is guaranteed unique.
    public var id: String { url }
    public let title: String
    public let url: String
    /// `owner/name`, as GitHub's `nameWithOwner`.
    public let repository: String
    public let updatedAt: Date

    public init(title: String, url: String, repository: String, updatedAt: Date) {
        self.title = title
        self.url = url
        self.repository = repository
        self.updatedAt = updatedAt
    }
}

/// What arrived on one of my own pull requests since I last touched it.
///
/// Counts rather than a flag, because the row is read at a glance and "two
/// approvals" and "changes requested" ask different things of the author.
public struct InboxNews: Sendable, Equatable {
    public let approvals: Int
    public let changesRequested: Int
    /// Everything else people said: review comments and conversation
    /// comments, which are the same kind of news to the person who has to
    /// answer them.
    public let comments: Int

    public static let none = InboxNews(approvals: 0, changesRequested: 0, comments: 0)

    public init(approvals: Int, changesRequested: Int, comments: Int) {
        self.approvals = approvals
        self.changesRequested = changesRequested
        self.comments = comments
    }

    public var hasNews: Bool { approvals + changesRequested + comments > 0 }

    /// The one-line form the list shows under the title, or `nil` when
    /// nothing arrived.
    public var summary: String? {
        var parts: [String] = []
        if approvals > 0 {
            parts.append(approvals == 1 ? "1 approval" : "\(approvals) approvals")
        }
        if changesRequested > 0 {
            parts.append("changes requested")
        }
        if comments > 0 {
            parts.append(comments == 1 ? "1 comment" : "\(comments) comments")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// One of my own open pull requests, with whatever came in on it.
public struct AuthoredPullRequest: Sendable, Equatable, Identifiable {
    public var id: String { pullRequest.url }
    public let pullRequest: InboxPullRequest
    public let news: InboxNews

    public init(pullRequest: InboxPullRequest, news: InboxNews) {
        self.pullRequest = pullRequest
        self.news = news
    }
}

/// The three areas of the panel.
public enum InboxBucket: Sendable, CaseIterable {
    /// `review-requested:<me>`: someone asked and has not been answered.
    case waitingOnMe
    /// Already reviewed by me, and something has happened since that is worth
    /// my attention again. See `needsAnotherLook` for what counts.
    case needsAnotherLook
    /// Mine, open, with whatever people sent back. See `newsOnMyPullRequest`.
    case myPullRequests

    public var title: String {
        switch self {
        case .waitingOnMe: return "Waiting on your review"
        case .needsAnotherLook: return "Needs another look"
        case .myPullRequests: return "My pull requests"
        }
    }
}

public struct InboxSnapshot: Sendable, Equatable {
    public let waitingOnMe: [InboxPullRequest]
    public let needsAnotherLook: [InboxPullRequest]
    /// *All* of my open pull requests, the ones with news first — not only
    /// the ones with news. The count beside the row is the news count, but an
    /// author opening the list wants their whole slate; see `count`.
    public let mine: [AuthoredPullRequest]

    public init(
        waitingOnMe: [InboxPullRequest],
        needsAnotherLook: [InboxPullRequest],
        mine: [AuthoredPullRequest]
    ) {
        self.waitingOnMe = waitingOnMe
        self.needsAnotherLook = needsAnotherLook
        self.mine = mine
    }

    public func list(_ bucket: InboxBucket) -> [InboxPullRequest] {
        switch bucket {
        case .waitingOnMe: return waitingOnMe
        case .needsAnotherLook: return needsAnotherLook
        case .myPullRequests: return mine.map(\.pullRequest)
        }
    }

    /// What the row shows. Every count on this panel means "needs me", so for
    /// my own pull requests that is the ones something arrived on — not the
    /// number of pull requests I have open, which is not a call to action and
    /// would sit there as a permanent non-zero number beside two counts that
    /// mean something.
    public func count(_ bucket: InboxBucket) -> Int {
        switch bucket {
        case .waitingOnMe, .needsAnotherLook: return list(bucket).count
        case .myPullRequests: return mine.filter(\.news.hasNews).count
        }
    }

    /// Whether there is a list worth navigating to, which is not the same as
    /// the count being non-zero: a quiet slate of my own pull requests is
    /// still worth opening.
    public func hasList(_ bucket: InboxBucket) -> Bool {
        switch bucket {
        case .waitingOnMe, .needsAnotherLook: return list(bucket).isEmpty == false
        case .myPullRequests: return mine.isEmpty == false
        }
    }
}

/// What a refresh produced. There is no third case for "zero": a count that
/// could not be established is `undetermined`, and the panel draws that as an
/// em dash with the reason beside it. A zero here always means the search ran
/// and came back empty.
public enum InboxOutcome: Sendable, Equatable {
    case loaded(InboxSnapshot)
    case undetermined(reason: String)

    public func list(_ bucket: InboxBucket) -> [InboxPullRequest]? {
        switch self {
        case .loaded(let snapshot): return snapshot.list(bucket)
        case .undetermined: return nil
        }
    }

    public var mine: [AuthoredPullRequest]? {
        if case .loaded(let snapshot) = self { return snapshot.mine }
        return nil
    }

    public func hasList(_ bucket: InboxBucket) -> Bool {
        guard case .loaded(let snapshot) = self else { return false }
        return snapshot.hasList(bucket)
    }

    /// What the panel prints where a count goes. An em dash, never a zero:
    /// "no pull requests need you" and "I could not find out" are different
    /// answers, and showing the first when the second is true is the one
    /// failure this inbox must not have.
    public func countText(_ bucket: InboxBucket) -> String {
        guard case .loaded(let snapshot) = self else { return "—" }
        return "\(snapshot.count(bucket))"
    }

    public var reason: String? {
        if case .undetermined(let reason) = self { return reason }
        return nil
    }
}

/// Why something could not be made sense of: a sentence, not a code. It is
/// printed verbatim under the counts, so it is written to be read by the
/// person looking at the panel rather than grepped by a machine.
public struct InboxProblem: Error, Equatable, Sendable {
    public let reason: String

    public init(_ reason: String) {
        self.reason = reason
    }
}

// MARK: - The request

/// Logins that may be interpolated into the GraphQL document.
///
/// The login is spliced into a quoted string inside the query, so a login
/// containing a quote or a backslash would end the string and let the rest be
/// read as query text. GitHub logins are alphanumerics and hyphens; enterprise
/// accounts add underscores and dots. Anything outside that is refused rather
/// than escaped, because refusing is checkable and escaping GraphQL string
/// literals by hand is the kind of thing that is wrong once and then wrong
/// forever.
public func isSupportedLogin(_ login: String) -> Bool {
    guard login.isEmpty == false, login.count <= 64 else { return false }
    return login.allSatisfy { character in
        character.isASCII && (character.isLetter || character.isNumber
            || character == "-" || character == "_" || character == ".")
    }
}

/// How many results each search asks for. Past this the panel is not a list
/// anyone reads anyway, and the count is honest about being a count of what
/// the search returned.
public let inboxSearchLimit = 50

/// One document, three aliased searches, so a refresh is two process spawns in
/// total: `gh api user` for the login and this. `@me` is not used in the search
/// strings — it is not dependable across GitHub Enterprise versions, and a
/// search term the server does not understand comes back as an empty result
/// rather than an error, which would show as a confident zero.
///
/// The second and third searches' selections are shaped by what their filters
/// need: everyone's recent reviews (not just mine — the question in both is
/// what *others* did), the recent conversation comments, the head commit for
/// `needsAnotherLook`, and the pull request's own `createdAt` plus its latest
/// commit for `newsOnMyPullRequest`'s anchor.
public func inboxQuery(login: String) -> String {
    let waiting = "is:open is:pr archived:false review-requested:\(login)"
    let reviewed = "is:open is:pr archived:false reviewed-by:\(login) -author:\(login)"
    let authored = "is:open is:pr archived:false author:\(login)"
    return """
    query {
      waiting: search(query: "\(waiting)", type: ISSUE, first: \(inboxSearchLimit)) {
        nodes {
          ... on PullRequest {
            title
            url
            updatedAt
            repository { nameWithOwner }
          }
        }
      }
      reviewed: search(query: "\(reviewed)", type: ISSUE, first: \(inboxSearchLimit)) {
        nodes {
          ... on PullRequest {
            title
            url
            updatedAt
            headRefOid
            repository { nameWithOwner }
            reviews(last: \(reviewWindow)) {
              nodes {
                author { login }
                state
                submittedAt
                commit { oid }
              }
            }
            comments(last: \(commentWindow)) {
              nodes {
                author { login }
                createdAt
              }
            }
          }
        }
      }
      mine: search(query: "\(authored)", type: ISSUE, first: \(inboxSearchLimit)) {
        nodes {
          ... on PullRequest {
            title
            url
            updatedAt
            createdAt
            repository { nameWithOwner }
            reviews(last: \(reviewWindow)) {
              nodes {
                author { login }
                state
                submittedAt
              }
            }
            comments(last: \(commentWindow)) {
              nodes {
                author { login }
                createdAt
              }
            }
            commits(last: 1) {
              nodes {
                commit { committedDate }
              }
            }
          }
        }
      }
    }
    """
}

/// How many reviews and comments are pulled back per candidate pull request.
///
/// A window, not the whole history, because this is one call for up to
/// `inboxSearchLimit` pull requests. The cost of the window is a silent miss:
/// on a pull request with more than `reviewWindow` reviews after mine, my own
/// review falls out of the window, is not found, and the pull request is
/// treated as one I never reviewed — so it stays out of the bucket. A miss,
/// not a false alarm, which is the right direction for a bucket whose value is
/// being quiet.
public let reviewWindow = 20
public let commentWindow = 10

public func inboxArguments(login: String) -> [String] {
    ["api", "graphql", "-f", "query=\(inboxQuery(login: login))"]
}

public let userArguments = ["api", "user"]

// MARK: - The evidence rule

/// A review, reduced to what the bucket rule asks about.
public struct ReviewEvent: Sendable, Equatable {
    public let authorLogin: String?
    /// `APPROVED`, `COMMENTED`, `CHANGES_REQUESTED`, `DISMISSED`, `PENDING`.
    public let state: String?
    /// `nil` for a pending review, which has not been submitted.
    public let submittedAt: Date?
    /// The commit the review was submitted against.
    public let commitOid: String?

    public init(authorLogin: String?, state: String?, submittedAt: Date?, commitOid: String?) {
        self.authorLogin = authorLogin
        self.state = state
        self.submittedAt = submittedAt
        self.commitOid = commitOid
    }
}

/// A conversation-tab comment, reduced the same way.
public struct CommentEvent: Sendable, Equatable {
    public let authorLogin: String?
    public let createdAt: Date?

    public init(authorLogin: String?, createdAt: Date?) {
        self.authorLogin = authorLogin
        self.createdAt = createdAt
    }
}

/// Whether a pull request I have already reviewed needs another look from me.
///
/// The rule is *positive evidence*, not movement. `updatedAt` was the obvious
/// implementation and it is the wrong one: it bumps when anyone labels the
/// pull request, assigns it, sets a milestone, or approves it, none of which
/// asks anything of me. A bucket that lights up for those is a bucket that
/// gets ignored, which is the same failure this project already refused for
/// the menu-bar mark.
///
/// So exactly two things count, both of them things that happened *after* my
/// last submitted review:
///
///   1. The code moved: the pull request's head commit is not the commit my
///      review was submitted against. Compared as object ids, never as
///      timestamps — a force-push rewrites history and leaves timestamps
///      describing a tree that no longer exists, while the oid simply stops
///      matching.
///   2. Somebody else wrote words: an issue comment by anyone but me, or
///      another person's `COMMENTED` or `CHANGES_REQUESTED` review. Replies on
///      an inline thread arrive as single-comment `COMMENTED` reviews, so that
///      clause catches those without asking for the review-thread connection.
///
/// Excluded by name, and not to be "simplified" back:
///   - other people's `APPROVED` reviews. Someone else approving is exactly
///     the notification the user asked not to receive. Note that
///     `newsOnMyPullRequest` counts the very same event, on purpose: see the
///     inversion described there before making these two agree.
///   - `DISMISSED` reviews, which are a state change on an old review, not new
///     words.
///   - anything that only moves `updatedAt`: labels, assignees, milestones,
///     projects, a base-branch rename.
///
/// Absence is never evidence. A null author, a null `submittedAt`, a review
/// with no `commit`, a head oid that did not come back — each of those means
/// "I cannot tell", and a bucket built on "I cannot tell" is noise. So each
/// clause requires both sides to be present before it can fire.
public func needsAnotherLook(
    myLogin: String,
    headRefOid: String?,
    reviews: [ReviewEvent],
    comments: [CommentEvent]
) -> Bool {
    let mine = reviews
        .filter { isSameLogin($0.authorLogin, myLogin) && $0.submittedAt != nil }
        .max { ($0.submittedAt ?? .distantPast) < ($1.submittedAt ?? .distantPast) }
    // Not found means either I never submitted a review here (the search said
    // otherwise, so this is the window truncating) or the field did not come
    // back. Either way there is no "since" to measure against, and a bucket
    // entry with nothing to compare to is a guess.
    guard let mine, let myReviewAt = mine.submittedAt else { return false }

    if let headRefOid, headRefOid.isEmpty == false,
       let reviewedOid = mine.commitOid, reviewedOid.isEmpty == false,
       headRefOid != reviewedOid {
        return true
    }

    let saidSomething = comments.contains { comment in
        guard let author = comment.authorLogin, let createdAt = comment.createdAt else { return false }
        return isSameLogin(author, myLogin) == false && createdAt > myReviewAt
    }
    if saidSomething { return true }

    return reviews.contains { review in
        guard let author = review.authorLogin,
              let submittedAt = review.submittedAt,
              let state = review.state
        else { return false }
        guard isSameLogin(author, myLogin) == false, submittedAt > myReviewAt else { return false }
        return state == "COMMENTED" || state == "CHANGES_REQUESTED"
    }
}

/// Whether one of my own open pull requests has news, and what kind.
///
/// **The inversion, which is the whole reason these are two functions.**
/// `needsAnotherLook` excludes other people's `APPROVED` reviews by name:
/// on a pull request I am reviewing, somebody else approving asks nothing of
/// me and surfacing it is the noise the user explicitly refused. Here the
/// same event is the point — on my own pull request an approval is news,
/// because this team needs three of them before it can merge. Same event,
/// opposite meaning, decided entirely by which side of the review I am on.
/// Do not unify these two filters.
///
/// The anchor is my own last touch: the latest of my own conversation
/// comments, the latest commit on the branch, and the pull request's own
/// creation time as a floor. The commit counts as *my* touch on the
/// assumption that the commits on a pull request I authored are mine — true
/// in the overwhelming case; a co-author or a maintainer pushing to my branch
/// moves the anchor forward and can hide news that arrived just before their
/// push. Accepted for v1: the alternative is asking for every commit's author
/// and comparing, which doubles the size of this already large single query.
///
/// The same window caps apply as in `needsAnotherLook` — `reviewWindow`
/// reviews and `commentWindow` comments — with the same consequence: past
/// them, older news is not seen. A silent miss rather than a false alarm.
///
/// Absence is not evidence, the same as `needsAnotherLook`: a review with no
/// author, no state, or no `submittedAt` cannot be established as somebody
/// else's answer to me, so it does not count.
public func newsOnMyPullRequest(
    myLogin: String,
    createdAt: Date?,
    latestCommitAt: Date?,
    reviews: [ReviewEvent],
    comments: [CommentEvent]
) -> InboxNews {
    let myComments = comments
        .filter { isSameLogin($0.authorLogin, myLogin) }
        .compactMap(\.createdAt)
    let candidates = ([createdAt, latestCommitAt] + myComments).compactMap { $0 }
    // Nothing to anchor against — not even the pull request's own creation
    // time came back — means every timestamp below would be compared to a
    // guess. No anchor, no news.
    guard let anchor = candidates.max() else { return .none }

    var approvals = 0
    var changesRequested = 0
    var comment = 0

    for review in reviews {
        guard let author = review.authorLogin,
              let state = review.state,
              let submittedAt = review.submittedAt
        else { continue }
        guard isSameLogin(author, myLogin) == false, submittedAt > anchor else { continue }
        switch state {
        case "APPROVED": approvals += 1
        case "CHANGES_REQUESTED": changesRequested += 1
        // `COMMENTED`, and `DISMISSED` too: a dismissal is somebody acting on
        // my pull request after my last touch, which is news to me even
        // though it is not news to a reviewer of someone else's.
        default: comment += 1
        }
    }

    for entry in comments {
        guard let author = entry.authorLogin, let createdAt = entry.createdAt else { continue }
        guard isSameLogin(author, myLogin) == false, createdAt > anchor else { continue }
        comment += 1
    }

    return InboxNews(approvals: approvals, changesRequested: changesRequested, comments: comment)
}

/// GitHub logins are case-insensitive, and the casing `gh api user` returns is
/// not guaranteed to match the casing in a review's `author.login`.
private func isSameLogin(_ left: String?, _ right: String) -> Bool {
    guard let left else { return false }
    return left.compare(right, options: .caseInsensitive) == .orderedSame
}

// MARK: - The response

/// Everything optional, on purpose: a decode that throws tells the panel
/// nothing it can show, while a decode that succeeds into optionals lets the
/// checks below name the field that was missing.
private struct Envelope: Decodable {
    let data: Payload?
    let errors: [GraphQLError]?
}

private struct GraphQLError: Decodable {
    let message: String?
}

private struct Payload: Decodable {
    let waiting: SearchConnection?
    let reviewed: SearchConnection?
    let mine: SearchConnection?
}

private struct SearchConnection: Decodable {
    let nodes: [SearchNode?]?
}

private struct SearchNode: Decodable {
    let title: String?
    let url: String?
    let updatedAt: String?
    let createdAt: String?
    let headRefOid: String?
    let repository: Repository?
    let reviews: ReviewConnection?
    let comments: CommentConnection?
    let commits: CommitConnection?

    /// A `search` of type `ISSUE` returns issues as well as pull requests, and
    /// the `... on PullRequest` fragment selects nothing from an issue — the
    /// node comes back as `{}`. `is:pr` should already have excluded those;
    /// this is what keeps the belt-and-braces case from being reported as a
    /// broken response.
    var isEmptySelection: Bool {
        title == nil && url == nil && updatedAt == nil && createdAt == nil
            && repository == nil && headRefOid == nil && reviews == nil
            && comments == nil && commits == nil
    }
}

private struct Repository: Decodable {
    let nameWithOwner: String?
}

private struct ReviewConnection: Decodable {
    let nodes: [ReviewNode?]?
}

private struct ReviewNode: Decodable {
    let author: Author?
    let state: String?
    let submittedAt: String?
    let commit: Commit?
}

private struct CommentConnection: Decodable {
    let nodes: [CommentNode?]?
}

private struct CommentNode: Decodable {
    let author: Author?
    let createdAt: String?
}

private struct Author: Decodable {
    let login: String?
}

private struct Commit: Decodable {
    let oid: String?
    let committedDate: String?
}

private struct CommitConnection: Decodable {
    let nodes: [CommitNode?]?
}

private struct CommitNode: Decodable {
    let commit: Commit?
}

/// `gh api user`'s answer, for the login alone.
public func parseLogin(_ data: Data) -> Result<String, InboxProblem> {
    struct User: Decodable { let login: String? }
    guard let user = try? JSONDecoder().decode(User.self, from: data) else {
        return .failure(InboxProblem("gh api user did not return JSON"))
    }
    guard let login = user.login, login.isEmpty == false else {
        return .failure(InboxProblem("gh api user returned no login"))
    }
    guard isSupportedLogin(login) else {
        return .failure(InboxProblem("gh api user returned a login this cannot search for: \(login)"))
    }
    return .success(login)
}

/// Turns one GraphQL response into the two buckets, or into a sentence saying
/// why it could not.
///
/// Never throws and never partially reports. A node this cannot read is not
/// quietly dropped: dropping it would make the count wrong, and a wrong count
/// presented confidently is the one outcome worse than no count.
public func parseInbox(_ data: Data, myLogin: String) -> InboxOutcome {
    guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else {
        return .undetermined(reason: "gh did not return JSON this can read")
    }
    if let errors = envelope.errors, errors.isEmpty == false {
        let first = errors.compactMap(\.message).first ?? "no message"
        return .undetermined(reason: "GitHub refused the query: \(first)")
    }
    guard let payload = envelope.data else {
        return .undetermined(reason: "the response carried no data")
    }
    guard let waitingNodes = payload.waiting?.nodes else {
        return .undetermined(reason: "the response had no results for the review-requested search")
    }
    guard let reviewedNodes = payload.reviewed?.nodes else {
        return .undetermined(reason: "the response had no results for the already-reviewed search")
    }
    guard let mineNodes = payload.mine?.nodes else {
        return .undetermined(reason: "the response had no results for the authored search")
    }

    var waiting: [InboxPullRequest] = []
    for node in waitingNodes.compactMap({ $0 }) where node.isEmptySelection == false {
        switch pullRequest(from: node) {
        case .failure(let problem): return .undetermined(reason: problem.reason)
        case .success(let entry): waiting.append(entry)
        }
    }

    var needing: [InboxPullRequest] = []
    for node in reviewedNodes.compactMap({ $0 }) where node.isEmptySelection == false {
        let entry: InboxPullRequest
        switch pullRequest(from: node) {
        case .failure(let problem): return .undetermined(reason: problem.reason)
        case .success(let value): entry = value
        }
        // The connections themselves must be there. A *field inside* one that
        // is null is simply not evidence (see `needsAnotherLook`), but a whole
        // connection missing means the server did not answer the query that
        // was sent — and silently reporting a bucket of zero off a response
        // that shape would be the confident lie this refuses to tell.
        guard let reviews = reviewEvents(node) else {
            return .undetermined(reason: "no reviews came back for \(entry.url)")
        }
        guard let comments = commentEvents(node) else {
            return .undetermined(reason: "no comments came back for \(entry.url)")
        }
        if needsAnotherLook(
            myLogin: myLogin,
            headRefOid: node.headRefOid,
            reviews: reviews,
            comments: comments
        ) {
            needing.append(entry)
        }
    }

    var mine: [AuthoredPullRequest] = []
    for node in mineNodes.compactMap({ $0 }) where node.isEmptySelection == false {
        let entry: InboxPullRequest
        switch pullRequest(from: node) {
        case .failure(let problem): return .undetermined(reason: problem.reason)
        case .success(let value): entry = value
        }
        guard let reviews = reviewEvents(node) else {
            return .undetermined(reason: "no reviews came back for \(entry.url)")
        }
        guard let comments = commentEvents(node) else {
            return .undetermined(reason: "no comments came back for \(entry.url)")
        }
        let news = newsOnMyPullRequest(
            myLogin: myLogin,
            createdAt: node.createdAt.flatMap(parseTimestamp),
            latestCommitAt: node.commits?.nodes?
                .compactMap { $0?.commit?.committedDate }
                .compactMap(parseTimestamp)
                .max(),
            reviews: reviews,
            comments: comments
        )
        mine.append(AuthoredPullRequest(pullRequest: entry, news: news))
    }

    // Most recently touched first. `updatedAt` is a poor rule for *membership*
    // — that is the whole point of `needsAnotherLook` — but it is a perfectly
    // good rule for the order of a list whose membership is already decided.
    return .loaded(InboxSnapshot(
        waitingOnMe: waiting.sorted { $0.updatedAt > $1.updatedAt },
        needsAnotherLook: needing.sorted { $0.updatedAt > $1.updatedAt },
        // News first, then most recently updated. The quiet ones stay in the
        // list — an author wants their whole slate — but they are below the
        // ones asking something, and the panel dims them.
        mine: mine.sorted { left, right in
            if left.news.hasNews != right.news.hasNews { return left.news.hasNews }
            return left.pullRequest.updatedAt > right.pullRequest.updatedAt
        }
    ))
}

/// `nil` when the connection itself did not come back; an entry inside it
/// with null fields is kept as-is, because "not evidence" is the filters'
/// job, not the parser's.
private func reviewEvents(_ node: SearchNode) -> [ReviewEvent]? {
    guard let nodes = node.reviews?.nodes else { return nil }
    return nodes.compactMap { $0 }.map { review in
        ReviewEvent(
            authorLogin: review.author?.login,
            state: review.state,
            submittedAt: review.submittedAt.flatMap(parseTimestamp),
            commitOid: review.commit?.oid
        )
    }
}

private func commentEvents(_ node: SearchNode) -> [CommentEvent]? {
    guard let nodes = node.comments?.nodes else { return nil }
    return nodes.compactMap { $0 }.map { comment in
        CommentEvent(
            authorLogin: comment.author?.login,
            createdAt: comment.createdAt.flatMap(parseTimestamp)
        )
    }
}

/// The fields both buckets need. The reason string names the pull request
/// where it can, so the first run against the real server says which one.
private func pullRequest(from node: SearchNode) -> Result<InboxPullRequest, InboxProblem> {
    let subject = node.url ?? node.title ?? "a pull request"
    guard let title = node.title else { return .failure(InboxProblem("no title came back for \(subject)")) }
    guard let url = node.url else { return .failure(InboxProblem("no url came back for \(subject)")) }
    guard let repository = node.repository?.nameWithOwner else {
        return .failure(InboxProblem("no repository came back for \(subject)"))
    }
    guard let stamp = node.updatedAt else { return .failure(InboxProblem("no updatedAt came back for \(subject)")) }
    guard let updatedAt = parseTimestamp(stamp) else {
        return .failure(InboxProblem("could not read the time \(stamp) on \(subject)"))
    }
    return .success(InboxPullRequest(
        title: title,
        url: url,
        repository: repository,
        updatedAt: updatedAt
    ))
}

/// GitHub returns RFC 3339 in UTC.
///
/// Parsed with `Date.ISO8601FormatStyle` rather than an `ISO8601DateFormatter`
/// held in a global: the formatter class is not `Sendable`, and a shared
/// mutable one is exactly the kind of cross-thread reuse Swift 6 refuses to
/// compile here. Two strategies because fractional seconds are a separate
/// option in both spellings, and GitHub sends timestamps both ways depending
/// on the field.
public func parseTimestamp(_ text: String) -> Date? {
    if let date = try? Date(text, strategy: plainTimestamp) { return date }
    return try? Date(text, strategy: fractionalTimestamp)
}

private let plainTimestamp = Date.ISO8601FormatStyle(includingFractionalSeconds: false)
private let fractionalTimestamp = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

// MARK: - The list

/// How many pull requests a bucket's list shows before it summarises the rest.
public let inboxListLimit = 10

/// The first `limit` items and how many were left. The panel is a menu-bar
/// popover: a list longer than this scrolls off a screen edge rather than
/// scrolling, so the tail is summarised instead of drawn.
public func inboxListPreview<Item>(
    _ items: [Item],
    limit: Int = inboxListLimit
) -> (shown: [Item], remaining: Int) {
    guard items.count > limit else { return (items, 0) }
    return (Array(items.prefix(limit)), items.count - limit)
}

/// The URL to hand `NSWorkspace` when a row is clicked, or `nil`.
///
/// Restricted to http and https on purpose. The string comes from a server
/// response, and `NSWorkspace.open` will happily act on other schemes — a
/// `file:` URL opens a local file, and a custom scheme hands the string to
/// whichever application claims it. Clicking a row in a list of pull requests
/// should only ever open a web page, so anything else is simply not opened.
public func inboxOpenableURL(_ text: String) -> URL? {
    guard let url = URL(string: text), let scheme = url.scheme?.lowercased() else { return nil }
    guard scheme == "https" || scheme == "http" else { return nil }
    return url
}

// MARK: - The refresh

/// One refresh: the login, then the one query, then the parse.
///
/// `run` is the only way this touches the outside world, and it is injected.
/// Nothing here spawns a process on its own, which is what lets every test in
/// this package exercise the real code path against bytes it wrote itself.
public struct PullRequestInbox: Sendable {
    public typealias Run = @Sendable ([String]) async -> Result<Data, GhFailure>

    private let run: Run

    public init(run: @escaping Run) {
        self.run = run
    }

    public static func live(timeoutSeconds: Double = 12) -> PullRequestInbox {
        PullRequestInbox(run: GhCommand.live(timeoutSeconds: timeoutSeconds))
    }

    public func load() async -> InboxOutcome {
        let user: Data
        switch await run(userArguments) {
        case .failure(let failure): return .undetermined(reason: failure.shortReason)
        case .success(let data): user = data
        }
        let login: String
        switch parseLogin(user) {
        case .failure(let problem): return .undetermined(reason: problem.reason)
        case .success(let value): login = value
        }

        switch await run(inboxArguments(login: login)) {
        case .failure(let failure): return .undetermined(reason: failure.shortReason)
        case .success(let data): return parseInbox(data, myLogin: login)
        }
    }
}
