import CubbyKit
import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @State private var submitting = false
    @State private var showServer = false

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    TextField("Email", text: $email)
                        .textContentType(.username)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        #endif
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .onSubmit { Task { await submit() } }
                } header: {
                    Text("Sign in to \(model.host)")
                } footer: {
                    if let error = model.lastError {
                        Text(error).foregroundStyle(PorcelainTokens.destructive)
                    }
                }
                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        if submitting {
                            ProgressView()
                        } else {
                            Text("Sign in").frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(submitting || email.isEmpty || password.isEmpty)
                    .buttonStyle(.borderedProminent)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Cubby")
            .toolbar {
                ToolbarItem {
                    Button("Server", systemImage: "server.rack") { showServer = true }
                }
            }
            .sheet(isPresented: $showServer) {
                SettingsView().environment(model)
            }
        }
    }

    private func submit() async {
        submitting = true
        defer { submitting = false }
        await model.signIn(email: email, password: password)
        if model.phase == .signedIn { password = "" }
    }
}

#Preview {
    LoginView().environment(PreviewFixtures.signedOutModel())
}
