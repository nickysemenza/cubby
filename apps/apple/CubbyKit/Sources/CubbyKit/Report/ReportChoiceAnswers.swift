import CubbyAPISupport
import Foundation

/// What the person has answered for a report block's choices. The server says which choices exist
/// and which are required; this only records answers and asks whether each is complete. Web's
/// `commitPreparedInput` (`packages/schemas/src/report-choice.ts`) has the same rules, and
/// `ReportChoiceAnswersTests` mirrors its cases.
public struct ReportChoiceAnswers: Equatable, Sendable {
    /// The Source typed for one of an option's Distinct-from records.
    public struct Source: Hashable, Sendable {
        public let recordID: String
        public var url = ""
        public var quote = ""
    }

    public struct Answer: Hashable, Sendable {
        /// One of the choice's option ids.
        public var optionID: String
        /// The record picked, for an option that asks for one.
        public var pickID: String?
        public var pickTitle: String?
        /// The reason written, for an option that asks for one.
        public var text: String?
        /// One Source per Distinct-from record of the chosen option, in the option's order. Only
        /// that option's records, so the body never carries evidence another option listed.
        public var distinctFrom: [Source] = []
    }

    public private(set) var answers: [String: Answer] = [:]
    /// The commit's idempotency key. It changes with every answer, because the server rejects a
    /// replayed id that carries other input; retrying the same answers reuses it.
    public private(set) var operationID = UUID().uuidString

    public init() {}

    public func answer(for choiceID: String) -> Answer? { answers[choiceID] }

    /// Chooses `optionID`, keeping a pick, reason or Source already given when the new option still
    /// asks for it. A nil option clears the answer.
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
            text: option.text == nil ? nil : previous?.text,
            distinctFrom: Self.sources(for: option, keeping: previous?.distinctFrom ?? []))
        operationID = UUID().uuidString
    }

    public mutating func pick(
        _ choice: ReportPresentation.Choice, optionID: String, id: String, title: String
    ) {
        let option = choice.options.first { $0.id == optionID }
        answers[choice.id] = Answer(
            optionID: optionID, pickID: id, pickTitle: title, text: nil,
            distinctFrom: option.map { Self.sources(for: $0, keeping: []) } ?? [])
        operationID = UUID().uuidString
    }

    /// Types the Source for one of the chosen option's Distinct-from records.
    public mutating func writeSource(
        _ choice: ReportPresentation.Choice, recordID: String, url: String, quote: String
    ) {
        guard var answer = answers[choice.id],
            let index = answer.distinctFrom.firstIndex(where: { $0.recordID == recordID })
        else { return }
        answer.distinctFrom[index].url = url
        answer.distinctFrom[index].quote = quote
        answers[choice.id] = answer
        operationID = UUID().uuidString
    }

    private static func sources(
        for option: ReportPresentation.Choice.Option, keeping previous: [Source]
    ) -> [Source] {
        option.distinctFrom.map { record in
            previous.first { $0.recordID == record.id } ?? Source(recordID: record.id)
        }
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
        for record in option.distinctFrom {
            guard let source = answer.distinctFrom.first(where: { $0.recordID == record.id }),
                !Self.blank(source.url), !Self.blank(source.quote)
            else { return false }
        }
        return true
    }

    /// How many required choices still lack a complete answer.
    public func remaining(in choices: [ReportPresentation.Choice]) -> Int {
        choices.filter { $0.required && !isAnswered($0) }.count
    }

    /// Every required choice, the rows' and the form's own, has a complete answer the commit
    /// would accept.
    public func canSubmit(
        form: ReportPresentation.Form, rowChoices: [ReportPresentation.Choice]
    ) -> Bool {
        form.disabledReason == nil && remaining(in: rowChoices + form.choices) == 0
            && commitInput(for: form) != nil
    }

    /// Web's sentence for answers that are all complete but cannot be sent as they stand.
    public func unsendableText(
        form: ReportPresentation.Form, rowChoices: [ReportPresentation.Choice]
    ) -> String? {
        guard remaining(in: rowChoices + form.choices) == 0, commitInput(for: form) == nil
        else { return nil }
        return
            "An answer cannot be sent: a reason is at most \(Self.count(SharedConstants.productDecisionReasonMax)) characters, a Product must be chosen from the picker, and a Source needs a full URL."
    }

    /// Per-field feedback for one typed Source under the bounds the commit parses (web's
    /// `distinctFromSourceFeedback`): an error per field, and the quote's length against its bound.
    public struct SourceFeedback: Equatable, Sendable {
        public let url: String?
        public let quote: String?
        public let quoteLength: String
    }

    public static func sourceFeedback(url: String, quote: String) -> SourceFeedback {
        let url = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let quote = quote.trimmingCharacters(in: .whitespacesAndNewlines)
        return SourceFeedback(
            url: url.isEmpty || validURL(url)
                ? nil
                : "Enter a full URL of at most \(count(SharedConstants.distinctFromURLMax)) characters.",
            quote: quote.utf16.count > SharedConstants.distinctFromQuoteMax
                ? "Shorten the quote to at most \(count(SharedConstants.distinctFromQuoteMax)) characters."
                : nil,
            quoteLength:
                "\(count(quote.utf16.count)) of \(count(SharedConstants.distinctFromQuoteMax)) characters."
        )
    }

    /// Zod's `z.url()` bound by `DISTINCT_FROM_URL_MAX`: a scheme and a host, any scheme. Lengths
    /// count UTF-16 units, as zod does.
    private static func validURL(_ url: String) -> Bool {
        guard url.utf16.count <= SharedConstants.distinctFromURLMax,
            let components = URLComponents(string: url),
            components.scheme?.isEmpty == false, components.host?.isEmpty == false
        else { return false }
        return true
    }

    /// A count as web's `toLocaleString("en-US")` writes it.
    private static func count(_ value: Int) -> String {
        value.formatted(.number.locale(Locale(identifier: "en_US")))
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
        /// The trimmed Distinct-from Sources, empty when the option lists no candidate (exact-name
        /// or identity-review) to tell the new Product apart from.
        case new([Source])
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
            let sources = answer.distinctFrom.map {
                Source(
                    recordID: $0.recordID, url: $0.url.trimmingCharacters(in: .whitespacesAndNewlines),
                    quote: $0.quote.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            guard
                sources.allSatisfy({
                    Self.validURL($0.url) && !$0.quote.isEmpty
                        && $0.quote.utf16.count <= SharedConstants.distinctFromQuoteMax
                })
            else { return nil }
            return .new(sources)
        case "unresolved":
            guard let reason = answer.text?.trimmingCharacters(in: .whitespacesAndNewlines),
                !reason.isEmpty, reason.utf16.count <= SharedConstants.productDecisionReasonMax
            else { return nil }
            return .unresolved(reason)
        case "expense_only":
            return .expenseOnly
        default:
            return nil
        }
    }

    /// The exact `run.commitPrepared` body for these answers, or nil while any line's decision or
    /// the batch's trade is missing, or a reason or Source is outside the bounds the commit parses.
    public func commitInput(for form: ReportPresentation.Form) -> RunCommitPreparedInput? {
        let command = form.command
        var trade: Trade?
        if let tradeID = command.tradeChoiceID {
            guard let optionID = answers[tradeID]?.optionID,
                let value = Trade.allCases.first(where: { $0.rawValue == optionID })
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
                case .new(let sources):
                    .init(
                        stableOrderId: line.stableOrderID, stableLineId: line.stableLineID,
                        resolution: .new(
                            .init(
                                kind: .new,
                                distinctFrom: sources.isEmpty
                                    ? nil
                                    : sources.map {
                                        .init(
                                            productId: ProductCode($0.recordID), url: $0.url,
                                            quote: $0.quote)
                                    })))
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
