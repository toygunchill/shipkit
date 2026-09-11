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

            if let tokenError = model.tokenError {
                Text(tokenError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

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
