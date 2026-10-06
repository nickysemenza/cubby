import Foundation
import Synchronization
import Testing

@testable import CubbyKit

// Failure modes this guards (web's `commitPreparedInput` has the same cases in
// `report-choice.unit.test.ts`): an existing-Product decision with no Product, or an unresolved one
// with a blank reason, counted as answered; the exact suggestion preselected for the person; a
// decision sent under another line's order or line ids; the trade left out; a commit sent without
// the confirmation the server declared, twice, or while incomplete; an answer change that keeps the
// old operation id (the server rejects a replayed id carrying other input).

private func decode<T: Decodable>(_ json: String) throws -> T {
    try JSONDecoder.cubby().decode(T.self, from: Data(json.utf8))
}

private func choiceJSON(_ id: String, title: String) -> String {
    #"""
    {"id": "\#(id)", "label": "Product decision for \#(title)", "required": true,
     "options": [
       {"id": "existing", "label": "Use an existing Product",
        "pick": {"entity": "product", "label": "Product for \#(title)"}},
       {"id": "new", "label": "Create a new Product", "hint": "A new Product will use this line."},
       {"id": "unresolved", "label": "Leave Product unresolved",
        "text": {"label": "Reason for leaving \#(title) unresolved"}},
       {"id": "expense_only", "label": "Record as an expense only"}],
     "suggestions": [
       {"optionId": "existing", "entity": "product", "id": "PRD-4K7M", "name": "Exact thing",
        "label": "Use Exact thing", "subtitle": "Fixture maker", "badges": ["Exact identifier"]}]}
    """#
}

private func lineRow(_ title: String, choice: String? = nil) -> String {
    let choice = choice.map { #","choice": \#($0)"# } ?? ""
    return
        #"{"entity": null, "id": null, "title": "\#(title)", "subtitle": null, "trailing": "$12.50", "key": "line:\#(title)", "statuses": [], "lines": [], "commands": []\#(choice)}"#
}

/// A prepared batch: two Product lines (same stable line id in two orders), one adjustment.
private func preparedReport(disabledReason: String? = nil, committedTrade: Bool = true) throws
    -> EntityReportOut
{
    let reason = disabledReason.map { #""\#($0)""# } ?? "null"
    let trade =
        committedTrade
        ? #"""
        {"id": "trade", "label": "Trade for imported expenses", "required": true,
         "options": [{"id": "other", "label": "Other"}, {"id": "plumbing", "label": "Plumbing"}]}
        """# : ""
    return try decode(
        #"""
        {"blocks": [{"kind": "records", "empty": "", "rows": [
           \#(lineRow("Item A", choice: choiceJSON("o1/l1", title: "Item A"))),
           \#(lineRow("Item B", choice: choiceJSON("o2/l1", title: "Item B"))),
           \#(lineRow("Adjustment"))],
         "form": {"choices": [\#(trade)],
                  "note": "Approval imports the prepared orders and expenses.",
                  "noun": "Product decision", "completeText": "All Product decisions reviewed.",
                  "disabledReason": \#(reason), "doneText": "Prepared import approved and committed.",
                  "command": {"id": "commit:prepare-1", "label": "Approve and import",
                              "prominent": true,
                              "confirm": "Import 2 prepared orders (3 lines)? Inventory is not changed.",
                              "request": {"kind": "commit-prepared", "runId": "RUN-4K7M",
                                          "prepareOperationId": "prepare-1", "tradeChoiceId": "trade",
                                          "lines": [
                                            {"choiceId": "o1/l1", "stableOrderId": "o1", "stableLineId": "l1"},
                                            {"choiceId": "o2/l1", "stableOrderId": "o2", "stableLineId": "l1"}]}}}}],
         "live": true, "status": "running"}
        """#)
}

private struct MissingRecords: Error {}

private func recordsBlock(_ presentation: ReportPresentation) -> ReportPresentation.Records? {
    for case .records(let records) in presentation.blocks { return records }
    return nil
}

private func recordsBlock(_ report: EntityReportOut) throws -> ReportPresentation.Records {
    guard let block = recordsBlock(ReportPresentation(report)) else { throw MissingRecords() }
    return block
}

@Suite("Report choice answers")
struct ReportChoiceAnswersTests {
    @Test("A prepared batch parses into per-line choices and one form, with nothing preselected")
    func parses() throws {
        let batch = try recordsBlock(try preparedReport())
        let form = try #require(batch.form)
        #expect(form.noun == "Product decision")
        #expect(form.command.label == "Approve and import")
        #expect(form.choices.map(\.id) == ["trade"])
        let choice = try #require(batch.rows.first?.choice)
        #expect(choice.required)
        #expect(choice.options.map(\.id) == ["existing", "new", "unresolved", "expense_only"])
        #expect(choice.options[0].pick?.entity == "product")
        #expect(choice.options[2].text == "Reason for leaving Item A unresolved")
        #expect(choice.suggestions.first?.badges == ["Exact identifier"])
        #expect(choice.suggestions.first?.optionID == "existing")
        #expect(batch.rows.last?.choice == nil)
        #expect(batch.rowChoices.map(\.id) == ["o1/l1", "o2/l1"])
        // An exact suggestion is only ranked: the person has answered nothing yet.
        let answers = ReportChoiceAnswers()
        #expect(answers.answer(for: "o1/l1") == nil)
        #expect(answers.remaining(in: batch.rowChoices) == 2)
        #expect(!answers.canSubmit(form: form, rowChoices: batch.rowChoices))
    }

    @Test("A pick option needs a record and a text option needs a non-blank reason")
    func completeness() throws {
        let block = try recordsBlock(try preparedReport())
        let choice = try #require(block.rows.first?.choice)
        var answers = ReportChoiceAnswers()
        #expect(!answers.isAnswered(choice))
        answers.choose(choice, optionID: "existing")
        #expect(!answers.isAnswered(choice))
        answers.pick(choice, optionID: "existing", id: "PRD-4K7M", title: "Exact thing")
        #expect(answers.isAnswered(choice))
        answers.choose(choice, optionID: "unresolved")
        #expect(!answers.isAnswered(choice))
        answers.write(choice, text: "   ")
        #expect(!answers.isAnswered(choice))
        answers.write(choice, text: "Cannot tell which")
        #expect(answers.isAnswered(choice))
        answers.choose(choice, optionID: "new")
        #expect(answers.isAnswered(choice))
        answers.choose(choice, optionID: nil)
        #expect(answers.answer(for: choice.id) == nil)
    }

    @Test("The commit body carries each decision under its own order and line, with the trade")
    func commitBody() throws {
        let batch = try recordsBlock(try preparedReport())
        let form = try #require(batch.form)
        let (first, second) = (batch.rowChoices[0], batch.rowChoices[1])
        let trade = form.choices[0]
        var answers = ReportChoiceAnswers()
        #expect(answers.commitInput(for: form) == nil)
        answers.pick(first, optionID: "existing", id: "PRD-4K7M", title: "Exact thing")
        answers.choose(second, optionID: "unresolved")
        answers.write(second, text: "  Cannot tell which  ")
        #expect(answers.commitInput(for: form) == nil)  // no trade yet
        answers.choose(trade, optionID: "plumbing")
        #expect(answers.canSubmit(form: form, rowChoices: batch.rowChoices))

        let input = try #require(answers.commitInput(for: form))
        #expect(input.runId == "RUN-4K7M")
        #expect(input.operationId == answers.operationID)
        #expect(input.prepareOperationId == "prepare-1")
        #expect(input.defaultTrade?.rawValue == "plumbing")
        let sent = try JSONEncoder.cubby().encode(input.resolutions)
        let lines = try JSONDecoder().decode([[String: AnyDecodable]].self, from: sent)
        #expect(lines.map { $0["stableOrderId"]?.string } == ["o1", "o2"])
        #expect(lines.map { $0["stableLineId"]?.string } == ["l1", "l1"])
        let kinds = lines.map { $0["resolution"]?.object?["kind"]?.string }
        #expect(kinds == ["existing", "unresolved"])
        #expect(lines[0]["resolution"]?.object?["productId"]?.string == "PRD-4K7M")
        #expect(lines[1]["resolution"]?.object?["reason"]?.string == "Cannot tell which")
    }

    @Test("An expense-only decision is sent as its own kind, with no Product or reason")
    func expenseOnlyBody() throws {
        let batch = try recordsBlock(try preparedReport())
        let form = try #require(batch.form)
        var answers = ReportChoiceAnswers()
        answers.choose(batch.rowChoices[0], optionID: "expense_only")
        answers.choose(batch.rowChoices[1], optionID: "new")
        answers.choose(form.choices[0], optionID: "plumbing")
        let input = try #require(answers.commitInput(for: form))
        let sent = try JSONEncoder.cubby().encode(input.resolutions)
        let lines = try JSONDecoder().decode([[String: AnyDecodable]].self, from: sent)
        #expect(lines[0]["resolution"]?.object?.keys.sorted() == ["kind"])
        #expect(lines[0]["resolution"]?.object?["kind"]?.string == "expense_only")
    }

    @Test("Every answer change makes a new operation id; reading the same answers does not")
    func operationIDFollowsAnswers() throws {
        let batch = try recordsBlock(try preparedReport())
        let form = try #require(batch.form)
        var answers = ReportChoiceAnswers()
        let start = answers.operationID
        answers.choose(batch.rowChoices[0], optionID: "new")
        let afterOne = answers.operationID
        #expect(afterOne != start)
        _ = answers.commitInput(for: form)
        _ = answers.remaining(in: batch.rowChoices)
        #expect(answers.operationID == afterOne)
        answers.write(batch.rowChoices[0], text: "x")
        #expect(answers.operationID != afterOne)
    }

    @Test("The remaining count is worded the way web words it")
    func remainingText() throws {
        let batch = try recordsBlock(try preparedReport())
        let form = try #require(batch.form)
        var answers = ReportChoiceAnswers()
        #expect(
            answers.progressText(form: form, rowChoices: batch.rowChoices)
                == "2 Product decisions remaining. Approval imports the prepared orders and expenses.")
        answers.choose(batch.rowChoices[0], optionID: "new")
        #expect(
            answers.progressText(form: form, rowChoices: batch.rowChoices)
                == "1 Product decision remaining. Approval imports the prepared orders and expenses.")
        answers.choose(batch.rowChoices[1], optionID: "new")
        #expect(
            answers.progressText(form: form, rowChoices: batch.rowChoices)
                == "All Product decisions reviewed. Approval imports the prepared orders and expenses.")
    }
}

private final class FakeCommit: ReportServing {
    let committed = Mutex<[RunCommitPreparedInput]>([])
    let failure: (any Error)?
    init(failure: (any Error)? = nil) { self.failure = failure }
    func report(slot: ReportSlot, id: String, cursor: String?) async throws -> EntityReportOut {
        try preparedReport(
            disabledReason: committed.withLock { $0.isEmpty }
                ? nil : "Prepared import approved and committed.")
    }
    func reports(slots: [ReportSlot], id: String) async throws -> [(ReportSlot, EntityReportOut)] { [] }
    func controlRun(_ input: RunControlInput) async throws -> String? { nil }
    func resolveFinding(_ input: ResolveRunFindingInput) async throws -> Bool { false }
    func commitPrepared(_ input: RunCommitPreparedInput) async throws {
        if let failure { throw failure }
        committed.withLock { $0.append(input) }
    }
}

@MainActor
@Suite("Approve prepared orders")
struct ApprovePreparedOrdersTests {
    private func ready() throws -> (form: ReportPresentation.Form, answers: ReportChoiceAnswers) {
        let batch = try recordsBlock(try preparedReport())
        let form = try #require(batch.form)
        var answers = ReportChoiceAnswers()
        answers.choose(batch.rowChoices[0], optionID: "new")
        answers.choose(batch.rowChoices[1], optionID: "new")
        answers.choose(form.choices[0], optionID: "other")
        return (form, answers)
    }

    @Test("Nothing is sent without the declared confirmation, then the exact body once")
    func confirmsThenSends() async throws {
        let (form, answers) = try ready()
        let service = FakeCommit()
        let model = ReportSlotModel(slot: .run_importPreparedOrders, id: "RUN-4K7M", service: service)

        #expect(await model.approve(form, answers: answers, confirmed: false) == nil)
        #expect(service.committed.withLock { $0.isEmpty })
        #expect(model.actionError != nil)

        #expect(
            await model.approve(form, answers: answers, confirmed: true) == .done("Approved and imported."))
        let sent = try #require(service.committed.withLock { $0.first })
        #expect(sent.operationId == answers.operationID)
        #expect(sent.prepareOperationId == "prepare-1")
        #expect(service.committed.withLock { $0.count } == 1)
        // The refreshed report now says it is committed.
        let presentation = try #require(model.presentation)
        let fresh = try #require(recordsBlock(presentation))
        #expect(fresh.form?.disabledReason == "Prepared import approved and committed.")
    }

    @Test("An incomplete form or a form the server disabled sends nothing")
    func refusals() async throws {
        let (form, answers) = try ready()
        let service = FakeCommit()
        let model = ReportSlotModel(slot: .run_importPreparedOrders, id: "RUN-4K7M", service: service)

        #expect(await model.approve(form, answers: ReportChoiceAnswers(), confirmed: true) == nil)
        #expect(model.actionError != nil)

        let blocked = try recordsBlock(
            try preparedReport(disabledReason: "Prepared import approved and committed."))
        let disabled = try #require(blocked.form)
        #expect(await model.approve(disabled, answers: answers, confirmed: true) == nil)
        #expect(model.actionError == "Prepared import approved and committed.")
        #expect(service.committed.withLock { $0.isEmpty })
    }

    @Test("A failed commit keeps the server's raw error and is not reported as done")
    func failure() async throws {
        let (form, answers) = try ready()
        let service = FakeCommit(failure: URLError(.badServerResponse))
        let model = ReportSlotModel(slot: .run_importPreparedOrders, id: "RUN-4K7M", service: service)
        #expect(await model.approve(form, answers: answers, confirmed: true) == nil)
        #expect(model.actionError != nil)
        #expect(model.actionNotice == nil)
    }
}

/// A JSON value for reading the encoded resolutions without naming the generated anonymous types.
private enum AnyDecodable: Decodable {
    case string(String)
    case object([String: AnyDecodable])
    case other

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: AnyDecodable].self) {
            self = .object(value)
        } else {
            self = .other
        }
    }

    var string: String? { if case .string(let value) = self { value } else { nil } }
    var object: [String: AnyDecodable]? { if case .object(let value) = self { value } else { nil } }
}
