import Foundation
import HTTPTypes

extension NativeWorkspaceSession {
    /// This browser-session endpoint is distinct from generated entity operations. Credentials
    /// remain in URLSession, and redirects are refused before they can carry auth to another host.
    public static func bootstrap(
        baseURL: URL, credentials: CredentialProvider, identity: ClientIdentity,
        observer: (any RequestObserver)? = nil, expectedRevision: Int
    ) async throws -> [HTTPCookie] {
        let policy = NativeWorkspacePolicy(baseURL: baseURL)
        let state = await credentials.requestState()
        guard await credentials.authenticationRevision() == expectedRevision else {
            throw CancellationError()
        }
        guard case .bearer = state.credential else { throw URLError(.userAuthenticationRequired) }
        var fields = HTTPFields()
        CubbyAuthMiddleware.apply(state.credential, identity: identity, to: &fields)
        var request = URLRequest(url: baseURL.appending(path: "api/native-workspace/session"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("cubby-mobile://", forHTTPHeaderField: "Origin")
        for field in fields { request.setValue(field.value, forHTTPHeaderField: field.name.rawName) }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        let session = URLSession(configuration: config, delegate: NoWorkspaceRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let start = Date()
        let (data, rawResponse) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let response = rawResponse as? HTTPURLResponse, let url = response.url, policy.trusts(url)
        else { throw URLError(.badServerResponse) }
        guard await credentials.authenticationRevision() == expectedRevision else {
            throw CancellationError()
        }
        await observer?.record(
            operationID: "nativeWorkspace.session", ms: Date().timeIntervalSince(start) * 1000,
            status: response.statusCode)
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, item in
            result[String(describing: item.key)] = String(describing: item.value)
        }
        guard await credentials.authenticationRevision() == expectedRevision else {
            throw CancellationError()
        }
        guard (200..<300).contains(response.statusCode) else {
            throw NativeWorkspaceError.bootstrap(response.statusCode, String(decoding: data, as: UTF8.self))
        }
        // A late response may not revive a signed-out account in WebKit.
        guard await credentials.authenticationRevision() == expectedRevision else {
            throw CancellationError()
        }
        return try cookies(data: data, response: response, policy: policy, headers: headers)
    }

}

private final class NoWorkspaceRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? { nil }
}
