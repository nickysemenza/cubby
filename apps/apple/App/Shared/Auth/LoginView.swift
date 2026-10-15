import CubbyKit
import SwiftUI

/// The one screen shown before a credential exists: a centered identity panel with password and
/// Google sign-in plus the host both methods will use.
struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @State private var submitting = false
    @State private var showServer = false
    @State private var webAuthentication = SystemWebAuthenticationSession()
    @FocusState private var focused: Field?

    private enum Field {
        case email
        case password
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ScrollView {
                VStack(spacing: FieldGuideTokens.Space.xl) {
                    Panel(padding: FieldGuideTokens.Space.xl, spacing: FieldGuideTokens.Space.lg) {
                        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                            Text("Cubby")
                                .font(.fieldGuideDisplay)
                                .tracking(-0.6)
                                .foregroundStyle(FieldGuideTokens.graphite)
                            Text("Household operating software")
                                .font(.fieldGuideBody)
                                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                        }

                        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
                            FieldBox(focused: focused == .email) {
                                TextField("Email", text: $email)
                                    .textContentType(.username)
                                    .autocorrectionDisabled()
                                    .focused($focused, equals: .email)
                                    #if os(iOS)
                                        .keyboardType(.emailAddress)
                                        .textInputAutocapitalization(.never)
                                    #endif
                                    .onSubmit { focused = .password }
                            }
                            FieldBox(focused: focused == .password) {
                                SecureField("Password", text: $password)
                                    .textContentType(.password)
                                    .focused($focused, equals: .password)
                                    .onSubmit { Task { await submit() } }
                            }
                            if let error = model.lastError {
                                Text(error)
                                    .font(.fieldGuideBody)
                                    .foregroundStyle(FieldGuideTokens.destructive)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .disabled(submitting)

                        Button {
                            Task { await submit() }
                        } label: {
                            Group {
                                if submitting {
                                    LoadingIndicator(label: "Signing in").controlSize(.small)
                                } else {
                                    Text("Sign in").font(.fieldGuideTitle)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget - 12)
                        }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.roundedRectangle(radius: FieldGuideTokens.radiusControl))
                        .tint(FieldGuideTokens.interaction)
                        .disabled(submitting || email.isEmpty || password.isEmpty)

                        HStack(spacing: FieldGuideTokens.Space.sm) {
                            Rectangle()
                                .fill(FieldGuideTokens.hairline)
                                .frame(maxWidth: .infinity, maxHeight: FieldGuideTokens.hairlineWidth)
                            Text("or")
                                .font(.fieldGuideLabel)
                                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                            Rectangle()
                                .fill(FieldGuideTokens.hairline)
                                .frame(maxWidth: .infinity, maxHeight: FieldGuideTokens.hairlineWidth)
                        }

                        Button {
                            Task { await submitGoogle() }
                        } label: {
                            Text("Continue with Google")
                                .font(.fieldGuideTitle)
                                .frame(
                                    maxWidth: .infinity,
                                    minHeight: FieldGuideTokens.touchTarget - 12
                                )
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.roundedRectangle(radius: FieldGuideTokens.radiusControl))
                        .tint(FieldGuideTokens.interaction)
                        .disabled(submitting)

                        Button {
                            showServer = true
                        } label: {
                            HStack(spacing: FieldGuideTokens.Space.xs) {
                                Text("Signing in to \(model.host)")
                                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                                Text("·").foregroundStyle(FieldGuideTokens.hairline)
                                Text("Change").foregroundStyle(FieldGuideTokens.interaction)
                            }
                            .font(.fieldGuideLabel)
                            .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget - 16)
                        }
                        .buttonStyle(.plain)
                        .disabled(submitting)
                    }
                    .frame(maxWidth: 420)
                }
                .frame(maxWidth: .infinity)
                .padding(FieldGuideTokens.Space.xl)
            }
            .fieldGuideScreen()
            .sheet(isPresented: $showServer) {
                NavigationStack { SettingsView() }.environment(model)
                    .nativeSheet(.editor)
            }
        }
    }

    private func submit() async {
        guard !submitting else { return }
        submitting = true
        defer { submitting = false }
        await model.signIn(email: email, password: password)
        if model.phase == .signedIn { password = "" }
    }

    private func submitGoogle() async {
        guard !submitting else { return }
        submitting = true
        defer { submitting = false }
        await model.signInWithGoogle { url in
            try await webAuthentication.authenticate(url: url)
        }
        if model.phase == .signedIn { password = "" }
    }
}

/// A 44pt white field with a hairline that turns ink on focus — a crisp boundary, never a glow.
private struct FieldBox<Content: View>: View {
    let focused: Bool
    @ViewBuilder let content: Content

    var body: some View {
        content
            .font(.fieldGuideBody)
            .textFieldStyle(.plain)
            .padding(.horizontal, FieldGuideTokens.Space.md)
            .frame(height: FieldGuideTokens.touchTarget)
            .background(
                RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl)
                    .fill(FieldGuideTokens.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl)
                    .strokeBorder(
                        focused ? FieldGuideTokens.interaction : FieldGuideTokens.hairline,
                        lineWidth: focused ? 2 : FieldGuideTokens.hairlineWidth
                    )
            )
    }
}

#Preview(traits: .modifier(SignedOutPreview())) {
    LoginView()
}
