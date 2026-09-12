import Foundation
import HTTPTypes
import OpenAPIRuntime

extension HTTPField.Name {
    /// Better Auth's API-key header, used by the CLI harness. Force-unwrap is safe: the literal is
    /// a valid token.
    public static let xAPIKey = HTTPField.Name("x-api-key")!
}

/// The one place credentials are attached and errors are decoded for the typed client.
///
/// Every error body in the API shares the `ErrorEnvelope` shape, so a single middleware can turn
/// any status >= 400 into a `CubbyAPIError` and per-operation code never sees the `ok: false`
/// branch. A 401 also invalidates the credential so the app returns to LoginView.
public struct CubbyAuthMiddleware: ClientMiddleware {
    public static let maxErrorBodyBytes = 1 << 20

    private let credentials: CredentialProvider

    public init(credentials: CredentialProvider) {
        self.credentials = credentials
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        Self.apply(await credentials.current(), to: &request.headerFields)

        let (response, responseBody) = try await next(request, body, baseURL)
        guard response.status.code >= 400 else { return (response, responseBody) }

        if response.status.code == 401 { await credentials.invalidate() }
        let data: Data
        if let responseBody {
            data = try await Data(collecting: responseBody, upTo: Self.maxErrorBodyBytes)
        } else {
            data = Data()
        }
        throw CubbyAPIError.decode(status: response.status.code, operationID: operationID, body: data)
    }

    /// Shared with `CubbyRawClient`, which does not go through OpenAPIRuntime.
    static func apply(_ credential: CubbyCredential?, to fields: inout HTTPFields) {
        switch credential {
        case .bearer(let token): fields[.authorization] = "Bearer \(token)"
        case .apiKey(let key): fields[.xAPIKey] = key
        case nil: break
        }
    }
}
