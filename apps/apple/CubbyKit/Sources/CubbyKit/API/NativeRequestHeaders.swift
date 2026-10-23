import Foundation
import HTTPTypes

extension HTTPField.Name {
    /// Better Auth's API-key header, used by the CLI harness. Force-unwrap is safe: the literal is
    /// a valid token.
    public static let xAPIKey = HTTPField.Name("x-api-key")!
    /// This install's id, echoed on every request alongside the identity `User-Agent`.
    public static let xCubbyDevice = HTTPField.Name("x-cubby-device")!
}

/// Shared authentication and identity headers for HTTP and socket handshakes.
enum NativeRequestHeaders {
    static func apply(_ credential: CubbyCredential?, identity: ClientIdentity, to fields: inout HTTPFields) {
        switch credential {
        case .bearer(let token): fields[.authorization] = "Bearer \(token)"
        case .apiKey(let key): fields[.xAPIKey] = key
        case nil: break
        }
        apply(identity, to: &fields)
    }

    static func apply(
        _ state: CredentialProvider.RequestState, identity: ClientIdentity, to fields: inout HTTPFields
    ) {
        apply(state.credential, identity: identity, to: &fields)
        if case .bearer = state.credential {
            if !state.sessionDataCookies.isEmpty {
                fields[.cookie] = state.sessionDataCookies
                    .sorted { $0.key < $1.key }
                    .map { "\($0.key)=\($0.value)" }
                    .joined(separator: "; ")
            }
        }
    }

    private static func apply(_ identity: ClientIdentity, to fields: inout HTTPFields) {
        fields[.userAgent] = identity.userAgent
        if let installationID = identity.installationID {
            fields[.xCubbyDevice] = installationID.uuidString.lowercased()
        }
    }
}
