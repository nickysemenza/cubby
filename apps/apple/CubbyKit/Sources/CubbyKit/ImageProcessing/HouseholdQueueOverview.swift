import Foundation
import Observation

/// Activity shares ordinary entity list ownership, including enrichment and saved-view ordering.
@MainActor
@Observable
public final class HouseholdQueueOverview {
    public let runs: GenericEntityListModel
    public let jobs: GenericEntityListModel
    public private(set) var counts: [JobQueueOutputCountsItem] = []
    public private(set) var health: JobHealthOutputSnapshot?
    public private(set) var error: (any Error)?
    public private(set) var isRetrying = false
    private let client: CubbyClient

    public init(client: CubbyClient) {
        self.client = client
        let run = EntityCatalog[.run]
        let attention = run.presentation.savedViews.first { $0.id == "attention" }
        runs = GenericEntityListModel(
            descriptor: run, client: client, pageSize: 10,
            sort: attention?.sortParameter, filters: attention?.filterState ?? EntityFilterState())
        let job = EntityCatalog[.job]
        jobs = GenericEntityListModel(
            descriptor: job, client: client, pageSize: 25,
            filters: job.presentation.savedViews.first { $0.id == "in-progress" }?.filterState
                ?? EntityFilterState())
    }

    public func refresh() async {
        do {
            async let queue = client.native_job_queue(body: .init(filter: .init(), pageSize: 1))
            async let status = client.native_job_health(body: .object([:]))
            counts = try await queue.counts
            health = try await status.snapshot
            error = nil
        } catch { self.error = error }
        await runs.refresh()
        await jobs.refresh()
    }

    public func filter(lane: String, reason: String) async {
        let descriptor = EntityCatalog[.job]
        var filters =
            descriptor.presentation.savedViews.first { $0.id == "in-progress" }?.filterState
            ?? EntityFilterState()
        let scope = EntityFilterState(entity: .job, urlFilters: ["lane": lane, "reason": reason])
        for name in scope.names { filters.set(scope[name] ?? [], for: name) }
        await jobs.apply(filters: filters)
    }

    public func applyJobView(_ view: SavedView) async { await jobs.apply(savedView: view) }

    public func retry(codes: [String] = []) async {
        guard !isRetrying else { return }
        isRetrying = true
        defer { isRetrying = false }
        do {
            let filter: JSONValue
            if codes.isEmpty {
                // The kernel owns wire conversion for the same manifest filter state as the list.
                filter = .object([
                    "entityFilters": .object(
                        try EntityCatalog[.job].filterBody(jobs.filters, includeWindow: false))
                ])
            } else {
                filter = .object(["codes": .array(codes.map(JSONValue.string))])
            }
            let _: JobRetryNowOutput = try await client.request(
                "job.retryNow", body: JSONValue.object(["filter": filter]))
            error = nil
            await refresh()
        } catch { self.error = error }
    }
}

/// The inline panel is loaded only when its Job is expanded.
@MainActor
@Observable
public final class ActivityJobExplanation {
    public private(set) var explanation: JobExplainOutput?
    public private(set) var logs: JobLogsOutput?
    public private(set) var error: (any Error)?

    public init() {}

    public func load(client: CubbyClient, code: String) async {
        do {
            async let chain: JobExplainOutput = client.request(
                "job.explain", body: JSONValue.object(["id": .string(code)]))
            async let lines: JobLogsOutput = client.request(
                "job.logs", body: JSONValue.object(["jobId": .string(code)]))
            explanation = try await chain
            logs = try await lines
            error = nil
        } catch { self.error = error }
    }
}
