import Foundation

/// Activity's household queue sections, from `job.queue` and `job.runRollups`: per lane, live
/// Jobs grouped by what they wait on; the Apple device lane's leases split into this device's and
/// other devices'; Jobs waiting on a time (funding window, backoff); and Runs needing attention
/// with their rollups. Every figure is a server count or a server row; this type only groups them.
/// The server excludes inactive installs from lane counts.
public struct HouseholdQueueOverview: Sendable, Equatable {
    /// One lane's live Jobs for one waiting-on reason (`job.queue` `counts`).
    public struct ReasonCount: Sendable, Equatable, Identifiable {
        /// The wire reason (`due`, `waiting_device`, `waiting_funding`, …), verbatim.
        public let reason: String
        public let count: Int
        /// For `waiting_funding`: when the AI funding window reopens, from a listed Job.
        public let until: Date?
        public var id: String { reason }

        public init(reason: String, count: Int, until: Date? = nil) {
            self.reason = reason
            self.count = count
            self.until = until
        }
    }

    /// A leased Apple-device Job (`waitingOn.reason == "leased"`).
    public struct Lease: Sendable, Equatable, Identifiable {
        /// The Job id.
        public let id: String
        public let kind: String
        /// The image job id the device's command carries, from the Job key; matches this device's
        /// own claims.
        public let imageJobID: String?
        /// The executor named on the lease, verbatim.
        public let executor: String?
        public let leaseExpiresAt: Date
        /// The server's flag: an expired lease is reclaimed by the next claim.
        public let expired: Bool

        public init(
            id: String, kind: String, imageJobID: String?, executor: String?, leaseExpiresAt: Date,
            expired: Bool
        ) {
            self.id = id
            self.kind = kind
            self.imageJobID = imageJobID
            self.executor = executor
            self.leaseExpiresAt = leaseExpiresAt
            self.expired = expired
        }
    }

    /// A Job backing off after failures, with when it is due again.
    public struct BackingOff: Sendable, Equatable, Identifiable {
        public let id: String
        public let kind: String
        /// The wire lane, verbatim.
        public let lane: String
        public let until: Date
        public let attempts: Int
        public let lastError: String?

        public init(
            id: String, kind: String, lane: String, until: Date, attempts: Int, lastError: String?
        ) {
            self.id = id
            self.kind = kind
            self.lane = lane
            self.until = until
            self.attempts = attempts
            self.lastError = lastError
        }
    }

    /// A Run needing attention with its `job.runRollups` rollup, when the server returned one.
    public struct RunRollupRow: Sendable, Equatable, Identifiable {
        /// The Run's public code.
        public let id: String
        public let title: String
        /// Live Jobs per waiting-on reason, in the server's reason order.
        public let counts: [ReasonCount]
        public let waitingForFunding: Bool
        /// Running Jobs whose executor's lease lapsed; the next claim reclaims them.
        public let expiredLeases: Int
        public let stalled: Bool
        public let stallMinutes: Int
        public let lastProgressAt: Date?

        public init(
            id: String, title: String, counts: [ReasonCount] = [], waitingForFunding: Bool = false,
            expiredLeases: Int = 0, stalled: Bool = false, stallMinutes: Int = 0,
            lastProgressAt: Date? = nil
        ) {
            self.expiredLeases = expiredLeases
            self.id = id
            self.title = title
            self.counts = counts
            self.waitingForFunding = waitingForFunding
            self.stalled = stalled
            self.stallMinutes = stallMinutes
            self.lastProgressAt = lastProgressAt
        }

        /// Expired leases the next claim reclaims, worded for Activity; `nil` when there are none.
        public var expiredLeasesLabel: String? {
            switch expiredLeases {
            case 0: nil
            case 1: "1 expired lease awaiting reclaim"
            default: "\(expiredLeases) expired leases awaiting reclaim"
            }
        }
    }

    public let appleCounts: [ReasonCount]
    public let frontierCounts: [ReasonCount]
    /// The first page of leased Apple-device Jobs, oldest-expiring first.
    public let leases: [Lease]
    public let backingOff: [BackingOff]
    public let runsNeedingAttention: Int
    public let runs: [RunRollupRow]

    public init(
        appleCounts: [ReasonCount], frontierCounts: [ReasonCount], leases: [Lease],
        backingOff: [BackingOff], runsNeedingAttention: Int, runs: [RunRollupRow]
    ) {
        self.appleCounts = appleCounts
        self.frontierCounts = frontierCounts
        self.leases = leases
        self.backingOff = backingOff
        self.runsNeedingAttention = runsNeedingAttention
        self.runs = runs
    }

    /// Every leased Apple-device Job, which can exceed the listed rows.
    public var leasedCount: Int {
        appleCounts.first { $0.reason == JobWaitingOnReason.leased.rawValue }?.count ?? 0
    }

    /// Leases this device holds (by its worker's live claims, never by device name) and the rest.
    public func leases(claimedImageJobIDs: Set<String>) -> (mine: [Lease], others: [Lease]) {
        let mine = leases.filter { $0.imageJobID.map(claimedImageJobIDs.contains) ?? false }
        return (mine, leases.filter { !mine.contains($0) })
    }

    /// Image work's Job key is `image-processing:<image job id>`; the command a device runs
    /// carries that image job id as its `jobId`.
    static func imageJobID(fromJobKey key: String) -> String? {
        let prefix = "image-processing:"
        guard key.hasPrefix(prefix) else { return nil }
        let id = key.dropFirst(prefix.count)
        return id.isEmpty ? nil : String(id)
    }

    static func reasonCounts(
        _ counts: [JobQueueOutputCountsItem], lane: JobLane, fundingUntil: Date? = nil
    ) -> [ReasonCount] {
        let order = JobWaitingOnReason.allCases.map(\.rawValue)
        return counts.filter { $0.lane == lane && $0.count > 0 }
            .map { item in
                ReasonCount(
                    reason: item.reason.rawValue, count: item.count,
                    until: item.reason == .waitingFunding ? fundingUntil : nil)
            }
            .sorted { (order.firstIndex(of: $0.reason) ?? .max) < (order.firstIndex(of: $1.reason) ?? .max) }
    }

    /// Maps the three `job.queue` reads and the Runs page with their rollups.
    static func make(
        counts: JobQueueOutput, leased: JobQueueOutput, waiting: JobQueueOutput,
        runRows: [EntityRow], runsNeedingAttention: Int, rollups: JobRunRollupsOutput?
    ) -> Self {
        var fundingUntil: Date?
        var backingOff: [BackingOff] = []
        for job in waiting.jobs {
            switch job.waitingOn {
            case .waitingFunding(let funding): fundingUntil = fundingUntil ?? funding.until
            case .backingOff(let wait):
                backingOff.append(
                    .init(
                        id: job.id, kind: job.kind, lane: job.lane.rawValue, until: wait.until,
                        attempts: wait.attempts, lastError: wait.lastError))
            default: break
            }
        }
        let leases = leased.jobs.compactMap { job -> Lease? in
            guard case .leased(let lease) = job.waitingOn else { return nil }
            return Lease(
                id: job.id, kind: job.kind, imageJobID: imageJobID(fromJobKey: job.key),
                executor: lease.executor, leaseExpiresAt: lease.leaseExpiresAt, expired: lease.expired)
        }
        .sorted { $0.leaseExpiresAt < $1.leaseExpiresAt }
        let order = JobWaitingOnReason.allCases.map(\.rawValue)
        let rollupByRun = Dictionary(
            (rollups?.rollups ?? []).map { ($0.runId, $0) }, uniquingKeysWith: { first, _ in first })
        let runs = runRows.map { row in
            guard let rollup = rollupByRun[row.id] else {
                return RunRollupRow(id: row.id, title: row.title)
            }
            return RunRollupRow(
                id: row.id, title: row.title,
                counts: rollup.counts.filter { $0.value > 0 }
                    .map { ReasonCount(reason: $0.key, count: $0.value) }
                    .sorted {
                        (order.firstIndex(of: $0.reason) ?? .max, $0.reason)
                            < (order.firstIndex(of: $1.reason) ?? .max, $1.reason)
                    },
                waitingForFunding: rollup.waitingForFunding, expiredLeases: rollup.expiredLeases,
                stalled: rollup.stalled,
                stallMinutes: rollup.stallMinutes, lastProgressAt: rollup.lastProgressAt)
        }
        return Self(
            appleCounts: reasonCounts(counts.counts, lane: .appleDevice),
            frontierCounts: reasonCounts(counts.counts, lane: .frontierAi, fundingUntil: fundingUntil),
            leases: leases, backingOff: backingOff, runsNeedingAttention: runsNeedingAttention,
            runs: runs)
    }

    /// Three `job.queue` reads (lane counts, Apple leases, timed waits), the Runs needing
    /// attention page, and those Runs' rollups.
    public static func load(client: CubbyClient) async throws -> Self {
        let lanes: [JobLane] = [.appleDevice, .frontierAi]
        async let counts = client.native_job_queue(body: .init(filter: .init(lanes: lanes), pageSize: 1))
        async let leased = client.native_job_queue(
            body: .init(filter: .init(lanes: [.appleDevice], reasons: [.leased]), pageSize: 50))
        async let waiting = client.native_job_queue(
            body: .init(filter: .init(lanes: lanes, reasons: [.waitingFunding, .backingOff]), pageSize: 10))
        let runs = EntityCatalog[.run]
        let attention = runs.presentation.savedViews.first { $0.id == "attention" }?.filterState
        var runPage: ListPage<EntityRow>?
        if let attention { runPage = try await client.list(runs, pageSize: 10, filters: attention) }
        let runRows = runPage?.items ?? []
        let rollups =
            runRows.isEmpty
            ? nil : try await client.native_job_runRollups(body: .init(runIds: runRows.map(\.id)))
        return make(
            counts: try await counts, leased: try await leased, waiting: try await waiting,
            runRows: runRows, runsNeedingAttention: runPage?.meta.totalCount ?? 0, rollups: rollups)
    }
}
