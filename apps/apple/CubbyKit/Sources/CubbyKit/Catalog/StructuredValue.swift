import Foundation

/// The editor model for a structured field's `JSONValue`, driven by its `ValueSchema`: the pure
/// operations the generic structured-value editor needs, none of them per entity or per field.
/// The server stays the only validator; this only keeps a value shaped like the input schema
/// (so a read payload can round-trip into a patch) and maps the server's issues back onto it.
public enum StructuredValue {
    // MARK: - Read payload to input schema

    /// `value` clipped to what `schema` declares. A read payload carries keys the input schema
    /// rejects (a mapping's `sourceMetadata`, timestamps); sending them back would fail a strict
    /// schema and make an untouched row look edited. Hidden keys the schema declares (`id`) stay,
    /// so an untouched row updates in place.
    public static func project(_ value: JSONValue, to schema: ValueSchema) -> JSONValue {
        switch (schema.node, value) {
        case (.amount(let upper), .object(let object)):
            let keys = upper ? ["value", "unit", "upperValue"] : ["value", "unit"]
            return .object(object.filter { keys.contains($0.key) })
        case (.object(let fields), .object(let object)):
            return .object(projectFields(object, fields))
        case (.array(let item), .array(let items)):
            return .array(items.map { project($0, to: item) })
        case (.map(let keys, let item), .object(let object)):
            let allowed = Set(keys.map(\.value))
            return .object(
                object.filter { allowed.contains($0.key) }.mapValues { project($0, to: item) })
        case (.variant(let discriminator, let cases), .object(let object)):
            guard let tag = object[discriminator]?.stringValue,
                let match = cases.first(where: { $0.value == tag })
            else { return value }
            var projected = projectFields(object, match.fields)
            projected[discriminator] = .string(tag)
            return .object(projected)
        default:
            return value
        }
    }

    /// A key the read payload does not carry at its own name is read from the field's `readPath`
    /// (the nested record a flat input id names), and a required key the schema fixes (a union's
    /// `null` arm) is written as that constant, so a read line is exactly the input line.
    private static func projectFields(
        _ object: [String: JSONValue], _ fields: [ValueSchema.Field]
    ) -> [String: JSONValue] {
        var projected: [String: JSONValue] = [:]
        for field in fields {
            if let child = object[field.key] {
                projected[field.key] = project(child, to: field.schema)
            } else if let path = field.readPath,
                case let found = value(at: path.split(separator: ".").map(String.init), in: .object(object)),
                found != .null
            {
                projected[field.key] = project(found, to: field.schema)
            } else if field.required, case .constant(let fixed) = field.schema.node {
                projected[field.key] = fixed
            }
        }
        return projected
    }

    // MARK: - New values

    /// What a new row or newly added object starts as. Only required keys are present; text is
    /// empty and a number unset, so an unfilled row is rejected by the server rather than guessed.
    /// A nullable schema starts `null` unless `populated`, and a variant starts `null` (no case
    /// chosen): the person picks one, never a default the editor guessed.
    public static func blank(_ schema: ValueSchema, populated: Bool = false) -> JSONValue {
        if schema.nullable && !populated { return .null }
        switch schema.node {
        case .text: return .string("")
        case .number, .reference: return .null
        case .boolean: return .bool(false)
        case .enum(let options):
            return options.first.map { .string($0.value) } ?? .null
        case .amount: return .object(["value": .null, "unit": .string("")])
        case .constant(let value): return value
        case .object(let fields): return .object(blankFields(fields))
        case .array: return .array([])
        case .map: return .object([:])
        case .variant: return .null
        }
    }

    /// A variant value of `match`, carrying its tag and required keys.
    public static func blankCase(_ discriminator: String, _ match: ValueSchema.Case) -> JSONValue {
        var object = blankFields(match.fields)
        object[discriminator] = .string(match.value)
        return .object(object)
    }

    private static func blankFields(_ fields: [ValueSchema.Field]) -> [String: JSONValue] {
        var object: [String: JSONValue] = [:]
        for field in fields where field.required { object[field.key] = blank(field.schema) }
        return object
    }

    // MARK: - Draft to wire value

    /// The value the editor sends: an unfilled optional text/number is left out (or `null` where
    /// the schema takes `null`). A required one is kept as typed so the server's rejection, not a
    /// silent omission, tells the person what to fill.
    public static func wireValue(_ value: JSONValue, schema: ValueSchema) -> JSONValue {
        normalize(value, schema: schema, required: true) ?? .null
    }

    private static func normalize(_ value: JSONValue, schema: ValueSchema, required: Bool) -> JSONValue? {
        // What an unfilled value becomes: `null` where the schema takes it, as typed where the key
        // is required, otherwise absent. Spelled out because `JSONValue` is
        // `ExpressibleByNilLiteral`, so a `nil` in a ternary here resolves to `.null`.
        func unfilled(_ typed: JSONValue) -> JSONValue? {
            if schema.nullable { return JSONValue.null }
            if required { return typed }
            return Optional<JSONValue>.none
        }
        switch (schema.node, value) {
        case (_, .null):
            return unfilled(.null)
        case (.text, .string(let text)):
            return text.isEmpty ? unfilled(value) : value
        case (.amount, .object(var object)):
            // The range end is optional and not nullable: an emptied one is absent.
            if object["upperValue"] == .null { object.removeValue(forKey: "upperValue") }
            guard let quantity = object["value"], quantity != .null else { return unfilled(.object(object)) }
            return .object(object)
        case (.object(let fields), .object(let object)):
            return .object(normalizeFields(object, fields))
        case (.array(let item), .array(let items)):
            // An empty optional list is absent (the input says `.min(1).optional()`).
            if items.isEmpty && !required { return unfilled(value) }
            return .array(items.map { normalize($0, schema: item, required: true) ?? .null })
        case (.map(_, let item), .object(let object)):
            // A map's present keys are its rows: an emptied one is removed, never sent as `null`.
            // (`JSONValue` is `ExpressibleByNilLiteral`, so this filters rather than returning nil.)
            return .object(
                object.mapValues { normalize($0, schema: item, required: true) ?? .null }
                    .filter { $0.value != .null })
        case (.variant(let discriminator, let cases), .object(let object)):
            guard let tag = object[discriminator]?.stringValue,
                let match = cases.first(where: { $0.value == tag })
            else { return value }
            var normalized = normalizeFields(object, match.fields)
            normalized[discriminator] = .string(tag)
            return .object(normalized)
        default:
            return value
        }
    }

    private static func normalizeFields(
        _ object: [String: JSONValue], _ fields: [ValueSchema.Field]
    ) -> [String: JSONValue] {
        var normalized: [String: JSONValue] = [:]
        for field in fields {
            guard let child = object[field.key] else { continue }
            if let wire = normalize(child, schema: field.schema, required: field.required) {
                normalized[field.key] = wire
            }
        }
        return normalized
    }

    // MARK: - Positions

    /// The value `path` (object keys and array indices, as a validation issue spells them) names
    /// inside `root`; `null` where nothing is there.
    public static func value(at path: [String], in root: JSONValue) -> JSONValue {
        var current = root
        for step in path {
            if let index = Int(step), case .array(let items) = current {
                current = items.indices.contains(index) ? items[index] : .null
            } else {
                current = current[step] ?? .null
            }
        }
        return current
    }

    /// `root` with the value at `path` replaced. An existing array index is replaced in place;
    /// any other step is an object key, created (with its parents) when absent.
    public static func setting(_ new: JSONValue, at path: ArraySlice<String>, in root: JSONValue) -> JSONValue
    {
        guard let step = path.first else { return new }
        let rest = path.dropFirst()
        if case .array(var items) = root, let index = Int(step), items.indices.contains(index) {
            items[index] = setting(new, at: rest, in: items[index])
            return .array(items)
        }
        var object = root.objectValue ?? [:]
        object[step] = setting(new, at: rest, in: object[step] ?? .null)
        return .object(object)
    }

    // MARK: - Validation issues

    /// Whether the editor draws a place for `path` (relative to the field's value): a visible
    /// object key, an existing row, a present map entry, or an amount's value or unit. An issue that names
    /// anywhere else belongs under the field, not at a position that does not exist on screen.
    public static func draws(path: [String], in value: JSONValue?, schema: ValueSchema) -> Bool {
        guard let head = path.first else { return false }
        let rest = Array(path.dropFirst())
        switch schema.node {
        case .amount(let upper):
            return rest.isEmpty
                && (upper ? ["value", "unit", "upperValue"] : ["value", "unit"]).contains(head)
        case .object(let fields):
            return drawsField(head, rest, value, fields)
        case .variant(let discriminator, let cases):
            guard let tag = value?[discriminator]?.stringValue,
                let match = cases.first(where: { $0.value == tag })
            else { return false }
            return drawsField(head, rest, value, match.fields)
        case .array(let item):
            guard let index = Int(head), let element = value?.arrayValue?[safe: index] else { return false }
            return rest.isEmpty || draws(path: rest, in: element, schema: item)
        case .map(_, let item):
            guard let entry = value?[head] else { return false }
            return rest.isEmpty || draws(path: rest, in: entry, schema: item)
        case .text, .number, .boolean, .enum, .reference, .constant:
            return false
        }
    }

    private static func drawsField(
        _ key: String, _ rest: [String], _ value: JSONValue?, _ fields: [ValueSchema.Field]
    ) -> Bool {
        guard let field = fields.first(where: { $0.key == key }), field.schema.isEdited else { return false }
        return rest.isEmpty || draws(path: rest, in: value?[key], schema: field.schema)
    }
}

extension ValueSchema {
    /// Whether the editor draws a control for this schema: a fixed constant and an opaque `uuid`
    /// (a row's id, kept so an untouched row updates in place) are carried, never shown.
    public var isEdited: Bool {
        switch node {
        case .constant: false
        case .text(let format): format != "uuid" && format != "opaque"
        default: true
        }
    }
}

extension Array {
    fileprivate subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
