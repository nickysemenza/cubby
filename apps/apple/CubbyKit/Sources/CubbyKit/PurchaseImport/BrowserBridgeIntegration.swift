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

    init?(_ row: EntityRow) {
        guard let status = row.raw["status"]?.stringValue,
            status == "active" || status == "paused_auth" || status == "paused_offline",
            let ledgerPartyID = row.raw["ledgerPartyId"]?.stringValue,
            let browserName = row.raw["browser"]?.stringValue,
            let browser = BrowserChoice(rawValue: browserName)
        else { return nil }
        self.init(id: row.id, label: row.title, ledgerPartyID: ledgerPartyID, browser: browser)
    }
}

public protocol BrowserBridgeVendorAccountListing: Sendable {
    func browserBridgeVendorAccounts() async throws -> [BrowserBridgeVendorAccount]
}

extension CubbyClient: BrowserBridgeVendorAccountListing {
    public func browserBridgeVendorAccounts() async throws -> [BrowserBridgeVendorAccount] {
        let pageSize = 500
        var pageNumber = 1
        var accounts: [BrowserBridgeVendorAccount] = []
        repeat {
            let page = try await list(
                EntityCatalog[.vendorAccount], page: pageNumber, pageSize: pageSize, sort: "label",
                filters: EntityFilterState([
                    "status": .many(["active", "paused_auth", "paused_offline"])
                ]))
            accounts.append(contentsOf: page.items.compactMap(BrowserBridgeVendorAccount.init))
            guard accounts.count < page.meta.totalCount else { break }
            pageNumber += 1
        } while true
        return accounts
    }
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
        guard case .bearer(let token) = await credentials.current(), !token.isEmpty else {
            throw URLError(.userAuthenticationRequired)
        }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw URLError(.badURL)
        }
        components.path = "/api/import/agent/accounts"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(ResponseBody.self, from: data).accounts
    }
}

public enum BrowserBridgeEndpoint {
    public enum Failure: Error, Equatable, Sendable {
        case invalidBaseURL
        case insecureRemoteServer
    }

    public static func socketURL(baseURL: URL, vendorAccountID: String) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
            let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased()
        else { throw Failure.invalidBaseURL }
        switch scheme {
        case "https": components.scheme = "wss"
        case "http" where host == "localhost" || host == "127.0.0.1" || host == "::1":
            components.scheme = "ws"
        default: throw Failure.insecureRemoteServer
        }
        components.path = "/api/import/agent/socket"
        components.queryItems = [URLQueryItem(name: "vendorAccount", value: vendorAccountID)]
        components.fragment = nil
        guard let url = components.url else { throw Failure.invalidBaseURL }
        return url
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

/// The client-side handoff after the user explicitly confirms a nearby or manually picked photo.
/// Implementations may begin uploading only after this method is called.
public protocol ConfirmedReceiptImportSubmitting: Sendable {
    func submitConfirmedReceipt(_ receipt: ConfirmedReceiptImport) async throws
}

public struct ReceiptHuntSummary: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let transactionDate: String
    public let merchant: String?
    public let amountInCents: Int

    public init(id: String, transactionDate: String, merchant: String?, amountInCents: Int) {
        self.id = id
        self.transactionDate = transactionDate
        self.merchant = merchant
        self.amountInCents = amountInCents
    }

    public var searchContext: NearbyReceiptSearchContext? {
        guard let date = Self.dayFormatter.date(from: transactionDate) else { return nil }
        return NearbyReceiptSearchContext(
            huntID: id, transactionDate: date, merchant: merchant, amountInCents: amountInCents)
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

public actor URLSessionReceiptHuntClient {
    private struct ResponseBody: Decodable { let items: [ReceiptHuntSummary] }
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

    public func list() async throws -> [ReceiptHuntSummary] {
        guard case .bearer(let token) = await credentials.current(), !token.isEmpty else {
            throw URLError(.userAuthenticationRequired)
        }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw URLError(.badURL)
        }
        components.path = "/api/v1/purchaseImport/listReceiptHunts"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(ResponseBody.self, from: data).items
    }
}

public struct ConfirmedReceiptImport: Sendable, Hashable {
    public let context: NearbyReceiptSearchContext
    public let file: PhotoFile

    public init(context: NearbyReceiptSearchContext, file: PhotoFile) {
        self.context = context
        self.file = file
    }
}

/// Server integration required to make `ConfirmedReceiptImportSubmitting` concrete. The operation
/// must verify hunt ownership, accept a finalized `ImageShortcode`, attach it as hunt evidence,
/// and enqueue extraction exactly once for `(huntId, imageId)`.
public enum ConfirmedReceiptImportServerContract {
    public static let operationID = "purchaseImport.submitReceiptEvidence"
    public static let path = "/api/v1/purchaseImport/submitReceiptEvidence"
}

public struct ConfirmedReceiptEvidenceInput: Codable, Sendable, Hashable {
    public let huntID: String
    public let imageID: ImageCode

    public init(huntID: String, imageID: ImageCode) {
        self.huntID = huntID
        self.imageID = imageID
    }

    private enum CodingKeys: String, CodingKey {
        case huntID = "huntId"
        case imageID = "imageId"
    }
}

public struct ConfirmedReceiptEvidenceOutput: Codable, Sendable, Hashable {
    public let huntID: String
    public let imageID: ImageCode
    public let queued: Bool

    public init(huntID: String, imageID: ImageCode, queued: Bool) {
        self.huntID = huntID
        self.imageID = imageID
        self.queued = queued
    }

    private enum CodingKeys: String, CodingKey {
        case huntID = "huntId"
        case imageID = "imageId"
        case queued
    }
}

public actor URLSessionConfirmedReceiptImportSubmitter: ConfirmedReceiptImportSubmitting {
    private let baseURL: URL
    private let credentials: CredentialProvider
    private let client: CubbyClient
    private let session: URLSession

    public init(
        baseURL: URL, credentials: CredentialProvider, client: CubbyClient,
        session: URLSession = .cubbyShared
    ) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.client = client
        self.session = session
    }

    public func submitConfirmedReceipt(_ receipt: ConfirmedReceiptImport) async throws {
        let prepared = try PreparedPhoto.prepare(file: receipt.file)
        let upload = try await PendingImageUpload(service: client).upload(prepared, entity: nil)
        try await client.markUploaded(upload.imageID)

        guard case .bearer(let token) = await credentials.current(), !token.isEmpty else {
            throw URLError(.userAuthenticationRequired)
        }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw URLError(.badURL)
        }
        components.path = ConfirmedReceiptImportServerContract.path
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            ConfirmedReceiptEvidenceInput(
                huntID: receipt.context.huntID, imageID: upload.imageID))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        _ = try JSONDecoder().decode(ConfirmedReceiptEvidenceOutput.self, from: data)
    }
}
