import Foundation

/// One list filter's value as it travels on the wire: a scalar parameter, or an array parameter
/// whose key repeats once per element (`tagFilters=a&tagFilters=b`).
public enum EntityFilterValue: Sendable, Hashable {
    case single(String)
    case many([String])

    /// A filter with nothing in it is not a filter; `EntityFilterState.set` drops it.
    public var isEmpty: Bool {
        switch self {
        case .single(let value): value.isEmpty
        case .many(let values): values.isEmpty
        }
    }
}

/// The active filters of one entity list, keyed by wire parameter name (a `FilterDescriptor`'s
/// compiled `wire` name), so a filter sheet, a route, and the request all speak the same key.
public struct EntityFilterState: Sendable, Hashable {
    public private(set) var values: [String: EntityFilterValue]

    public init(_ values: [String: EntityFilterValue] = [:]) {
        self.values = values.filter { !$0.value.isEmpty }
    }

    public var isEmpty: Bool { values.isEmpty }

    /// How many parameters carry a value — the badge count on a Filter button.
    public var activeCount: Int { values.count }

    /// Parameter names in a stable order, for rendering and for deterministic request URLs.
    public var names: [String] { values.keys.sorted() }

    public subscript(name: String) -> EntityFilterValue? { values[name] }

    /// Sets `value` for `name`; an empty value removes the parameter instead.
    public mutating func set(_ value: EntityFilterValue, for name: String) {
        if value.isEmpty {
            values[name] = nil
        } else {
            values[name] = value
        }
    }

    public mutating func remove(_ name: String) {
        values[name] = nil
    }
}

extension FilterDescriptor: Identifiable {
    /// `columnId` is unique within one entity's filters (the compiler checks it).
    public var id: String { columnId }
}

/// Thrown by the generated `listPage`/`timeline` arms when a filter cannot be sent.
public enum EntityFilterError: Error, Sendable, Hashable {
    /// The wire name is not a query parameter of the entity's route.
    case unknownParameter(EntityKey, String)
    case invalidValue(parameter: String, value: String, expected: String)
}

// The conversions the generated per-parameter arms call (`Generated/EntityOperations.swift`).
// Each maps the wire string(s) onto the typed query property's shape; a value the schema cannot
// carry throws before any request is sent.
extension EntityFilterValue {
    public var strings: [String] {
        switch self {
        case .single(let value): [value]
        case .many(let values): values
        }
    }

    func string(_ name: String) throws -> String {
        switch self {
        case .single(let value): return value
        case .many(let values):
            guard values.count == 1, let value = values.first else {
                throw EntityFilterError.invalidValue(
                    parameter: name, value: values.joined(separator: ","), expected: "one value")
            }
            return value
        }
    }

    func double(_ name: String) throws -> Double {
        let raw = try string(name)
        guard let value = Double(raw) else {
            throw EntityFilterError.invalidValue(parameter: name, value: raw, expected: "a number")
        }
        return value
    }

    func int(_ name: String) throws -> Int {
        let raw = try string(name)
        guard let value = Int(raw) else {
            throw EntityFilterError.invalidValue(parameter: name, value: raw, expected: "an integer")
        }
        return value
    }

    func bool(_ name: String) throws -> Bool {
        switch try string(name) {
        case "true", "1": return true
        case "false", "0": return false
        case let raw:
            throw EntityFilterError.invalidValue(parameter: name, value: raw, expected: "true or false")
        }
    }

    func enumCase<Case: RawRepresentable>(_ name: String) throws -> Case where Case.RawValue == String {
        let raw = try string(name)
        guard let value = Case(rawValue: raw) else {
            throw EntityFilterError.invalidValue(
                parameter: name, value: raw, expected: "one of the enum's cases")
        }
        return value
    }

    func enumCases<Case: RawRepresentable>(_ name: String) throws -> [Case] where Case.RawValue == String {
        try strings.map { raw in
            guard let value = Case(rawValue: raw) else {
                throw EntityFilterError.invalidValue(
                    parameter: name, value: raw, expected: "one of the enum's cases")
            }
            return value
        }
    }

    /// An `anyOf` item whose arms were all tried by the caller; `valid` says whether one matched.
    static func anyOfCase<Item>(
        _ name: String, _ raw: String, _ item: Item, _ valid: (Item) -> Bool
    ) throws -> Item {
        guard valid(item) else {
            throw EntityFilterError.invalidValue(
                parameter: name, value: raw, expected: "one of the anyOf arms")
        }
        return item
    }
}
