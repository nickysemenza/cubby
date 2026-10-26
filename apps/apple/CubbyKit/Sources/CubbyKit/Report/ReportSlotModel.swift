import CubbyAPI
import Foundation
import Observation

/// The reads and writes a report slot needs, narrowed to what the model uses. `CubbyClient` is
/// the one implementation; tests supply a fake.
public protocol ReportServing: Sendable {
    func report(slot: ReportSlot, id: String, cursor: String?) async throws -> EntityReportOut
    /// Several slots of one record in one read (`entityReport.getMany`).
    func reports(slots: [ReportSlot], id: String) async throws -> [(ReportSlot, EntityReportOut)]
    func executeCommand(operation: String, body: JSONValue) async throws -> JSONValue
    /// The cookbook commands, run to their end; each answers with the sentence to show.
    func reprocessCookbook(_ input: CookbookReprocessChunkInput) async throws -> CookbookChunkResult
    func importCookbookRecipes(_ input: CookbookImportChunkInput) async throws -> CookbookChunkResult
    /// `run.commitPrepared`: approve and import one prepared batch.
    func commitPrepared(_ input: RunCommitPreparedInput) async throws

}

/// Commands a read-only fake need not implement; `CubbyClient` always does.
extension ReportServing {
    public func executeCommand(operation: String, body: JSONValue) async throws -> JSONValue {
        throw ReportActionError.unavailable("Not supported by this service.")
    }
    public func reprocessCookbook(_ input: CookbookReprocessChunkInput) async throws
        -> CookbookChunkResult
    {
        throw ReportActionError.unavailable("Not supported by this service.")
    }
    public func importCookbookRecipes(_ input: CookbookImportChunkInput) async throws
        -> CookbookChunkResult
    {
        throw ReportActionError.unavailable("Not supported by this service.")
    }
}

extension CubbyClient: ReportServing {
    public func report(slot: ReportSlot, id: String, cursor: String?) async throws -> EntityReportOut {
        try await entityReport(slot: slot, id: id, cursor: cursor)
    }

    public func reports(slots: [ReportSlot], id: String) async throws -> [(ReportSlot, EntityReportOut)] {
        try await entityReports(slots: slots, id: id)
    }

    public func reprocessCookbook(_ input: CookbookReprocessChunkInput) async throws
        -> CookbookChunkResult
    {
        let out: RecipeReprocessCookbookOnceOutput = try await reprocessCookbook(input)
        return CookbookChunkResult(done: out.reprocessed, failureText: nil, next: out.nextOffset)
    }

    public func importCookbookRecipes(_ input: CookbookImportChunkInput) async throws
        -> CookbookChunkResult
    {
        let out: RecipeImportCookbookRecipesOnceOutput = try await importCookbookRecipes(input)
        return CookbookChunkResult(
            done: out.imported,
            failureText: out.failed > 0
                ? "\(out.failed) failed: "
                    + out.failures.map { "\($0.sourceRecipeId): \($0.error)" }.joined(separator: "; ")
                : nil,
            next: nil)
    }

    public func commitPrepared(_ input: RunCommitPreparedInput) async throws {
        let _: CommitPurchaseImportOut = try await commitPreparedImport(input)
    }
}

/// One bounded call of a cookbook command: how many recipes it finished, the raw reason any
/// failed, and where a reprocess continues (nil when it was the last window).
public struct CookbookChunkResult: Sendable, Equatable {
    public let done: Int
    public let failureText: String?
    public let next: Int?

    public init(done: Int, failureText: String?, next: Int?) {
        self.done = done
        self.failureText = failureText
        self.next = next
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
    /// How far a command that runs in several calls has got ("Added 40 recipes…").
    public private(set) var actionProgress: String?
    public private(set) var openedRunID: String?

    public let slot: ReportSlot
    public let id: String
    /// The status the detail screen currently shows; a different one from the server asks the
    /// screen to reload its record.
    public var shownStatus: String?
    @ObservationIgnored public var onRecordStale: (@MainActor () -> Void)?
    /// For a host that reads the report itself (Today's briefing): a refresh, including the one
    /// after a command, reloads through it and the model keeps no copy.
    @ObservationIgnored public var reload: (@MainActor () async -> Void)?

    @ObservationIgnored private let service: any ReportServing
    @ObservationIgnored private let batch: ReportBatchModel?
    @ObservationIgnored private let waitForNextPoll: @Sendable () async throws -> Void
    @ObservationIgnored private var watchers = 0
    @ObservationIgnored private(set) var pollTask: Task<Void, Never>?
    /// Callers waiting for the read in flight to finish; a later read never overlaps it. Observed,
    /// so a test can see a read queue behind the one in flight.
    private var loadWaiters: [CheckedContinuation<Void, Never>] = []
    var queuedLoads: Int { loadWaiters.count }
    @ObservationIgnored private var staleStatusReported: String?
    /// Pages after the first, kept across a refresh so polling never drops what was loaded.
    @ObservationIgnored private var laterPages: [ReportPresentation] = []

    /// With a `batch`, the slot reads, polls and refreshes through it (one request for all of
    /// the screen's slots); without, it reads its own report and pages with the cursor.
    public init(
        slot: ReportSlot, id: String, shownStatus: String? = nil, batch: ReportBatchModel? = nil,
        service: any ReportServing,
        waitForNextPoll: @escaping @Sendable () async throws -> Void = {
            try await Task.sleep(for: .seconds(3))
        }
    ) {
        self.slot = slot
        self.id = id
        self.shownStatus = shownStatus
        self.batch = batch
        self.service = service
        self.waitForNextPoll = waitForNextPoll
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
        if let reload { return await reload() }
        if let batch { return await batch.refresh() }
        await loadFinished()
        isLoading = true
        defer { endLoading() }
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
        await loadFinished()
        guard let current = ownPresentation, let cursor = current.nextCursor else { return }
        isLoading = true
        defer { endLoading() }
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
                try? await self.waitForNextPoll()
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
    public func run(
        _ action: ReportCommand, confirmed: Bool, form: ReportCommandForm? = nil
    ) async -> ReportActionOutcome? {
        guard busyActionID == nil else { return nil }
        if action.declaredConfirmation != nil, !confirmed {
            actionError = ReportActionError.confirmationRequired.localizedDescription
            return nil
        }
        // A command that asks for inputs is not sent until every one has a usable answer.
        if !(action.inputs ?? []).isEmpty, !(form?.isComplete ?? false) {
            actionError = ReportActionError.incompleteAnswers.localizedDescription
            return nil
        }
        busyActionID = action.id
        actionError = nil
        actionNotice = nil
        defer { busyActionID = nil }
        do {
            defer { actionProgress = nil }
            let outcome = try await Self.perform(
                action.request, form: form, service: service
            ) { [weak self] in self?.actionProgress = $0 }
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
        _ request: ReportCommandRequest, form: ReportCommandForm?, service: any ReportServing,
        progress: @MainActor (String) -> Void = { _ in }
    ) async throws -> ReportActionOutcome {
        switch request {
        case .unrecognized(let raw):
            throw UnsupportedNativeResponse(context: "report command", raw: raw)
        case .operation(let command):
            guard let presentation = WorkflowCommandCatalog.presentation(for: command.operation) else {
                throw ReportActionError.unavailable("Undeclared user command: \(command.operation)")
            }
            let bindings =
                try command.bindings.map {
                    try JSONValue(encoding: $0).objectValue?.compactMapValues(\.stringValue) ?? [:]
                } ?? [:]
            let body = try ReportCommandForm.commandBody(
                try JSONValue(encoding: command.body), bindings: bindings,
                form: form, booleanInputs: presentation.booleanInputs)
            let output = try await service.executeCommand(operation: command.operation, body: body)
            let result = output
            if let path = presentation.navigateRunPath,
                let runID = try JSONRead(value: result, context: command.operation).optionalString(path)
            {
                return .openedRun(runID)
            }
            if let path = presentation.runIdsPath {
                let runs =
                    result.pathValue(path)?.arrayValue?.compactMap(\.stringValue)
                    ?? result.pathText(path).map { [$0] } ?? []
                if runs.count == 1, let runID = runs.first { return .openedRun(runID) }
                if !runs.isEmpty { return .done("Import Runs: " + runs.joined(separator: ", ")) }
            }
            return .done(presentation.message(for: result) ?? "\(presentation.label) completed")
        case .reprocessCookbook(let book):
            // One bounded window per call; the first error ends the loop, and what landed is
            // already finalized by the server.
            var offset = 0
            var total = 0
            while true {
                let result = try await service.reprocessCookbook(
                    .init(cookbookId: book.cookbookId, offset: offset))
                total += result.done
                progress("Reprocessed \(total) recipes…")
                guard let next = result.next else { break }
                offset = next
            }
            return .done("Reprocessed \(total) recipes")
        case .importCookbookRecipes(let book):
            var added = 0
            var start = 0
            let size = max(1, book.chunkSize)
            while start < book.recipeIds.count {
                let chunk = Array(book.recipeIds[start..<min(start + size, book.recipeIds.count)])
                let result = try await service.importCookbookRecipes(
                    .init(cookbookId: book.cookbookId, recipeIds: chunk))
                added += result.done
                if let failure = result.failureText {
                    throw ReportActionError.unavailable(
                        "Added \(added) of \(book.recipeIds.count); \(failure)")
                }
                start += size
                progress("Added \(added) of \(book.recipeIds.count)…")
            }
            return .done("Added \(added) recipes")
        }
    }
}
