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
                inbox
            case .list(let bucket):
                // My own pull requests list differently from the other two:
                // all of them, not only the ones with news, each with what
                // arrived. See `InboxSnapshot.count`.
                if bucket == .myPullRequests {
                    AuthoredList(pullRequests: model.inbox?.mine ?? []) { route = .inbox }
                } else {
                    InboxList(
                        bucket: bucket,
                        pullRequests: model.inbox?.list(bucket) ?? []
                    ) { route = .inbox }
                }
            case .token:
                SettingsPane(model: model) { route = .inbox }
            }
        }
        .onAppear { model.inboxAppeared() }
        .onDisappear { model.inboxDisappeared() }
    }

    private var inbox: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Pull requests").font(.headline)
                Spacer()
                if model.inboxRefreshing {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Button {
                        model.refreshInbox()
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
            if let reason = model.inbox?.reason {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            Divider()

            Button("Add/Edit Jira Token") { route = .token }
                .buttonStyle(.link)

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
    let back: () -> Void

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

            VStack(alignment: .leading, spacing: 0) {
                ForEach(preview.shown) { pullRequest in
                    if pullRequest.id != preview.shown.first?.id { Divider() }
                    PullRequestRow(pullRequest: pullRequest)
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
    let back: () -> Void

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

            VStack(alignment: .leading, spacing: 0) {
                ForEach(preview.shown) { entry in
                    if entry.id != preview.shown.first?.id { Divider() }
                    PullRequestRow(pullRequest: entry.pullRequest, news: entry.news)
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

    var body: some View {
        Button {
            // Silently does nothing for a URL that is not a web page; see
            // `inboxOpenableURL` for why a server-supplied string is not
            // handed to `NSWorkspace` unchecked.
            if let url = inboxOpenableURL(pullRequest.url) {
                NSWorkspace.shared.open(url)
            }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(pullRequest.title)
                    .font(.callout)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Text(pullRequest.repository)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let summary = news?.summary {
                        Text("·").font(.caption).foregroundStyle(.secondary)
                        Text(summary).font(.caption)
                    }
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
