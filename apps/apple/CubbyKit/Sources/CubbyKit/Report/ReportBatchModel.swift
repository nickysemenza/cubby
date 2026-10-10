import Foundation
import Observation

/// The Run slots one detail screen shows together. A screen polls them as ONE batched read
/// (`entityReport.getMany`), so the run loads once per poll however many sections it has.
public enum RunReportBatch {
    public static let slots: [ReportSlot] = [
        .run_liveProgress, .run_importStats, .run_importProgressLive, .run_importProgressStopped,
        .run_importPurchases, .run_importApprovals, .run_importFindings, .run_importTargets,
        .run_importPreparedOrders, .run_importTimeline,
    ]

    public static func contains(_ slot: ReportSlot) -> Bool { slots.contains(slot) }
}

/// One polled read for all of a record's batched slots. The slot models read their report from
/// here; this alone fetches, polls while the record is live, and tells the screen when the
/// record shows a different status than the server reports.
@MainActor @Observable
public final class ReportBatchModel {
    public private(set) var presentations: [ReportSlot: ReportPresentation] = [:]
    public private(set) var isLoaded = false
    public private(set) var isLoading = false
    public private(set) var loadError: String?
    public private(set) var live = false
    /// The record's status as of the last read: a screen whose own header follows the record
    /// (a Run detail) reads it here instead of polling the record separately.
    public private(set) var status: String?
    /// Counts completed reads, so a screen can re-read what it draws beside the reports (a photo
    /// Run's review) on the same clock.
    public private(set) var revision = 0

    public let id: String
    /// The status the detail screen currently shows; set again after the record reloads.
    public var shownStatus: String?
    @ObservationIgnored public var onRecordStale: (@MainActor () -> Void)?

    @ObservationIgnored private let service: any ReportServing
    @ObservationIgnored private let slots: [ReportSlot]
    @ObservationIgnored private let waitForNextPoll: @Sendable () async throws -> Void
    @ObservationIgnored private var watchers = 0
    @ObservationIgnored private(set) var pollTask: Task<Void, Never>?
    /// Callers waiting for the read in flight to finish; a later read never overlaps it.
    @ObservationIgnored private var loadWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var staleStatusReported: String?

    public init(
        id: String, slots: [ReportSlot] = RunReportBatch.slots, shownStatus: String? = nil,
        service: any ReportServing,
        waitForNextPoll: @escaping @Sendable () async throws -> Void = {
            try await Task.sleep(for: .seconds(3))
        }
    ) {
        self.id = id
        self.slots = slots
        self.shownStatus = shownStatus
        self.service = service
        self.waitForNextPoll = waitForNextPoll
    }

    public func presentation(for slot: ReportSlot) -> ReportPresentation? { presentations[slot] }

    /// Reads the batch. A refresh asked for while one is in flight waits for it and then reads
    /// again, so a change made just before (an action) is never hidden behind a stale poll.
    public func refresh() async {
        await loadFinished()
        isLoading = true
        defer { endLoading() }
        do {
            let reports = try await service.reports(slots: slots, id: id)
            var next: [ReportSlot: ReportPresentation] = [:]
            for (slot, report) in reports { next[slot] = ReportPresentation(report) }
            presentations = next
            live = next.values.contains { $0.live }
            if let status = next.values.compactMap(\.status).first {
                self.status = status
                noteStatus(status)
            }
            loadError = nil
            isLoaded = true
            revision += 1
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func noteStatus(_ status: String) {
        if let shownStatus, shownStatus != status, staleStatusReported != status {
            staleStatusReported = status
            onRecordStale?()
        }
    }

    private func loadFinished() async {
        while isLoading { await withCheckedContinuation { loadWaiters.append($0) } }
    }

    private func endLoading() {
        isLoading = false
        let waiters = loadWaiters
        loadWaiters = []
        for waiter in waiters { waiter.resume() }
    }

    // MARK: Polling

    /// Keeps the batch fresh until the matching `release()`; the first reader starts the loop and
    /// the last stops it. The loop polls only while the record is `live`.
    public func retain() {
        watchers += 1
        startPolling()
    }

    public func release() {
        watchers = max(0, watchers - 1)
        if watchers == 0 {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    /// Starts the loop if a reader is waiting and none runs: after the record's status changes
    /// (a stopped run resumed) or an action ran.
    public func restartPolling() { startPolling() }

    private func startPolling() {
        guard pollTask == nil, watchers > 0 else { return }
        pollTask = Task { [weak self] in
            guard let self else { return }
            await self.refresh()
            while !Task.isCancelled, self.live {
                try? await self.waitForNextPoll()
                if Task.isCancelled { return }
                await self.refresh()
            }
            self.pollTask = nil
        }
    }
}

/// One batch per record on a detail screen; the screen owns the store, so batches end with it.
@MainActor
public final class ReportBatchStore {
    private var batches: [String: ReportBatchModel] = [:]
    /// Called when the server reports a status the screen's record does not show.
    public var onRecordStale: (() -> Void)?

    public init() {}

    public func batch(service: any ReportServing, id: String, shownStatus: String?)
        -> ReportBatchModel
    {
        if let existing = batches[id] {
            existing.shownStatus = shownStatus
            return existing
        }
        let batch = ReportBatchModel(id: id, shownStatus: shownStatus, service: service)
        batch.onRecordStale = { [weak self] in self?.onRecordStale?() }
        batches[id] = batch
        return batch
    }
}
