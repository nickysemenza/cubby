import Foundation
import Observation

/// The reads and writes a report slot needs, narrowed to what the model uses. `CubbyClient` is
/// the one implementation; tests supply a fake.
public protocol ReportServing: Sendable {
    func report(slot: ReportSlot, id: String, cursor: String?) async throws -> EntityReportOut
    /// Several slots of one record in one read (`entityReport.getMany`).
    func reports(slots: [ReportSlot], id: String) async throws -> [(ReportSlot, EntityReportOut)]
    /// `run.control`; the successor run's shortcode when the action started one.
    func controlRun(_ input: RunControlInput) async throws -> String?
    /// `problems.resolveRunFinding`; true when the fix was applied rather than dismissed.
    func resolveFinding(_ input: ResolveRunFindingInput) async throws -> Bool
    func resendGmailSearch(_ input: RunRetryGmailSearchInput) async throws
    /// `run.commitPrepared`: approve and import one prepared batch.
    func commitPrepared(_ input: RunCommitPreparedInput) async throws
}

extension CubbyClient: ReportServing {
    public func report(slot: ReportSlot, id: String, cursor: String?) async throws -> EntityReportOut {
        try await entityReport(slot: slot, id: id, cursor: cursor)
    }

    public func reports(slots: [ReportSlot], id: String) async throws -> [(ReportSlot, EntityReportOut)] {
        try await entityReports(slots: slots, id: id)
    }

    public func controlRun(_ input: RunControlInput) async throws -> String? {
        let out: RunControlOutput = try await controlRun(input)
        return out.successor?.publicId
    }

    public func resolveFinding(_ input: ResolveRunFindingInput) async throws -> Bool {
        let out: ResolveRunFindingOut = try await resolveRunFinding(input)
        return out.status == .applied
    }

    public func resendGmailSearch(_ input: RunRetryGmailSearchInput) async throws {
        let _: VendorSearchMailOut = try await retryGmailSearch(input)
    }

    public func commitPrepared(_ input: RunCommitPreparedInput) async throws {
        let _: CommitPurchaseImportOut = try await commitPreparedImport(input)
    }
}

/// What happened when a report action ran.
public enum ReportActionOutcome: Sendable, Equatable {
    case done(String?)
    /// `run.control` started a successor run; the person is offered it.
    case openedRun(String)
}

public enum ReportActionError: Error, LocalizedError, Equatable {
    /// The action carries a confirmation the person has not given; nothing was sent.
    case confirmationRequired
    /// A required decision has no complete answer yet; nothing was sent.
    case incompleteAnswers
    /// The server says the command cannot run (already done, wrong state).
    case unavailable(String)
    public var errorDescription: String? {
        switch self {
        case .confirmationRequired: "Confirm this action before it runs."
        case .incompleteAnswers: "Answer every required decision first."
        case .unavailable(let reason): reason
        }
    }
}

/// One report slot's server read, kept fresh by polling while the server says the record is
/// live. Polling is the only refresh mechanism: there is no realtime transport. Actions run the
/// exact request the server composed, and only after the confirmation the action declares.
@MainActor @Observable
public final class ReportSlotModel {
    public private(set) var ownPresentation: ReportPresentation?
    public private(set) var isLoading = false
    public private(set) var loadError: String?
    public private(set) var busyActionID: String?
    public private(set) var actionError: String?
    public private(set) var actionNotice: String?
    public private(set) var openedRunID: String?

    public let slot: ReportSlot
    public let id: String
    /// The status the detail screen currently shows; a different one from the server asks the
    /// screen to reload its record.
    public var shownStatus: String?
    @ObservationIgnored public var onRecordStale: (@MainActor () -> Void)?

    @ObservationIgnored private let service: any ReportServing
    @ObservationIgnored private let batch: ReportBatchModel?
    @ObservationIgnored private let pollInterval: Duration
    @ObservationIgnored private var watchers = 0
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var staleStatusReported: String?
    /// Pages after the first, kept across a refresh so polling never drops what was loaded.
    @ObservationIgnored private var laterPages: [ReportPresentation] = []

    /// With a `batch`, the slot reads, polls and refreshes through it (one request for all of
    /// the screen's slots); without, it reads its own report and pages with the cursor.
    public init(
        slot: ReportSlot, id: String, shownStatus: String? = nil, batch: ReportBatchModel? = nil,
        service: any ReportServing, pollInterval: Duration = .seconds(3)
    ) {
        self.slot = slot
        self.id = id
        self.shownStatus = shownStatus
        self.batch = batch
        self.service = service
        self.pollInterval = pollInterval
    }

    public var presentation: ReportPresentation? {
        batch.map { $0.presentation(for: slot) } ?? ownPresentation
    }
    public var live: Bool { presentation?.live ?? false }
    public var canLoadMore: Bool { batch == nil && presentation?.nextCursor != nil }
    public var failure: String? { batch.map(\.loadError) ?? loadError }

    /// Reads the report. A refresh asked for while a read is in flight waits for it and reads
    /// again, so a change made just before (an action) is never hidden behind a stale poll.
    public func refresh() async {
        if let batch { return await batch.refresh() }
        while isLoading { try? await Task.sleep(for: .milliseconds(5)) }
        isLoading = true
        defer { isLoading = false }
        do {
            let first = ReportPresentation(try await service.report(slot: slot, id: id, cursor: nil))
            ownPresentation = laterPages.reduce(first) { $0.appending($1) }
            noteStatus(first.status)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// Appends the next page under the first page's blocks; a poll in flight finishes first.
    public func loadMore() async {
        while isLoading { try? await Task.sleep(for: .milliseconds(5)) }
        guard let current = ownPresentation, let cursor = current.nextCursor else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = ReportPresentation(try await service.report(slot: slot, id: id, cursor: cursor))
            laterPages.append(page)
            ownPresentation = current.appending(page)
            noteStatus(page.status)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func noteStatus(_ status: String?) {
        if let status, let shownStatus, shownStatus != status, staleStatusReported != status {
            staleStatusReported = status
            onRecordStale?()
        }
    }

    // MARK: Polling

    /// Keeps the report fresh until the matching `release()`; the first reader starts the loop
    /// and the last one stops it. The loop polls only while the server reports `live`.
    public func retain() {
        watchers += 1
        if let batch { return batch.retain() }
        startPolling()
    }

    public func release() {
        watchers = max(0, watchers - 1)
        if let batch { return batch.release() }
        if watchers == 0 {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    /// Starts polling again if a reader waits and none runs: the record's status changed (a
    /// stopped run resumed) or an action ran.
    public func restartPolling() {
        if let batch { return batch.restartPolling() }
        startPolling()
    }

    private func startPolling() {
        guard pollTask == nil, watchers > 0 else { return }
        pollTask = Task { [weak self] in
            guard let self else { return }
            await self.refresh()
            while !Task.isCancelled, self.live {
                try? await Task.sleep(for: self.pollInterval)
                if Task.isCancelled { return }
                await self.refresh()
            }
            // A stopped record is not polled; a later `retain()` or action starts it again.
            self.pollTask = nil
        }
    }

    // MARK: Actions

    /// Runs `action`'s exact request. An action with a confirmation does nothing until the
    /// caller passes `confirmed: true` (the person tapped the dialog's button).
    @discardableResult
    public func run(_ action: ReportCommand, confirmed: Bool) async -> ReportActionOutcome? {
        guard busyActionID == nil else { return nil }
        if action.confirm != nil, !confirmed {
            actionError = ReportActionError.confirmationRequired.localizedDescription
            return nil
        }
        busyActionID = action.id
        actionError = nil
        actionNotice = nil
        defer { busyActionID = nil }
        do {
            let outcome = try await Self.perform(action.request, service: service)
            switch outcome {
            case .openedRun(let runID): openedRunID = runID
            case .done(let message): actionNotice = message
            }
            await refresh()
            restartPolling()
            return outcome
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    /// Approves a prepared batch with the person's answers: the form's confirmation first, then
    /// exactly the body `answers` assemble, and only while the server allows it and every
    /// required decision is answered. The same answers retried reuse their operation id.
    @discardableResult
    public func approve(
        _ form: ReportPresentation.Form, answers: ReportChoiceAnswers, confirmed: Bool
    ) async -> ReportActionOutcome? {
        guard busyActionID == nil else { return nil }
        actionError = nil
        actionNotice = nil
        if let reason = form.disabledReason {
            actionError = ReportActionError.unavailable(reason).localizedDescription
            return nil
        }
        if form.command.confirm != nil, !confirmed {
            actionError = ReportActionError.confirmationRequired.localizedDescription
            return nil
        }
        guard let input = answers.commitInput(for: form) else {
            actionError = ReportActionError.incompleteAnswers.localizedDescription
            return nil
        }
        busyActionID = form.command.id
        defer { busyActionID = nil }
        do {
            try await service.commitPrepared(input)
            let outcome = ReportActionOutcome.done("Approved and imported.")
            actionNotice = "Approved and imported."
            await refresh()
            restartPolling()
            return outcome
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    static func perform(
        _ request: ReportCommandRequest, service: any ReportServing
    ) async throws -> ReportActionOutcome {
        switch request {
        case .runControl(let control):
            let successor = try await service.controlRun(
                .init(
                    runId: control.runId, action: control.action,
                    operationId: control.operationId, approvalId: control.approvalId))
            if let successor { return .openedRun(successor) }
            return .done(nil)
        case .resolveFinding(let finding):
            let applied = try await service.resolveFinding(
                .init(
                    reviewedFingerprint: finding.reviewedFingerprint, id: finding.findingId,
                    action: finding.decision == .apply ? .apply : .dismiss))
            return .done(applied ? "Applied import correction" : "Dismissed import finding")
        case .retryGmailSearch(let retry):
            try await service.resendGmailSearch(.init(shortcode: retry.runId))
            return .done("Resent to the background queue")
        }
    }
}
