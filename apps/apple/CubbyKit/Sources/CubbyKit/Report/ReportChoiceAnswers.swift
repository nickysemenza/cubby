import CubbyAPISupport
import Foundation

/// What the person has answered for a report block's choices. The server says which choices exist
/// and which are required; this only records answers and asks whether each is complete. Web's
/// `commitPreparedInput` (`packages/schemas/src/report-choice.ts`) has the same rules, and
/// `ReportChoiceAnswersTests` mirrors its cases.
public struct ReportChoiceAnswers: Equatable, Sendable {
    public struct Answer: Hashable, Sendable {
        /// One of the choice's option ids.
        public var optionID: String
        /// The record picked, for an option that asks for one.
        public var pickID: String?
        public var pickTitle: String?
        /// The reason written, for an option that asks for one.
        public var text: String?
    }

    public private(set) var answers: [String: Answer] = [:]
    /// The commit's idempotency key. It changes with every answer, because the server rejects a
    /// replayed id that carries other input; retrying the same answers reuses it.
    public private(set) var operationID = UUID().uuidString

    public init() {}

    public func answer(for choiceID: String) -> Answer? { answers[choiceID] }

    /// Chooses `optionID`, keeping a pick or reason already given when the new option still asks
    /// for one. A nil option clears the answer.
    public mutating func choose(_ choice: ReportPresentation.Choice, optionID: String?) {
        guard let optionID, let option = choice.options.first(where: { $0.id == optionID }) else {
            answers[choice.id] = nil
            operationID = UUID().uuidString
            return
        }
        let previous = answers[choice.id]
        answers[choice.id] = Answer(
            optionID: option.id, pickID: option.pick == nil ? nil : previous?.pickID,
            pickTitle: option.pick == nil ? nil : previous?.pickTitle,
            text: option.text == nil ? nil : previous?.text)
        operationID = UUID().uuidString
    }

    public mutating func pick(
        _ choice: ReportPresentation.Choice, optionID: String, id: String, title: String
    ) {
        answers[choice.id] = Answer(optionID: optionID, pickID: id, pickTitle: title, text: nil)
        operationID = UUID().uuidString
    }

    public mutating func write(_ choice: ReportPresentation.Choice, text: String) {
        guard var answer = answers[choice.id] else { return }
        answer.text = text
        answers[choice.id] = answer
        operationID = UUID().uuidString
    }

    /// Whether the answer names one of the choice's options and gives everything it asks for.
    public func isAnswered(_ choice: ReportPresentation.Choice) -> Bool {
        guard let answer = answers[choice.id],
            let option = choice.options.first(where: { $0.id == answer.optionID })
        else { return false }
        if option.pick != nil, Self.blank(answer.pickID) { return false }
        if option.text != nil, Self.blank(answer.text) { return false }
        return true
    }

    /// How many required choices still lack a complete answer.
    public func remaining(in choices: [ReportPresentation.Choice]) -> Int {
        choices.filter { $0.required && !isAnswered($0) }.count
    }

    /// Every required choice, the rows' and the form's own, has a complete answer.
    public func canSubmit(
        form: ReportPresentation.Form, rowChoices: [ReportPresentation.Choice]
    ) -> Bool {
        form.disabledReason == nil && remaining(in: rowChoices + form.choices) == 0
    }

    /// "2 Product decisions remaining." or the form's completion sentence, then what approving does.
    public func progressText(
        form: ReportPresentation.Form, rowChoices: [ReportPresentation.Choice]
    ) -> String {
        let left = remaining(in: rowChoices)
        let state =
            left == 0 ? form.completeText : "\(left) \(form.noun)\(left == 1 ? "" : "s") remaining."
        return "\(state) \(form.note)"
    }

    /// A line's complete decision, before it is spelled as the wire type.
    private enum Decision {
        case existing(String)
        case new
        case unresolved(String)
        case expenseOnly
    }

    private func decision(of choiceID: String) -> Decision? {
        guard let answer = answers[choiceID] else { return nil }
        switch answer.optionID {
        case "existing":
            guard let id = answer.pickID, !Self.blank(id) else { return nil }
            return .existing(id)
        case "new":
            return .new
        case "unresolved":
            guard let reason = answer.text?.trimmingCharacters(in: .whitespacesAndNewlines),
                !reason.isEmpty
            else { return nil }
            return .unresolved(reason)
        case "expense_only":
            return .expenseOnly
        default:
            return nil
        }
    }

    /// The exact `run.commitPrepared` body for these answers, or nil while any line's decision or
    /// the batch's trade is missing.
    public func commitInput(for form: ReportPresentation.Form) -> RunCommitPreparedInput? {
        let command = form.command
        var trade: Trade?
        if let tradeID = command.tradeChoiceID {
            guard let optionID = answers[tradeID]?.optionID, let value = Trade(rawValue: optionID)
            else { return nil }
            trade = value
        }
        let decisions = command.lines.compactMap { decision(of: $0.choiceID) }
        guard decisions.count == command.lines.count else { return nil }
        return RunCommitPreparedInput(
            prepareOperationId: command.prepareOperationID, defaultTrade: trade,
            resolutions: zip(command.lines, decisions).map { line, decision in
                switch decision {
                case .existing(let id):
                    .init(
                        stableOrderId: line.stableOrderID, stableLineId: line.stableLineID,
                        resolution: .existing(.init(kind: .existing, productId: ProductCode(id))))
                case .new:
                    .init(
                        stableOrderId: line.stableOrderID, stableLineId: line.stableLineID,
                        resolution: .new(.init(kind: .new)))
                case .unresolved(let reason):
                    .init(
                        stableOrderId: line.stableOrderID, stableLineId: line.stableLineID,
                        resolution: .unresolved(.init(kind: .unresolved, reason: reason)))
                case .expenseOnly:
                    .init(
                        stableOrderId: line.stableOrderID, stableLineId: line.stableLineID,
                        resolution: .expenseOnly(.init(kind: .expenseOnly)))
                }
            },
            runId: command.runID, operationId: operationID)
    }

    private static func blank(_ text: String?) -> Bool {
        text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
    }
}
