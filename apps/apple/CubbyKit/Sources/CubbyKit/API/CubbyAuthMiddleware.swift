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
    private let observer: (any RequestObserver)?

    public init(credentials: CredentialProvider, observer: (any RequestObserver)? = nil) {
        self.credentials = credentials
        self.observer = observer
    }

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        let authentication = await credentials.requestState()
        Self.apply(authentication, to: &request.headerFields)

        let start = Date()
        let (response, responseBody) = try await next(request, body, baseURL)
        let ms = Date().timeIntervalSince(start) * 1000
        await credentials.processResponse(
            for: authentication,
            status: response.status.code,
            setAuthToken: response.headerFields[HTTPField.Name("set-auth-token")!],
            setCookieHeaders: response.headerFields[values: .setCookie],
            responseURL: baseURL
        )
        await observer?.record(operationID: operationID, ms: ms, status: Int(response.status.code))
        guard response.status.code >= 400 else { return (response, responseBody) }

        let data: Data
        if let responseBody {
            data = try await Data(collecting: responseBody, upTo: Self.maxErrorBodyBytes)
        } else {
            data = Data()
        }
        throw CubbyAPIError.decode(status: response.status.code, operationID: operationID, body: data)
    }

    /// Shared with `CubbyDebugClient` and `AuthFlow`, which do not go through
    /// OpenAPIRuntime.
    static func apply(_ credential: CubbyCredential?, to fields: inout HTTPFields) {
        switch credential {
        case .bearer(let token): fields[.authorization] = "Bearer \(token)"
        case .apiKey(let key): fields[.xAPIKey] = key
        case nil: break
        }
    }

    static func apply(_ state: CredentialProvider.RequestState, to fields: inout HTTPFields) {
        apply(state.credential, to: &fields)
        if case .bearer = state.credential {
            if !state.sessionDataCookies.isEmpty {
                fields[.cookie] = state.sessionDataCookies
                    .sorted { $0.key < $1.key }
                    .map { "\($0.key)=\($0.value)" }
                    .joined(separator: "; ")
            }
        }
    }
}
