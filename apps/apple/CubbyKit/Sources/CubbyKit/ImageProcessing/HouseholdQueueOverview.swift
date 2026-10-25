import Foundation

/// Activity's household queue sections: the Apple device lane (this device's leases, other
/// devices' leases, work waiting for any Apple device), the frontier AI lane, and Runs needing
/// attention. Every figure is a server count or a server row; this type only groups them.
///
/// TODO(unclog integration): today this reads the generic `imageJob` list by `state`
/// (`leased`, `waiting_for_device`, `pending`) and matches `lastExecutor` to this device's name.
/// When the read-only `job` entity lands, read it instead through the same generic list and map:
/// `waitingOn.lane` (`apple_device` / `frontier_ai`) for the lane sections, `waitingOn.reason`
/// for per-reason counts (grouped list counts, linking to the filtered Job list), and for
/// `reason == "leased"` the `waitingOn.executor` (device id and name), `waitingOn.leaseExpiresAt`,
/// and `waitingOn.expired` fields for `Lease.executorDeviceID`, `Lease.leaseExpiresAt`, and
/// `Lease.expired`. Inactive installs are excluded from lane counts by the server.
public struct HouseholdQueueOverview: Sendable, Equatable {
    public struct Lease: Sendable, Equatable, Identifiable {
        /// The image job's public code.
        public let id: String
        public let title: String
        /// The device name of the attempt holding the lease, verbatim.
        public let executor: String?
        public let leasedAt: Date?
        /// `nil` until the server reports lease expiry (see the TODO above).
        public let expired: Bool?

        public init(id: String, title: String, executor: String?, leasedAt: Date?, expired: Bool? = nil) {
            self.id = id
            self.title = title
            self.executor = executor
            self.leasedAt = leasedAt
            self.expired = expired
        }
    }

    public let myLeases: [Lease]
    public let otherLeases: [Lease]
    /// Every leased job, which can exceed the listed rows.
    public let leasedCount: Int
    public let waitingForAppleDevice: Int
    public let frontierQueued: Int
    public let runsNeedingAttention: Int

    public init(
        myLeases: [Lease], otherLeases: [Lease], leasedCount: Int, waitingForAppleDevice: Int,
        frontierQueued: Int, runsNeedingAttention: Int
    ) {
        self.myLeases = myLeases
        self.otherLeases = otherLeases
        self.leasedCount = leasedCount
        self.waitingForAppleDevice = waitingForAppleDevice
        self.frontierQueued = frontierQueued
        self.runsNeedingAttention = runsNeedingAttention
    }

    /// The image-job states each section counts, as the generic list's `state` filter values.
    public enum ImageJobState: String, Sendable, CaseIterable {
        case leased
        case waitingForDevice = "waiting_for_device"
        case pending
    }

    /// The generic `imageJob` list filter for `state`, for the counts and their drill-in links.
    public static func imageJobFilter(_ state: ImageJobState) -> EntityFilterState {
        let name =
            EntityCatalog[.imageJob].filters.first { $0.columnId == "state" }?.wire.names.first
            ?? "state"
        return EntityFilterState([name: [state.rawValue]])
    }

    /// Splits leased rows into this device's and other devices', oldest lease first.
    public static func make(
        leasedRows: [EntityRow], leasedCount: Int, waitingForAppleDevice: Int, frontierQueued: Int,
        runsNeedingAttention: Int, thisDeviceName: String
    ) -> Self {
        let transcoder = LenientISO8601DateTranscoder()
        let leases = leasedRows.map { row in
            Lease(
                id: row.id, title: row.title,
                executor: row.raw["lastExecutor"]?.stringValue,
                leasedAt: row.raw["dispatchedAt"]?.stringValue.flatMap { try? transcoder.decode($0) })
        }
        .sorted { ($0.leasedAt ?? .distantFuture) < ($1.leasedAt ?? .distantFuture) }
        return Self(
            myLeases: leases.filter { $0.executor == thisDeviceName },
            otherLeases: leases.filter { $0.executor != thisDeviceName },
            leasedCount: leasedCount, waitingForAppleDevice: waitingForAppleDevice,
            frontierQueued: frontierQueued, runsNeedingAttention: runsNeedingAttention)
    }

    /// Four generic list reads: leased rows (first page) and three counts.
    public static func load(client: CubbyClient, thisDeviceName: String) async throws -> Self {
        let jobs = EntityCatalog[.imageJob]
        async let leased = client.list(jobs, pageSize: 50, filters: imageJobFilter(.leased))
        async let waiting = client.list(jobs, pageSize: 1, filters: imageJobFilter(.waitingForDevice))
        async let queued = client.list(jobs, pageSize: 1, filters: imageJobFilter(.pending))
        let runs = EntityCatalog[.run]
        let attention = runs.presentation.savedViews.first { $0.id == "attention" }?.filterState
        async let runsNeedingAttention = client.list(
            runs, pageSize: 1, filters: attention ?? EntityFilterState())
        let leasedPage = try await leased
        return make(
            leasedRows: leasedPage.items, leasedCount: leasedPage.meta.totalCount,
            waitingForAppleDevice: try await waiting.meta.totalCount,
            frontierQueued: try await queued.meta.totalCount,
            runsNeedingAttention: attention == nil ? 0 : try await runsNeedingAttention.meta.totalCount,
            thisDeviceName: thisDeviceName)
    }
}
