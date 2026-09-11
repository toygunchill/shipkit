import SwiftUI
import ShipkitKit

/// `Warning` is `Equatable` but not `Hashable`, so `ForEach` needs a
/// synthetic id. A NUL separator keeps two distinct (check, message) pairs
/// from ever concatenating to the same string.
private extension Warning {
    var identity: String { "\(check)\u{0}\(message)" }
}

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
                // Identified by check *and* message: the canonical fingerprint
                // form sorts on the message as a tiebreak precisely because two
                // warnings can share a `check`, and a duplicate SwiftUI id
                // renders undefined -- the one case the sort exists for is the
                // case a `check`-only id would mis-draw.
                ForEach(request.warnings, id: \.identity) { warning in
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
