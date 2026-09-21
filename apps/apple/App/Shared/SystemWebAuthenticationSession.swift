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
final class SystemWebAuthenticationSession {
    private var session: ASWebAuthenticationSession?
    private var presentationContext: PresentationContext?

    func authenticate(url: URL) async throws -> URL {
        guard session == nil else { throw AuthError.browserUnavailable }
        guard let anchor = Self.currentAnchor else { throw AuthError.browserUnavailable }
        let presentationContext = PresentationContext(anchor: anchor)

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
                    self?.presentationContext = nil
                    continuation.resume(with: result)
                }
            }
            session.presentationContextProvider = presentationContext
            session.prefersEphemeralWebBrowserSession = false
            self.presentationContext = presentationContext
            self.session = session
            guard session.start() else {
                self.session = nil
                self.presentationContext = nil
                continuation.resume(throwing: AuthError.browserUnavailable)
                return
            }
        }
    }

    private static var currentAnchor: ASPresentationAnchor? {
        #if os(iOS)
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
            return scene?.windows.first(where: \.isKeyWindow) ?? scene?.windows.first
        #else
            return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first
        #endif
    }

    /// ASWebAuthenticationSession holds its provider weakly; retain the selected window until
    /// completion so scene changes cannot replace the anchor while sign-in is presented.
    private final class PresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
        let anchor: ASPresentationAnchor

        init(anchor: ASPresentationAnchor) {
            self.anchor = anchor
        }

        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            anchor
        }
    }
}
