import Foundation

/// What the person has entered for the inputs a report command declares. The server names every
/// input (`key`, label, kind, the starting value); this holds the answers and says what is still
/// missing, so a command with an empty or out-of-range input is never sent. Nothing here knows
/// what the command does: the model puts each answer in the request field of the same `key`.
public struct ReportCommandForm: Equatable, Sendable {
    public struct Option: Equatable, Sendable, Identifiable {
        public var id: String { value }
        public let value: String
        public let label: String
    }

    public struct Field: Equatable, Sendable, Identifiable {
        public enum Kind: Equatable, Sendable {
            /// A number of at least `min`.
            case number(min: Double)
            /// One record of `entity`, picked by the person (searched on the client).
            case record(entity: String)
            case choice([Option])
            /// Free text the person writes; blank counts as missing.
            case text
        }

        public var id: String { key }
        public let key: String
        public let label: String
        public let kind: Kind
    }

    public let fields: [Field]
    public private(set) var unsupportedInputs: [JSONValue] = []
    private var numbers: [String: Double] = [:]
    /// What was typed into a number field, kept as typed so "1." survives until "1.5".
    private var numberTexts: [String: String] = [:]
    private var texts: [String: String] = [:]
    private var titles: [String: String] = [:]

    public init(command: ReportCommand) {
        var fields: [Field] = []
        var unsupported: [JSONValue] = []
        var seeded = ReportCommandForm(fields: [])
        for input in command.inputs ?? [] {
            switch input {
            case .number(let number):
                fields.append(Field(key: number.key, label: number.label, kind: .number(min: number.min)))
                if let initial = number.initial { seeded.setNumber(number.key, initial) }
            case .record(let record):
                fields.append(
                    Field(key: record.key, label: record.label, kind: .record(entity: record.entity)))
            case .choice(let choice):
                fields.append(
                    Field(
                        key: choice.key, label: choice.label,
                        kind: .choice(choice.options.map { Option(value: $0.value, label: $0.label) })))
                if let initial = choice.initial { seeded.setChoice(choice.key, initial) }
            case .unrecognized(let raw):
                unsupported.append(raw)
            case .text(let text):
                fields.append(Field(key: text.key, label: text.label, kind: .text))
                if let initial = text.initial { seeded.setText(text.key, initial) }
            }
        }
        self = ReportCommandForm(fields: fields, seeding: seeded)
        self.unsupportedInputs = unsupported
    }

    private init(fields: [Field], seeding: ReportCommandForm? = nil) {
        self.fields = fields
        numbers = seeding?.numbers ?? [:]
        numberTexts = seeding?.numberTexts ?? [:]
        texts = seeding?.texts ?? [:]
        titles = seeding?.titles ?? [:]
    }

    public func number(_ key: String) -> Double? { numbers[key] }
    /// The picked record's id, the chosen option's value, or the written text.
    public func text(_ key: String) -> String? { texts[key] }
    /// What to show for a picked record.
    public func title(_ key: String) -> String? { titles[key] }

    public mutating func setNumber(_ key: String, _ value: Double?) {
        numbers[key] = value
        numberTexts[key] = value.map { $0 == $0.rounded() ? String(Int($0)) : String($0) } ?? ""
    }

    /// The text typed into a number field.
    public func numberText(_ key: String) -> String { numberTexts[key] ?? "" }

    /// Records what was typed; the number is whatever it parses to (nil while it does not).
    public mutating func setNumberText(_ key: String, _ text: String) {
        numberTexts[key] = text
        numbers[key] = Double(text.trimmingCharacters(in: .whitespaces))
    }

    public mutating func setRecord(_ key: String, id: String?, title: String?) {
        texts[key] = id
        titles[key] = title
    }

    public mutating func setChoice(_ key: String, _ value: String?) { texts[key] = value }

    public mutating func setText(_ key: String, _ value: String) { texts[key] = value }

    /// The inputs still lacking a usable answer, by label.
    public var missing: [String] {
        let missing = fields.compactMap { field -> String? in
            switch field.kind {
            case .number(let min):
                if let value = numbers[field.key], value.isFinite, value >= min { return nil }
            case .record, .choice:
                if let value = texts[field.key], !value.isEmpty { return nil }
            case .text:
                if let value = texts[field.key],
                    !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                {
                    return nil
                }
            }
            return field.label
        }
        return missing
            + unsupportedInputs.map {
                UnsupportedNativeResponse(context: "report command input", raw: $0).localizedDescription
            }
    }

    public var isComplete: Bool { missing.isEmpty }
    static func commandBody(
        _ body: JSONValue, bindings: [String: String], form: ReportCommandForm?,
        booleanInputs: [String]
    ) throws -> JSONValue {
        guard let form else { return body }
        if let raw = form.unsupportedInputs.first {
            throw UnsupportedNativeResponse(context: "report command input", raw: raw)
        }
        var result = body
        for field in form.fields {
            let value: JSONValue
            if let number = form.number(field.key) {
                value = .number(number)
            } else if let text = form.text(field.key) {
                value =
                    booleanInputs.contains(field.key)
                    ? .bool(text == "true")
                    : .string(
                        field.kind == .text ? text.trimmingCharacters(in: .whitespacesAndNewlines) : text)
            } else {
                throw ReportActionError.incompleteAnswers
            }
            result = try setting(
                result, path: (bindings[field.key] ?? field.key).split(separator: ".")[...], value: value)
        }
        return result
    }

    private static func setting(_ body: JSONValue, path: ArraySlice<Substring>, value: JSONValue) throws
        -> JSONValue
    {
        guard let key = path.first else { return value }
        let rest = path.dropFirst()
        switch body {
        case .object(var fields):
            fields[String(key)] = try setting(fields[String(key)] ?? .null, path: rest, value: value)
            return .object(fields)
        case .array(var values):
            guard let index = Int(key), values.indices.contains(index) else {
                throw ReportActionError.incompleteAnswers
            }
            values[index] = try setting(values[index], path: rest, value: value)
            return .array(values)
        default: throw ReportActionError.incompleteAnswers
        }
    }

}

extension ReportCommand {
    public var declaredConfirmation: String? {
        if let confirm { return confirm }
        if case .operation(let command) = request {
            return WorkflowCommandCatalog.presentation(for: command.operation)?.confirmation
        }
        return nil
    }
}

extension WorkflowCommandPresentation {
    public func message(for result: JSONValue) -> String? {
        let facts = resultFields.compactMap { field in
            result.pathText(field.path).map { "\(field.label): \($0)" }
        }
        return facts.isEmpty ? success : facts.joined(separator: "; ")
    }
}
