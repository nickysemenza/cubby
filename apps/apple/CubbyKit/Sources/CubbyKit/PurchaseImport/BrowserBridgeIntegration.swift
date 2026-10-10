import Foundation

public protocol BrowserBridgeVendorAccountListing: Sendable {
    func browserBridgeVendorAccounts() async throws -> [BrowserBridgeVendorAccount]
}

public actor URLSessionBrowserBridgeVendorAccountClient: BrowserBridgeVendorAccountListing {
    private let client: CubbyClient

    public init(
        baseURL: URL, credentials: CredentialProvider, session: URLSession = .cubbyShared
    ) {
        client = CubbyClient(baseURL: baseURL, credentials: credentials, session: session)
    }

    public func browserBridgeVendorAccounts() async throws -> [BrowserBridgeVendorAccount] {
        try await client.browserBridgeAccounts().accounts
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
