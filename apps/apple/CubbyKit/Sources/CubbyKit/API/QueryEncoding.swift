import Foundation

/// Encodes query values the way ts-rest's `jsonQuery: true` expects them, which is what the
/// `/api/v1` router decodes: a plain string travels literally, and anything else (numbers,
/// booleans, null, objects, arrays) travels as JSON text. A string that would itself parse as
/// JSON (`"12"`, `"true"`, `"[1]"`) is JSON-quoted so the server does not misread it.
public enum QueryEncoding {
    public static func queryItems(_ values: [String: JSONValue]) -> [URLQueryItem] {
        values.keys.sorted().map { key in
            URLQueryItem(name: key, value: encode(values[key]!))
        }
    }

    public static func encode(_ value: JSONValue) -> String {
        if case .string(let text) = value, !looksLikeJSON(text) {
            return text
        }
        // JSONValue is Encodable; fragments (numbers, strings, bools) are allowed.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    static func looksLikeJSON(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return false }
        if ["true", "false", "null"].contains(trimmed) { return true }
        if let first = trimmed.first, "{[\"".contains(first) { return true }
        return Double(trimmed) != nil
    }
}
