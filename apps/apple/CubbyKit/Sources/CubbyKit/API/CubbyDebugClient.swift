import Foundation

/// The CLI's raw JSON escape hatch, using the same HTTP transport as typed native calls.
public actor CubbyDebugClient {
    public let baseURL: URL
    private let transport: NativeHTTPTransport

    public init(
        baseURL: URL, credentials: CredentialProvider, identity: ClientIdentity = .unknown,
        session: URLSession = .cubbyShared
    ) {
        self.baseURL = baseURL
        self.transport = NativeHTTPTransport(
            baseURL: baseURL, credentials: credentials, identity: identity,
            session: session, observer: nil)
    }

    /// Literal scalar query values; repeat a key for an array. Response bytes are retained.
    public func call(
        _ route: OperationRoute,
        query: [(String, String)] = [],
        body: Data? = nil
    ) async throws -> Data {
        try await transport.send(route: route, query: query, body: body)
    }
}
