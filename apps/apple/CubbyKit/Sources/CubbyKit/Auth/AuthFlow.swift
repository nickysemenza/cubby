import CryptoKit
import Foundation
import HTTPTypes
import Security

/// Bearer sign-in/sign-out against Better Auth. See `apps/apple/AGENTS.md` "Wire rules": every
/// `/api/auth/*` request needs `Origin: cubby-mobile://`, and a `set-auth-token` response header
/// that differs from the stored bearer always overwrites it, never the other way around.
public actor AuthFlow {
    public typealias WebAuthenticationHandler = @Sendable (URL) async throws -> URL

    public let baseURL: URL
    private let credentials: CredentialProvider
    private let session: URLSession

    public init(baseURL: URL, credentials: CredentialProvider, session: URLSession = .cubbyShared) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.session = session
    }

    /// Signs in with email + password, stores the returned bearer token, and returns it.
    public func signIn(email: String, password: String) async throws -> CubbyCredential {
        let authentication = await credentials.requestState()
        var request = URLRequest(url: baseURL.appending(path: "/api/auth/sign-in/email"))
        request.httpMethod = "POST"
        request.setValue("cubby-mobile://", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(
            SignInBody(email: email, password: password, rememberMe: true)
        )

        let (data, response) = try await session.data(for: request)
        return try await completeSignIn(data: data, response: response, for: authentication)
    }

    /// Signs in through Google's system-browser flow, then exchanges the PKCE-bound transfer code
    /// for the same signed Better Auth session bearer used by password sign-in.
    public func signInWithGoogle(
        authenticate: @escaping WebAuthenticationHandler
    ) async throws -> CubbyCredential {
        // Capture the credential revision before presenting the browser. A late callback must not
        // restore a session after sign-out, another sign-in, or a server change.
        let authentication = await credentials.requestState()
        let state = try Self.randomToken()
        let codeVerifier = try Self.randomToken()
        let codeChallenge = Self.base64URLEncoded(
            Data(SHA256.hash(data: Data(codeVerifier.utf8)))
        )

        var components = URLComponents(
            url: baseURL.appending(path: "/auth/native"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        guard let authorizationURL = components?.url else {
            throw AuthError.invalidCallback
        }

        let callbackURL = try await authenticate(authorizationURL)
        let transfer = try Self.transfer(from: callbackURL)
        guard transfer.state == state else { throw AuthError.stateMismatch }

        var request = URLRequest(url: baseURL.appending(path: "/api/auth/electron/token"))
        request.httpMethod = "POST"
        request.setValue("cubby-mobile://", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(
            GoogleTokenExchangeBody(
                token: transfer.identifier,
                state: state,
                codeVerifier: codeVerifier
            )
        )

        let (data, response) = try await session.data(for: request)
        return try await completeSignIn(data: data, response: response, for: authentication)
    }

    /// Signs out on the server, then always clears the stored credential — even if the request
    /// fails — so a dead session on the server never leaves a stale credential on the device.
    public func signOut() async throws {
        let authentication = await credentials.requestState()
        var request = URLRequest(url: baseURL.appending(path: "/api/auth/sign-out"))
        request.httpMethod = "POST"
        request.setValue("cubby-mobile://", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var fields = HTTPFields()
        CubbyAuthMiddleware.apply(authentication, to: &fields)
        for field in fields {
            request.setValue(field.value, forHTTPHeaderField: field.name.rawName)
        }
        request.httpBody = try JSONEncoder().encode(JSONValue.object([:]))

        do {
            let (data, response) = try await session.data(for: request)
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                await credentials.invalidate(for: authentication)
                throw Self.error(for: status, body: data)
            }
            await credentials.invalidate(for: authentication)
        } catch {
            await credentials.invalidate(for: authentication)
            throw error
        }
    }

    private static func setCookieHeaders(from response: HTTPURLResponse) -> [String] {
        response.allHeaderFields.compactMap { key, value -> [String]? in
            guard String(describing: key).caseInsensitiveCompare("Set-Cookie") == .orderedSame
            else { return nil }
            if let values = value as? [String] { return values }
            return [String(describing: value)]
        }.flatMap { $0 }
    }

    private func completeSignIn(
        data: Data, response: URLResponse, for authentication: CredentialProvider.RequestState
    ) async throws -> CubbyCredential {
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        guard status == 200, let http else {
            throw Self.error(for: status, body: data)
        }
        // The exchange JSON contains Better Auth's raw database session token. Only the signed
        // bearer echoed by the bearer plugin is an accepted native credential.
        guard let token = http.value(forHTTPHeaderField: "set-auth-token") else {
            throw AuthError.missingToken
        }
        let credential = CubbyCredential.bearer(token)
        guard
            try await credentials.completeSignIn(
                credential,
                for: authentication,
                setCookieHeaders: Self.setCookieHeaders(from: http),
                responseURL: http.url ?? baseURL
            )
        else {
            throw AuthError.superseded
        }
        return credential
    }

    private static func transfer(from callbackURL: URL) throws -> GoogleTransfer {
        guard
            callbackURL.scheme?.lowercased() == "cubby",
            callbackURL.host?.lowercased() == "auth",
            callbackURL.path == "/callback",
            let fragment = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.fragment,
            let token = URLComponents(string: "?\(fragment)")?.queryItems?.first(where: {
                $0.name == "token"
            })?.value,
            let data = Data(base64URLEncoded: token),
            let transfer = try? JSONDecoder().decode(GoogleTransfer.self, from: data),
            !transfer.identifier.isEmpty,
            !transfer.state.isEmpty
        else {
            throw AuthError.invalidCallback
        }
        return transfer
    }

    private static func randomToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw AuthError.randomGenerationFailed
        }
        return base64URLEncoded(Data(bytes))
    }

    private static func base64URLEncoded(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func error(for status: Int, body: Data) -> AuthError {
        switch status {
        case 401: return .invalidCredentials
        case 403: return .originRejected
        case 429: return .rateLimited
        default: return .http(status: status, body: String(decoding: body, as: UTF8.self))
        }
    }
}

private struct SignInBody: Encodable {
    let email: String
    let password: String
    let rememberMe: Bool
}

private struct GoogleTokenExchangeBody: Encodable {
    let token: String
    let state: String
    let codeVerifier: String

    enum CodingKeys: String, CodingKey {
        case token, state
        case codeVerifier = "code_verifier"
    }
}

private struct GoogleTransfer: Decodable {
    let identifier: String
    let state: String
}

private extension Data {
    init?(base64URLEncoded value: String) {
        let normalized = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        self.init(base64Encoded: normalized + padding)
    }
}

public enum AuthError: Error, Sendable, Equatable {
    /// The server returned 200 but no `set-auth-token` header.
    case missingToken
    case invalidCredentials
    case originRejected
    case rateLimited
    case superseded
    case cancelled
    case invalidCallback
    case stateMismatch
    case randomGenerationFailed
    case browserUnavailable
    case http(status: Int, body: String)

    public var message: String {
        switch self {
        case .missingToken:
            return "Sign-in succeeded but the server did not return a session token."
        case .invalidCredentials:
            return "Incorrect email or password."
        case .originRejected:
            return "The server rejected this app's origin."
        case .rateLimited:
            return "Too many sign-in attempts. Wait a moment and try again."
        case .superseded:
            return "Your authentication state changed before sign-in completed."
        case .cancelled:
            return "Google sign-in was cancelled."
        case .invalidCallback:
            return "Google sign-in returned an invalid response."
        case .stateMismatch:
            return "Google sign-in could not verify the browser response."
        case .randomGenerationFailed:
            return "Google sign-in could not create a secure request."
        case .browserUnavailable:
            return "Google sign-in could not open the system browser."
        case .http(let status, let body):
            return "HTTP \(status): \(body)"
        }
    }
}
