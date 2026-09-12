import CubbyKit
import SwiftUI

/// Base URL and session. On iOS it is a sheet from Login and a Dev-tab row; on macOS the
/// Settings scene. The one screen that stays a `Form`: it is a settings form, and pretending
/// otherwise would cost the platform's own field behaviour for nothing.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draftURL = ""

    private var isCurrentHost: Bool {
        URL(string: draftURL) == nil || draftURL == model.baseURL.absoluteString
    }

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                TextField("Base URL", text: $draftURL)
                    .keyboardDismissBar()
                    .font(.porcelainCode)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    #endif
                    .onSubmit(apply)
                    .frame(minHeight: PorcelainTokens.touchTarget - 12)
                Button(action: apply) {
                    Text(isCurrentHost ? "Already in use" : "Use this server")
                        .font(.porcelainBody)
                        .frame(minHeight: PorcelainTokens.touchTarget - 12)
                }
                .disabled(isCurrentHost)
                Button {
                    draftURL = AppModel.productionBaseURL.absoluteString
                    apply()
                } label: {
                    serverChoice("Production", host: CubbyBaseURL.host(of: AppModel.productionBaseURL))
                }
                Button {
                    draftURL = AppModel.localBaseURL.absoluteString
                    apply()
                } label: {
                    serverChoice("Local dev server", host: CubbyBaseURL.host(of: AppModel.localBaseURL))
                }
            } header: {
                Eyebrow("Server")
            } footer: {
                Text("Each host keeps its own credential, so switching never sends one server's token to another.")
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }

            Section {
                LabeledContent("Host") {
                    Text(model.host).font(.porcelainCode)
                }
                .frame(minHeight: PorcelainTokens.touchTarget - 12)
                LabeledContent("Credential") {
                    Text(model.credentialSummary).font(.porcelainData)
                }
                .frame(minHeight: PorcelainTokens.touchTarget - 12)
                if model.phase == .signedIn {
                    Button("Sign out", role: .destructive) {
                        Task {
                            await model.signOut()
                            dismiss()
                        }
                    }
                    .frame(minHeight: PorcelainTokens.touchTarget - 12)
                }
            } header: {
                Eyebrow("Session")
            }
        }
        .formStyle(.grouped)
        .font(.porcelainBody)
        .porcelainScreen()
        .navigationTitle("Settings")
        .onAppear { draftURL = model.baseURL.absoluteString }
        #if os(iOS)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        #endif
    }

    private func serverChoice(_ title: String, host: String) -> some View {
        HStack(spacing: PorcelainTokens.Space.md) {
            Text(title).font(.porcelainBody)
            Spacer(minLength: PorcelainTokens.Space.sm)
            Text(host)
                .font(.porcelainCode)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
            if host == model.host {
                Image(systemName: "checkmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(PorcelainTokens.cobalt)
            }
        }
        .frame(minHeight: PorcelainTokens.touchTarget - 12)
    }

    private func apply() {
        guard let url = URL(string: draftURL) else { return }
        model.baseURL = url
    }
}

extension AppModel {
    /// One phrase for "what are we authenticating with", shown on Today and in Settings.
    var credentialSummary: String {
        switch credential {
        case .bearer(let token): "Session token (\(token.prefix(6))…)"
        case .apiKey: "API key"
        case nil: "None"
        }
    }
}

#Preview {
    NavigationStack { SettingsView() }.environment(PreviewFixtures.signedInModel())
}
