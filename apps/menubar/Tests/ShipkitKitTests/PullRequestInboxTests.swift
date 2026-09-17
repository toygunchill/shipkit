import Foundation
import Testing
@testable import ShipkitKit

// Every fixture below is written from GitHub's published GraphQL schema, not
// captured from a live server — the only authenticated host available is a
// company GitHub Enterprise server and it is out of bounds, the same rule
// `tests/fixtures/forge/` states on the Node side. Do not over-trust these
// shapes: they say what the code does with a response, not what the server
// actually sends. That is why the parser reports what it could not read
// instead of throwing, and why nothing here spawns `gh` or opens a socket.

// MARK: - Fixtures

private func graphQL(waiting: String, reviewed: String, mine: String = "") -> Data {
    Data("""
    {"data":{"waiting":{"nodes":[\(waiting)]},"reviewed":{"nodes":[\(reviewed)]},\
    "mine":{"nodes":[\(mine)]}}}
    """.utf8)
}

/// `"author":{...}` as the searches select it, or the literal null a deleted
/// account produces. `nil` for `login` is that null; `nil` for `avatar` is an
/// author whose `avatarUrl` came back null.
private func authorField(login: String?, avatar: String?) -> String {
    guard let login else { return "\"author\":null," }
    let url = avatar.map { "\"\($0)\"" } ?? "null"
    return "\"author\":{\"login\":\"\(login)\",\"avatarUrl\":\(url)},"
}

private func decisionField(_ decision: String?) -> String {
    decision.map { "\"reviewDecision\":\"\($0)\"," } ?? ""
}

/// A node as the third search returns it: my own pull request, with the
/// anchor material and everyone's answers.
private func myNode(
    url: String = "https://example.test/acme/api/pull/3",
    updatedAt: String = "2026-09-16T09:00:00Z",
    createdAt: String = "2026-09-10T09:00:00Z",
    lastCommitAt: String? = "2026-09-12T09:00:00Z",
    authorLogin: String? = "toygun",
    avatarURL: String? = "https://example.test/avatars/u/1",
    reviewDecision: String? = nil,
    reviews: [String] = [],
    comments: [String] = []
) -> String {
    let commits = lastCommitAt
        .map { "\"commits\":{\"nodes\":[{\"commit\":{\"committedDate\":\"\($0)\"}}]}," }
        ?? "\"commits\":{\"nodes\":[]},"
    return """
    {"title":"Drop the dead flag","url":"\(url)","updatedAt":"\(updatedAt)",\
    "createdAt":"\(createdAt)","repository":{"nameWithOwner":"acme/api"},\
    \(authorField(login: authorLogin, avatar: avatarURL))\
    \(decisionField(reviewDecision))\
    \(commits)\
    "reviews":{"nodes":[\(reviews.joined(separator: ","))]},\
    "comments":{"nodes":[\(comments.joined(separator: ","))]}}
    """
}

/// A node as the first search returns it.
///
/// `reviews: nil` omits the connection altogether, which is what an older
/// server that did not answer that part of the selection would produce — not
/// the same as an empty connection, and the parser is required to tell them
/// apart.
private func waitingNode(
    title: String = "Tighten the merge gate",
    url: String = "https://example.test/acme/api/pull/7",
    repository: String = "acme/api",
    updatedAt: String = "2026-09-15T09:00:00Z",
    authorLogin: String? = "raine",
    avatarURL: String? = "https://example.test/avatars/u/9",
    reviewDecision: String? = nil,
    reviews: [String]? = []
) -> String {
    let reviewField = reviews
        .map { "\"reviews\":{\"nodes\":[\($0.joined(separator: ","))]}," }
        ?? ""
    return """
    {"title":"\(title)","url":"\(url)","updatedAt":"\(updatedAt)",\
    \(authorField(login: authorLogin, avatar: avatarURL))\
    \(decisionField(reviewDecision))\
    \(reviewField)\
    "repository":{"nameWithOwner":"\(repository)"}}
    """
}

/// A node as the second search returns it: head commit, everyone's reviews,
/// and the conversation comments.
private func reviewedNode(
    url: String = "https://example.test/acme/api/pull/11",
    updatedAt: String = "2026-09-16T09:00:00Z",
    headRefOid: String? = "aaa111",
    authorLogin: String? = "raine",
    avatarURL: String? = "https://example.test/avatars/u/9",
    reviewDecision: String? = nil,
    reviews: [String] = [],
    comments: [String] = []
) -> String {
    let head = headRefOid.map { "\"headRefOid\":\"\($0)\"," } ?? ""
    return """
    {"title":"Rename the base branch","url":"\(url)","updatedAt":"\(updatedAt)",\
    \(head)"repository":{"nameWithOwner":"acme/api"},\
    \(authorField(login: authorLogin, avatar: avatarURL))\
    \(decisionField(reviewDecision))\
    "reviews":{"nodes":[\(reviews.joined(separator: ","))]},\
    "comments":{"nodes":[\(comments.joined(separator: ","))]}}
    """
}

private func review(
    login: String?,
    state: String = "COMMENTED",
    submittedAt: String? = "2026-09-14T10:00:00Z",
    commitOid: String? = "aaa111"
) -> String {
    let author = login.map { "{\"login\":\"\($0)\"}" } ?? "null"
    let submitted = submittedAt.map { "\"\($0)\"" } ?? "null"
    let commit = commitOid.map { "{\"oid\":\"\($0)\"}" } ?? "null"
    return """
    {"author":\(author),"state":"\(state)","submittedAt":\(submitted),"commit":\(commit)}
    """
}

private func comment(login: String?, createdAt: String = "2026-09-15T10:00:00Z") -> String {
    let author = login.map { "{\"login\":\"\($0)\"}" } ?? "null"
    return "{\"author\":\(author),\"createdAt\":\"\(createdAt)\"}"
}

private func at(_ text: String) -> Date {
    // Force-unwrapped deliberately: a fixture timestamp this cannot read is a
    // broken test, not a tolerated input.
    parseTimestamp(text)!
}

private let myReview = at("2026-09-14T10:00:00Z")

// MARK: - The query

@Test func asksBothSearchesInOneDocumentWithTheLoginSplicedIn() {
    let query = inboxQuery(login: "toygun")

    #expect(query.contains("waiting: search("))
    #expect(query.contains("reviewed: search("))
    #expect(query.contains("review-requested:toygun"))
    #expect(query.contains("reviewed-by:toygun"))
    #expect(query.contains("-author:toygun"))
    // `@me` is not dependable on every GitHub Enterprise version, and a term
    // the server ignores returns an empty result rather than an error.
    #expect(query.contains("@me") == false)
}

@Test func asksForMyOwnPullRequestsInTheSameDocument() {
    let query = inboxQuery(login: "toygun")

    #expect(query.contains("mine: search("))
    #expect(query.contains("author:toygun"))
    #expect(query.contains("commits(last: 1)"))
    #expect(query.contains("committedDate"))
    #expect(query.contains("createdAt"))
    // Still one document: three aliased searches, one process.
    #expect(query.components(separatedBy: "search(").count - 1 == 3)
}

@Test func asksForTheEvidenceTheBucketRuleNeeds() {
    let query = inboxQuery(login: "toygun")

    #expect(query.contains("headRefOid"))
    // Everyone's reviews, not `reviews(author:)`: the question this bucket
    // answers is what *other* people did after my own review.
    #expect(query.contains("reviews(last: 20)"))
    #expect(query.contains("reviews(author") == false)
    #expect(query.contains("comments(last: 10)"))
    #expect(query.contains("commit { oid }"))
}

@Test func refusesALoginThatCouldEscapeTheQueryString() {
    #expect(isSupportedLogin("taylor-chen"))
    #expect(isSupportedLogin("someone_example.eu"))
    #expect(isSupportedLogin("me\" ) { id } #") == false)
    #expect(isSupportedLogin("has space") == false)
    #expect(isSupportedLogin("") == false)
}

// MARK: - The evidence rule

@Test func anotherPersonsApprovalAfterMineIsNotAReasonToLookAgain() {
    // The user's own words: "someone else approved it" must not surface a
    // pull request. This is the case `updatedAt` would have got wrong.
    let listed = needsAnotherLook(
        myLogin: "me",
        headRefOid: "aaa111",
        reviews: [
            ReviewEvent(authorLogin: "me", state: "APPROVED", submittedAt: myReview, commitOid: "aaa111"),
            ReviewEvent(
                authorLogin: "other",
                state: "APPROVED",
                submittedAt: at("2026-09-16T10:00:00Z"),
                commitOid: "aaa111"
            ),
        ],
        comments: []
    )

    #expect(listed == false)
}

@Test func aNewHeadCommitSinceMyReviewIsAReasonToLookAgain() {
    let listed = needsAnotherLook(
        myLogin: "me",
        headRefOid: "bbb222",
        reviews: [
            ReviewEvent(authorLogin: "me", state: "APPROVED", submittedAt: myReview, commitOid: "aaa111")
        ],
        comments: []
    )

    #expect(listed == true)
}

@Test func someoneElsesCommentAfterMyReviewIsAReasonToLookAgain() {
    let listed = needsAnotherLook(
        myLogin: "me",
        headRefOid: "aaa111",
        reviews: [
            ReviewEvent(authorLogin: "me", state: "COMMENTED", submittedAt: myReview, commitOid: "aaa111")
        ],
        comments: [CommentEvent(authorLogin: "other", createdAt: at("2026-09-15T10:00:00Z"))]
    )

    #expect(listed == true)
}

@Test func myOwnCommentAfterMyReviewIsNotAReasonToLookAgain() {
    let listed = needsAnotherLook(
        myLogin: "me",
        headRefOid: "aaa111",
        reviews: [
            ReviewEvent(authorLogin: "me", state: "COMMENTED", submittedAt: myReview, commitOid: "aaa111")
        ],
        comments: [CommentEvent(authorLogin: "Me", createdAt: at("2026-09-15T10:00:00Z"))]
    )

    // Cased differently on purpose: GitHub logins are case-insensitive and the
    // casing in `author.login` need not match what `gh api user` returned.
    #expect(listed == false)
}

@Test func someoneElseRequestingChangesAfterMyReviewIsAReasonToLookAgain() {
    let listed = needsAnotherLook(
        myLogin: "me",
        headRefOid: "aaa111",
        reviews: [
            ReviewEvent(authorLogin: "me", state: "APPROVED", submittedAt: myReview, commitOid: "aaa111"),
            ReviewEvent(
                authorLogin: "other",
                state: "CHANGES_REQUESTED",
                submittedAt: at("2026-09-15T10:00:00Z"),
                commitOid: "aaa111"
            ),
        ],
        comments: []
    )

    #expect(listed == true)
}

@Test func nothingSinceMyReviewIsNotAReasonToLookAgain() {
    let listed = needsAnotherLook(
        myLogin: "me",
        headRefOid: "aaa111",
        reviews: [
            ReviewEvent(
                authorLogin: "other",
                state: "CHANGES_REQUESTED",
                submittedAt: at("2026-09-13T10:00:00Z"),
                commitOid: "aaa111"
            ),
            ReviewEvent(authorLogin: "me", state: "APPROVED", submittedAt: myReview, commitOid: "aaa111"),
        ],
        comments: [CommentEvent(authorLogin: "other", createdAt: at("2026-09-13T11:00:00Z"))]
    )

    #expect(listed == false)
}

@Test func myReviewFallingOutOfTheWindowKeepsThePullRequestOut() {
    // The documented silent miss: past `reviewWindow` reviews, mine is not in
    // the response at all, so there is no "since" to measure against.
    let listed = needsAnotherLook(
        myLogin: "me",
        headRefOid: "bbb222",
        reviews: [
            ReviewEvent(
                authorLogin: "other",
                state: "CHANGES_REQUESTED",
                submittedAt: at("2026-09-15T10:00:00Z"),
                commitOid: "aaa111"
            )
        ],
        comments: []
    )

    #expect(listed == false)
}

@Test func aNullCommitOnMyReviewIsNotEvidenceThatCodeMoved() {
    let listed = needsAnotherLook(
        myLogin: "me",
        headRefOid: "bbb222",
        reviews: [
            ReviewEvent(authorLogin: "me", state: "APPROVED", submittedAt: myReview, commitOid: nil)
        ],
        comments: []
    )

    #expect(listed == false)
}

@Test func aMissingHeadCommitIsNotEvidenceThatCodeMoved() {
    let listed = needsAnotherLook(
        myLogin: "me",
        headRefOid: nil,
        reviews: [
            ReviewEvent(authorLogin: "me", state: "APPROVED", submittedAt: myReview, commitOid: "aaa111")
        ],
        comments: []
    )

    #expect(listed == false)
}

@Test func aCommentWithNoAuthorIsNotEvidenceThatSomebodySpoke() {
    // A deleted account comes back as a null author. "Not me" cannot be
    // established, so it is not evidence.
    let listed = needsAnotherLook(
        myLogin: "me",
        headRefOid: "aaa111",
        reviews: [
            ReviewEvent(authorLogin: "me", state: "APPROVED", submittedAt: myReview, commitOid: "aaa111")
        ],
        comments: [CommentEvent(authorLogin: nil, createdAt: at("2026-09-15T10:00:00Z"))]
    )

    #expect(listed == false)
}

@Test func myLatestReviewIsTheOneComparedAgainst() {
    // Two reviews of mine: an old one and a newer one. A comment between them
    // is not new since my last look.
    let listed = needsAnotherLook(
        myLogin: "me",
        headRefOid: "aaa111",
        reviews: [
            ReviewEvent(
                authorLogin: "me",
                state: "COMMENTED",
                submittedAt: at("2026-09-10T10:00:00Z"),
                commitOid: "aaa111"
            ),
            ReviewEvent(authorLogin: "me", state: "APPROVED", submittedAt: myReview, commitOid: "aaa111"),
        ],
        comments: [CommentEvent(authorLogin: "other", createdAt: at("2026-09-12T10:00:00Z"))]
    )

    #expect(listed == false)
}

// MARK: - News on my own pull requests

private let myAnchor = at("2026-09-12T09:00:00Z")

@Test func anotherPersonsApprovalOnMyOwnPullRequestIsNewsUnlikeOnOneIReviewed() {
    // The inversion, stated as a test: `needsAnotherLook` excludes exactly
    // this event as noise, and here it is the point — three approvals are
    // what lets this team merge.
    let news = newsOnMyPullRequest(
        myLogin: "me",
        createdAt: at("2026-09-10T09:00:00Z"),
        latestCommitAt: myAnchor,
        reviews: [
            ReviewEvent(
                authorLogin: "other",
                state: "APPROVED",
                submittedAt: at("2026-09-15T09:00:00Z"),
                commitOid: nil
            )
        ],
        comments: []
    )

    #expect(news.hasNews)
    #expect(news.approvals == 1)
    #expect(news.summary == "1 approval")
}

@Test func someoneElsesCommentAfterMyLastTouchIsNews() {
    let news = newsOnMyPullRequest(
        myLogin: "me",
        createdAt: at("2026-09-10T09:00:00Z"),
        latestCommitAt: myAnchor,
        reviews: [],
        comments: [CommentEvent(authorLogin: "other", createdAt: at("2026-09-13T09:00:00Z"))]
    )

    #expect(news.comments == 1)
    #expect(news.summary == "1 comment")
}

@Test func myOwnCommentIsNotNewsAndMovesTheAnchorPastWhatCameBefore() {
    let news = newsOnMyPullRequest(
        myLogin: "me",
        createdAt: at("2026-09-10T09:00:00Z"),
        latestCommitAt: myAnchor,
        reviews: [],
        comments: [
            CommentEvent(authorLogin: "other", createdAt: at("2026-09-13T09:00:00Z")),
            // Mine, and later: I have already seen theirs.
            CommentEvent(authorLogin: "me", createdAt: at("2026-09-14T09:00:00Z")),
        ]
    )

    #expect(news.hasNews == false)
}

@Test func aReviewOlderThanMyLastCommitIsNotNews() {
    let news = newsOnMyPullRequest(
        myLogin: "me",
        createdAt: at("2026-09-10T09:00:00Z"),
        latestCommitAt: myAnchor,
        reviews: [
            ReviewEvent(
                authorLogin: "other",
                state: "CHANGES_REQUESTED",
                submittedAt: at("2026-09-11T09:00:00Z"),
                commitOid: nil
            )
        ],
        comments: []
    )

    #expect(news.hasNews == false)
}

@Test func nothingSinceMyLastTouchIsNotNews() {
    let news = newsOnMyPullRequest(
        myLogin: "me",
        createdAt: at("2026-09-10T09:00:00Z"),
        latestCommitAt: myAnchor,
        reviews: [],
        comments: []
    )

    #expect(news.hasNews == false)
    #expect(news.summary == nil)
}

@Test func reviewsWithFieldsMissingAreNotNews() {
    let news = newsOnMyPullRequest(
        myLogin: "me",
        createdAt: at("2026-09-10T09:00:00Z"),
        latestCommitAt: myAnchor,
        reviews: [
            ReviewEvent(authorLogin: nil, state: "APPROVED", submittedAt: at("2026-09-15T09:00:00Z"), commitOid: nil),
            ReviewEvent(authorLogin: "other", state: nil, submittedAt: at("2026-09-15T09:00:00Z"), commitOid: nil),
            ReviewEvent(authorLogin: "other", state: "APPROVED", submittedAt: nil, commitOid: nil),
        ],
        comments: []
    )

    #expect(news.hasNews == false)
}

@Test func summarisesSeveralKindsOfNewsInOneLine() {
    let news = InboxNews(approvals: 1, changesRequested: 1, comments: 2)

    #expect(news.summary == "1 approval · changes requested · 2 comments")
}

@Test func countsOnlyMyPullRequestsWithNewsButListsThemAll() {
    // The deliberate difference from the other two rows: the count means
    // "needs me", the list is the author's whole slate.
    let quiet = myNode(url: "https://example.test/acme/api/pull/1", updatedAt: "2026-09-16T10:00:00Z")
    let loud = myNode(
        url: "https://example.test/acme/api/pull/2",
        updatedAt: "2026-09-16T08:00:00Z",
        reviews: [review(login: "other", state: "APPROVED", submittedAt: "2026-09-15T09:00:00Z", commitOid: nil)]
    )
    let data = graphQL(waiting: "", reviewed: "", mine: "\(quiet),\(loud)")

    let outcome = parseInbox(data, myLogin: "me")

    #expect(outcome.countText(.myPullRequests) == "1")
    #expect(outcome.mine?.count == 2)
    // News first, even though the quiet one was updated more recently.
    #expect(outcome.mine?.first?.pullRequest.url == "https://example.test/acme/api/pull/2")
    #expect(outcome.mine?.last?.news.hasNews == false)
    // And there is a list to open even when nothing is asking anything.
    #expect(outcome.hasList(.myPullRequests))
}

// MARK: - The parser



@Test func readsBothBucketsFromOneResponse() {
    let data = graphQL(
        waiting: waitingNode(),
        reviewed: reviewedNode(
            headRefOid: "bbb222",
            reviews: [review(login: "me", state: "APPROVED")],
            comments: []
        )
    )

    let outcome = parseInbox(data, myLogin: "me")

    #expect(outcome.list(.waitingOnMe)?.count == 1)
    #expect(outcome.list(.waitingOnMe)?.first?.repository == "acme/api")
    #expect(outcome.list(.waitingOnMe)?.first?.title == "Tighten the merge gate")
    #expect(outcome.list(.needsAnotherLook)?.count == 1)
}

@Test func leavesOutAPullRequestNothingHasHappenedOn() {
    let data = graphQL(
        waiting: "",
        reviewed: reviewedNode(
            headRefOid: "aaa111",
            reviews: [
                review(login: "me", state: "APPROVED"),
                review(login: "other", state: "APPROVED", submittedAt: "2026-09-16T10:00:00Z"),
            ],
            comments: []
        )
    )

    let outcome = parseInbox(data, myLogin: "me")

    #expect(outcome.list(.needsAnotherLook)?.isEmpty == true)
    #expect(outcome.list(.waitingOnMe)?.isEmpty == true)
}

@Test func countsAPullRequestSomebodyElseRepliedOnSinceMyReview() {
    // The whole path, from bytes to bucket: my review, then their comment.
    let data = graphQL(
        waiting: "",
        reviewed: reviewedNode(
            headRefOid: "aaa111",
            reviews: [review(login: "me", state: "APPROVED")],
            comments: [comment(login: "other")]
        )
    )

    let outcome = parseInbox(data, myLogin: "me")

    #expect(outcome.list(.needsAnotherLook)?.count == 1)
    #expect(outcome.list(.needsAnotherLook)?.first?.url == "https://example.test/acme/api/pull/11")
}

@Test func sortsEachBucketMostRecentlyUpdatedFirst() {
    let older = waitingNode(title: "older", url: "https://example.test/a/1", updatedAt: "2026-09-10T09:00:00Z")
    let newer = waitingNode(title: "newer", url: "https://example.test/a/2", updatedAt: "2026-09-16T09:00:00Z")
    let data = graphQL(waiting: "\(older),\(newer)", reviewed: "")

    let outcome = parseInbox(data, myLogin: "me")

    #expect(outcome.list(.waitingOnMe)?.map(\.title) == ["newer", "older"])
}

@Test func skipsAnIssueTheSearchReturnedWithNoPullRequestSelection() {
    // `search(type: ISSUE)` can return issues; the `... on PullRequest`
    // fragment then selects nothing and the node arrives as `{}`.
    let data = graphQL(waiting: "{},\(waitingNode())", reviewed: "")

    let outcome = parseInbox(data, myLogin: "me")

    #expect(outcome.list(.waitingOnMe)?.count == 1)
}

@Test func refusesToCountWhenAPullRequestCameBackWithoutItsRepository() {
    let broken = """
    {"title":"t","url":"https://example.test/a/1","updatedAt":"2026-09-15T09:00:00Z"}
    """
    let data = graphQL(waiting: broken, reviewed: "")

    let outcome = parseInbox(data, myLogin: "me")

    #expect(outcome.list(.waitingOnMe) == nil)
    #expect(outcome.reason?.contains("repository") == true)
    // Names the pull request, so the first run against the real server says
    // which one rather than only that something was wrong.
    #expect(outcome.reason?.contains("https://example.test/a/1") == true)
}

@Test func refusesToCountWhenATimestampCannotBeRead() {
    let data = graphQL(waiting: waitingNode(updatedAt: "last tuesday"), reviewed: "")

    let outcome = parseInbox(data, myLogin: "me")

    #expect(outcome.list(.waitingOnMe) == nil)
    #expect(outcome.reason?.contains("last tuesday") == true)
}

@Test func refusesToCountWhenAReviewedPullRequestCameBackWithoutItsReviews() {
    // A whole connection missing means the server did not answer the query
    // that was sent. Reporting zero off that would be the confident lie.
    let node = """
    {"title":"t","url":"https://example.test/a/9","updatedAt":"2026-09-15T09:00:00Z",\
    "headRefOid":"aaa111","repository":{"nameWithOwner":"acme/api"},"comments":{"nodes":[]}}
    """
    let data = graphQL(waiting: "", reviewed: node)

    let outcome = parseInbox(data, myLogin: "me")

    #expect(outcome.list(.needsAnotherLook) == nil)
    #expect(outcome.reason?.contains("reviews") == true)
}

@Test func reportsWhatGitHubSaidWhenItRefusedTheQuery() {
    let data = Data(#"{"errors":[{"message":"Field 'headRefOid' doesn't exist"}]}"#.utf8)

    let outcome = parseInbox(data, myLogin: "me")

    #expect(outcome.list(.waitingOnMe) == nil)
    #expect(outcome.reason?.contains("headRefOid") == true)
}

@Test func doesNotThrowOnBytesThatAreNotJSONAtAll() {
    let outcome = parseInbox(Data("gh: command not found".utf8), myLogin: "me")

    #expect(outcome.list(.waitingOnMe) == nil)
    #expect(outcome.reason?.isEmpty == false)
}

@Test func anUndeterminedCountShowsAsAnEmDashAndNeverAsZero() {
    let outcome = InboxOutcome.undetermined(reason: "gh did not answer within 12s")

    #expect(outcome.countText(.waitingOnMe) == "—")
    #expect(outcome.countText(.needsAnotherLook) == "—")
    #expect(outcome.countText(.waitingOnMe) != "0")
}

@Test func anEmptySearchResultDoesShowAsZero() {
    let outcome = parseInbox(graphQL(waiting: "", reviewed: ""), myLogin: "me")

    #expect(outcome.countText(.waitingOnMe) == "0")
}

// MARK: - The login

@Test func readsTheLoginFromGhApiUser() {
    let data = Data(#"{"login":"toygun","id":41}"#.utf8)

    guard case .success(let login) = parseLogin(data) else {
        Issue.record("expected a login")
        return
    }
    #expect(login == "toygun")
}

@Test func refusesAUserResponseWithoutALogin() {
    let outcome = parseLogin(Data("{}".utf8))

    guard case .failure(let problem) = outcome else {
        Issue.record("expected a refusal")
        return
    }
    #expect(problem.reason.contains("login"))
}

// MARK: - The list

@Test func summarisesTheTailOfALongList() {
    let (shown, remaining) = inboxListPreview(Array(1...12))

    #expect(shown.count == 10)
    #expect(remaining == 2)
}

@Test func showsAShortListWhole() {
    let (shown, remaining) = inboxListPreview(Array(1...3))

    #expect(shown.count == 3)
    #expect(remaining == 0)
}

@Test func opensAPullRequestOverHttps() {
    #expect(inboxOpenableURL("https://example.test/acme/api/pull/7")?.host == "example.test")
}

@Test func refusesToOpenAnythingThatIsNotAWebPage() {
    // The URL comes from a server response and `NSWorkspace.open` acts on
    // whatever scheme it is given.
    #expect(inboxOpenableURL("file:///etc/passwd") == nil)
    #expect(inboxOpenableURL("x-shipkit://approve") == nil)
    #expect(inboxOpenableURL("not a url at all") == nil)
}

// MARK: - The refresh

/// Records what was asked of `gh` and answers from a script. Nothing here
/// spawns a process: that is the point of the seam.
private actor RunSpy {
    private(set) var calls: [[String]] = []
    private var answers: [Result<Data, GhFailure>]

    init(_ answers: [Result<Data, GhFailure>]) {
        self.answers = answers
    }

    func run(_ arguments: [String]) -> Result<Data, GhFailure> {
        calls.append(arguments)
        return answers.isEmpty ? .failure(.spawnFailed("the test ran out of answers")) : answers.removeFirst()
    }
}

@Test func spendsExactlyTwoInvocationsOnARefresh() async {
    let spy = RunSpy([
        .success(Data(#"{"login":"toygun"}"#.utf8)),
        .success(graphQL(waiting: waitingNode(), reviewed: "")),
    ])
    let inbox = PullRequestInbox { await spy.run($0) }

    let outcome = await inbox.load()

    let calls = await spy.calls
    #expect(calls.count == 2)
    #expect(calls.first == ["api", "user"])
    #expect(Array(calls.last?.prefix(2) ?? []) == ["api", "graphql"])
    // The login from the first call is what the second searches for.
    #expect(calls.last?.last?.contains("review-requested:toygun") == true)
    #expect(outcome.list(.waitingOnMe)?.count == 1)
}

@Test func doesNotAskForPullRequestsWhenItCannotEstablishWhoIAm() async {
    let spy = RunSpy([.failure(.notInstalled(searched: GhCommand.candidatePaths))])
    let inbox = PullRequestInbox { await spy.run($0) }

    let outcome = await inbox.load()

    let calls = await spy.calls
    #expect(calls.count == 1)
    #expect(outcome.list(.waitingOnMe) == nil)
    #expect(outcome.reason?.contains("/opt/homebrew/bin/gh") == true)
}

@Test func doesNotSearchWhenGhAnsweredWithoutALogin() async {
    // Without a login there is nothing to interpolate, and a search built
    // around a guess would answer a different question than the one asked.
    let spy = RunSpy([.success(Data("{}".utf8))])
    let inbox = PullRequestInbox { await spy.run($0) }

    let outcome = await inbox.load()

    let calls = await spy.calls
    #expect(calls.count == 1)
    #expect(outcome.reason?.contains("login") == true)
}

@Test func saysSoWhenGhHangs() async {
    let spy = RunSpy([
        .success(Data(#"{"login":"toygun"}"#.utf8)),
        .failure(.timedOut(seconds: 12)),
    ])
    let inbox = PullRequestInbox { await spy.run($0) }

    let outcome = await inbox.load()

    #expect(outcome.list(.needsAnotherLook) == nil)
    #expect(outcome.reason == "gh did not answer within 12s")
}

@Test func passesOnWhatGhPrintedWhenItFailed() async {
    let spy = RunSpy([.failure(.failed(exitCode: 4, message: "gh auth login required"))])
    let inbox = PullRequestInbox { await spy.run($0) }

    let outcome = await inbox.load()

    #expect(outcome.reason?.contains("gh auth login required") == true)
}

// MARK: - Finding gh

@Test func prefersHomebrewOverTheSystemCopy() {
    let found = GhCommand.resolvePath { path in
        path == "/opt/homebrew/bin/gh" || path == "/usr/bin/gh"
    }

    #expect(found == "/opt/homebrew/bin/gh")
}

@Test func fallsThroughToWhicheverCandidateExists() {
    let found = GhCommand.resolvePath { $0 == "/usr/local/bin/gh" }

    #expect(found == "/usr/local/bin/gh")
}

@Test func findsNothingRatherThanGuessingAPath() {
    // A LaunchServices app has no shell `PATH` to fall back on, so "not
    // found" has to be an answer the panel can show rather than a crash.
    #expect(GhCommand.resolvePath { _ in false } == nil)
}

@Test func aReviewStateThisCodeDoesNotKnowIsNotNews() {
    // The whitelist, pinned. A review found the previous `default:` branch
    // counting any unknown state string — a GHE-version variant, a future
    // enum member — as a comment on my own pull request. An unknown state is
    // a non-null field, but it is not affirmative evidence of anything, and
    // only affirmative evidence counts as news.
    let news = newsOnMyPullRequest(
        myLogin: "me",
        createdAt: at("2026-09-10T09:00:00Z"),
        latestCommitAt: myAnchor,
        reviews: [
            ReviewEvent(
                authorLogin: "other",
                state: "SOME_FUTURE_STATE",
                submittedAt: at("2026-09-15T09:00:00Z"),
                commitOid: nil
            ),
        ],
        comments: []
    )
    #expect(news == .none)
}

@Test func aDismissalOnMyOwnPullRequestStillCountsAsAComment() {
    // The deliberate half of the old `default:` branch, kept by name now
    // that the accidental half is gone.
    let news = newsOnMyPullRequest(
        myLogin: "me",
        createdAt: at("2026-09-10T09:00:00Z"),
        latestCommitAt: myAnchor,
        reviews: [
            ReviewEvent(
                authorLogin: "other",
                state: "DISMISSED",
                submittedAt: at("2026-09-15T09:00:00Z"),
                commitOid: nil
            ),
        ],
        comments: []
    )
    #expect(news.comments == 1)
}

// MARK: - Who owns it, and where the review stands

@Test func asksEverySearchForTheAuthorAndTheServersReviewDecision() {
    let query = inboxQuery(login: "toygun")

    // Three of each, one per aliased search. Counted rather than merely
    // `contains`-checked, because "it is in the document somewhere" would pass
    // with the field on one search and missing from the other two.
    #expect(query.components(separatedBy: "author { login avatarUrl }").count - 1 == 3)
    #expect(query.components(separatedBy: "reviewDecision").count - 1 == 3)
}

@Test func asksTheReviewRequestedSearchForReviewsToo() {
    let query = inboxQuery(login: "toygun")

    // Three review windows now: the first search needs one only for the
    // approval count, not for its membership.
    #expect(query.components(separatedBy: "reviews(last: 20)").count - 1 == 3)
    // The literal 20 above and the constant are the same number: the window
    // is reused, not re-chosen.
    #expect(reviewWindow == 20)
}

@Test func areviewerWhoRequestedChangesAndThenApprovedCountsOnce() {
    // The case the feature was asked for by name: somebody blocked the pull
    // request and later came back and approved it. They are one approval, not
    // a rejection plus an approval.
    //
    // Measured, not assumed: this case alone does *not* discriminate against
    // the obvious wrong implementation. Filtering the rows for "APPROVED"
    // also answers 1 here, because there is only one such row. The tests that
    // catch that implementation are the three below —
    // `theSameReviewerApprovingTwiceStillCountsOnce`,
    // `areviewerWhoApprovedAndThenRequestedChangesCountsAsNeither` and
    // `aDismissedReviewIsAWithdrawnApproval`. This one pins the behaviour that
    // was asked for; those three pin the mechanism that delivers it.
    let count = latestApprovalCount(reviews: [
        ReviewEvent(
            authorLogin: "raine",
            state: "CHANGES_REQUESTED",
            submittedAt: at("2026-09-10T09:00:00Z"),
            commitOid: "aaa111"
        ),
        ReviewEvent(
            authorLogin: "raine",
            state: "APPROVED",
            submittedAt: at("2026-09-14T09:00:00Z"),
            commitOid: "bbb222"
        ),
    ])

    #expect(count == 1)
}

@Test func theSameReviewerApprovingTwiceStillCountsOnce() {
    // GitHub records a fresh `APPROVED` review every time someone re-approves
    // after a push, so one enthusiastic reviewer on a branch that went round
    // three times is three rows. Counting rows would report that single
    // person as the three approvals this team merges on.
    let count = latestApprovalCount(reviews: [
        ReviewEvent(
            authorLogin: "raine",
            state: "APPROVED",
            submittedAt: at("2026-09-10T09:00:00Z"),
            commitOid: "aaa111"
        ),
        ReviewEvent(
            authorLogin: "raine",
            state: "APPROVED",
            submittedAt: at("2026-09-14T09:00:00Z"),
            commitOid: "bbb222"
        ),
    ])

    #expect(count == 1)
}

@Test func areviewerWhoApprovedAndThenRequestedChangesCountsAsNeither() {
    // The same rule read the other way round: the latest position stands, so
    // an approval that was withdrawn is not counted.
    let count = latestApprovalCount(reviews: [
        ReviewEvent(
            authorLogin: "raine",
            state: "APPROVED",
            submittedAt: at("2026-09-10T09:00:00Z"),
            commitOid: "aaa111"
        ),
        ReviewEvent(
            authorLogin: "raine",
            state: "CHANGES_REQUESTED",
            submittedAt: at("2026-09-14T09:00:00Z"),
            commitOid: "bbb222"
        ),
    ])

    #expect(count == 0)
}

@Test func twoDifferentPeopleApprovingCountAsTwo() {
    // The collapsing must not collapse across people, which is the failure
    // mode opposite to the one above.
    let count = latestApprovalCount(reviews: [
        ReviewEvent(
            authorLogin: "raine",
            state: "APPROVED",
            submittedAt: at("2026-09-14T09:00:00Z"),
            commitOid: "aaa111"
        ),
        ReviewEvent(
            authorLogin: "kerem",
            state: "APPROVED",
            submittedAt: at("2026-09-15T09:00:00Z"),
            commitOid: "aaa111"
        ),
    ])

    #expect(count == 2)
}

@Test func onePersonUnderTwoCasingsIsOnePerson() {
    // Both rows are approvals, on purpose: with one of each state the folding
    // makes no difference to the answer and the test would not be testing it.
    // GitHub logins are case-insensitive and the casing is not guaranteed
    // stable across fields, so an unfolded key turns one reviewer into two.
    let count = latestApprovalCount(reviews: [
        ReviewEvent(
            authorLogin: "Raine",
            state: "APPROVED",
            submittedAt: at("2026-09-10T09:00:00Z"),
            commitOid: "aaa111"
        ),
        ReviewEvent(
            authorLogin: "raine",
            state: "APPROVED",
            submittedAt: at("2026-09-14T09:00:00Z"),
            commitOid: "bbb222"
        ),
    ])

    #expect(count == 1)
}

@Test func aLaterCommentDoesNotRetractAnEarlierApproval() {
    // `COMMENTED` is not a position. GitHub leaves the approval standing when
    // its author later comments, and so does this: if a comment could become
    // someone's latest review, replying in a thread would silently un-approve.
    let count = latestApprovalCount(reviews: [
        ReviewEvent(
            authorLogin: "raine",
            state: "APPROVED",
            submittedAt: at("2026-09-10T09:00:00Z"),
            commitOid: "aaa111"
        ),
        ReviewEvent(
            authorLogin: "raine",
            state: "COMMENTED",
            submittedAt: at("2026-09-16T09:00:00Z"),
            commitOid: "aaa111"
        ),
    ])

    #expect(count == 1)
}

@Test func aDismissedReviewIsAWithdrawnApproval() {
    let count = latestApprovalCount(reviews: [
        ReviewEvent(
            authorLogin: "raine",
            state: "APPROVED",
            submittedAt: at("2026-09-10T09:00:00Z"),
            commitOid: "aaa111"
        ),
        ReviewEvent(
            authorLogin: "raine",
            state: "DISMISSED",
            submittedAt: at("2026-09-16T09:00:00Z"),
            commitOid: "aaa111"
        ),
    ])

    #expect(count == 0)
}

@Test func areviewThatCannotBeAttributedOrOrderedIsNotCounted() {
    // Absence is not evidence, the same rule the two bucket filters keep. A
    // null author cannot be told apart from somebody already counted, and a
    // review with no `submittedAt` cannot be placed against the others.
    let count = latestApprovalCount(reviews: [
        ReviewEvent(authorLogin: nil, state: "APPROVED", submittedAt: at("2026-09-14T09:00:00Z"), commitOid: nil),
        ReviewEvent(authorLogin: "kerem", state: "APPROVED", submittedAt: nil, commitOid: nil),
        ReviewEvent(authorLogin: "ada", state: nil, submittedAt: at("2026-09-14T09:00:00Z"), commitOid: nil),
    ])

    #expect(count == 0)
}

@Test func changesRequestedOutranksAHealthyApprovalCount() {
    // The user's rule: if it got an "rc", that is what the row says. Two
    // approvals do not soften a pull request that is blocked.
    let standing = ReviewStanding(decision: .changesRequested, approvals: 2)

    #expect(standing.mark == .changesRequested)
}

@Test func theApprovalCountIsTheMarkWhenNothingIsBlocking() {
    #expect(ReviewStanding(decision: .approved, approvals: 3).mark == .approvals(3))
    #expect(ReviewStanding(decision: .reviewRequired, approvals: 1).mark == .approvals(1))
    // No decision at all — GitHub returns null when no review is required —
    // still shows the count.
    #expect(ReviewStanding(decision: nil, approvals: 0).mark == .approvals(0))
}

@Test func aStandingThatCouldNotBeEstablishedHasNoMark() {
    // Absent, not zero. The same rule the counts on the front screen keep.
    #expect(ReviewStanding.unknown.mark == nil)
    #expect(ReviewStanding(decision: nil, approvals: nil).mark == nil)
    // But a known decision alone is still worth saying.
    #expect(ReviewStanding(decision: .changesRequested, approvals: nil).mark == .changesRequested)
}

@Test func readsTheAuthorAndTheStandingOntoEveryRow() {
    let data = graphQL(
        waiting: waitingNode(
            authorLogin: "raine",
            avatarURL: "https://ghe.example.test/avatars/u/9",
            reviewDecision: "REVIEW_REQUIRED",
            reviews: [
                review(login: "kerem", state: "APPROVED", submittedAt: "2026-09-14T09:00:00Z")
            ]
        ),
        reviewed: ""
    )

    let outcome = parseInbox(data, myLogin: "toygun")

    let row = outcome.list(.waitingOnMe)?.first
    #expect(row?.author?.login == "raine")
    #expect(row?.author?.avatarURL == "https://ghe.example.test/avatars/u/9")
    #expect(row?.standing.decision == .reviewRequired)
    #expect(row?.standing.approvals == 1)
    #expect(row?.standing.mark == .approvals(1))
}

@Test func readsTheStandingOntoMyOwnPullRequestsToo() {
    let data = graphQL(
        waiting: "",
        reviewed: "",
        mine: myNode(
            reviewDecision: "CHANGES_REQUESTED",
            reviews: [
                review(login: "raine", state: "CHANGES_REQUESTED", submittedAt: "2026-09-13T09:00:00Z"),
                review(login: "raine", state: "APPROVED", submittedAt: "2026-09-15T09:00:00Z"),
                // raine re-approved after a push. Three rows, two of them
                // approvals, one person.
                review(login: "raine", state: "APPROVED", submittedAt: "2026-09-16T09:00:00Z"),
                review(login: "kerem", state: "APPROVED", submittedAt: "2026-09-15T10:00:00Z"),
            ]
        )
    )

    let outcome = parseInbox(data, myLogin: "toygun")

    let row = outcome.mine?.first?.pullRequest
    // Two approvals after collapsing raine's three reviews into one position,
    // and the server still says the pull request is blocked — so the row
    // shows the block.
    #expect(row?.standing.approvals == 2)
    #expect(row?.standing.decision == .changesRequested)
    #expect(row?.standing.mark == .changesRequested)
}

@Test func aPullRequestWhoseAuthorWasDeletedStillAppears() {
    // The row must survive a null author: it is still a pull request waiting
    // on this person, and dropping it would make the count wrong.
    let data = graphQL(
        waiting: waitingNode(authorLogin: nil, avatarURL: nil),
        reviewed: ""
    )

    let outcome = parseInbox(data, myLogin: "toygun")

    #expect(outcome.list(.waitingOnMe)?.count == 1)
    #expect(outcome.list(.waitingOnMe)?.first?.author == nil)
    #expect(outcome.reason == nil)
}

@Test func anAuthorWithNoAvatarKeepsTheirLogin() {
    let data = graphQL(waiting: waitingNode(avatarURL: nil), reviewed: "")

    let outcome = parseInbox(data, myLogin: "toygun")

    #expect(outcome.list(.waitingOnMe)?.first?.author?.login == "raine")
    #expect(outcome.list(.waitingOnMe)?.first?.author?.avatarURL == nil)
}

@Test func aReviewDecisionThisDoesNotRecogniseIsNotGuessedAt() {
    // The same whitelist discipline the two bucket filters keep: an
    // unrecognised enum member is not affirmative evidence of anything.
    let data = graphQL(waiting: waitingNode(reviewDecision: "SOME_FUTURE_STATE"), reviewed: "")

    let outcome = parseInbox(data, myLogin: "toygun")

    #expect(outcome.list(.waitingOnMe)?.first?.standing.decision == nil)
    // And it does not take the whole refresh down with it.
    #expect(outcome.reason == nil)
}

@Test func reviewsMissingFromTheFirstSearchLeaveTheCountAbsentRatherThanZero() {
    // The first search's *membership* does not depend on the reviews — being
    // in it means someone asked. So a reviews connection that did not come
    // back costs the count and nothing else, unlike the other two searches
    // where it means the server did not answer the query that was sent.
    let data = graphQL(
        waiting: waitingNode(reviewDecision: "APPROVED", reviews: nil),
        reviewed: ""
    )

    let outcome = parseInbox(data, myLogin: "toygun")

    #expect(outcome.reason == nil)
    let row = outcome.list(.waitingOnMe)?.first
    #expect(row?.standing.approvals == nil)
    #expect(row?.standing.decision == .approved)
    #expect(row?.standing.mark == nil)
}

@Test func anEmptyReviewsConnectionIsAConfidentZero() {
    // The other side of the line above: the connection came back and is
    // empty, which is an answer.
    let data = graphQL(waiting: waitingNode(reviews: []), reviewed: "")

    let outcome = parseInbox(data, myLogin: "toygun")

    #expect(outcome.list(.waitingOnMe)?.first?.standing.approvals == 0)
    #expect(outcome.list(.waitingOnMe)?.first?.standing.mark == .approvals(0))
}

@Test func aNodeCarryingOnlyAnAuthorIsReportedRatherThanSkipped() {
    // `isEmptySelection` has to list every selected field. If it did not list
    // `author`, this node would look like the `{}` an issue produces and be
    // dropped in silence — one pull request missing from a count that is then
    // presented with confidence.
    let data = graphQL(waiting: "{\"author\":{\"login\":\"raine\",\"avatarUrl\":null}}", reviewed: "")

    let outcome = parseInbox(data, myLogin: "toygun")

    #expect(outcome.reason?.contains("no title came back") == true)
    #expect(outcome.list(.waitingOnMe) == nil)
}
