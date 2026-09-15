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
/// Every error status in the API carries the same `ApiError` body, so a single middleware can
/// turn any status >= 400 into a `CubbyAPIError` and per-operation code never has to reach for
/// the generated `default` response. A 401 also invalidates the credential so the app returns to
/// LoginView.
public struct CubbyAuthMiddleware: ClientMiddleware {
    public static let maxErrorBodyBytes = 1 << 20

    private let credentials: CredentialProvider
    private let now: @Sendable () -> Date

    public init(credentials: CredentialProvider, now: @escaping @Sendable () -> Date = Date.init) {
        self.credentials = credentials
        self.now = now
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        Self.apply(await credentials.requestState(at: now()), to: &request.headerFields)

        let (response, responseBody) = try await next(request, body, baseURL)
        await credentials.updateSessionDataCookies(
            from: response.headerFields[values: .setCookie]
        )
        if let value = response.headerFields[.xCubbyFreshReadSeconds], let seconds = Int(value) {
            await credentials.markFreshReads(seconds: seconds, now: now())
        }
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

    /// Shared with `CubbyDebugClient` and `PresignedUpload`, which do not go through
    /// OpenAPIRuntime.
    static func apply(_ credential: CubbyCredential?, to fields: inout HTTPFields) {
        switch credential {
        case .bearer(let token): fields[.authorization] = "Bearer \(token)"
        case .apiKey(let key): fields[.xAPIKey] = key
        case nil: break
        }
    }

    static func apply(_ state: CubbyAuthState?, to fields: inout HTTPFields) {
        apply(state?.credential, to: &fields)
        guard let state, case .bearer = state.credential else { return }
        if !state.sessionDataCookies.isEmpty {
            fields[.cookie] = state.sessionDataCookies
                .sorted { $0.key < $1.key }
                .map { "\($0.key)=\($0.value)" }
                .joined(separator: "; ")
        }
        if state.freshReadUntil != nil { fields[.xCubbyFreshRead] = "1" }
    }
}

extension HTTPField.Name {
    static let xCubbyFreshRead = HTTPField.Name("x-cubby-fresh-read")!
    static let xCubbyFreshReadSeconds = HTTPField.Name("x-cubby-fresh-read-seconds")!
}
