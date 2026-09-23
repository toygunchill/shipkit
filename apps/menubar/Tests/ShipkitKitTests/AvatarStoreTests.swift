import Foundation
import Testing
@testable import ShipkitKit

// Every fixture below is synthesized, not captured from a live server — the
// only authenticated host available is a company GitHub Enterprise server and
// it is out of bounds, the same rule `tests/fixtures/forge/` states on the
// Node side and the same one the inbox fixtures state. The avatar bytes are a
// real 1×1 PNG so that the signature check is exercised against a genuine
// file header rather than a hand-written one; the *URLs* are invented. Do not
// over-trust these shapes: they say what the code does with a response, not
// what the server actually sends.
//
// Nothing here spawns `gh`, opens a socket, or fetches an image. `run` is the
// injected seam and every test writes the bytes it hands back.

// MARK: - Fixtures

/// A 1×1 transparent PNG: 70 bytes, beginning with the eight-byte PNG
/// signature.
private let onePixelPNG = Data(base64Encoded: """
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6\
kgAAAABJRU5ErkJggg==
""")!

/// What an enterprise host answers a request it does not like, and the body
/// this must never write into the cache.
private let jsonError = Data(#"{"message":"Not Found","status":"404"}"#.utf8)

/// A directory of its own per test, removed afterwards, so nothing here can
/// read or write the real `~/Library/Caches/shipkit/avatars`.
private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory
        .appendingPathComponent("shipkit-avatar-tests", isDirectory: true)
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
}

private func removing(_ directory: URL) {
    try? FileManager.default.removeItem(at: directory)
}

/// Counts calls and records how many were in flight at once. An actor because
/// the whole point of some of these tests is that the calls overlap.
private actor CallLog {
    private(set) var arguments: [[String]] = []
    private(set) var active = 0
    private(set) var peak = 0

    func began(_ arguments: [String]) {
        self.arguments.append(arguments)
        active += 1
        peak = max(peak, active)
    }

    func ended() {
        active -= 1
    }

    var count: Int { arguments.count }
}

// MARK: - Initials

@Test func initialsComeFromTheLoginsParts() {
    #expect(avatarInitials(for: "taylor-chen") == "TC")
    #expect(avatarInitials(for: "taylor_chen") == "TC")
    #expect(avatarInitials(for: "taylor.chen") == "TC")
    #expect(avatarInitials(for: "octocat") == "OC")
    #expect(avatarInitials(for: "a") == "A")
    // Non-letters are skipped rather than drawn: `_bot.7` is a B, not an `_.`,
    // and a login that leads with digits shows the letters that follow them
    // rather than the digits. (Added after a mutation run: without this line
    // the letter filter inside the single-part branch was not exercised by
    // anything and could be deleted with every test still green.)
    #expect(avatarInitials(for: "_bot.7") == "BO")
    #expect(avatarInitials(for: "0xdeadbeef") == "XD")
    #expect(avatarInitials(for: "007-bond") == "BO")
    #expect(avatarInitials(for: "dependabot[bot]") == "DE")
    // Nothing to draw at all still produces something — never an empty circle.
    #expect(avatarInitials(for: "") == "?")
    #expect(avatarInitials(for: "123") == "?")
}

// MARK: - What counts as an image

@Test func recognisesTheImageFormatsAndRefusesEverythingElse() {
    #expect(looksLikeImage(onePixelPNG))
    #expect(looksLikeImage(Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])))
    #expect(looksLikeImage(Data("GIF89a".utf8)))
    #expect(looksLikeImage(Data("RIFF\u{0}\u{0}\u{0}\u{0}WEBP".utf8)))

    // The body this check exists for.
    #expect(looksLikeImage(jsonError) == false)
    #expect(looksLikeImage(Data("<html><body>Sign in</body></html>".utf8)) == false)
    #expect(looksLikeImage(Data()) == false)
    #expect(looksLikeImage(Data([0x89, 0x50])) == false)
}

// MARK: - The fetch

@Test func fetchesThroughGhWithTheAbsoluteUrlAndHandsBackTheBytes() async {
    let directory = temporaryDirectory()
    defer { removing(directory) }
    let log = CallLog()
    let store = AvatarStore(
        run: { arguments in
            await log.began(arguments)
            await log.ended()
            return .success(onePixelPNG)
        },
        directory: directory
    )

    let bytes = await store.image(for: "https://ghe.example.test/avatars/u/9?s=80")

    #expect(bytes == onePixelPNG)
    // `gh api <absolute-url>` — the same seam the inbox query goes through, so
    // the avatar inherits whatever credentials, proxy and certificate `gh` is
    // already configured with. No second HTTP path.
    #expect(await log.arguments == [["api", "https://ghe.example.test/avatars/u/9?s=80"]])
}

@Test func writesTheAvatarToTheCacheDirectoryUnderAHashOfItsUrl() async {
    let directory = temporaryDirectory()
    defer { removing(directory) }
    let url = "https://ghe.example.test/avatars/u/9"
    let store = AvatarStore(run: { _ in .success(onePixelPNG) }, directory: directory)

    _ = await store.image(for: url)

    let file = directory.appendingPathComponent(AvatarStore.cacheFileName(for: url))
    #expect(FileManager.default.fileExists(atPath: file.path))
    #expect((try? Data(contentsOf: file)) == onePixelPNG)
}

@Test func aLaterRefreshReadsTheFaceFromDiskInsteadOfFetchingItAgain() async {
    // The hard requirement: the panel re-asks every five minutes while it is
    // open, and a refresh must not re-fetch faces. A *second store* over the
    // same directory is the honest test — sharing one instance would only
    // prove the in-memory table works.
    let directory = temporaryDirectory()
    defer { removing(directory) }
    let url = "https://ghe.example.test/avatars/u/9"
    let first = AvatarStore(run: { _ in .success(onePixelPNG) }, directory: directory)
    _ = await first.image(for: url)

    let log = CallLog()
    let second = AvatarStore(
        run: { arguments in
            await log.began(arguments)
            await log.ended()
            return .success(onePixelPNG)
        },
        directory: directory
    )
    let bytes = await second.image(for: url)

    #expect(bytes == onePixelPNG)
    #expect(await log.count == 0)
}

@Test func ignoresACachedFaceOlderThanItsTimeToLive() async {
    let directory = temporaryDirectory()
    defer { removing(directory) }
    let url = "https://ghe.example.test/avatars/u/9"
    let file = directory.appendingPathComponent(AvatarStore.cacheFileName(for: url))
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try? onePixelPNG.write(to: file)
    try? FileManager.default.setAttributes(
        [.modificationDate: Date(timeIntervalSinceNow: -3600)],
        ofItemAtPath: file.path
    )

    let log = CallLog()
    let store = AvatarStore(
        run: { arguments in
            await log.began(arguments)
            await log.ended()
            return .success(onePixelPNG)
        },
        directory: directory,
        maximumAge: 60
    )
    _ = await store.image(for: url)

    #expect(await log.count == 1)
}

// MARK: - Failing honestly

@Test func aFailedFetchRendersAsNothingAndIsNotAttemptedAgainThisSession() async {
    // Not retried, and the reason is kept. A URL that 404s does not start
    // existing, and retrying it once per row per five-minute refresh is an
    // unbounded number of `gh` spawns producing nothing.
    let directory = temporaryDirectory()
    defer { removing(directory) }
    let log = CallLog()
    let store = AvatarStore(
        run: { arguments in
            await log.began(arguments)
            await log.ended()
            return .failure(.failed(exitCode: 1, message: "HTTP 404: Not Found"))
        },
        directory: directory
    )
    let url = "https://ghe.example.test/avatars/u/9"

    #expect(await store.image(for: url) == nil)
    #expect(await store.image(for: url) == nil)

    #expect(await log.count == 1)
    #expect(await store.problem(for: url) == .fetchFailed("gh exited 1: HTTP 404: Not Found"))
}

@Test func aBodyThatIsNotAnImageIsRefusedAndNeverCached() async {
    // `gh` exiting zero is not proof of an image. Caching a JSON error body
    // would make one bad answer permanent for a fortnight.
    let directory = temporaryDirectory()
    defer { removing(directory) }
    let url = "https://ghe.example.test/avatars/u/9"
    let store = AvatarStore(run: { _ in .success(jsonError) }, directory: directory)

    #expect(await store.image(for: url) == nil)

    let file = directory.appendingPathComponent(AvatarStore.cacheFileName(for: url))
    #expect(FileManager.default.fileExists(atPath: file.path) == false)
    #expect(await store.problem(for: url) == .notAnImage(bytes: jsonError.count))
}

@Test func refusesAnAddressThatIsNotAWebUrlWithoutEverRunningGh() async {
    // `avatarUrl` is a server-supplied string that becomes an argv element. An
    // argument beginning with `-` is read by `gh` as a flag, and a `file:` URL
    // is not something a pull-request list should be reading.
    let directory = temporaryDirectory()
    defer { removing(directory) }
    let log = CallLog()
    let store = AvatarStore(
        run: { arguments in
            await log.began(arguments)
            await log.ended()
            return .success(onePixelPNG)
        },
        directory: directory
    )

    for address in ["--version", "file:///etc/passwd", "", "ftp://example.test/a.png"] {
        #expect(await store.image(for: address) == nil)
        #expect(await store.problem(for: address) == .unusableURL)
    }
    #expect(await log.count == 0)
}

// MARK: - Bounded work

@Test func eightRowsByTheSameAuthorAreOneFetch() async {
    let directory = temporaryDirectory()
    defer { removing(directory) }
    let log = CallLog()
    let store = AvatarStore(
        run: { arguments in
            await log.began(arguments)
            try? await Task.sleep(for: .milliseconds(30))
            await log.ended()
            return .success(onePixelPNG)
        },
        directory: directory
    )
    let url = "https://ghe.example.test/avatars/u/9"

    await withTaskGroup(of: Data?.self) { group in
        for _ in 0..<8 { group.addTask { await store.image(for: url) } }
        for await bytes in group { #expect(bytes == onePixelPNG) }
    }

    #expect(await log.count == 1)
}

@Test func neverRunsMoreFetchesAtOnceThanTheCapAllows() async {
    // A list can hold `inboxListLimit` rows. Uncapped, opening one would spawn
    // that many `gh` processes at once on top of the two the refresh itself
    // spawns — while the rows that are waiting are already drawing initials
    // and losing nothing by waiting.
    let directory = temporaryDirectory()
    defer { removing(directory) }
    let log = CallLog()
    let store = AvatarStore(
        run: { arguments in
            await log.began(arguments)
            try? await Task.sleep(for: .milliseconds(40))
            await log.ended()
            return .success(onePixelPNG)
        },
        directory: directory,
        maximumConcurrentFetches: 3
    )

    await withTaskGroup(of: Void.self) { group in
        for index in 0..<10 {
            group.addTask { _ = await store.image(for: "https://ghe.example.test/avatars/u/\(index)") }
        }
    }

    // Every one of them still gets its face: the cap queues, it does not drop.
    #expect(await log.count == 10)
    #expect(await log.peak <= 3)
    // And it really is running them in parallel, not one at a time by
    // accident, which is what would make the cap meaningless in the other
    // direction.
    #expect(await log.peak >= 2)
}

@Test func aCapOfOneRunsThemStrictlyOneAtATime() async {
    let directory = temporaryDirectory()
    defer { removing(directory) }
    let log = CallLog()
    let store = AvatarStore(
        run: { arguments in
            await log.began(arguments)
            try? await Task.sleep(for: .milliseconds(10))
            await log.ended()
            return .success(onePixelPNG)
        },
        directory: directory,
        maximumConcurrentFetches: 1
    )

    await withTaskGroup(of: Void.self) { group in
        for index in 0..<6 {
            group.addTask { _ = await store.image(for: "https://ghe.example.test/avatars/u/\(index)") }
        }
    }

    #expect(await log.count == 6)
    #expect(await log.peak == 1)
}

// MARK: - The cache key

@Test func theCacheFileNameIsAHashThatCannotEscapeTheDirectory() {
    let name = AvatarStore.cacheFileName(for: "https://ghe.example.test/avatars/u/9?s=80&v=4")

    #expect(name.count == 64)
    #expect(name.allSatisfy { $0.isHexDigit })
    // The two properties that matter: it is stable, and two URLs that a naive
    // sanitiser would flatten together stay apart.
    #expect(name == AvatarStore.cacheFileName(for: "https://ghe.example.test/avatars/u/9?s=80&v=4"))
    #expect(name != AvatarStore.cacheFileName(for: "https://ghe.example.test/avatars/u/9?s=81&v=4"))
    #expect(AvatarStore.cacheFileName(for: "https://a/../../b").contains("/") == false)
}

@Test func theCacheLivesUnderLibraryCachesShipkitAvatars() {
    let path = AvatarStore.defaultDirectory().path

    #expect(path.hasSuffix("/Library/Caches/shipkit/avatars"))
}

@Test func aRotatingTokenDoesNotChangeTheCacheKey() {
    // Measured against the real host: avatar URLs are signed and carry an
    // expiring token, so the same face arrives under a different URL on every
    // refresh. Keying on the whole string re-downloaded every avatar each time
    // and orphaned the previous copy — the cache existed but never hit.
    let first = "https://git.example.com/avatars/u/4321?token=MTc4OTY1MTQyNS4wMDI0OTM"
    let later = "https://git.example.com/avatars/u/4321?token=OTk5OTk5OTk5OS5aWlpaWlo"
    #expect(AvatarStore.cacheFileName(for: first) == AvatarStore.cacheFileName(for: later))

    // Two different people must still never share a file.
    let other = "https://git.example.com/avatars/u/999?token=MTc4OTY1MTQyNS4wMDI0OTM"
    #expect(AvatarStore.cacheFileName(for: first) != AvatarStore.cacheFileName(for: other))

    // And only the credential is dropped: a size parameter still identifies a
    // different image, which `theCacheFileNameIsAHashThatCannotEscapeTheDirectory`
    // caught when a first attempt at this dropped the whole query string.
    let small = "https://git.example.com/avatars/u/4321?s=80&token=AAA"
    let large = "https://git.example.com/avatars/u/4321?s=200&token=AAA"
    #expect(AvatarStore.cacheFileName(for: small) != AvatarStore.cacheFileName(for: large))
    // Parameter order is not identity.
    let reordered = "https://git.example.com/avatars/u/4321?token=BBB&s=80"
    #expect(AvatarStore.cacheFileName(for: small) == AvatarStore.cacheFileName(for: reordered))
}
