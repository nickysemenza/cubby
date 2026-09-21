import AuthenticationServices
import CubbyKit
import Foundation

#if os(iOS)
    import UIKit
#elseif os(macOS)
    import AppKit
#endif

/// Owns the system-browser session for one interactive sign-in. The authentication protocol and
/// credential exchange stay in CubbyKit; this app-layer type supplies only Apple's presentation.
@MainActor
final class SystemWebAuthenticationSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authenticate(url: URL) async throws -> URL {
        guard session == nil else { throw AuthError.browserUnavailable }

        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: "cubby"
            ) { [weak self] callbackURL, error in
                let result: Result<URL, AuthError>
                if let callbackURL {
                    result = .success(callbackURL)
                } else if let error = error as? ASWebAuthenticationSessionError,
                    error.code == .canceledLogin
                {
                    result = .failure(.cancelled)
                } else {
                    result = .failure(.browserUnavailable)
                }
                Task { @MainActor [weak self] in
                    self?.session = nil
                    continuation.resume(with: result)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            guard session.start() else {
                self.session = nil
                continuation.resume(throwing: AuthError.browserUnavailable)
                return
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(iOS)
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
            return scene?.windows.first(where: \.isKeyWindow) ?? scene?.windows.first
                ?? ASPresentationAnchor()
        #else
            return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first
                ?? ASPresentationAnchor()
        #endif
    }
}
