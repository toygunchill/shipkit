import CryptoKit
import Foundation

// Author avatars for the pull-request inbox.
//
// The whole file exists to answer one question safely: how do you put a face
// on a row without the panel ever waiting on a network it may not have?
//
// Three rules answer it, and none of them is optional:
//
//   1. The bytes come through `gh`, not through `URLSession`. `avatarUrl` on a
//      GitHub Enterprise install is served by that same enterprise host and
//      almost certainly wants the credentials `gh` already carries. A second
//      HTTP path here would mean a second place that has to learn about the
//      token, the host, the proxy and the enterprise certificate — so there
//      isn't one. `gh api` accepts an absolute URL and writes the response
//      body to stdout unchanged, which is exactly the seam `PullRequestInbox`
//      already uses.
//   2. Whatever arrives is written to disk. The inbox re-asks every five
//      minutes while the panel is open, and a refresh that re-downloaded eight
//      faces would be eight `gh` spawns for pixels that have not changed since
//      the person joined the company.
//   3. Anything that goes wrong renders as initials. Missing URL, failed
//      fetch, slow fetch, a body that is not an image — all of them are the
//      same outcome to the reader, a circle with two letters in it, and none
//      of them is allowed to be an empty hole or a spinner that never stops.
//
// As everywhere else in this package, nothing here reaches the network on its
// own: `run` is injected, every test feeds it bytes, and the first contact
// with the real enterprise server is the first real test. That is why the
// failures below carry sentences — see `problem(for:)`.

/// Why one avatar could not be shown. Kept per URL for the session so the row
/// can put it in a tooltip: this code's first run against a real enterprise
/// host is the one that finds out whether `gh api <absolute-url>` behaves as
/// documented, and it should be able to say so rather than fail mutely.
public enum AvatarFailure: Equatable, Sendable {
    /// The string was not an `https`/`http` URL. Refused before it is handed
    /// to `gh`, because this string comes from a server response and an argv
    /// element beginning with `-` is a flag, not a URL.
    case unusableURL
    /// `gh` ran and did not produce the bytes.
    case fetchFailed(String)
    /// `gh` succeeded and returned something that is not an image — most
    /// likely a JSON error body, which is what an enterprise host answers a
    /// request it does not like. Refused rather than cached: caching it would
    /// make one bad answer permanent for a fortnight.
    case notAnImage(bytes: Int)

    public var shortReason: String {
        switch self {
        case .unusableURL:
            return "the avatar address was not a web URL"
        case .fetchFailed(let detail):
            return "the avatar could not be fetched: \(detail)"
        case .notAnImage(let bytes):
            return "the avatar address returned \(bytes) bytes that are not an image"
        }
    }
}

/// The letters drawn in place of a face.
///
/// One letter per name-part for a login that has parts (`taylor-chen` → `TC`),
/// the first two letters otherwise (`octocat` → `OC`). Two letters rather than
/// one because a review queue is mostly the same handful of people and a
/// single initial collides constantly.
///
/// Non-letters are skipped rather than drawn: a login like `_bot.7` should
/// produce `B`, not `_.`.
public func avatarInitials(for login: String) -> String {
    let parts = login
        .split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == "." || $0 == " " })
        .map(String.init)
        .filter { $0.contains(where: \.isLetter) }
    if parts.count >= 2 {
        let letters = parts.prefix(2).compactMap { $0.first(where: \.isLetter) }
        return String(letters).uppercased()
    }
    guard let only = parts.first else { return "?" }
    return String(only.filter(\.isLetter).prefix(2)).uppercased()
}

/// The arguments that fetch one avatar. `gh api` with an absolute URL: it uses
/// the URL as given rather than joining it onto the host's REST prefix, and it
/// still attaches the host's credentials.
public func avatarArguments(url: String) -> [String] {
    ["api", url]
}

/// Whether the bytes are an image, by signature.
///
/// A whitelist, for the same reason the review-state switches are whitelists:
/// an unrecognised body is not affirmative evidence of an image. The specific
/// body this exists to reject is a JSON error object, which is perfectly valid
/// UTF-8 and would be cached forever if the only check were "did `gh` exit
/// zero".
public func looksLikeImage(_ data: Data) -> Bool {
    let bytes = [UInt8](data.prefix(12))
    guard bytes.count >= 4 else { return false }
    // PNG
    if bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return true }
    // JPEG
    if bytes.starts(with: [0xFF, 0xD8, 0xFF]) { return true }
    // GIF87a / GIF89a
    if bytes.starts(with: Array("GIF8".utf8)) { return true }
    // RIFF....WEBP
    if bytes.count >= 12,
       bytes.starts(with: Array("RIFF".utf8)),
       Array(bytes[8..<12]) == Array("WEBP".utf8) { return true }
    return false
}

/// Fetches, caches and hands back author avatars.
///
/// An actor because the three pieces of state below are read and written from
/// as many concurrent row `task`s as the list has rows, and every one of them
/// is there to stop work from happening twice.
public actor AvatarStore {
    /// The same shape `PullRequestInbox` takes, on purpose: one seam for
    /// everything that shells out, one place to stub in a test.
    public typealias Run = @Sendable ([String]) async -> Result<Data, GhFailure>

    private let run: Run
    private let directory: URL
    private let maximumAge: TimeInterval
    private let maximumConcurrentFetches: Int

    /// Decoded-once bytes, so re-rendering a list is not a disk read per row.
    private var memory: [String: Data] = [:]
    /// One task per URL in flight. Eight rows by the same author are one
    /// fetch, not eight.
    private var inFlight: [String: Task<Data?, Never>] = [:]
    /// URLs that failed this session, with why. Never retried until the app
    /// restarts: a URL that 404s does not start existing, and retrying it once
    /// per row per five-minute refresh is an unbounded number of `gh` spawns
    /// producing nothing.
    private var failures: [String: AvatarFailure] = [:]

    private var activeFetches = 0
    private var waitingForSlot: [CheckedContinuation<Void, Never>] = []

    /// A fortnight. The trade is one-sided: a stale avatar is somebody's old
    /// photograph, which costs nothing, while a short TTL costs a `gh` spawn
    /// per face per expiry on a panel whose whole job is to be cheap enough to
    /// leave open.
    public static let defaultMaximumAge: TimeInterval = 60 * 60 * 24 * 14

    /// Three at a time. The list draws at most `inboxListLimit` rows, so an
    /// uncapped store would spawn ten `gh` processes the instant a list opens
    /// — on top of the two the refresh itself spawns. Three keeps the first
    /// faces arriving quickly while the rest queue behind them, and the rows
    /// that are still waiting are already drawing their initials.
    public static let defaultConcurrency = 3

    public init(
        run: @escaping Run,
        directory: URL = AvatarStore.defaultDirectory(),
        maximumAge: TimeInterval = AvatarStore.defaultMaximumAge,
        maximumConcurrentFetches: Int = AvatarStore.defaultConcurrency
    ) {
        self.run = run
        self.directory = directory
        self.maximumAge = maximumAge
        self.maximumConcurrentFetches = max(1, maximumConcurrentFetches)
    }

    /// Bound to a real `gh`, with a shorter deadline than the inbox query's.
    /// An avatar is decoration: if it has not arrived in this long the row has
    /// been showing initials for a while and will go on doing so, and holding
    /// one of three slots open past that only delays the faces behind it.
    public static func live(timeoutSeconds: Double = 8) -> AvatarStore {
        AvatarStore(run: GhCommand.live(timeoutSeconds: timeoutSeconds))
    }

    /// `~/Library/Caches/shipkit/avatars`. Caches rather than Application
    /// Support because every byte in it is re-derivable from the server, which
    /// is the exact distinction the directory means — and it lets the system
    /// reclaim the space without breaking anything.
    public static func defaultDirectory() -> URL {
        let base = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)
            .first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Caches")
        return base
            .appendingPathComponent("shipkit", isDirectory: true)
            .appendingPathComponent("avatars", isDirectory: true)
    }

    /// Query parameters that authorise a fetch rather than identify an image.
    ///
    /// Measured against the real host: avatar URLs come back signed, as
    /// `…/avatars/u/1274872?token=MTc4OTY1MTQyNS4wMDI0OTM…`. The token rotates,
    /// so keying on it re-fetched every face on a refresh that was supposed to
    /// be free and orphaned the previous copy forever.
    private static let credentialParameters: Set<String> = ["token", "jwt", "signature", "sig", "x-amz-signature"]

    /// The cache file's name: a SHA-256 of the URL *without its query string*, hex.
    ///
    /// Hashed rather than escaped because the URL carries `/`, `?` and `&`,
    /// any of which would either create directories or be dropped by a naive
    /// sanitiser — and two URLs that sanitise to the same name would serve
    /// each other's faces. A hash cannot collide by accident and cannot
    /// escape the directory.
    ///
    /// The signing token is dropped — see `credentialParameters`. What is left
    /// identifies the image: the path says who, and a size parameter says which
    /// rendering of them.
    public static func cacheFileName(for url: String) -> String {
        let identity = URLComponents(string: url).flatMap { parts -> String? in
            var stable = parts
            stable.fragment = nil
            // Only the credential is dropped, not the whole query: `?s=80` and
            // `?s=81` are different images and must stay different files, which
            // an existing test pins. Sorted so the same parameters in a
            // different order still land on one file.
            let kept = (parts.queryItems ?? [])
                .filter { credentialParameters.contains($0.name.lowercased()) == false }
                .sorted { $0.name < $1.name }
            stable.queryItems = kept.isEmpty ? nil : kept
            return stable.string
        } ?? url
        return SHA256.hash(data: Data(identity.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    /// Why this URL has no avatar, if it is known to have failed. `nil` while
    /// it is merely absent or still arriving — the two are the same to the
    /// row, which draws initials either way, but they are not the same to
    /// someone reading a tooltip to find out whether `gh api` on an absolute
    /// URL works against their server.
    public func problem(for url: String) -> AvatarFailure? {
        failures[url]
    }

    /// The image bytes for one avatar URL, or `nil`.
    ///
    /// `nil` is an ordinary answer, not an error: the caller's job on `nil` is
    /// to draw initials. The call may suspend — on disk, on a concurrency
    /// slot, on `gh` — but it never blocks a thread and it always returns.
    public func image(for url: String) async -> Data? {
        if let cached = memory[url] { return cached }
        if failures[url] != nil { return nil }

        // A server-supplied string, so it is checked before it becomes argv.
        // Restricted to http/https for the same reason `inboxOpenableURL` is,
        // plus one that is specific to a subprocess: an argument beginning
        // with `-` is read by `gh` as a flag, and this refusal is what makes
        // that unreachable.
        guard let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            failures[url] = .unusableURL
            return nil
        }

        if let existing = inFlight[url] { return await existing.value }

        let task = Task<Data?, Never> { [weak self] in
            guard let self else { return nil }
            return await self.produce(url)
        }
        inFlight[url] = task
        let bytes = await task.value
        inFlight[url] = nil
        return bytes
    }

    /// Disk first, then `gh`. Split out of `image(for:)` so the in-flight
    /// entry is installed before anything suspends — otherwise two rows by the
    /// same author both find the table empty and both fetch.
    private func produce(_ url: String) async -> Data? {
        let file = directory.appendingPathComponent(Self.cacheFileName(for: url))
        if let onDisk = await Self.readCache(file, maximumAge: maximumAge) {
            remember(url, onDisk)
            return onDisk
        }

        await acquireSlot()
        defer { releaseSlot() }

        let result = await run(avatarArguments(url: url))
        switch result {
        case .failure(let failure):
            failures[url] = .fetchFailed(failure.shortReason)
            return nil
        case .success(let data):
            guard looksLikeImage(data) else {
                failures[url] = .notAnImage(bytes: data.count)
                return nil
            }
            remember(url, data)
            await Self.writeCache(file, data: data)
            return data
        }
    }

    /// Keeps the in-memory copy bounded. The real bound is the number of
    /// distinct authors a person sees in a session, which is small; this is
    /// only here so that "small" is a property of the code rather than an
    /// assumption about the team.
    private func remember(_ url: String, _ data: Data) {
        if memory.count >= 64, let victim = memory.keys.first { memory[victim] = nil }
        memory[url] = data
    }

    /// Waits for one of `maximumConcurrentFetches` slots. Counted before the
    /// suspension and handed over on release rather than decremented, so a
    /// waiter is resumed into a slot that was never free for anyone else to
    /// take.
    private func acquireSlot() async {
        if activeFetches < maximumConcurrentFetches {
            activeFetches += 1
            return
        }
        await withCheckedContinuation { continuation in
            waitingForSlot.append(continuation)
        }
    }

    private func releaseSlot() {
        if waitingForSlot.isEmpty {
            activeFetches -= 1
        } else {
            waitingForSlot.removeFirst().resume()
        }
    }

    // MARK: - Disk

    /// Off the cooperative pool, the same reason `GhCommand.run` hops: that
    /// pool has one thread per core and is never overcommitted, so a
    /// synchronous file read on it stalls every other `await` in the process.
    /// The files are a few kilobytes each and usually in the page cache, but
    /// "usually" is not a scheduling guarantee and a cold or network home
    /// directory is exactly when the panel must stay responsive.
    private static func readCache(_ file: URL, maximumAge: TimeInterval) async -> Data? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: readCacheBlocking(file, maximumAge))
            }
        }
    }

    private static func readCacheBlocking(_ file: URL, _ maximumAge: TimeInterval) -> Data? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
              let modified = attributes[.modificationDate] as? Date
        else { return nil }
        guard Date().timeIntervalSince(modified) < maximumAge else { return nil }
        guard let data = try? Data(contentsOf: file), looksLikeImage(data) else { return nil }
        return data
    }

    private static func writeCache(_ file: URL, data: Data) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                // Every failure here is ignored on purpose. A cache that
                // cannot be written is a slower panel, not a broken one, and
                // there is nothing a person could do about a read-only Caches
                // directory that is worth a line on a pull-request list.
                try? FileManager.default.createDirectory(
                    at: file.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try? data.write(to: file, options: .atomic)
                continuation.resume()
            }
        }
    }
}
