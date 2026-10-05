import CubbyAPISupport
import Foundation

/// An inclusive order-date window the server backfills instead of the usual incremental sync.
/// Dates are calendar days (`YYYY-MM-DD`), so a window never depends on the time of day it was
/// picked.
public struct BrowserBridgeBackfillRange: Codable, Sendable, Hashable {
    public let from: String
    public let to: String

    /// Nil when `from` falls after `to` by calendar day; the server rejects that with a 409.
    public init?(from: Date, to: Date, calendar: Calendar = .current) {
        let start = calendar.startOfDay(for: from)
        let end = calendar.startOfDay(for: to)
        guard start <= end else { return nil }
        self.from = PlainDate(start, in: calendar.timeZone).rawValue
        self.to = PlainDate(end, in: calendar.timeZone).rawValue
    }

    /// Today back one year: the one decision the control makes for the household.
    public static func defaultDates(today: Date = .now, calendar: Calendar = .current)
        -> (from: Date, to: Date)
    {
        let end = calendar.startOfDay(for: today)
        return (calendar.date(byAdding: .year, value: -1, to: end) ?? end, end)
    }
}

public struct BrowserBridgeSyncRequest: Codable, Sendable, Hashable {
    public let vendorAccount: String
    /// Encoded only when present (synthesized `encodeIfPresent`), so a plain sync keeps its body.
    public let backfill: BrowserBridgeBackfillRange?

    public init(vendorAccount: String, backfill: BrowserBridgeBackfillRange? = nil) {
        self.vendorAccount = vendorAccount
        self.backfill = backfill
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
    func requestSync(vendorAccountID: String, backfill: BrowserBridgeBackfillRange?) async throws
        -> BrowserBridgeSyncResponse
}

extension BrowserBridgeSyncRequesting {
    public func requestSync(vendorAccountID: String) async throws -> BrowserBridgeSyncResponse {
        try await requestSync(vendorAccountID: vendorAccountID, backfill: nil)
    }
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

    public func requestSync(vendorAccountID: String, backfill: BrowserBridgeBackfillRange?)
        async throws -> BrowserBridgeSyncResponse
    {
        var request = try await AuthenticatedSocketSupport.agentRequest(
            baseURL: baseURL, path: "/api/import/agent/sync", credentials: credentials,
            jsonBody: try JSONEncoder().encode(
                BrowserBridgeSyncRequest(vendorAccount: vendorAccountID, backfill: backfill)))
        request.timeoutInterval = 30
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
