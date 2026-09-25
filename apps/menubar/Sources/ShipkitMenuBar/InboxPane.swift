import AppKit
import SwiftUI
import ShipkitKit

/// The panel's main screen: what is waiting on this person, what they already
/// reviewed and needs another look, what came back on their own pull requests,
/// and a way to the Jira token.
///
/// The token used to be what clicking the menu-bar icon opened, which said the
/// application's subject was a setting. It is not — it is a pull request's last
/// mile — so the token moved behind a navigation and the three counts took the
/// front.
///
/// Nothing here touches the menu-bar mark. The mark means exactly one thing,
/// that a push is blocked on this person's decision, and a review queue is
/// almost always non-empty: sharing the mark's state would turn a rare, urgent
/// signal into a number nobody reads.
struct InboxPane: View {
    @ObservedObject var model: AppModel

    private enum Route: Equatable {
        case inbox
        case list(InboxBucket)
        case token
    }

    @State private var route: Route = .inbox

    var body: some View {
        Group {
            switch route {
            case .inbox:
                // The lifecycle hooks sit on this branch, not on the Group:
                // on the container they straddle a _ConditionalContent, where
                // whether a route flip re-fires them is not behaviour SwiftUI
                // promises -- one reading spawned a gh pair per list visit,
                // the other left the timer ticking under the token pane. On
                // the branch, appearing means exactly "the inbox is what is
                // on screen".
                inbox
                    .onAppear { model.inboxAppeared() }
                    .onDisappear { model.inboxDisappeared() }
            case .list(let bucket):
                // My own pull requests list differently from the other two:
                // all of them, not only the ones with news, each with what
                // arrived. See `InboxSnapshot.count`.
                if bucket == .myPullRequests {
                    AuthoredList(
                        pullRequests: model.inbox?.mine ?? [],
                        avatars: model.avatars,
                        back: { route = .inbox },
                        model: model
                    )
                } else {
                    InboxList(
                        bucket: bucket,
                        pullRequests: model.inbox?.list(bucket) ?? [],
                        avatars: model.avatars,
                        back: { route = .inbox },
                        model: model
                    )
                }
            case .token:
                SettingsPane(model: model) { route = .inbox }
            }
        }
    }

    private var inbox: some View {
        VStack(alignment: .leading, spacing: 12) {
            // A review that was on this panel a moment ago and is not any more.
            // Said out loud rather than left as a pane that silently changed
            // underneath someone: the usual cause is that they answered it in
            // the browser, and the second is that the run stopped — and a
            // person who ticked six boxes here deserves to know which.
            if model.reviewWithdrawn {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "info.circle")
                    Text("The review was closed — answered elsewhere, or the run stopped.")
                        .font(.caption)
                    Spacer(minLength: 4)
                    Button("OK") { model.acknowledgeWithdrawnReview() }
                        .buttonStyle(.link)
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
            }
            HStack {
                Text("Pull requests").font(.headline)
                // Which GitHub these came from. Shown whenever there is more
                // than one to choose between, and not otherwise: with a single
                // host it is the only possible answer and saying it is noise.
                // With two it is the difference between "I have no pull
                // requests" and "you are looking at the wrong account", which a
                // person cannot tell from a row of zeroes.
                if model.ghHosts.count > 1 {
                    Menu {
                        ForEach(model.ghHosts, id: \.self) { host in
                            Button {
                                model.chooseHost(host)
                            } label: {
                                if host == model.ghHost {
                                    Label(host, systemImage: "checkmark")
                                } else {
                                    Text(host)
                                }
                            }
                        }
                    } label: {
                        Text(model.ghHost ?? "choose a host")
                            .font(.caption)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                }
                Spacer()
                if model.inboxRefreshing {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Button {
                        model.refreshInbox(ignoringInterval: true)
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .help("Check again")
                }
            }

            VStack(spacing: 0) {
                ForEach(InboxBucket.allCases, id: \.self) { bucket in
                    if bucket != InboxBucket.allCases.first { Divider() }
                    BucketRow(
                        bucket: bucket,
                        outcome: model.inbox,
                        refreshing: model.inboxRefreshing
                    ) { route = .list(bucket) }
                }
            }

            // One short line, and only when there is one. A count that could
            // not be established is shown as an em dash above; this says why,
            // so the answer is never a silent zero.
            // Said before the counts are read as an answer. `gh` can reach more
            // than one GitHub and nothing on this machine says which one this
            // person means, so the app asks rather than picking the one `gh`
            // happens to default to — which is a global setting, and moves the
            // moment somebody logs in anywhere else.
            if model.ghHost == nil && model.ghHosts.count > 1 {
                Text("gh is signed in to \(model.ghHosts.count) GitHubs. Choose which one these "
                     + "pull requests should come from, above.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let reason = model.inbox?.reason {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            Divider()

            Button("Add/Edit Jira Token") { route = .token }
                .buttonStyle(.link)

            ReviewNoticeBar(model: model)

            // Kept on the main screen deliberately. It used to live on the
            // only screen this panel had; now that the token is behind a
            // navigation, a socket that failed to start would be invisible
            // unless someone went looking for it — and a listener that is not
            // running means every push silently loses its approval prompt.
            if let listenerError = model.listenerError {
                Divider()
                Text("The approval socket failed to start.")
                    .font(.caption)
                    .foregroundStyle(.red)
                Text(listenerError)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(18)
        .frame(width: 380)
    }
}

/// What happened when the Review button was pressed, wherever it was pressed.
///
/// A view rather than an alert, and shown on every screen that carries the
/// button rather than only the first. A SwiftUI alert never presents from a
/// `MenuBarExtra(.window)` popover — the window is not key, so there is nothing
/// for it to attach to — and the first version used one: the button wrote the
/// request and told the person nothing, which is the exact failure the notice
/// exists to prevent. The second version put it on the main pane only, which
/// was no better, because the button is pressed from a list.
private struct ReviewNoticeBar: View {
    @ObservedObject var model: AppModel

    var body: some View {
        if let notice = model.reviewRequestNotice {
            Divider()
            HStack(alignment: .top, spacing: 6) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(notice.title).font(.caption).bold()
                    Text(notice.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if notice.opensTerminal {
                        Button("Open Terminal") { model.openTerminal() }
                            .buttonStyle(.link)
                            .font(.caption)
                    }
                }
                Spacer(minLength: 4)
                Button {
                    model.reviewRequestNotice = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .help("Dismiss")
            }
        }
    }
}

/// One bucket as a row: its name, its count, and a way into its list.
private struct BucketRow: View {
    let bucket: InboxBucket
    let outcome: InboxOutcome?
    let refreshing: Bool
    let open: () -> Void

    /// Nothing to navigate to when there is nothing in the list, and nothing
    /// to navigate to when it could not be established either — an empty list
    /// would be an answer this does not have. Not the same as the count being
    /// zero: my own pull requests are worth opening even when none of them is
    /// asking anything.
    private var hasList: Bool {
        outcome?.hasList(bucket) ?? false
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Text(bucket.title)
                    .font(.callout)
                Spacer()
                Text(outcome?.countText(bucket) ?? "—")
                    .font(.title3)
                    .monospacedDigit()
                    // Dimmed, not blanked, while a refresh runs: the previous
                    // answer is still the best one available until the new one
                    // arrives.
                    .opacity(refreshing ? 0.35 : 1)
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .opacity(hasList ? 1 : 0)
            }
            .contentShape(Rectangle())
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .disabled(hasList == false)
    }
}

/// One reviewer bucket's pull requests, by name. Membership is the whole
/// message here: every row in these two lists is asking something.
private struct InboxList: View {
    let bucket: InboxBucket
    let pullRequests: [InboxPullRequest]
    let avatars: AvatarStore
    let back: () -> Void
    @ObservedObject var model: AppModel

    var body: some View {
        let preview = inboxListPreview(pullRequests)

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Button(action: back) {
                    Label("Pull requests", systemImage: "chevron.left")
                        .labelStyle(.titleAndIcon)
                        .font(.callout)
                }
                .buttonStyle(.link)
                Spacer()
            }

            Text(bucket.title).font(.headline)

            ReviewNoticeBar(model: model)

            VStack(alignment: .leading, spacing: 0) {
                // Where the button is, so pressing it produces something visible
                // without navigating anywhere.
                ForEach(preview.shown) { pullRequest in
                    if pullRequest.id != preview.shown.first?.id { Divider() }
                    PullRequestRow(
                        pullRequest: pullRequest,
                        avatars: avatars,
                        onReview: { model.requestReview(of: pullRequest) }
                    )
                }
            }

            if preview.remaining > 0 {
                Text("… and \(preview.remaining) more")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(18)
        .frame(width: 380)
    }
}

/// My own open pull requests: the ones with news first and in full colour,
/// the quiet ones dimmed below. Dimmed rather than hidden, because an author
/// opening this wants the whole slate — the ordering is what keeps the glance
/// honest about which ones are asking something.
private struct AuthoredList: View {
    let pullRequests: [AuthoredPullRequest]
    let avatars: AvatarStore
    let back: () -> Void
    @ObservedObject var model: AppModel

    var body: some View {
        let preview = inboxListPreview(pullRequests)

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Button(action: back) {
                    Label("Pull requests", systemImage: "chevron.left")
                        .labelStyle(.titleAndIcon)
                        .font(.callout)
                }
                .buttonStyle(.link)
                Spacer()
            }

            Text(InboxBucket.myPullRequests.title).font(.headline)

            ReviewNoticeBar(model: model)

            VStack(alignment: .leading, spacing: 0) {
                // Where the button is, so pressing it produces something visible
                // without navigating anywhere.
                ForEach(preview.shown) { entry in
                    if entry.id != preview.shown.first?.id { Divider() }
                    // `showsAuthor: false`. Every pull request in this list is
                    // mine, so a face and a login repeated down the column
                    // would be the one fact the reader already knows, taking
                    // the slot where something they do not know could go. The
                    // standing mark takes it instead, and takes it in its
                    // prominent form.
                    PullRequestRow(
                        pullRequest: entry.pullRequest,
                        news: entry.news,
                        showsAuthor: false,
                        avatars: avatars,
                        onReview: { model.requestReview(of: entry.pullRequest) }
                    )
                    .opacity(entry.news.hasNews ? 1 : 0.55)
                }
            }

            if preview.remaining > 0 {
                Text("… and \(preview.remaining) more")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(18)
        .frame(width: 380)
    }
}

private struct PullRequestRow: View {
    let pullRequest: InboxPullRequest
    /// What arrived since I last touched it, for my own pull requests. `nil`
    /// in the two reviewer lists, where the row's presence is the whole
    /// message.
    var news: InboxNews? = nil
    /// Whether the author's face and login are drawn. See the call site in
    /// `AuthoredList` for why they are not, there.
    var showsAuthor: Bool = true
    let avatars: AvatarStore
    /// Asks for a review of this pull request. Absent where there is nothing to
    /// ask — the row then behaves exactly as it did before this existed.
    var onReview: (() -> Void)? = nil

    var body: some View {
        Button {
            // Silently does nothing for a URL that is not a web page; see
            // `inboxOpenableURL` for why a server-supplied string is not
            // handed to `NSWorkspace` unchecked.
            if let url = inboxOpenableURL(pullRequest.url) {
                NSWorkspace.shared.open(url)
            }
        } label: {
            HStack(alignment: .top, spacing: 8) {
                if showsAuthor {
                    // Drawn for a null author too, as an empty circle. The
                    // space is held rather than collapsed so that one deleted
                    // account in a list does not shunt that one row's title
                    // left of every other.
                    AvatarBadge(author: pullRequest.author, avatars: avatars)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(pullRequest.title)
                        .font(.callout)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        if showsAuthor, let login = pullRequest.author?.login {
                            Text(login)
                                .font(.caption)
                            Text("·").font(.caption).foregroundStyle(.secondary)
                        }
                        Text(pullRequest.repository)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let summary = news?.summary {
                            Text("·").font(.caption).foregroundStyle(.secondary)
                            Text(summary).font(.caption)
                        }
                    }
                }
                Spacer(minLength: 6)
                // Absent when neither the decision nor the reviews came back.
                // Nothing at all, never a "0" — the panel's standing rule that
                // an unestablished number is shown as absent.
                if let mark = pullRequest.standing.mark {
                    StandingChip(mark: mark, prominent: showsAuthor == false)
                }
                if let onReview {
                    // Its own button, not the row's: the row opens the pull
                    // request in a browser, and asking for a review is a
                    // different thing that must not be reachable by aiming at
                    // the title and missing.
                    Button(action: onReview) {
                        Image(systemName: "text.magnifyingglass")
                    }
                    .buttonStyle(.borderless)
                    .help("Ask your agent to review this")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
        .help(pullRequest.url)
    }
}

/// The author's face, or their initials, or an empty circle.
///
/// The three states are drawn in the same 22-point circle so the row's layout
/// never shifts when an avatar arrives a second after the list opened. The
/// initials are not a placeholder that gets replaced by a spinner: they are
/// the final answer for every author whose avatar cannot be had, and the panel
/// is finished drawing the moment the list appears.
private struct AvatarBadge: View {
    let author: InboxAuthor?
    let avatars: AvatarStore

    @State private var image: NSImage?
    /// Filled in only when the fetch is known to have failed, and only so the
    /// tooltip can say what happened. This code's first contact with a real
    /// enterprise host is the first test of whether `gh api <absolute-url>`
    /// works there, and it should be able to report rather than just be blank.
    @State private var problem: String?

    private static let diameter: CGFloat = 22

    var body: some View {
        ZStack {
            Circle().fill(Color.secondary.opacity(0.18))
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
                    .clipShape(Circle())
            } else if let login = author?.login {
                Text(avatarInitials(for: login))
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: Self.diameter, height: Self.diameter)
        .help(helpText)
        // Keyed on the URL: a list re-render with the same author must not
        // restart the fetch, and a row reused for a different author must.
        // Cancelling this task on disappearance does not abandon a fetch in
        // progress — `AvatarStore` runs it in its own task and caches the
        // result, so navigating away mid-fetch still fills the cache.
        .task(id: author?.avatarURL) {
            guard let url = author?.avatarURL else { return }
            let bytes = await avatars.image(for: url)
            if let bytes, let decoded = NSImage(data: bytes) {
                image = decoded
                return
            }
            if let failure = await avatars.problem(for: url) {
                problem = failure.shortReason
            } else if bytes != nil {
                // Passed the signature check and still would not decode: a
                // truncated file. Named separately because it is the one
                // failure the store cannot see.
                problem = "the avatar image could not be decoded"
            }
        }
    }

    private var helpText: String {
        guard let login = author?.login else { return "the author's account no longer exists" }
        guard let problem else { return login }
        return "\(login) — \(problem)"
    }
}

/// Where the review stands, in one mark at the end of the row.
///
/// `rc` rather than "changes requested" spelled out: the row already carries a
/// title, a repository and sometimes a login, and the long form pushes the
/// title into a third line. The tooltip carries the words.
private struct StandingChip: View {
    let mark: StandingMark
    /// Larger and filled. Used in the list of my own pull requests, where the
    /// review state is the reason the row is worth looking at rather than one
    /// detail among several.
    var prominent: Bool = false

    var body: some View {
        Group {
            switch mark {
            case .changesRequested:
                label("rc", color: .red)
                    .help("changes requested")
            case .approvals(let count):
                // Zero is drawn, dimmed. This team needs three approvals to
                // merge, so "nobody yet" is a real answer to the question the
                // reader is asking and not the same as the mark being absent.
                label("\(count) ✓", color: count > 0 ? .green : .secondary)
                    .help(count == 1 ? "1 approval" : "\(count) approvals")
            }
        }
        .font(prominent ? .callout : .caption)
        .monospacedDigit()
    }

    private func label(_ text: String, color: Color) -> some View {
        Text(text)
            .fontWeight(.semibold)
            .foregroundStyle(color)
            .padding(.horizontal, prominent ? 7 : 5)
            .padding(.vertical, prominent ? 3 : 2)
            .background(
                Capsule().fill(color.opacity(prominent ? 0.18 : 0.12))
            )
            .fixedSize()
    }
}
