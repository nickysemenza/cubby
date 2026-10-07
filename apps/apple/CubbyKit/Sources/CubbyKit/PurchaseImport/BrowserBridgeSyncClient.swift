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

public protocol BrowserBridgeSyncRequesting: Sendable {
    func syncPlan() async throws -> SyncPlanOutput
    func requestSync(vendorAccountID: String, backfill: BrowserBridgeBackfillRange?) async throws
        -> StartSyncOutput
}

extension BrowserBridgeSyncRequesting {
    public func requestSync(vendorAccountID: String) async throws -> StartSyncOutput {
        try await requestSync(vendorAccountID: vendorAccountID, backfill: nil)
    }
}

public struct BrowserBridgeSyncClient: BrowserBridgeSyncRequesting {
    private let client: CubbyClient

    public init(client: CubbyClient) {
        self.client = client
    }

    public func syncPlan() async throws -> SyncPlanOutput {
        try await client.syncPlan(.init())
    }

    public func requestSync(vendorAccountID: String, backfill: BrowserBridgeBackfillRange?)
        async throws -> StartSyncOutput
    {
        try await client.startSync(
            .init(
                vendorAccountId: vendorAccountID,
                backfill: backfill.map {
                    .init(from: PlainDate(rawValue: $0.from), to: PlainDate(rawValue: $0.to))
                }))
    }
}
