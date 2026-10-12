import Foundation

/// A `cubby://cli-auth` request: the loopback port a `cubby auth login` listener waits on, plus
/// the nonce that authenticates it. The app confirms with the user, then POSTs its bearer token
/// to that listener; the nonce keeps a different local process from harvesting the approval.
public struct CliAuthRequest: Sendable, Hashable, Equatable {
    public let port: UInt16
    public let nonce: String

    public init(port: UInt16, nonce: String) {
        self.port = port
        self.nonce = nonce
    }

    /// 32 random bytes as base64url — the same shape as the ChatGPT attempt's `random()`.
    public static func makeNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Base64url, bounded so a link cannot smuggle an unbounded string into the handoff.
    public static func isValidNonce(_ raw: String) -> Bool {
        guard (20...128).contains(raw.count) else { return false }
        return raw.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }
}

/// Canonical `scheme://host[:port]` server identity. The handoff carries the app's origin so the
/// CLI never files the token under a different `--base-url` host.
public enum CliAuthOrigin {
    public static func of(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), !scheme.isEmpty,
            let host = url.host()?.lowercased(), !host.isEmpty
        else { return nil }
        if let port = url.port { return "\(scheme)://\(host):\(port)" }
        return "\(scheme)://\(host)"
    }
}

/// The JSON body the app POSTs to the CLI's loopback listener. CubbyKit-internal: the CLI and
/// the app only touch it through `CliAuthLoopbackHandoff` and `CliAuthSender`.
struct CliAuthHandoffPayload: Sendable, Codable {
    let token: String
    let nonce: String
    let origin: String
}

public enum CliAuthOriginError: Error, Sendable, LocalizedError {
    case emptyToken
    case mismatch(expected: String, received: String)

    public var errorDescription: String? {
        switch self {
        case .emptyToken:
            return "The Cubby app handed over an empty credential."
        case .mismatch(let expected, let received):
            return
                "The Cubby app is signed in to \(received), but this CLI targets \(expected). Switch one of them to the same server and try again."
        }
    }
}

public enum CliAuthSenderError: Error, Sendable, LocalizedError {
    case invalidResponse
    case server(status: Int, body: String)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The CLI did not answer the sign-in handoff."
        case .server(let status, let body):
            return "The CLI refused the sign-in handoff (HTTP \(status)): \(body)"
        }
    }
}

/// POSTs this app's bearer token to a waiting `cubby auth login` listener. The token is a copy:
/// the CLI keeps its own file-store entry, so a CLI 401 clears only the CLI's stored credential —
/// but `auth logout` also revokes the session on the server, which signs the app out there too.
public enum CliAuthSender {
    public static func post(
        token: String, to port: UInt16, nonce: String, origin: String,
        session: URLSession = .shared
    ) async throws {
        var request = URLRequest(
            url: URL(string: "http://127.0.0.1:\(port)/handoff")!, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            CliAuthHandoffPayload(token: token, nonce: nonce, origin: origin))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CliAuthSenderError.invalidResponse
        }
        guard http.statusCode == 200 else {
            throw CliAuthSenderError.server(
                status: http.statusCode, body: String(decoding: data, as: UTF8.self))
        }
    }
}
