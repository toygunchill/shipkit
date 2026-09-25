import Foundation
import Testing
@testable import ShipkitKit

@Suite("Leaving a review request where an agent will find it")
struct RequestedReviewTests {
    private func scratch() -> URL {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("shipkit-requested-\(UUID().uuidString)", isDirectory: true)
        return directory.appendingPathComponent("requested-review.json", isDirectory: false)
    }

    @Test func whatIsWrittenIsWhatComesBack() throws {
        let at = scratch()
        let review = RequestedReview(
            repository: "acme/widget",
            number: 12,
            title: "fix: something",
            url: "https://example.com/acme/widget/pull/12",
            requestedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )

        try RequestedReviewStore.write(review, to: at)

        let read = RequestedReviewStore.read(from: at)
        #expect(read == review)
    }

    @Test func itCreatesTheDirectoryRatherThanFailing() throws {
        let at = scratch()

        try RequestedReviewStore.write(
            RequestedReview(repository: "a/b", number: 1, title: "t", url: "u"),
            to: at
        )

        #expect(FileManager.default.fileExists(atPath: at.path))
    }

    // It names a repository and a pull request, which on a private forge is not
    // everybody's business.
    @Test func itIsReadableOnlyByItsOwner() throws {
        let at = scratch()

        try RequestedReviewStore.write(
            RequestedReview(repository: "a/b", number: 1, title: "t", url: "u"),
            to: at
        )

        let mode = try FileManager.default.attributesOfItem(atPath: at.path)[.posixPermissions] as? NSNumber
        #expect(mode?.int16Value == 0o600)
    }

    // Replacing, not queueing. A queue means a press answered minutes later on a
    // pull request the person has stopped thinking about — and what is being
    // asked for ends in comments published under their name.
    @Test func asecondRequestReplacesTheFirst() throws {
        let at = scratch()
        try RequestedReviewStore.write(RequestedReview(repository: "a/b", number: 1, title: "old", url: "u"), to: at)

        try RequestedReviewStore.write(RequestedReview(repository: "a/b", number: 2, title: "new", url: "u"), to: at)

        #expect(RequestedReviewStore.read(from: at)?.number == 2)
    }

    @Test func nothingPendingReadsAsNothingRatherThanThrowing() {
        #expect(RequestedReviewStore.read(from: scratch()) == nil)
    }

    @Test func clearingRemovesIt() throws {
        let at = scratch()
        try RequestedReviewStore.write(RequestedReview(repository: "a/b", number: 1, title: "t", url: "u"), to: at)

        RequestedReviewStore.clear(at: at)

        #expect(RequestedReviewStore.read(from: at) == nil)
    }

    @Test func garbageInTheFileReadsAsNothingPending() throws {
        let at = scratch()
        try FileManager.default.createDirectory(
            at: at.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("not json".utf8).write(to: at)

        #expect(RequestedReviewStore.read(from: at) == nil)
    }

    // Built here rather than in the view, so the two paths — hand it to an agent,
    // or tell the person how to start one — cannot drift into asking for
    // different things.
    @Test func theFallbackCommandNamesThePullRequestAndTheRepository() {
        let command = RequestedReviewStore.command(repository: "acme/widget", number: 943)

        #expect(command.contains("--pr 943"))
        #expect(command.contains("--repo-slug acme/widget"))
        #expect(command.hasPrefix("shipkit pr-review"))
    }

    @Test func anEnterpriseForgeKeepsItsHostInTheSlug() {
        let command = RequestedReviewStore.command(repository: "git.example.com/acme/widget", number: 1)

        #expect(command.contains("git.example.com/acme/widget"))
    }

    @Test func theDefaultPathSitsBesideTheApplicationsOtherState() {
        let url = RequestedReviewStore.defaultURL(home: URL(fileURLWithPath: "/Users/someone"))

        #expect(url.path == "/Users/someone/Library/Application Support/shipkit/requested-review.json")
    }
}

@Suite("Reading a pull request number from its URL")
struct InboxPullRequestNumberTests {
    @Test func itReadsAnOrdinaryPullRequestURL() {
        #expect(inboxPullRequestNumber("https://github.com/acme/widget/pull/943") == 943)
    }

    @Test func itReadsAnEnterpriseURL() {
        #expect(inboxPullRequestNumber("https://git.example.com/acme/widget/pull/12") == 12)
    }

    // A link to a comment ends in digits too, and those digits are not the pull
    // request. Commenting on the wrong pull request is the mistake this prevents.
    @Test func itRefusesAnythingThatIsNotThePullRequestItself() {
        #expect(inboxPullRequestNumber("https://github.com/acme/widget/pull/943/files") == nil)
        #expect(inboxPullRequestNumber("https://github.com/acme/widget/issues/943") == nil)
        #expect(inboxPullRequestNumber("https://github.com/acme/widget/tree/release-2026") == nil)
        #expect(inboxPullRequestNumber("https://github.com/acme/widget/commit/1234") == nil)
    }

    @Test func itRefusesNonsense() {
        #expect(inboxPullRequestNumber("") == nil)
        #expect(inboxPullRequestNumber("not a url at all") == nil)
        #expect(inboxPullRequestNumber("https://github.com/acme/widget/pull/abc") == nil)
        #expect(inboxPullRequestNumber("https://github.com/acme/widget/pull/0") == nil)
        #expect(inboxPullRequestNumber("https://github.com/acme/widget/pull/-1") == nil)
    }
}

@Suite("Naming the repository a pull request lives in")
struct InboxRepositorySlugTests {
    @Test func githubNeedsNoHost() {
        #expect(inboxRepositorySlug("https://github.com/acme/widget/pull/1") == "acme/widget")
    }

    // The bug this exists for: the inbox carries `owner/name` only, and on an
    // enterprise forge that sends gh to whichever host it saw last.
    @Test func anEnterpriseForgeKeepsItsHost() {
        #expect(
            inboxRepositorySlug("https://git.example.com/ACME/widget/pull/977")
                == "git.example.com/ACME/widget"
        )
    }

    @Test func itRefusesAUrlWithNoRepositoryInIt() {
        #expect(inboxRepositorySlug("https://github.com/acme") == nil)
        #expect(inboxRepositorySlug("not a url") == nil)
        #expect(inboxRepositorySlug("") == nil)
    }
}
