import SwiftUI

struct SettingsPane: View {
    @ObservedObject var model: AppModel
    /// How to get back to the inbox. This pane is no longer what the panel
    /// opens on, so it needs a way out.
    let back: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Button(action: back) {
                    Label("Pull requests", systemImage: "chevron.left")
                        .labelStyle(.titleAndIcon)
                        .font(.callout)
                }
                .buttonStyle(.link)
                Spacer()
            }

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

            // The listener error used to be shown here because this pane was
            // the whole panel. It now lives on the inbox, which is what the
            // panel opens on: a socket that failed to start must not be
            // reachable only by someone who went looking for the token.
        }
        .padding(18)
        .frame(width: 380)
        // Refreshed on appear, not read inline in `body`: the keychain item
        // can change from outside this process (Keychain Access, a second
        // copy of this app), and `tokenSaved` would otherwise only ever
        // reflect whatever this process last wrote itself.
        .onAppear { model.refreshTokenStatus() }
    }
}
