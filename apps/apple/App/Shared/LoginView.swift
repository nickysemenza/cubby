import CubbyKit
import SwiftUI

/// The one screen shown before a credential exists. A single centered working plane on the canvas:
/// identity, two fields, one primary action, and the host it will talk to — nothing else.
struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    @State private var submitting = false
    @State private var showServer = false
    @FocusState private var focused: Field?

    private enum Field {
        case email
        case password
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ScrollView {
                VStack(spacing: PorcelainTokens.Space.xl) {
                    Panel(padding: PorcelainTokens.Space.xl, spacing: PorcelainTokens.Space.lg) {
                        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                            Text("Cubby")
                                .font(.porcelainDisplay)
                                .tracking(-0.6)
                                .foregroundStyle(PorcelainTokens.graphite)
                            Text("Household operating software")
                                .font(.porcelainBody)
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        }

                        VStack(alignment: .leading, spacing: PorcelainTokens.Space.md) {
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
                                    .font(.porcelainBody)
                                    .foregroundStyle(PorcelainTokens.destructive)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }

                        Button {
                            Task { await submit() }
                        } label: {
                            Group {
                                if submitting {
                                    LoadingIndicator(label: "Signing in").controlSize(.small)
                                } else {
                                    Text("Sign in").font(.porcelainTitle)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: PorcelainTokens.touchTarget - 12)
                        }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.roundedRectangle(radius: PorcelainTokens.radiusControl))
                        .tint(PorcelainTokens.cobalt)
                        .disabled(submitting || email.isEmpty || password.isEmpty)

                        Button {
                            showServer = true
                        } label: {
                            HStack(spacing: PorcelainTokens.Space.xs) {
                                Text("Signing in to \(model.host)")
                                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                                Text("·").foregroundStyle(PorcelainTokens.hairline)
                                Text("Change").foregroundStyle(PorcelainTokens.cobalt)
                            }
                            .font(.porcelainLabel)
                            .frame(maxWidth: .infinity, minHeight: PorcelainTokens.touchTarget - 16)
                        }
                        .buttonStyle(.plain)
                    }
                    .frame(maxWidth: 420)
                }
                .frame(maxWidth: .infinity)
                .padding(PorcelainTokens.Space.xl)
            }
            .porcelainScreen()
            .sheet(isPresented: $showServer) {
                NavigationStack { SettingsView() }.environment(model)
                    #if os(macOS)
                        .frame(minWidth: 480, minHeight: 480)
                    #endif
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

/// A 44pt white field with a hairline that turns cobalt on focus — a crisp boundary, never a glow.
private struct FieldBox<Content: View>: View {
    let focused: Bool
    @ViewBuilder let content: Content

    var body: some View {
        content
            .font(.porcelainBody)
            .textFieldStyle(.plain)
            .padding(.horizontal, PorcelainTokens.Space.md)
            .frame(height: PorcelainTokens.touchTarget)
            .background(
                RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl)
                    .fill(PorcelainTokens.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl)
                    .strokeBorder(
                        focused ? PorcelainTokens.cobalt : PorcelainTokens.hairline,
                        lineWidth: focused ? 2 : PorcelainTokens.hairlineWidth
                    )
            )
    }
}

#Preview {
    LoginView().environment(PreviewFixtures.signedOutModel())
}
