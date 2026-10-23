import Foundation

/// Presence is separate from nullability: `.value(nil)` clears a nullable field.
public enum NativeField<Value: Sendable & Hashable>: Sendable, Hashable {
    case absent
    case value(Value)

    /// Optional source metadata supplies a value or leaves the wire field absent.
    public init<Wrapped: Sendable & Hashable>(ifPresent value: Wrapped?) where Value == Wrapped? {
        self = value.map { .value($0) } ?? .absent
    }

    /// Preserves a present null as `.some(nil)` when `Value` is itself optional.
    public var valueIfPresent: Value? {
        switch self {
        case .absent: nil
        case .value(let value): .some(value)
        }
    }
}

/// A required JSON null, rather than a missing optional property.
public struct JSONNull: Codable, Hashable, Sendable {
    public init() {}

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        guard container.decodeNil() else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected null")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encodeNil()
    }
}

/// A schema's empty tuple has no constructible nonempty state.
public struct NativeEmptyArray: Codable, Hashable, Sendable, RandomAccessCollection, ExpressibleByArrayLiteral
{
    public typealias Element = Never
    public var startIndex: Int { 0 }
    public var endIndex: Int { 0 }
    public subscript(index: Int) -> Never { preconditionFailure("An empty array has no elements") }
    public init() {}
    public init(arrayLiteral elements: Never...) {}

    public init(from decoder: any Decoder) throws {
        let container = try decoder.unkeyedContainer()
        guard container.isAtEnd else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected an empty array")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        _ = encoder.unkeyedContainer()
    }
}
