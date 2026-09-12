import Foundation
import HTTPTypes

/// Bearer sign-in/sign-out against Better Auth. See `apps/apple/CLAUDE.md` "Wire rules": every
/// `/api/auth/*` request needs `Origin: cubby-mobile://`, and a `set-auth-token` response header
/// that differs from the stored bearer always overwrites it, never the other way around.
public actor AuthFlow {
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
        var request = URLRequest(url: baseURL.appending(path: "/api/auth/sign-in/email"))
        request.httpMethod = "POST"
        request.setValue("cubby-mobile://", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(
            SignInBody(email: email, password: password, rememberMe: true)
        )

        let (data, response) = try await session.data(for: request)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        guard status == 200, let http else {
            throw Self.error(for: status, body: data)
        }
        guard let token = http.value(forHTTPHeaderField: "set-auth-token") else {
            throw AuthError.missingToken
        }
        let credential = CubbyCredential.bearer(token)
        try await credentials.set(credential)
        // Idempotent given the token we just stored, but keeps sign-in and sign-out sharing one
        // "did the server hand us a different token" code path.
        await refreshTokenIfRotated(from: http)
        return credential
    }

    /// Signs out on the server, then always clears the stored credential — even if the request
    /// fails — so a dead session on the server never leaves a stale credential on the device.
    public func signOut() async throws {
        var request = URLRequest(url: baseURL.appending(path: "/api/auth/sign-out"))
        request.httpMethod = "POST"
        request.setValue("cubby-mobile://", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var fields = HTTPFields()
        CubbyAuthMiddleware.apply(await credentials.current(), to: &fields)
        for field in fields {
            request.setValue(field.value, forHTTPHeaderField: field.name.rawName)
        }
        request.httpBody = try JSONEncoder().encode(JSONValue.object([:]))

        do {
            let (data, response) = try await session.data(for: request)
            let http = response as? HTTPURLResponse
            if let http { await refreshTokenIfRotated(from: http) }
            let status = http?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                await credentials.invalidate()
                throw Self.error(for: status, body: data)
            }
            await credentials.invalidate()
        } catch {
            await credentials.invalidate()
            throw error
        }
    }

    /// If the response carries a `set-auth-token` that differs from the currently stored bearer,
    /// overwrite it. Best-effort: a Keychain write failure here is not worth failing sign-in/out over.
    private func refreshTokenIfRotated(from response: HTTPURLResponse) async {
        guard let token = response.value(forHTTPHeaderField: "set-auth-token") else { return }
        if case .bearer(let current) = await credentials.current(), current == token { return }
        try? await credentials.set(.bearer(token))
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

public enum AuthError: Error, Sendable, Equatable {
    /// The server returned 200 but no `set-auth-token` header.
    case missingToken
    case invalidCredentials
    case originRejected
    case rateLimited
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
        case .http(let status, let body):
            return "HTTP \(status): \(body)"
        }
    }
}
