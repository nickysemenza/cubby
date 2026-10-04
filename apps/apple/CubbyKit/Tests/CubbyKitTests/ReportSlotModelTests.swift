import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// A recording stand-in for the server: answers the report read from a script and records every
/// write, so a test can prove what a tap did and did not send.
private final class FakeReports: ReportServing {
    struct Calls {
        var reads: [String] = []
        var controls: [RunControlInput] = []
        var findings: [ResolveRunFindingInput] = []
        var retries = 0
    }
    let calls = Mutex(Calls())
    let pages: Mutex<[EntityReportOut]>

    /// How long a read takes, so a test can act while one is in flight.
    let delay: Duration
    /// When set, a read answers by its cursor (`-` for the first page) instead of in sequence.
    let byCursor: [String: EntityReportOut]?

    init(
        _ pages: [EntityReportOut], delay: Duration = .zero, byCursor: [String: EntityReportOut]? = nil
    ) {
        self.pages = Mutex(pages)
        self.delay = delay
        self.byCursor = byCursor
    }

    func report(slot: ReportSlot, id: String, cursor: String?) async throws -> EntityReportOut {
        calls.withLock { $0.reads.append("\(slot.rawValue)|\(cursor ?? "-")") }
        try? await Task.sleep(for: delay)
        if let byCursor { return byCursor[cursor ?? "-"] ?? byCursor["-"]! }
        return pages.withLock { $0.count > 1 ? $0.removeFirst() : $0[0] }
    }
    func reports(slots: [ReportSlot], id: String) async throws -> [(ReportSlot, EntityReportOut)] {
        calls.withLock { $0.reads.append("batch:\(slots.count)") }
        try? await Task.sleep(for: delay)
        let page = pages.withLock { $0.count > 1 ? $0.removeFirst() : $0[0] }
        return slots.map { ($0, page) }
    }
    func controlRun(_ input: RunControlInput) async throws -> String? {
        calls.withLock { $0.controls.append(input) }
        return nil
    }
    func resolveFinding(_ input: ResolveRunFindingInput) async throws -> Bool {
        calls.withLock { $0.findings.append(input) }
        return input.action == .apply
    }
    func resendGmailSearch(_ input: RunRetryGmailSearchInput) async throws {
        calls.withLock { $0.retries += 1 }
        throw URLError(.badServerResponse)
    }
    func commitPrepared(_ input: RunCommitPreparedInput) async throws {}
}

private func decode<T: Decodable>(_ json: String) throws -> T {
    try JSONDecoder.cubby().decode(T.self, from: Data(json.utf8))
}

private func row(_ id: String, actions: String = "[]") -> String {
    #"{"entity": null, "id": null, "title": "\#(id)", "subtitle": null, "trailing": null, "key": "\#(id)", "statuses": [], "lines": [], "commands": \#(actions)}"#
}

private func report(
    live: Bool, status: String = "running", rows: [String] = [], nextCursor: String? = nil
) throws -> EntityReportOut {
    let cursor = nextCursor.map { #","nextCursor":"\#($0)""# } ?? ""
    return try decode(
        #"{"blocks": [{"kind": "records", "empty": "", "rows": [\#(rows.joined(separator: ","))]}], "live": \#(live), "status": "\#(status)"\#(cursor)}"#
    )
}

private let approve = #"""
    {"id": "approval-1:approve", "label": "Approve import proposal", "prominent": true,
     "confirm": "Approve product_overwrite?",
     "request": {"kind": "run-control", "runId": "RUN-4K7M", "action": "approve",
                 "operationId": "op-1", "approvalId": "approval-1"}}
    """#

private let dismiss = #"""
    {"id": "f:dismiss", "label": "Dismiss", "prominent": false, "confirm": null,
     "request": {"kind": "resolve-finding", "findingId": "8f0d4c2a-6b1e-4c7a-9a52-0d3f1e5b7c91",
                 "decision": "dismiss", "reviewedFingerprint": null}}
    """#

/// Waits (bounded) for `condition`, so a polling test does not depend on how loaded the machine is.
@MainActor
private func eventually(_ condition: () -> Bool) async {
    for _ in 0..<400 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
}

@MainActor
@Suite("Report slot model")
struct ReportSlotModelTests {
    private func model(_ service: FakeReports, shown: String? = nil) -> ReportSlotModel {
        ReportSlotModel(
            slot: .run_importApprovals, id: "RUN-4K7M", shownStatus: shown, service: service,
            pollInterval: .milliseconds(5))
    }

    private func rowIDs(_ presentation: ReportPresentation?) -> [String] {
        presentation?.blocks.flatMap { block -> [String] in
            if case .records(let records) = block { records.rows.compactMap(\.key) } else { [] }
        } ?? []
    }

    @Test("An approval sends nothing until the person confirms, then the exact request")
    func approvalNeedsConfirmation() async throws {
        let action: ReportCommand = try decode(approve)
        let service = FakeReports([try report(live: true, rows: [row("a")])])
        let model = model(service)

        #expect(await model.run(action, confirmed: false) == nil)
        #expect(service.calls.withLock { $0.controls.isEmpty })
        #expect(model.actionError != nil)

        #expect(await model.run(action, confirmed: true) == .done(nil))
        let sent = try #require(service.calls.withLock { $0.controls.first })
        #expect(sent.runId == "RUN-4K7M")
        #expect(sent.action == .approve)
        #expect(sent.operationId == "op-1")
        #expect(sent.approvalId == "approval-1")
        #expect(service.calls.withLock { $0.controls.count } == 1)
    }

    @Test("An action with no confirmation acts on the tap and refreshes the report")
    func dismissActsImmediately() async throws {
        let action: ReportCommand = try decode(dismiss)
        let service = FakeReports([try report(live: false, status: "completed")])
        let model = model(service)
        #expect(await model.run(action, confirmed: false) == .done("Dismissed import finding"))
        let sent = try #require(service.calls.withLock { $0.findings.first })
        #expect(sent.action == .dismiss)
        #expect(sent.reviewedFingerprint == nil)
        #expect(service.calls.withLock { $0.reads.count } == 1)
    }

    @Test("A failed action keeps the server's raw error and does not look done")
    func failedAction() async throws {
        let retry: ReportCommand = try decode(
            #"""
            {"id": "r", "label": "Retry", "prominent": false, "confirm": null,
             "request": {"kind": "retry-gmail-search", "runId": "RUN-4K7M"}}
            """#)
        let model = model(FakeReports([try report(live: false, status: "completed")]))
        #expect(await model.run(retry, confirmed: false) == nil)
        #expect(model.actionError != nil)
        #expect(model.busyActionID == nil)
    }

    @Test("Polling continues while the run is live and stops once it is not")
    func pollsOnlyWhileLive() async throws {
        let service = FakeReports([
            try report(live: true, rows: [row("a")]),
            try report(live: true, rows: [row("a")]),
            try report(live: false, status: "completed", rows: [row("b")]),
        ])
        let model = model(service)
        model.retain()
        await eventually { model.presentation != nil && !model.live }
        model.release()
        #expect(service.calls.withLock { $0.reads.count } == 3)
        #expect(!model.live)
        #expect(rowIDs(model.presentation) == ["b"])
    }

    @Test("Releasing the last reader stops polling")
    func releaseStopsPolling() async throws {
        let service = FakeReports([try report(live: true, rows: [row("a")])])
        let model = model(service)
        model.retain()
        model.retain()
        model.release()
        // One reader remains, so polling goes on.
        await eventually { service.calls.withLock { $0.reads.count } > 2 }
        model.release()
        try await Task.sleep(for: .milliseconds(30))
        let settled = service.calls.withLock { $0.reads.count }
        try await Task.sleep(for: .milliseconds(80))
        #expect(service.calls.withLock { $0.reads.count } == settled)
        #expect(settled > 2)
    }

    @Test("Load more appends the next page's rows under the first page")
    func pagesAReport() async throws {
        let service = FakeReports([
            try report(live: false, status: "completed", rows: [row("call-1")], nextCursor: "c2"),
            try report(live: false, status: "completed", rows: [row("call-2")]),
        ])
        let model = model(service)
        await model.refresh()
        #expect(model.canLoadMore)
        await model.loadMore()
        #expect(rowIDs(model.presentation) == ["call-1", "call-2"])
        #expect(!model.canLoadMore)
        #expect(service.calls.withLock { $0.reads } == ["run.import-approvals|-", "run.import-approvals|c2"])
    }

    @Test("A status the screen does not show asks the screen to reload once")
    func staleRecordIsReportedOnce() async throws {
        let service = FakeReports([try report(live: true, status: "paused_approval")])
        let model = model(service, shown: "running")
        var reloads = 0
        model.onRecordStale = { reloads += 1 }
        await model.refresh()
        await model.refresh()
        #expect(reloads == 1)
    }

    @Test("Records blocks keep rows, actions and the next cursor in the presentation")
    func recordsPresentation() throws {
        let page = try report(live: true, rows: [row("a", actions: "[\(approve)]")], nextCursor: "c")
        let presentation = ReportPresentation(page)
        guard case .records(let records) = presentation.blocks[0] else {
            Issue.record("expected records")
            return
        }
        #expect(records.rows[0].commands.map(\.id) == ["approval-1:approve"])
        #expect(presentation.live)
        #expect(presentation.nextCursor == "c")
    }

    @Test("Slots sharing a batch make one request per poll, however many sections there are")
    func batchedSlotsShareOneRead() async throws {
        let service = FakeReports([try report(live: false, status: "completed", rows: [row("a")])])
        let batch = ReportBatchModel(id: "RUN-4K7M", service: service, pollInterval: .milliseconds(5))
        let first = ReportSlotModel(
            slot: .run_importStats, id: "RUN-4K7M", batch: batch, service: service)
        let second = ReportSlotModel(
            slot: .run_importTimeline, id: "RUN-4K7M", batch: batch, service: service)
        first.retain()
        second.retain()
        await eventually { first.presentation != nil && second.presentation != nil }
        #expect(rowIDs(first.presentation) == ["a"])
        #expect(rowIDs(second.presentation) == ["a"])
        #expect(service.calls.withLock { $0.reads } == ["batch:\(RunReportBatch.slots.count)"])
        first.release()
        second.release()
    }

    @Test("A poll never drops pages that were loaded, and load more waits for a read in flight")
    func pollingKeepsLoadedPages() async throws {
        let service = FakeReports(
            [], delay: .milliseconds(20),
            byCursor: [
                "-": try report(
                    live: false, status: "completed", rows: [row("one")], nextCursor: "c2"),
                "c2": try report(live: false, status: "completed", rows: [row("two")]),
            ])
        let model = model(service)
        await model.refresh()
        // Asked for while a refresh is in flight: it must still load the page, not no-op.
        async let refreshing: Void = model.refresh()
        await eventually { model.isLoading }
        await model.loadMore()
        await refreshing
        #expect(rowIDs(model.presentation) == ["one", "two"])
        // A later refresh keeps the loaded page.
        await model.refresh()
        #expect(rowIDs(model.presentation) == ["one", "two"])
    }

    @Test("An action's refresh waits for a read in flight and reads again")
    func actionRefreshIsNotSwallowed() async throws {
        let action: ReportCommand = try decode(dismiss)
        let service = FakeReports(
            [
                try report(live: false, status: "completed", rows: [row("stale")]),
                try report(live: false, status: "completed", rows: [row("fresh")]),
            ], delay: .milliseconds(30))
        let model = model(service)
        async let poll: Void = model.refresh()
        await eventually { model.isLoading }
        _ = await model.run(action, confirmed: false)
        await poll
        #expect(rowIDs(model.presentation) == ["fresh"])
    }

    @Test("A stopped run polls again once restarted after its status changed")
    func restartResumesPolling() async throws {
        let service = FakeReports([
            try report(live: false, status: "completed", rows: [row("a")]),
            try report(live: true, status: "running", rows: [row("b")]),
            try report(live: true, status: "running", rows: [row("c")]),
            try report(live: false, status: "completed", rows: [row("d")]),
        ])
        let model = model(service)
        model.retain()
        await eventually { model.presentation != nil }
        let before = service.calls.withLock { $0.reads.count }
        try await Task.sleep(for: .milliseconds(40))
        #expect(service.calls.withLock { $0.reads.count } == before)
        model.restartPolling()
        await eventually { rowIDs(model.presentation) == ["d"] }
        #expect(rowIDs(model.presentation) == ["d"])
        model.release()
    }
}
