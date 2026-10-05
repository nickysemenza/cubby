import Foundation

public struct BrowserBridgeVendorAccount: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String
    public let ledgerPartyID: String
    public let browser: BrowserChoice

    public init(id: String, label: String, ledgerPartyID: String, browser: BrowserChoice) {
        self.id = id
        self.label = label
        self.ledgerPartyID = ledgerPartyID
        self.browser = browser
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, browser
        case ledgerPartyID = "ledgerPartyId"
    }
}

public protocol BrowserBridgeVendorAccountListing: Sendable {
    func browserBridgeVendorAccounts() async throws -> [BrowserBridgeVendorAccount]
}

public actor URLSessionBrowserBridgeVendorAccountClient: BrowserBridgeVendorAccountListing {
    private struct ResponseBody: Decodable { let accounts: [BrowserBridgeVendorAccount] }
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

    public func browserBridgeVendorAccounts() async throws -> [BrowserBridgeVendorAccount] {
        let request = try await AuthenticatedSocketSupport.agentRequest(
            baseURL: baseURL, path: "/api/import/agent/accounts", credentials: credentials)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(ResponseBody.self, from: data).accounts
    }
}

public enum BrowserBridgeFleetStatus {
    public static func aggregate(
        _ statuses: some Sequence<BrowserBridgeConnectionStatus>
    ) -> BrowserBridgeConnectionStatus {
        let statuses = Array(statuses)
        guard !statuses.isEmpty else { return .disconnected }
        if statuses.contains(.connected) { return .connected }
        if statuses.contains(.connecting) { return .connecting }
        if let attempt = statuses.compactMap({ status -> Int? in
            if case .waitingToReconnect(let attempt) = status { return attempt }
            return nil
        }).max() {
            return .waitingToReconnect(attempt: attempt)
        }
        if let message = statuses.compactMap({ status -> String? in
            if case .failed(let message) = status { return message }
            return nil
        }).first {
            return .failed(message: message)
        }
        return .disconnected
    }
}

extension CubbyClient {
    /// Uploads the receipt photo the person confirmed for a hunt and attaches it as the hunt's
    /// evidence; the server queues its extraction once per `(huntId, imageId)`. Uploading starts
    /// only after that confirmation.
    public func submitConfirmedReceipt(_ file: PhotoFile, huntID: String) async throws {
        let prepared = try PreparedPhoto.prepare(file: file)
        let upload = try await PendingImageUpload(service: self).upload(prepared, entity: nil)
        try await markUploaded(upload.imageID)
        _ = try await submitReceiptEvidence(.init(huntId: huntID, imageId: upload.imageID))
    }
}
