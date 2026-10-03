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
        self.from = Self.format(start, calendar: calendar)
        self.to = Self.format(end, calendar: calendar)
    }

    /// Today back one year: the one decision the control makes for the household.
    public static func defaultDates(today: Date = .now, calendar: Calendar = .current)
        -> (from: Date, to: Date)
    {
        let end = calendar.startOfDay(for: today)
        return (calendar.date(byAdding: .year, value: -1, to: end) ?? end, end)
    }

    private static func format(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
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
            BrowserBridgeSyncRequest(vendorAccount: vendorAccountID, backfill: backfill))
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
