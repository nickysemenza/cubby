import CubbyKit
import SwiftUI

/// Base URL and session. On iOS it is a sheet from Login and a Dev-tab row; on macOS the
/// Settings scene.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draftURL = ""

    var body: some View {
        @Bindable var model = model
        Form {
            Section("Server") {
                TextField("Base URL", text: $draftURL)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    #endif
                    .onSubmit(apply)
                Button("Use \(draftURL)", action: apply)
                    .disabled(URL(string: draftURL) == nil || draftURL == model.baseURL.absoluteString)
                Button("Production") { draftURL = AppModel.productionBaseURL.absoluteString; apply() }
                Button("Local dev server") { draftURL = AppModel.localBaseURL.absoluteString; apply() }
            }
            Section("Session") {
                LabeledContent("Host", value: model.host)
                LabeledContent("Credential", value: credentialLabel)
                if model.phase == .signedIn {
                    Button("Sign out", role: .destructive) {
                        Task { await model.signOut(); dismiss() }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .onAppear { draftURL = model.baseURL.absoluteString }
        #if os(iOS)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        #endif
    }

    private var credentialLabel: String {
        switch model.credential {
        case .bearer(let token): "Session token (\(token.prefix(6))…)"
        case .apiKey: "API key"
        case nil: "None"
        }
    }

    private func apply() {
        guard let url = URL(string: draftURL) else { return }
        model.baseURL = url
    }
}

#Preview {
    NavigationStack { SettingsView() }.environment(PreviewFixtures.signedInModel())
}
