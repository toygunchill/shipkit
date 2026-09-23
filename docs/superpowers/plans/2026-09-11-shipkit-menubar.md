# Approval surface, the menu-bar application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS menu-bar application that receives shipkit's refusal, renders the pre-flight warnings, and returns a decision the agent cannot fabricate.

**Architecture:** A SwiftPM package with a testable library and a thin executable. The library holds the fingerprint, the Keychain, the decision journal and the socket listener; the executable is a `MenuBarExtra` that renders them. A script assembles the `.app`, the same way `scripts/icons.sh` assembles the icon — nothing hand-built lives in the repository.

**Tech Stack:** Swift 6.2, SwiftPM, SwiftUI `MenuBarExtra`, CryptoKit, Security.framework, POSIX sockets with GCD.

**Spec:** `docs/superpowers/specs/2026-09-11-shipkit-approval-design.md`

**The other half is already merged.** `src/approval/` is the Node client this application answers, and `tests/fixtures/fingerprint-vectors.json` is the contract between them. Read both.

## Global Constraints

- Swift 6.2, macOS 14 deployment target. The package builds with `swift build` and tests with `swift test`; no Xcode project.
- `npm test` must not invoke `swift`, and `swift test` must not invoke `npm`. Neither suite's failure may hide inside the other.
- **The fingerprint must match `tests/fixtures/fingerprint-vectors.json` byte for byte.** It is the one place a silent cross-language disagreement would be invisible until someone tried to approve something.
- **Nothing is remembered beyond one fingerprint for ten minutes.** No "approve all", no per-repository trust, no allowlist. A consent surface with a remember-me checkbox has stopped being one.
- The socket lives at `~/Library/Application Support/shipkit/approvals.sock` in a directory created `0700`, and is `chmod`ed to `0600` **after** binding — measured: a freshly bound socket comes out `0755`.
- **Never run `shipkit submit`, `node dist/cli.js mcp`, or any MCP tool against this repository.** It holds real work.
- No test may write to the real login Keychain without deleting what it wrote, and none may bind a socket outside a temporary directory.
- Touch only this repository. Never `acme/example-app` or any pull request.
- Baseline: 371 Node tests passing, `npm run check` clean. Both must still hold at the end of every task — this plan adds a Swift suite beside them, it does not disturb them.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/menubar/Package.swift` | Two targets: `ShipkitKit` (library) and `ShipkitMenuBar` (executable) | 1 |
| `apps/menubar/Sources/ShipkitKit/Protocol.swift` | The request and response types, and their JSON coding | 1 |
| `scripts/app.sh` | Build the executable and assemble `shipkit.app` around it | 1 |
| `apps/menubar/Sources/ShipkitKit/Fingerprint.swift` | The canonical form and its hash | 2 |
| `apps/menubar/Sources/ShipkitKit/Keychain.swift` | Read, write and delete the Jira token | 3 |
| `apps/menubar/Sources/ShipkitKit/Journal.swift` | One decision per fingerprint, for ten minutes | 4 |
| `apps/menubar/Sources/ShipkitKit/Listener.swift` | The socket, and the request lifecycle | 5 |
| `apps/menubar/Sources/ShipkitMenuBar/App.swift` | `MenuBarExtra`, the panel, the Settings pane | 6 |

**Tasks 2, 3 and 4 share no file and no type.** They may be implemented in parallel, in separate worktrees, once Task 1 has landed — every one of them depends on the package existing and on nothing else. Tasks 5 and 6 come after, in order, because the listener needs all three and the interface needs the listener.

`ShipkitMark.swift` already exists under `Sources/ShipkitMenuBar/` and moves in Task 1. Do not redraw it.

---

### Task 1: The package, the wire types, and the bundle script

Everything else forks from here, so it lands alone. It ends with a package that builds, a test that runs, and an `.app` that launches — nothing yet does anything.

**Files:**
- Create: `apps/menubar/Package.swift`
- Create: `apps/menubar/Sources/ShipkitKit/Protocol.swift`
- Create: `apps/menubar/Sources/ShipkitMenuBar/main.swift`
- Move: `apps/menubar/Sources/ShipkitMenuBar/ShipkitMark.swift` (unchanged content)
- Create: `scripts/app.sh`
- Test: `apps/menubar/Tests/ShipkitKitTests/ProtocolTests.swift`

**Interfaces:**
- Produces, in module `ShipkitKit`:
  - `public let protocolVersion = 1`
  - `public struct Warning: Codable, Equatable, Sendable { public let check: String; public let message: String }`
  - `public struct ApprovalRequest: Codable, Equatable, Sendable` with `protocolVersion` decoded from the JSON key `protocol`, plus `fingerprint`, `repo`, `branch`, `base`, `head`, `title`, `commitMessage`, `diffstat`, `warnings: [Warning]` — all `public let`, all `String` except `warnings` and the version.
  - `public enum Decision: String, Codable, Sendable { case approved, denied, pending }`
  - `public struct ApprovalResponse: Codable, Equatable, Sendable { public let protocolVersion: Int; public let fingerprint: String; public let decision: Decision }`, again coding `protocolVersion` as `protocol`.
  - `public func decodeRequest(_ line: Data) throws -> ApprovalRequest`
  - `public func encodeResponse(_ response: ApprovalResponse) throws -> Data` — one line, newline-terminated.

`protocol` is a Swift keyword, which is why both structs need `CodingKeys` mapping it to `protocolVersion`. Getting that wrong produces a decoder that silently sees no version at all.

- [ ] **Step 1: Write the failing test**

`apps/menubar/Tests/ShipkitKitTests/ProtocolTests.swift`:

```swift
import Foundation
import Testing
@testable import ShipkitKit

@Test func decodesTheRequestTheNodeClientSends() throws {
    // Copied from src/approval/protocol.ts's own shape. If this drifts, the two
    // halves stop speaking and nothing else in this package can be trusted.
    let line = Data("""
    {"protocol":1,"fingerprint":"abc","repo":"/r","branch":"b","base":"d",\
    "head":"c","title":"t","commitMessage":"m","diffstat":"1 file",\
    "warnings":[{"check":"blocking-label","message":"in test"}]}
    """.utf8)

    let request = try decodeRequest(line)

    #expect(request.protocolVersion == 1)
    #expect(request.fingerprint == "abc")
    #expect(request.title == "t")
    #expect(request.commitMessage == "m")
    #expect(request.diffstat == "1 file")
    #expect(request.warnings.map(\.check) == ["blocking-label"])
}

@Test func rejectsARequestMissingAField() {
    let line = Data(#"{"protocol":1,"fingerprint":"abc"}"#.utf8)
    #expect(throws: (any Error).self) { try decodeRequest(line) }
}

@Test func encodesAResponseAsOneNewlineTerminatedLine() throws {
    let data = try encodeResponse(
        ApprovalResponse(protocolVersion: 1, fingerprint: "abc", decision: .approved)
    )
    let text = String(decoding: data, as: UTF8.self)

    #expect(text.hasSuffix("\n"))
    #expect(text.dropLast().contains("\n") == false)
    // The Node side reads the key `protocol`, not `protocolVersion`.
    #expect(text.contains("\"protocol\":1"))
    #expect(text.contains("\"decision\":\"approved\""))
}

@Test func roundTripsEveryDecision() throws {
    for decision in [Decision.approved, .denied, .pending] {
        let data = try encodeResponse(
            ApprovalResponse(protocolVersion: 1, fingerprint: "f", decision: decision)
        )
        #expect(String(decoding: data, as: UTF8.self).contains(decision.rawValue))
    }
}
```

- [ ] **Step 2: Run it to watch it fail**

Run: `cd apps/menubar && swift test`
Expected: FAIL — there is no package.

- [ ] **Step 3: Write `apps/menubar/Package.swift`**

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ShipkitMenuBar",
    platforms: [.macOS(.v14)],
    targets: [
        // The library holds everything worth testing. The executable is a thin
        // SwiftUI shell over it, because a MenuBarExtra cannot be unit tested.
        .target(name: "ShipkitKit"),
        .executableTarget(name: "ShipkitMenuBar", dependencies: ["ShipkitKit"]),
        .testTarget(name: "ShipkitKitTests", dependencies: ["ShipkitKit"]),
    ]
)
```

- [ ] **Step 4: Write `Sources/ShipkitKit/Protocol.swift`**

```swift
import Foundation

public let protocolVersion = 1

public struct Warning: Codable, Equatable, Sendable {
    public let check: String
    public let message: String

    public init(check: String, message: String) {
        self.check = check
        self.message = message
    }
}

/// One request per connection, exactly as `src/approval/protocol.ts` emits it.
public struct ApprovalRequest: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let fingerprint: String
    public let repo: String
    public let branch: String
    public let base: String
    public let head: String
    public let title: String
    public let commitMessage: String
    public let diffstat: String
    public let warnings: [Warning]

    // `protocol` is a Swift keyword. Without this mapping the decoder quietly
    // finds no version at all and every request looks like a version mismatch.
    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case fingerprint, repo, branch, base, head, title, commitMessage, diffstat, warnings
    }
}

public enum Decision: String, Codable, Sendable {
    case approved, denied, pending
}

public struct ApprovalResponse: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let fingerprint: String
    public let decision: Decision

    public init(protocolVersion: Int, fingerprint: String, decision: Decision) {
        self.protocolVersion = protocolVersion
        self.fingerprint = fingerprint
        self.decision = decision
    }

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case fingerprint, decision
    }
}

public func decodeRequest(_ line: Data) throws -> ApprovalRequest {
    try JSONDecoder().decode(ApprovalRequest.self, from: line)
}

public func encodeResponse(_ response: ApprovalResponse) throws -> Data {
    var data = try JSONEncoder().encode(response)
    data.append(0x0A)
    return data
}
```

- [ ] **Step 5: Add the entry point**

`ShipkitMark.swift` already sits at `apps/menubar/Sources/ShipkitMenuBar/`, which
is exactly where the executable target expects it. Nothing to move. Confirm with
`ls apps/menubar/Sources/ShipkitMenuBar/` and leave its contents alone — it is
the drawn mark, and it was reviewed when it landed.

`Sources/ShipkitMenuBar/main.swift`:

```swift
import SwiftUI

// Task 6 replaces this with the real MenuBarExtra. Until then the executable
// exists so the package builds and the .app script has something to wrap.
@main
struct ShipkitMenuBarApp: App {
    var body: some Scene {
        MenuBarExtra {
            Text("shipkit")
        } label: {
            ShipkitMark()
                .frame(width: 18, height: 18)
        }
        .menuBarExtraStyle(.window)
    }
}
```

- [ ] **Step 6: Write `scripts/app.sh`**

```bash
#!/usr/bin/env bash
# Build the menu-bar executable and assemble shipkit.app around it.
#
# The bundle is derived, like design/icon/generated — one command rebuilds it,
# so it is git-ignored rather than committed. SwiftPM produces an executable and
# not a bundle, and a menu-bar application needs an Info.plist saying it has no
# Dock icon, so the wrapping happens here.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="$ROOT/apps/menubar/build/shipkit.app"

echo "app: building"
( cd apps/menubar && swift build -c release )

BIN="$ROOT/apps/menubar/.build/release/ShipkitMenuBar"
[ -x "$BIN" ] || { echo "app: no executable at $BIN" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ShipkitMenuBar"

if [ -f "$ROOT/design/icon/generated/shipkit.icns" ]; then
  cp "$ROOT/design/icon/generated/shipkit.icns" "$APP/Contents/Resources/shipkit.icns"
else
  echo "app: no icon yet — run scripts/icons.sh first if you want one" >&2
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>shipkit</string>
  <key>CFBundleIdentifier</key><string>com.shipkit.menubar</string>
  <key>CFBundleExecutable</key><string>ShipkitMenuBar</string>
  <key>CFBundleIconFile</key><string>shipkit</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- No Dock icon and no menu bar of its own: this application is the status item. -->
  <key>LSUIElement</key><true/>
</dict>
PLIST
echo "</plist>" >> "$APP/Contents/Info.plist"

# Ad-hoc signature. Without one, Gatekeeper refuses the bundle outright rather
# than offering the right-click-open path. Real signing is a separate decision;
# see packaging/README.md.
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "app: ad-hoc signing failed, bundle is unsigned" >&2

echo "app: $APP"
```

Then `chmod +x scripts/app.sh` and add `apps/menubar/build/` and `apps/menubar/.build/` to `.gitignore`.

- [ ] **Step 7: Run the tests and build the app**

Run: `cd apps/menubar && swift test` — expected PASS, 4 tests.
Run: `./scripts/app.sh` — expected to print the bundle path.
Run: `plutil -lint apps/menubar/build/shipkit.app/Contents/Info.plist` — expected `OK`. A malformed plist makes the bundle silently unlaunchable.

**Do not launch the app.** It puts an item in your menu bar and there is nothing to click yet.

- [ ] **Step 8: Confirm the two suites stay apart**

Run: `npm test` from the repository root — expected 371 passing, and no `swift` invocation in the output.

- [ ] **Step 9: Commit**

```bash
git add apps/menubar scripts/app.sh .gitignore
git commit -m "feat(menubar): the package, the wire types, and the bundle script"
```

---

### Task 2: The fingerprint — the contract with the Node side

*Parallel-safe: shares no file with Tasks 3 or 4.*

This is the highest-risk piece in the plan. The application recomputes the fingerprint from the fields it was sent and rejects a request whose hash does not match them — that check is what makes the facts a person sees provably the facts that were hashed. If this disagrees with the TypeScript by one byte, nothing can ever be approved, and the failure is silent.

**Files:**
- Create: `apps/menubar/Sources/ShipkitKit/Fingerprint.swift`
- Test: `apps/menubar/Tests/ShipkitKitTests/FingerprintTests.swift`

**Interfaces:**
- Consumes: `Warning` from Task 1.
- Produces:
  - `public struct Situation: Sendable { public let repo, branch, base, head, title, commitMessage: String; public let warnings: [Warning] }` with a memberwise `public init`.
  - `public func sortWarnings(_ warnings: [Warning]) -> [Warning]`
  - `public func canonical(_ situation: Situation) -> String`
  - `public func fingerprint(_ situation: Situation) -> String` — lowercase hex SHA-256.
  - `public extension ApprovalRequest { var situation: Situation }` — the situation a request claims, for the listener to re-hash.

The reference implementation is `src/approval/fingerprint.ts`. Read it before writing anything. Its shape:

```
shipkit-approval-v1
<byteLength>:<repo>
<byteLength>:<branch>
<byteLength>:<base>
<byteLength>:<head>
<byteLength>:<title>
<byteLength>:<commitMessage>
<count>
<byteLength>:<check>
<byteLength>:<message>
… per warning, sorted
```

joined with `\n`, **no trailing newline**, hashed as UTF-8.

Three details that will bite:

- **Byte length, not character count.** `value.utf8.count`, never `value.count`. A fixture vector contains an emoji precisely to catch this.
- **Code-unit order, not `localeCompare` and not `String <`.** Swift's `<` on `String` compares by Unicode scalar, which for these ASCII ids and messages agrees with the TypeScript's UTF-16 code-unit comparison. Sort by `check`, then by `message`.
- **No trailing newline.** `joined(separator: "\n")`, not a loop that appends one each time. A fixture variant that appends one fails every vector, which is the cheapest mistake to make and the easiest to catch.

- [ ] **Step 1: Write the failing test**

`apps/menubar/Tests/ShipkitKitTests/FingerprintTests.swift`:

```swift
import Foundation
import Testing
@testable import ShipkitKit

private struct Vector: Decodable {
    struct Sit: Decodable {
        let repo, branch, base, head, title, commitMessage: String
        let warnings: [Warning]
    }
    let name: String
    let situation: Sit
    let fingerprint: String
}

private func loadVectors() throws -> [Vector] {
    // The fixture lives at the repository root, four levels above this package's
    // Tests directory. Walking up from #filePath keeps it working wherever the
    // package is checked out.
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    url.appendPathComponent("tests/fixtures/fingerprint-vectors.json")
    return try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
}

@Test func matchesEveryVectorInTheSharedFixture() throws {
    let vectors = try loadVectors()
    #expect(vectors.count >= 8)

    for vector in vectors {
        let situation = Situation(
            repo: vector.situation.repo,
            branch: vector.situation.branch,
            base: vector.situation.base,
            head: vector.situation.head,
            title: vector.situation.title,
            commitMessage: vector.situation.commitMessage,
            warnings: vector.situation.warnings
        )
        #expect(fingerprint(situation) == vector.fingerprint, "vector: \(vector.name)")
    }
}

@Test func countsBytesNotCharacters() {
    let situation = Situation(
        repo: "/r", branch: "fix 🎉", base: "d", head: "c",
        title: "t", commitMessage: "m", warnings: []
    )
    // "fix 🎉" is 6 characters and 9 bytes.
    #expect(canonical(situation).contains("9:fix 🎉"))
}

@Test func endsWithoutATrailingNewline() {
    let situation = Situation(
        repo: "/r", branch: "b", base: "d", head: "c",
        title: "t", commitMessage: "m", warnings: []
    )
    #expect(canonical(situation).hasSuffix("\n") == false)
}

@Test func sortsWarningsByCheckThenMessage() {
    let unsorted = [
        Warning(check: "blocking-label", message: "z"),
        Warning(check: "approvals-dismissed", message: "b"),
        Warning(check: "approvals-dismissed", message: "a"),
    ]
    #expect(sortWarnings(unsorted).map(\.message) == ["a", "b", "z"])
}

@Test func sortsByCodeUnitOrderSoUppercaseComesFirst() {
    let mixed = [Warning(check: "x", message: "alpha"), Warning(check: "x", message: "Alpha")]
    #expect(sortWarnings(mixed).map(\.message) == ["Alpha", "alpha"])
}

@Test func theOrderOfTheInputDoesNotChangeTheHash() {
    let a = Situation(
        repo: "/r", branch: "b", base: "d", head: "c", title: "t", commitMessage: "m",
        warnings: [Warning(check: "untracked-files", message: "u"),
                   Warning(check: "base-mismatch", message: "b")]
    )
    let b = Situation(
        repo: "/r", branch: "b", base: "d", head: "c", title: "t", commitMessage: "m",
        warnings: [Warning(check: "base-mismatch", message: "b"),
                   Warning(check: "untracked-files", message: "u")]
    )
    #expect(fingerprint(a) == fingerprint(b))
}

@Test func aRequestExposesTheSituationItClaims() throws {
    let line = Data("""
    {"protocol":1,"fingerprint":"f","repo":"/r","branch":"b","base":"d",\
    "head":"c","title":"t","commitMessage":"m","diffstat":"x","warnings":[]}
    """.utf8)
    let request = try decodeRequest(line)
    #expect(request.situation.title == "t")
    #expect(request.situation.commitMessage == "m")
}
```

- [ ] **Step 2: Run it to watch it fail**

Run: `cd apps/menubar && swift test --filter FingerprintTests`
Expected: FAIL — `Situation` does not exist.

- [ ] **Step 3: Write `Sources/ShipkitKit/Fingerprint.swift`**

```swift
import CryptoKit
import Foundation

/// Everything an approval is bound to. The mirror of `Situation` in
/// `src/approval/fingerprint.ts`; the two must render identically.
public struct Situation: Sendable, Equatable {
    public let repo: String
    public let branch: String
    public let base: String
    public let head: String
    public let title: String
    public let commitMessage: String
    public let warnings: [Warning]

    public init(
        repo: String, branch: String, base: String, head: String,
        title: String, commitMessage: String, warnings: [Warning]
    ) {
        self.repo = repo
        self.branch = branch
        self.base = base
        self.head = head
        self.title = title
        self.commitMessage = commitMessage
        self.warnings = warnings
    }
}

private let version = "shipkit-approval-v1"

/// Code-unit order, matching the TypeScript. Not `localeCompare`, which is
/// locale-sensitive, and not a collation that would put "alpha" before "Alpha".
public func sortWarnings(_ warnings: [Warning]) -> [Warning] {
    warnings.sorted { a, b in
        if a.check != b.check { return a.check < b.check }
        return a.message < b.message
    }
}

/// Length-prefixed, not escaped. A delimiter that can appear inside a warning
/// message is a disagreement waiting for the first message that contains one.
public func canonical(_ situation: Situation) -> String {
    func field(_ value: String) -> String { "\(value.utf8.count):\(value)" }

    let sorted = sortWarnings(situation.warnings)
    var lines = [
        version,
        field(situation.repo),
        field(situation.branch),
        field(situation.base),
        field(situation.head),
        field(situation.title),
        field(situation.commitMessage),
        String(sorted.count),
    ]
    for warning in sorted {
        lines.append(field(warning.check))
        lines.append(field(warning.message))
    }
    return lines.joined(separator: "\n")
}

public func fingerprint(_ situation: Situation) -> String {
    let digest = SHA256.hash(data: Data(canonical(situation).utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
}

public extension ApprovalRequest {
    /// The situation this request claims. The listener re-hashes it and refuses
    /// when the result is not the fingerprint the request carries — which is what
    /// makes the facts on screen provably the facts that were hashed.
    var situation: Situation {
        Situation(
            repo: repo, branch: branch, base: base, head: head,
            title: title, commitMessage: commitMessage, warnings: warnings
        )
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/menubar && swift test --filter FingerprintTests`
Expected: PASS, 7 tests, including all eight fixture vectors.

- [ ] **Step 5: Prove the fixture is doing its job**

Break each of the three details in turn, confirm the fixture test fails, and restore. Record all three in the report:

1. `value.count` instead of `value.utf8.count` — the emoji vector must fail.
2. Append `"\n"` after the join — every vector must fail.
3. Return `warnings` unsorted from `sortWarnings` — the out-of-order vector must fail.

If any of the three does **not** fail the fixture, say so. It means the fixture has a hole and the Node side needs a vector it does not have.

- [ ] **Step 6: Commit**

```bash
git add apps/menubar/Sources/ShipkitKit/Fingerprint.swift apps/menubar/Tests
git commit -m "feat(menubar): recompute the fingerprint, and match the shared fixture"
```

---

### Task 3: The Jira token in the Keychain

*Parallel-safe: shares no file with Tasks 2 or 4.*

The Settings pane saves the token here, and `src/secrets/keychain.ts` reads it back with `/usr/bin/security`. Service `shipkit`, account `jira` — both sides must agree or the token is written somewhere nothing reads.

**Files:**
- Create: `apps/menubar/Sources/ShipkitKit/Keychain.swift`
- Test: `apps/menubar/Tests/ShipkitKitTests/KeychainTests.swift`

**Interfaces:**
- Produces:
  - `public enum KeychainError: Error, Equatable { case status(OSStatus) }`
  - `public struct Keychain: Sendable { public init(service: String = "shipkit") }`
  - `public func read(account: String) throws -> String?` — `nil` when absent, never an error for absence.
  - `public func write(_ secret: String, account: String) throws` — creates or replaces.
  - `public func delete(account: String) throws` — succeeds when already absent.

Absence is not an error. It is the ordinary state of a machine where nobody has saved a token, and an error there makes the common case look like a fault.

**The Node side reads this with `/usr/bin/security`, not the Security framework.** That matters: an item written without `kSecAttrAccess` granting that binary raises a GUI authorization prompt on the first read, which in an agent-spawned process is a hang with no ceiling. Write items with `kSecAttrAccessibleAfterFirstUnlock` and note in the report whether a `security find-generic-password` read of an item this code wrote prompts on your machine.

- [ ] **Step 1: Write the failing test**

`apps/menubar/Tests/ShipkitKitTests/KeychainTests.swift`:

```swift
import Foundation
import Testing
@testable import ShipkitKit

// A service name nothing else uses, so a failed run cannot collide with the
// real "shipkit" item or with another test run.
private let testService = "shipkit-test-\(UUID().uuidString)"

@Test func readsNilWhenTheItemIsAbsent() throws {
    let keychain = Keychain(service: testService)
    #expect(try keychain.read(account: "jira") == nil)
}

@Test func writesThenReadsBackTheSameSecret() throws {
    let keychain = Keychain(service: testService)
    defer { try? keychain.delete(account: "jira") }

    try keychain.write("s3cret", account: "jira")
    #expect(try keychain.read(account: "jira") == "s3cret")
}

@Test func replacesAnExistingSecret() throws {
    let keychain = Keychain(service: testService)
    defer { try? keychain.delete(account: "jira") }

    try keychain.write("first", account: "jira")
    try keychain.write("second", account: "jira")
    #expect(try keychain.read(account: "jira") == "second")
}

@Test func deletingAnAbsentItemIsNotAnError() throws {
    let keychain = Keychain(service: testService)
    #expect(throws: Never.self) { try keychain.delete(account: "jira") }
}

@Test func deleteRemovesIt() throws {
    let keychain = Keychain(service: testService)
    try keychain.write("gone-soon", account: "jira")
    try keychain.delete(account: "jira")
    #expect(try keychain.read(account: "jira") == nil)
}

@Test func handlesANonAsciiSecret() throws {
    let keychain = Keychain(service: testService)
    defer { try? keychain.delete(account: "jira") }

    try keychain.write("şifre-🎉", account: "jira")
    #expect(try keychain.read(account: "jira") == "şifre-🎉")
}
```

- [ ] **Step 2: Run it to watch it fail**

Run: `cd apps/menubar && swift test --filter KeychainTests`
Expected: FAIL — `Keychain` does not exist.

- [ ] **Step 3: Write `Sources/ShipkitKit/Keychain.swift`**

```swift
import Foundation
import Security

public enum KeychainError: Error, Equatable {
    case status(OSStatus)
}

/// The generic-password item `src/secrets/keychain.ts` reads with
/// `/usr/bin/security find-generic-password -s shipkit -a jira -w`. The service
/// and account must match that command exactly or the token is written where
/// nothing looks for it.
public struct Keychain: Sendable {
    private let service: String

    public init(service: String = "shipkit") {
        self.service = service
    }

    private func query(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// `nil` when the item is absent — the ordinary state of a machine where
    /// nobody has saved a token, and not a fault.
    public func read(account: String) throws -> String? {
        var request = query(account: account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.status(status) }
        guard let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ secret: String, account: String) throws {
        let data = Data(secret.utf8)
        let update: [String: Any] = [kSecValueData as String: data]

        let updated = SecItemUpdate(query(account: account) as CFDictionary, update as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw KeychainError.status(updated) }

        var insert = query(account: account)
        insert[kSecValueData as String] = data
        // After first unlock rather than when-unlocked: the agent that reads this
        // may be running while the screen is locked.
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let added = SecItemAdd(insert as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainError.status(added) }
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(query(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.status(status)
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/menubar && swift test --filter KeychainTests`
Expected: PASS, 6 tests.

- [ ] **Step 5: Confirm nothing was left behind**

Run: `security dump-keychain 2>/dev/null | grep -c "shipkit-test-" || true`
Expected: `0`. Every test deletes what it wrote; a non-zero count means a `defer` is missing.

- [ ] **Step 6: Check the cross-language read by hand**

Write an item under the real service, read it with the command the Node side uses, then delete it:

```bash
cd apps/menubar && swift run --package-path . 2>/dev/null || true
```

That will not work — there is no CLI. Instead write a throwaway test that uses `Keychain(service: "shipkit")`, run only it, and between the write and the delete run:

```bash
security find-generic-password -s shipkit -a jira -w
```

Record whether it printed the value and **whether macOS raised an authorization prompt**. Then delete the throwaway test. This is the one thing the unit tests cannot prove, and a prompt here means a hung tool call for whoever installs this.

- [ ] **Step 7: Commit**

```bash
git add apps/menubar/Sources/ShipkitKit/Keychain.swift apps/menubar/Tests
git commit -m "feat(menubar): store the Jira token where shipkit reads it"
```

---

### Task 4: The decision journal

*Parallel-safe: shares no file with Tasks 2 or 3.*

A call that times out must be able to resume: the agent calls again and finds the decision waiting. That is the journal's only reason to exist. It is keyed by fingerprint, not by a request id, so a resumed call is satisfied only by a decision made about the identical situation.

It is **not** a memory of preference. Ten minutes, one fingerprint, nothing else.

**Files:**
- Create: `apps/menubar/Sources/ShipkitKit/Journal.swift`
- Test: `apps/menubar/Tests/ShipkitKitTests/JournalTests.swift`

**Interfaces:**
- Consumes: `Decision` from Task 1.
- Produces:
  - `public actor Journal`
  - `public init(ttl: TimeInterval = 600, now: @escaping @Sendable () -> Date = Date.init)`
  - `public func record(_ decision: Decision, for fingerprint: String)`
  - `public func decision(for fingerprint: String) -> Decision?` — `nil` when absent or expired.
  - `public func count() -> Int` — live entries, for the test that proves expiry evicts rather than merely hides.

Time is injected. A test that sleeps for ten minutes is a test nobody runs.

- [ ] **Step 1: Write the failing test**

`apps/menubar/Tests/ShipkitKitTests/JournalTests.swift`:

```swift
import Foundation
import Testing
@testable import ShipkitKit

/// A clock the test moves by hand.
private final class Clock: @unchecked Sendable {
    private var instant = Date(timeIntervalSince1970: 1_000_000)
    func now() -> Date { instant }
    func advance(_ seconds: TimeInterval) { instant = instant.addingTimeInterval(seconds) }
}

@Test func remembersADecisionForItsFingerprint() async {
    let journal = Journal()
    await journal.record(.approved, for: "abc")
    #expect(await journal.decision(for: "abc") == .approved)
}

@Test func knowsNothingAboutAnotherFingerprint() async {
    let journal = Journal()
    await journal.record(.approved, for: "abc")
    #expect(await journal.decision(for: "def") == nil)
}

@Test func forgetsAfterTheTimeToLive() async {
    let clock = Clock()
    let journal = Journal(ttl: 600, now: clock.now)
    await journal.record(.approved, for: "abc")

    clock.advance(599)
    #expect(await journal.decision(for: "abc") == .approved)

    clock.advance(2)
    #expect(await journal.decision(for: "abc") == nil)
}

// Hiding an expired entry from the reader while keeping it in memory is a slow
// leak in a process that runs for weeks.
@Test func expiryEvictsRatherThanHides() async {
    let clock = Clock()
    let journal = Journal(ttl: 600, now: clock.now)
    await journal.record(.approved, for: "abc")
    #expect(await journal.count() == 1)

    clock.advance(601)
    _ = await journal.decision(for: "abc")
    #expect(await journal.count() == 0)
}

@Test func remembersADenialTheSameWay() async {
    let journal = Journal()
    await journal.record(.denied, for: "abc")
    #expect(await journal.decision(for: "abc") == .denied)
}

// The later decision wins: a person who changes their mind within the window
// should not be overruled by what they said first.
@Test func aSecondDecisionReplacesTheFirst() async {
    let journal = Journal()
    await journal.record(.denied, for: "abc")
    await journal.record(.approved, for: "abc")
    #expect(await journal.decision(for: "abc") == .approved)
}

@Test func keepsDistinctFingerprintsApart() async {
    let journal = Journal()
    await journal.record(.approved, for: "a")
    await journal.record(.denied, for: "b")
    #expect(await journal.decision(for: "a") == .approved)
    #expect(await journal.decision(for: "b") == .denied)
    #expect(await journal.count() == 2)
}
```

- [ ] **Step 2: Run it to watch it fail**

Run: `cd apps/menubar && swift test --filter JournalTests`
Expected: FAIL — `Journal` does not exist.

- [ ] **Step 3: Write `Sources/ShipkitKit/Journal.swift`**

```swift
import Foundation

/// One decision per fingerprint, for ten minutes.
///
/// Its only purpose is to let a timed-out call resume: the agent calls again
/// with the same situation and finds the answer waiting. Keyed by fingerprint
/// rather than by a request id, so a resumed call is satisfied only by a
/// decision made about the identical situation — and two agents racing on the
/// same branch cannot pick up each other's answers unless the situation is
/// genuinely identical, in which case they should.
///
/// This is not a memory of preference. There is no "approve all", no
/// per-repository trust, and nothing outlives the window.
public actor Journal {
    private struct Entry {
        let decision: Decision
        let recorded: Date
    }

    private var entries: [String: Entry] = [:]
    private let ttl: TimeInterval
    private let now: @Sendable () -> Date

    public init(ttl: TimeInterval = 600, now: @escaping @Sendable () -> Date = Date.init) {
        self.ttl = ttl
        self.now = now
    }

    public func record(_ decision: Decision, for fingerprint: String) {
        entries[fingerprint] = Entry(decision: decision, recorded: now())
    }

    public func decision(for fingerprint: String) -> Decision? {
        guard let entry = entries[fingerprint] else { return nil }
        if now().timeIntervalSince(entry.recorded) > ttl {
            // Evict rather than hide: this process runs for weeks.
            entries.removeValue(forKey: fingerprint)
            return nil
        }
        return entry.decision
    }

    public func count() -> Int {
        entries.count
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/menubar && swift test --filter JournalTests`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove two of them discriminate**

Record both observations:

1. Make `decision(for:)` return the entry without checking expiry. The time-to-live test must fail.
2. Make expiry return `nil` without removing the entry. The eviction test must fail, and only that one.

- [ ] **Step 6: Commit**

```bash
git add apps/menubar/Sources/ShipkitKit/Journal.swift apps/menubar/Tests
git commit -m "feat(menubar): remember one decision per fingerprint, briefly"
```

---

### Task 5: The listener

Where a request becomes a question. It binds the socket, reads one line, verifies the fingerprint against the fields it was sent, answers immediately from the journal when it can, and otherwise hands the request to whoever is presenting it.

**Files:**
- Create: `apps/menubar/Sources/ShipkitKit/Listener.swift`
- Test: `apps/menubar/Tests/ShipkitKitTests/ListenerTests.swift`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces:
  - `public enum ListenerError: Error { case bind(String) }`
  - `public struct PendingRequest: Sendable, Identifiable { public let id: String; public let request: ApprovalRequest }` — `id` is the fingerprint.
  - `public actor Listener`
  - `public init(socketPath: String, journal: Journal, present: @escaping @Sendable (PendingRequest) async -> Decision)`
  - `public func start() throws`
  - `public func stop()`
  - `public static func defaultSocketPath() -> String` — `~/Library/Application Support/shipkit/approvals.sock`.

Four things the tests must pin, because each is a silent failure:

- **The socket is `0600` after binding.** Measured: a freshly bound socket comes out `0755`, because `bind` honours the umask. The `0700` directory is the real control; the mode on the socket is the second lock.
- **A request whose fingerprint does not match its own fields is refused without asking anyone.** That check is the entire reason the application recomputes the hash.
- **A stale socket file is replaced, not fatal.** An application that crashed leaves one behind, and refusing to start until someone deletes it by hand is a worse failure than the crash.
- **A journalled decision answers immediately.** No second prompt for a situation already decided.

- [ ] **Step 1: Write the failing test**

`apps/menubar/Tests/ShipkitKitTests/ListenerTests.swift`:

```swift
import Foundation
import Testing
@testable import ShipkitKit

private func scratchSocket() -> String {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("shipkit-listener-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("approvals.sock").path
}

/// Connects, sends one line, reads one line. The Node client in miniature.
private func ask(_ path: String, _ line: String) throws -> String {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    #expect(fd >= 0)
    defer { close(fd) }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        path.withCString { source in
            strncpy(UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self),
                    source, MemoryLayout.size(ofValue: address.sun_path) - 1)
        }
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
    }
    #expect(connected == 0)

    _ = line.withCString { send(fd, $0, strlen($0), 0) }

    var buffer = [UInt8](repeating: 0, count: 4096)
    let read = recv(fd, &buffer, buffer.count, 0)
    #expect(read > 0)
    return String(decoding: buffer[0..<max(read, 0)], as: UTF8.self)
}

private func requestLine(fingerprintOverride: String? = nil) -> String {
    let situation = Situation(
        repo: "/r", branch: "b", base: "d", head: "c",
        title: "t", commitMessage: "m",
        warnings: [Warning(check: "blocking-label", message: "in test")]
    )
    let fp = fingerprintOverride ?? fingerprint(situation)
    return """
    {"protocol":1,"fingerprint":"\(fp)","repo":"/r","branch":"b","base":"d",\
    "head":"c","title":"t","commitMessage":"m","diffstat":"1 file",\
    "warnings":[{"check":"blocking-label","message":"in test"}]}
    """
}

@Test func chmodsTheSocketTo0600AfterBinding() async throws {
    let path = scratchSocket()
    let listener = Listener(socketPath: path, journal: Journal()) { _ in .denied }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let attributes = try FileManager.default.attributesOfItem(atPath: path)
    let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue
    // A freshly bound socket is 0755 — bind honours the umask — so this only
    // passes if something chmods it afterwards.
    #expect(mode == 0o600)
}

@Test func answersWithTheDecisionThePresenterReturns() async throws {
    let path = scratchSocket()
    let listener = Listener(socketPath: path, journal: Journal()) { _ in .approved }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try ask(path, requestLine() + "\n")
    #expect(reply.contains("\"decision\":\"approved\""))
    #expect(reply.hasSuffix("\n"))
}

// The check that makes the facts on screen provably the facts that were hashed.
@Test func refusesARequestWhoseFingerprintDoesNotMatchItsFields() async throws {
    let path = scratchSocket()
    var asked = false
    let listener = Listener(socketPath: path, journal: Journal()) { _ in
        asked = true
        return .approved
    }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try ask(path, requestLine(fingerprintOverride: String(repeating: "a", count: 64)) + "\n")
    #expect(reply.contains("\"decision\":\"denied\""))
    #expect(asked == false)
}

@Test func answersFromTheJournalWithoutAskingAgain() async throws {
    let path = scratchSocket()
    let journal = Journal()
    let situation = Situation(
        repo: "/r", branch: "b", base: "d", head: "c", title: "t", commitMessage: "m",
        warnings: [Warning(check: "blocking-label", message: "in test")]
    )
    await journal.record(.approved, for: fingerprint(situation))

    var asked = false
    let listener = Listener(socketPath: path, journal: journal) { _ in
        asked = true
        return .denied
    }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try ask(path, requestLine() + "\n")
    #expect(reply.contains("\"decision\":\"approved\""))
    #expect(asked == false)
}

@Test func recordsTheDecisionItObtained() async throws {
    let path = scratchSocket()
    let journal = Journal()
    let listener = Listener(socketPath: path, journal: journal) { _ in .denied }
    try await listener.start()
    defer { Task { await listener.stop() } }

    _ = try ask(path, requestLine() + "\n")

    let situation = Situation(
        repo: "/r", branch: "b", base: "d", head: "c", title: "t", commitMessage: "m",
        warnings: [Warning(check: "blocking-label", message: "in test")]
    )
    #expect(await journal.decision(for: fingerprint(situation)) == .denied)
}

// An application that crashed leaves a socket file behind. Refusing to start
// until someone deletes it by hand is a worse failure than the crash.
@Test func replacesAStaleSocketFile() async throws {
    let path = scratchSocket()
    FileManager.default.createFile(atPath: path, contents: Data())

    let listener = Listener(socketPath: path, journal: Journal()) { _ in .approved }
    // do/catch rather than #expect(throws: Never.self): the expectation macro's
    // async throwing form is easy to get subtly wrong, and a test that fails to
    // compile teaches nothing.
    do {
        try await listener.start()
    } catch {
        Issue.record("start() threw on a stale socket file: \(error)")
    }
    await listener.stop()
}

@Test func refusesAnUnparseableLineWithoutAsking() async throws {
    let path = scratchSocket()
    var asked = false
    let listener = Listener(socketPath: path, journal: Journal()) { _ in
        asked = true
        return .approved
    }
    try await listener.start()
    defer { Task { await listener.stop() } }

    let reply = try ask(path, "{\n")
    #expect(reply.contains("\"decision\":\"denied\"") || reply.isEmpty == false)
    #expect(asked == false)
}
```

- [ ] **Step 2: Run it to watch it fail**

Run: `cd apps/menubar && swift test --filter ListenerTests`
Expected: FAIL — `Listener` does not exist.

- [ ] **Step 3: Write `Sources/ShipkitKit/Listener.swift`**

A POSIX socket with a `DispatchSource`, not Network.framework: a unix-domain listener through `NWListener` needs private parameter plumbing, and this is forty lines of well-understood C.

```swift
import Foundation

public enum ListenerError: Error {
    case bind(String)
}

public struct PendingRequest: Sendable, Identifiable {
    /// The fingerprint. Two requests about the same situation are the same question.
    public let id: String
    public let request: ApprovalRequest

    public init(request: ApprovalRequest) {
        self.id = request.fingerprint
        self.request = request
    }
}

public actor Listener {
    private let socketPath: String
    private let journal: Journal
    private let present: @Sendable (PendingRequest) async -> Decision
    private var descriptor: Int32 = -1
    private var source: DispatchSourceRead?

    public init(
        socketPath: String,
        journal: Journal,
        present: @escaping @Sendable (PendingRequest) async -> Decision
    ) {
        self.socketPath = socketPath
        self.journal = journal
        self.present = present
    }

    public static func defaultSocketPath() -> String {
        let base = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/shipkit")
        return base.appendingPathComponent("approvals.sock").path
    }

    public func start() throws {
        let directory = (socketPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        // A crashed run leaves the file behind; bind would fail with EADDRINUSE.
        try? FileManager.default.removeItem(atPath: socketPath)

        descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw ListenerError.bind("socket() failed") }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard socketPath.utf8.count < capacity else {
            throw ListenerError.bind("socket path is too long: \(socketPath)")
        }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            socketPath.withCString { source in
                _ = strncpy(
                    UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self),
                    source, capacity - 1
                )
            }
        }

        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, size) }
        }
        guard bound == 0 else { throw ListenerError.bind("bind() failed: \(errno)") }

        // bind honours the umask, so the file lands 0755. The 0700 directory is
        // the real control; this is the second lock.
        chmod(socketPath, 0o600)

        guard listen(descriptor, 8) == 0 else { throw ListenerError.bind("listen() failed") }

        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: .global())
        source.setEventHandler { [descriptor] in
            let client = accept(descriptor, nil, nil)
            guard client >= 0 else { return }
            Task { await Listener.serve(client: client, on: self) }
        }
        source.resume()
        self.source = source
    }

    public func stop() {
        source?.cancel()
        source = nil
        if descriptor >= 0 { close(descriptor) }
        descriptor = -1
        try? FileManager.default.removeItem(atPath: socketPath)
    }

    /// Reads one line, answers it, closes. Everything it cannot verify is denied:
    /// a decision is permission to push, and a request it cannot make sense of is
    /// not something anyone agreed to.
    private static func serve(client: Int32, on listener: Listener) async {
        defer { close(client) }

        var buffer = [UInt8](repeating: 0, count: 65536)
        var collected = Data()
        while true {
            let read = recv(client, &buffer, buffer.count, 0)
            if read <= 0 { break }
            collected.append(contentsOf: buffer[0..<read])
            if collected.contains(0x0A) { break }
            if collected.count > 1_048_576 { return }
        }
        guard let newline = collected.firstIndex(of: 0x0A) else { return }
        let line = collected[collected.startIndex..<newline]

        let decision = await listener.decide(line: Data(line))
        let fingerprintOfRequest = (try? decodeRequest(Data(line)))?.fingerprint ?? ""
        let response = ApprovalResponse(
            protocolVersion: protocolVersion,
            fingerprint: fingerprintOfRequest,
            decision: decision
        )
        if let data = try? encodeResponse(response) {
            _ = data.withUnsafeBytes { send(client, $0.baseAddress, data.count, 0) }
        }
    }

    fileprivate func decide(line: Data) async -> Decision {
        guard let request = try? decodeRequest(line) else { return .denied }
        guard request.protocolVersion == protocolVersion else { return .denied }

        // What the person will see must be what was hashed. A request whose
        // fingerprint does not match its own fields is refused without asking.
        guard fingerprint(request.situation) == request.fingerprint else { return .denied }

        if let known = await journal.decision(for: request.fingerprint) { return known }

        let decision = await present(PendingRequest(request: request))
        await journal.record(decision, for: request.fingerprint)
        return decision
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/menubar && swift test`
Expected: PASS — all targets, roughly 28 tests.

- [ ] **Step 5: Prove three of them discriminate**

Record each observation:

1. Remove the `chmod`. The permission test must fail and report `0755`.
2. Remove the fingerprint comparison. The mismatch test must fail, and the presenter must have been asked.
3. Remove the journal lookup. The already-decided test must fail.

- [ ] **Step 6: Speak to the real Node client**

This is the first moment the two halves meet, and it is worth doing by hand.

```bash
cd apps/menubar && swift build
```

Then write a throwaway Swift file that starts a `Listener` on a temporary path with a presenter returning `.approved`, and keeps running. In another shell:

```bash
cd "$(git rev-parse --show-toplevel)"
SHIPKIT_APPROVAL_SOCKET=/tmp/shipkit-probe.sock node --input-type=module -e '
const { requestApproval } = await import("./dist/approval/client.js");
const { fingerprint } = await import("./dist/approval/fingerprint.js");
const situation = { repo:"/r", branch:"b", base:"d", head:"c", title:"t",
  commitMessage:"m", warnings:[{check:"blocking-label",message:"in test"}] };
console.log(await requestApproval({
  protocol: 1, fingerprint: fingerprint(situation), ...situation,
  diffstat: "1 file",
}, { socketPath: "/tmp/shipkit-probe.sock", timeoutMs: 5000 }));
'
```

Expected: `{ outcome: 'approved' }`. Paste the real output into the report. If the two disagree — on the fingerprint, the framing, or the key names — that is the single most valuable finding this plan can produce, and it must be reported rather than worked around.

Delete the throwaway file afterwards.

- [ ] **Step 7: Commit**

```bash
git add apps/menubar/Sources/ShipkitKit/Listener.swift apps/menubar/Tests
git commit -m "feat(menubar): answer on the socket, and verify what was hashed"
```

---

### Task 6: The menu bar and the panel

The part a person actually uses. Everything it needs already exists and is tested; this task is composition and judgement about what is on screen.

**Files:**
- Rewrite: `apps/menubar/Sources/ShipkitMenuBar/main.swift`
- Create: `apps/menubar/Sources/ShipkitMenuBar/ApprovalPanel.swift`
- Create: `apps/menubar/Sources/ShipkitMenuBar/SettingsPane.swift`
- Create: `apps/menubar/Sources/ShipkitMenuBar/AppModel.swift`
- Test: `apps/menubar/Tests/ShipkitKitTests/` — nothing new; SwiftUI views are not unit tested here, and `AppModel`'s logic lives in `ShipkitKit` if it needs a test.

**Interfaces:**
- Consumes: `Listener`, `Journal`, `Keychain`, `PendingRequest`, `Decision`, `ShipkitMark`.
- Produces: nothing other modules consume.

What the panel shows, in this order — the warnings are the content, and the rest is there so the reader knows which change they are approving:

```
shipkit wants to push  ·  <last path component of repo>
<branch> → <base>

⚠ <each warning's message, one per line>

<title>
<diffstat>

                          [ Deny ]  [ Approve push ]
```

Rules for the panel, each of which is a decision already made:

- **Neither button is the default** and neither is focused on appear. A consent surface where return means yes is one that gets dismissed by muscle memory.
- **No "approve all", no "remember", no per-repository toggle.** Nothing in this view may write anything except the one decision.
- **The mark shows the state.** `ShipkitMark(isPending: true)` while a request waits, `false` otherwise — the silhouette changes, because a menu-bar icon is tinted by the system and cannot signal with colour.
- **The commit message is shown in full** if it has a body. The reader is approving that text.

- [ ] **Step 1: Write `AppModel.swift`**

```swift
import Foundation
import ShipkitKit

/// Owns the listener and the one request that is waiting, if any.
///
/// A single pending request rather than a queue: that is what one person
/// driving one agent produces, and a queue would be scaffolding for a situation
/// nobody has had yet.
@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var pending: PendingRequest?
    @Published var tokenDraft: String = ""
    @Published private(set) var tokenSaved: Bool = false

    private let keychain = Keychain()
    private let journal = Journal()
    private var listener: Listener?
    private var answer: ((Decision) -> Void)?

    func start() {
        let listener = Listener(
            socketPath: Listener.defaultSocketPath(),
            journal: journal
        ) { [weak self] request in
            await self?.show(request) ?? .denied
        }
        self.listener = listener
        Task { try? await listener.start() }
        tokenSaved = (try? keychain.read(account: "jira")) != nil
    }

    /// Puts the request on screen and suspends until a button is pressed.
    private func show(_ request: PendingRequest) async -> Decision {
        await withCheckedContinuation { continuation in
            Task { @MainActor in
                self.pending = request
                self.answer = { decision in continuation.resume(returning: decision) }
            }
        }
    }

    func decide(_ decision: Decision) {
        let answer = self.answer
        self.answer = nil
        self.pending = nil
        answer?(decision)
    }

    func saveToken() {
        guard tokenDraft.isEmpty == false else { return }
        try? keychain.write(tokenDraft, account: "jira")
        tokenDraft = ""
        tokenSaved = true
    }

    func clearToken() {
        try? keychain.delete(account: "jira")
        tokenSaved = false
    }
}
```

- [ ] **Step 2: Write `ApprovalPanel.swift`**

```swift
import SwiftUI
import ShipkitKit

struct ApprovalPanel: View {
    let request: ApprovalRequest
    let decide: (Decision) -> Void

    private var repoName: String {
        (request.repo as NSString).lastPathComponent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("shipkit wants to push · \(repoName)")
                    .font(.headline)
                Text("\(request.branch) → \(request.base)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            // The warnings are the content. Everything else is here so the
            // reader knows which change they are approving.
            VStack(alignment: .leading, spacing: 7) {
                ForEach(request.warnings, id: \.check) { warning in
                    Label(warning.message, systemImage: "exclamationmark.triangle")
                        .font(.callout)
                        .labelStyle(.titleAndIcon)
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 3) {
                Text(request.title).font(.callout).fontWeight(.medium)
                if request.commitMessage != request.title {
                    Text(request.commitMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Text(request.diffstat).font(.caption).foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                // Neither is the default and neither is focused: a consent
                // surface where return means yes is dismissed by muscle memory.
                Button("Deny") { decide(.denied) }
                Button("Approve push") { decide(.approved) }
            }
        }
        .padding(18)
        .frame(width: 380)
    }
}
```

- [ ] **Step 3: Write `SettingsPane.swift`**

```swift
import SwiftUI

struct SettingsPane: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Jira token").font(.headline)
            Text("shipkit reads this from the login keychain. Without it, the "
                 + "issue-level check cannot run and every pull request is warned about.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            SecureField("Paste a token", text: $model.tokenDraft)
                .textFieldStyle(.roundedBorder)

            HStack {
                Button("Save") { model.saveToken() }
                    .disabled(model.tokenDraft.isEmpty)
                if model.tokenSaved {
                    Button("Remove saved token") { model.clearToken() }
                }
                Spacer()
                Text(model.tokenSaved ? "Saved" : "Not set")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(18)
        .frame(width: 380)
    }
}
```

- [ ] **Step 4: Rewrite `main.swift`**

```swift
import SwiftUI
import ShipkitKit

@main
struct ShipkitMenuBarApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            if let pending = model.pending {
                ApprovalPanel(request: pending.request) { model.decide($0) }
            } else {
                SettingsPane(model: model)
            }
        } label: {
            // The silhouette carries the state: a menu-bar icon is tinted by the
            // system and cannot signal with colour, and at 16pt a small addition
            // is not a state anyone notices.
            ShipkitMark(isPending: model.pending != nil)
                .frame(width: 18, height: 18)
        }
        .menuBarExtraStyle(.window)
    }
}
```

`AppModel.start()` is called from its own initialiser rather than from a scene
modifier. A `Scene` has no `.task`, and `.onChange(of:)` with a constant is a
hack that reads as a bug — add this to `AppModel`:

```swift
    init() {
        start()
    }
```

and make `start()` private.

- [ ] **Step 5: Build and assemble**

Run: `cd apps/menubar && swift build` — expected to succeed.
Run: `./scripts/app.sh` — expected to print the bundle path.
Run: `cd apps/menubar && swift test` — expected PASS, unchanged count.

- [ ] **Step 6: Launch it once, by hand, and drive it with the real client**

This is the only end-to-end proof there is, and it is worth the care.

```bash
open apps/menubar/build/shipkit.app
```

The mark appears in the menu bar with no pending request. Then, from the repository root:

```bash
node --input-type=module -e '
const { requestApproval } = await import("./dist/approval/client.js");
const { fingerprint } = await import("./dist/approval/fingerprint.js");
const situation = { repo:"/Users/x/example-app", branch:"bugfix/squad/31087-invoice",
  base:"release/3.76.0", head:"a".repeat(40), title:"fix(invoice): default citizenship",
  commitMessage:"fix(invoice): default citizenship",
  warnings:[
    {check:"approvals-dismissed",message:"Pushing will dismiss 4 approval(s) on #881"},
    {check:"blocking-label",message:"Label(s) in test will block the merge gate"}]};
console.log(await requestApproval({ protocol:1, fingerprint: fingerprint(situation),
  ...situation, diffstat:"12 files changed, 148 insertions(+), 37 deletions(-)" },
  { timeoutMs: 60000 }));
'
```

Expected: the mark changes to its pending silhouette, clicking it shows the panel with both warnings, and pressing a button returns the matching outcome to the waiting Node process.

Record in the report: whether the mark changed, whether both warnings appeared with their full text, what the panel looked like at its real size, and what the Node side printed. Then quit the application.

- [ ] **Step 7: Commit**

```bash
git add apps/menubar/Sources/ShipkitMenuBar
git commit -m "feat(menubar): the panel a person actually decides in"
```

---

## Done when

- `cd apps/menubar && swift test` passes, and `npm test` still reports 371 passing with `npm run check` clean.
- The Swift fingerprint matches every vector in `tests/fixtures/fingerprint-vectors.json`, and breaking any of byte-counting, sorting or the trailing newline fails it.
- A request whose fingerprint does not match its own fields is refused without anyone being asked.
- The socket is `0600` and its directory `0700`.
- Nothing is remembered but one decision per fingerprint for ten minutes.
- `scripts/app.sh` produces a bundle that launches and shows the mark.
- The real Node client and this application have spoken to each other at least once, and the transcript is in a report.

## Next

- **Signing and the cask.** Ad-hoc today, so Gatekeeper needs a right-click on first launch. `packaging/README.md` records where the signing step slots in.
- **The echo-denial question.** The spec routes it here: under `echo`, a caller refused by a person can call again with the ids echoed back and proceed, because the surface is never consulted twice. Answering it needs a query the protocol does not have — a decision the listener can report without prompting — and is its own piece of work.
- **More than one waiting request.** The model holds a single pending request. Two agents on two repositories is plausible; whether the panel needs a list or the second request simply waits is a question for after it has happened.
