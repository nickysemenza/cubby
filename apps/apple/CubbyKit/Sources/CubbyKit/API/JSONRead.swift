import Foundation

/// Required fields at the few consumer seams whose generated response is an open JSON object.
/// Keep path and received value in diagnostics; missing financial data must never become zero.
struct JSONRead: Sendable {
    let value: JSONValue
    let context: String

    // Display paths omit nulls. Wire validation must retain explicit null so a required nullable
    // amount can be unknown while an absent amount still fails instead of becoming unknown.
    private func field(_ path: String) -> JSONValue? {
        value.pathValue(path, preservingNull: true)
    }

    func string(_ path: String) throws -> String {
        guard let text = field(path)?.stringValue, !text.isEmpty else {
            throw malformed(path, expected: "a nonempty string")
        }
        return text
    }

    func number(_ path: String) throws -> Double {
        guard let number = field(path)?.doubleValue, number.isFinite else {
            throw malformed(path, expected: "a finite number")
        }
        return number
    }

    func nullableNumber(_ path: String) throws -> Double? {
        if field(path) == .null { return nil }
        return try number(path)
    }

    func array(_ path: String) throws -> [JSONRead] {
        guard let items = field(path)?.arrayValue else {
            throw malformed(path, expected: "an array")
        }
        return items.enumerated().map {
            JSONRead(value: $0.element, context: "\(context).\(path)[\($0.offset)]")
        }
    }

    func malformed(_ path: String, expected: String) -> DecodingError {
        DecodingError.dataCorrupted(
            .init(
                codingPath: [],
                debugDescription:
                    "\(context).\(path): expected \(expected); received \(String(describing: field(path)))"
            ))
    }
}
