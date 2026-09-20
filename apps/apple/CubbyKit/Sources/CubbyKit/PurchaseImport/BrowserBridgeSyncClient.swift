import Foundation

public struct BrowserBridgeSyncRequest: Codable, Sendable, Hashable {
    public let vendorAccount: String

    public init(vendorAccount: String) {
        self.vendorAccount = vendorAccount
    }
}

public struct BrowserBridgeSyncResponse: Codable, Sendable, Hashable {
    public let runID: String
    public let resumed: Bool

    public init(runID: String, resumed: Bool) {
        self.runID = runID
        self.resumed = resumed
    }

    private enum CodingKeys: String, CodingKey {
        case runID = "runId"
        case resumed
    }
}

public protocol BrowserBridgeSyncRequesting: Sendable {
    func requestSync(vendorAccountID: String) async throws -> BrowserBridgeSyncResponse
}

public actor URLSessionBrowserBridgeSyncClient: BrowserBridgeSyncRequesting {
    public struct Failure: LocalizedError, Sendable {
        public let status: Int
        public let message: String

        public var errorDescription: String? { message }

        public init(status: Int, message: String) {
            self.status = status
            self.message = message
        }
    }

    private struct ErrorBody: Decodable { let error: String }

    private let baseURL: URL
    private let credentials: CredentialProvider
    private let session: URLSession

    public init(
        baseURL: URL, credentials: CredentialProvider, session: URLSession = .cubbyShared
    ) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.session = session
    }

    public func requestSync(vendorAccountID: String) async throws -> BrowserBridgeSyncResponse {
        guard case .bearer(let token) = await credentials.current(), !token.isEmpty else {
            throw Failure(status: 401, message: "A signed-in Cubby session is required.")
        }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw Failure(status: 0, message: "The Cubby server URL is invalid.")
        }
        components.path = "/api/import/agent/sync"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else {
            throw Failure(status: 0, message: "The Cubby server URL is invalid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            BrowserBridgeSyncRequest(vendorAccount: vendorAccountID))
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message =
                (try? JSONDecoder().decode(ErrorBody.self, from: data).error)
                ?? "Browser sync failed with HTTP \(status)."
            throw Failure(status: status, message: message)
        }
        return try JSONDecoder().decode(BrowserBridgeSyncResponse.self, from: data)
    }
}
