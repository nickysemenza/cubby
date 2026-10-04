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
        var reparses: [RecipeReparseLineInput] = []
        var flows: [RecipeFlowGenerateInput] = []
        var reprocessed: [CookbookReprocessChunkInput] = []
        var imported: [CookbookImportChunkInput] = []
        var added: [MealAddRecipeInput] = []
        var scaled: [MealUpdateRecipeInput] = []
        var removed: [MealRecipeIdInput] = []
        var prepared: [SaveMealRecipePreparationInput] = []
    }
    let calls = Mutex(Calls())
    /// The import call (1-based) that reports a failure; 0 means none do.
    let importFailsOnCall = Mutex(0)
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
    func reparseLine(_ input: RecipeReparseLineInput) async throws -> RecipeReparseLineOutput {
        calls.withLock { $0.reparses.append(input) }
        return try decode(
            #"{"recipeId": "\#(input.recipeId)", "status": "updated", "changed": ["amount", "name"]}"#)
    }
    func generateFlow(_ input: RecipeFlowGenerateInput) async throws {
        calls.withLock { $0.flows.append(input) }
    }
    func reprocessCookbook(_ input: CookbookReprocessChunkInput) async throws -> CookbookChunkResult {
        calls.withLock { $0.reprocessed.append(input) }
        // Two windows of two, then a short last one.
        return input.offset < 4
            ? CookbookChunkResult(done: 2, failureText: nil, next: input.offset + 2)
            : CookbookChunkResult(done: 1, failureText: nil, next: nil)
    }
    func importCookbookRecipes(_ input: CookbookImportChunkInput) async throws -> CookbookChunkResult {
        calls.withLock { $0.imported.append(input) }
        let failing = calls.withLock { $0.imported.count } == importFailsOnCall.withLock { $0 }
        return CookbookChunkResult(
            done: failing ? 0 : input.recipeIds.count,
            failureText: failing ? "1 failed: 001.0003: boom" : nil, next: nil)
    }
    func addMealRecipe(_ input: MealAddRecipeInput) async throws {
        calls.withLock { $0.added.append(input) }
    }
    func updateMealRecipe(_ input: MealUpdateRecipeInput) async throws {
        calls.withLock { $0.scaled.append(input) }
    }
    func removeMealRecipe(_ input: MealRecipeIdInput) async throws {
        calls.withLock { $0.removed.append(input) }
    }
    func saveMealPreparation(_ input: SaveMealRecipePreparationInput) async throws {
        calls.withLock { $0.prepared.append(input) }
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

private let reparse = #"""
    {"id": "reparse:8f0d4c2a-6b1e-4c7a-9a52-0d3f1e5b7c91", "label": "Re-parse", "prominent": false,
     "confirm": "Re-parse this line in Synthetic Tart with the current parser?",
     "request": {"kind": "reparse-line", "recipeId": "RCP-4K7M",
                 "lineId": "8f0d4c2a-6b1e-4c7a-9a52-0d3f1e5b7c91"}}
    """#

private let generateFlow = #"""
    {"id": "generate-flow:first", "label": "Generate walkthrough", "prominent": true,
     "confirm": "Ask the AI to arrange this recipe's steps? It uses the model.",
     "request": {"kind": "generate-recipe-flow", "recipeId": "RCP-4K7M", "force": false}}
    """#

private let mealRecipeID = "8f0d4c2a-6b1e-4c7a-9a52-0d3f1e5b7c91"

private let scaleCommand = #"""
    {"id": "scale:x", "label": "Change scale", "prominent": false, "confirm": null,
     "inputs": [{"kind": "number", "key": "scale", "label": "Recipe scale", "initial": 2, "min": 0.01}],
     "request": {"kind": "meal-scale-recipe", "mealRecipeId": "\#(mealRecipeID)", "scale": null}}
    """#

private let removeCommand = #"""
    {"id": "remove:x", "label": "Remove", "prominent": false,
     "confirm": "Remove Synthetic stew from this meal?",
     "request": {"kind": "meal-remove-recipe", "mealRecipeId": "\#(mealRecipeID)"}}
    """#

private let addRecipeCommand = #"""
    {"id": "add-recipe", "label": "Add recipe", "prominent": true, "confirm": null,
     "inputs": [{"kind": "record", "key": "recipeId", "label": "Recipe", "entity": "recipe"},
                {"kind": "number", "key": "scale", "label": "Recipe scale", "initial": 1, "min": 0.01},
                {"kind": "choice", "key": "convertToCooked", "label": "Not cooked yet", "initial": "true",
                 "options": [{"value": "true", "label": "Switch"}, {"value": "false", "label": "Keep"}]}],
     "request": {"kind": "meal-add-recipe", "mealId": "MEL-4K7M", "recipeId": null, "scale": null,
                 "convertToCooked": null}}
    """#

private let addPortionCommand = #"""
    {"id": "portion-add", "label": "Add portion", "prominent": true, "confirm": null,
     "inputs": [{"kind": "record", "key": "ledgerPartyId", "label": "Eater", "entity": "ledgerParty"},
                {"kind": "number", "key": "value", "label": "Amount", "initial": 1, "min": 0.01},
                {"kind": "choice", "key": "unit", "label": "Unit", "initial": "serving",
                 "options": [{"value": "serving", "label": "serving"}, {"value": "g", "label": "g"}]}],
     "request": {"kind": "meal-portion-set", "mealRecipeId": "\#(mealRecipeID)", "mealId": "MEL-4K7M",
                 "ledgerPartyId": null, "value": null, "unit": null, "confirmed": false}}
    """#

private let markEatenCommand = #"""
    {"id": "portion-status", "label": "Mark eaten", "prominent": false, "confirm": null,
     "request": {"kind": "meal-portion-set", "mealRecipeId": "\#(mealRecipeID)", "mealId": "MEL-4K7M",
                 "ledgerPartyId": "LPY-4K7M", "value": 1, "unit": "serving", "confirmed": true}}
    """#

private let yieldCommand = #"""
    {"id": "yield", "label": "Set actual yield", "prominent": false, "confirm": null,
     "inputs": [{"kind": "number", "key": "grams", "label": "Made (g)", "initial": null, "min": 1}],
     "request": {"kind": "meal-yield", "mealRecipeId": "\#(mealRecipeID)", "field": "actual", "grams": null}}
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

    @Test("A re-parse asks first, then sends only the line's ids and words what the server changed")
    func reparseSendsOnlyTheLine() async throws {
        let action: ReportCommand = try decode(reparse)
        let service = FakeReports([try report(live: false, status: "completed")])
        let model = model(service)

        #expect(await model.run(action, confirmed: false) == nil)
        #expect(service.calls.withLock { $0.reparses.isEmpty })

        #expect(await model.run(action, confirmed: true) == .done("Re-parsed the line (amount, name)"))
        let sent = try #require(service.calls.withLock { $0.reparses.first })
        #expect(sent.recipeId == "RCP-4K7M")
        #expect(sent.lineId == "8f0d4c2a-6b1e-4c7a-9a52-0d3f1e5b7c91")
        // The report is read again so the drifted badge and its command disappear.
        #expect(service.calls.withLock { $0.reads.count } == 1)
    }

    @Test("Generating a walkthrough spends the model, so it waits for the confirmation")
    func generatingAWalkthroughNeedsConfirmation() async throws {
        let action: ReportCommand = try decode(generateFlow)
        let service = FakeReports([try report(live: false, status: "completed")])
        let model = model(service)

        #expect(await model.run(action, confirmed: false) == nil)
        #expect(service.calls.withLock { $0.flows.isEmpty })

        #expect(await model.run(action, confirmed: true) == .done("Walkthrough generated"))
        let sent = try #require(service.calls.withLock { $0.flows.first })
        #expect(sent.id == "RCP-4K7M")
        #expect(sent.force == false)
        #expect(sent.guidance == nil)
    }

    @Test("A scale the person types goes out with the server's ids; an empty or too-small one sends nothing")
    func scaleSendsTheTypedValue() async throws {
        let command: ReportCommand = try decode(scaleCommand)
        let service = FakeReports([try report(live: false, status: "completed")])
        let model = model(service)

        var form = ReportCommandForm(command: command)
        // Seeded with the current scale, so an untouched form is already complete.
        #expect(form.number("scale") == 2)
        form.setNumber("scale", nil)
        #expect(!form.isComplete)
        #expect(await model.run(command, confirmed: false, form: form) == nil)
        form.setNumber("scale", 0.001)
        #expect(!form.isComplete)
        #expect(service.calls.withLock { $0.scaled.isEmpty })

        form.setNumber("scale", 3)
        #expect(await model.run(command, confirmed: false, form: form) == .done("Scale changed"))
        let sent = try #require(service.calls.withLock { $0.scaled.first })
        #expect(sent.id == mealRecipeID)
        #expect(sent.scale == 3)
    }

    @Test("A number field keeps what was typed, and only a number counts as an answer")
    func numberFieldsKeepTheirText() throws {
        var form = ReportCommandForm(command: try decode(scaleCommand))
        #expect(form.numberText("scale") == "2")
        form.setNumberText("scale", "1.")
        #expect(form.numberText("scale") == "1.")
        #expect(form.number("scale") == 1)
        form.setNumberText("scale", "1.5")
        #expect(form.number("scale") == 1.5)
        form.setNumberText("scale", "a lot")
        #expect(form.number("scale") == nil)
        #expect(form.missing == ["Recipe scale"])
    }

    @Test("Reprocessing asks first, then walks the server's windows until the last")
    func reprocessWalksWindows() async throws {
        let reprocess: ReportCommand = try decode(
            #"{"id":"reprocess","label":"Reprocess","prominent":false,"confirm":"Re-derive 5 recipes (no AI)?","request":{"kind":"reprocess-cookbook","cookbookId":"CKB-4K7M"}}"#
        )
        let service = FakeReports([try report(live: false, status: "completed")])
        let model = model(service)
        #expect(await model.run(reprocess, confirmed: false) == nil)
        #expect(service.calls.withLock { $0.reprocessed.isEmpty })
        #expect(await model.run(reprocess, confirmed: true) == .done("Reprocessed 5 recipes"))
        #expect(service.calls.withLock { $0.reprocessed.map(\.offset) } == [0, 2, 4])
    }

    @Test("Adding source recipes goes a server-sized chunk at a time and stops at the first failure")
    func importIsChunkedAndStopsOnError() async throws {
        let add: ReportCommand = try decode(
            #"{"id":"import:all","label":"Add all 5","prominent":true,"confirm":"Import all 5 (no AI)?","request":{"kind":"import-cookbook-recipes","cookbookId":"CKB-4K7M","recipeIds":["a","b","c","d","e"],"chunkSize":2}}"#
        )
        let service = FakeReports([try report(live: false, status: "completed")])
        let model = model(service)
        #expect(await model.run(add, confirmed: false) == nil)
        #expect(service.calls.withLock { $0.imported.isEmpty })
        #expect(await model.run(add, confirmed: true) == .done("Added 5 recipes"))
        #expect(service.calls.withLock { $0.imported.map(\.recipeIds) } == [["a", "b"], ["c", "d"], ["e"]])

        // The second chunk fails: nothing after it is sent, and the raw reason is shown.
        let failing = FakeReports([try report(live: false, status: "completed")])
        failing.importFailsOnCall.withLock { $0 = 2 }
        let failingModel = self.model(failing)
        #expect(await failingModel.run(add, confirmed: true) == nil)
        #expect(failing.calls.withLock { $0.imported.count } == 2)
        #expect(failingModel.actionError?.contains("001.0003: boom") == true)
    }

    @Test("Removing a recipe from a meal waits for the confirmation")
    func removingNeedsConfirmation() async throws {
        let command: ReportCommand = try decode(removeCommand)
        let service = FakeReports([try report(live: false, status: "completed")])
        let model = model(service)
        #expect(await model.run(command, confirmed: false) == nil)
        #expect(service.calls.withLock { $0.removed.isEmpty })
        #expect(await model.run(command, confirmed: true) == .done("Removed from the meal"))
        #expect(service.calls.withLock { $0.removed.first?.id } == mealRecipeID)
    }

    @Test("Adding a recipe needs the picked recipe, and sends it with the scale and the meal")
    func addingARecipeNeedsThePick() async throws {
        let command: ReportCommand = try decode(addRecipeCommand)
        let service = FakeReports([try report(live: false, status: "completed")])
        let model = model(service)

        var form = ReportCommandForm(command: command)
        #expect(form.missing == ["Recipe"])
        #expect(await model.run(command, confirmed: false, form: form) == nil)
        #expect(service.calls.withLock { $0.added.isEmpty })

        form.setRecord("recipeId", id: "RCP-4K7M", title: "Synthetic stew")
        form.setNumber("scale", 1.5)
        #expect(form.isComplete)
        #expect(await model.run(command, confirmed: false, form: form) == .done("Added to the meal"))
        let sent = try #require(service.calls.withLock { $0.added.first })
        #expect(sent.mealId == "MEL-4K7M")
        #expect(sent.recipeId == "RCP-4K7M")
        #expect(sent.scale == 1.5)
        // The seeded answer is the reviewed one; changing it changes what is sent.
        #expect(sent.convertToCooked == true)
    }

    @Test("A portion is one set change; marking eaten resends the server's amount")
    func portionsAreSetChanges() async throws {
        let service = FakeReports([try report(live: false, status: "completed")])
        let model = model(service)

        let add: ReportCommand = try decode(addPortionCommand)
        var form = ReportCommandForm(command: add)
        form.setRecord("ledgerPartyId", id: "LPY-4K7M", title: "Test eater")
        form.setNumber("value", 250)
        form.setChoice("unit", "g")
        #expect(await model.run(add, confirmed: false, form: form) == .done("Portion saved"))

        let eaten: ReportCommand = try decode(markEatenCommand)
        #expect(await model.run(eaten, confirmed: false) == .done("Portion saved"))

        let sent = service.calls.withLock { $0.prepared }
        #expect(sent.count == 2)
        let first = try JSONValue(encoding: sent[0])
        #expect(first["mealRecipeId"]?.stringValue == mealRecipeID)
        #expect(first["changes"]?.arrayValue?.count == 1)
        let change = try #require(first["changes"]?.arrayValue?.first)
        #expect(change["action"]?.stringValue == "set")
        #expect(change["mealId"]?.stringValue == "MEL-4K7M")
        #expect(change["ledgerPartyId"]?.stringValue == "LPY-4K7M")
        #expect(change["amount"]?["value"]?.doubleValue == 250)
        #expect(change["amount"]?["unit"]?.stringValue == "g")
        #expect(change["confirmed"]?.boolValue == false)
        let second = try JSONValue(encoding: sent[1])
        #expect(second["changes"]?.arrayValue?.first?["confirmed"]?.boolValue == true)
        #expect(second["changes"]?.arrayValue?.first?["amount"]?["unit"]?.stringValue == "serving")
    }

    @Test("A yield is whole grams the person enters")
    func yieldSendsTheActualGrams() async throws {
        let command: ReportCommand = try decode(yieldCommand)
        let service = FakeReports([try report(live: false, status: "completed")])
        let model = model(service)
        var form = ReportCommandForm(command: command)
        #expect(!form.isComplete)
        form.setNumber("grams", 1200)
        #expect(await model.run(command, confirmed: false, form: form) == .done("Yield saved"))
        let sent = try JSONValue(encoding: try #require(service.calls.withLock { $0.prepared.first }))
        #expect(sent["actualYieldGrams"]?.doubleValue == 1200)
        #expect(sent["changes"]?.arrayValue?.isEmpty == true)
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
