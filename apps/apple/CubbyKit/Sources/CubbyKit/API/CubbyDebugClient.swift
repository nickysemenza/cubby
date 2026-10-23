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

    /// Sends a JSON input value and retains the operation's JSON response bytes.
    public func call(
        operationID: String,
        input: Data? = nil,
        nullInput: Bool = false
    ) async throws -> Data {
        try await transport.send(operationID: operationID, body: input, nullInput: nullInput)
    }
}
