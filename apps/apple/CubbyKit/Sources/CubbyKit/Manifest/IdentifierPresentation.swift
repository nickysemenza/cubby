import Foundation

/// Thin native adapter over the generated kind vocabulary and Rust barcode recognition.
public struct IdentifierPresentation: Sendable {
    public let source: String
    public let label: String
    public let value: String
    public let canonical: String?
    public let role: String?
    public let url: URL?

    public init?(_ row: JSONValue) {
        guard let source = row["source"]?.stringValue,
            let rawKind = row["kind"]?.stringValue, let kind = IdentifierKind(rawValue: rawKind),
            let canonical = row["externalId"]?.stringValue
        else { return nil }
        let isbn = kind.isBarcode ? ScanCodes.isbnFromGtin(canonical) : nil
        self.source = source
        self.label = isbn == nil ? kind.label : "ISBN-13"
        self.value = isbn ?? canonical
        self.canonical = value == canonical ? nil : canonical
        self.role = row["isPrimary"]?.boolValue.map { $0 ? "Primary" : "Secondary" }
        if source == "amazon", kind == .asin {
            var components = URLComponents(string: "https://www.amazon.com")
            components?.path = "/dp/\(canonical)"
            self.url = components?.url
        } else {
            self.url = row["url"]?.stringValue.flatMap(URL.init(string:))
        }
    }

    public var text: String {
        "\(source) · \(label): \(value)" + (canonical.map { " (GTIN: \($0))" } ?? "")
            + (role.map { " · \($0)" } ?? "")
    }

    public static func grouped(_ value: JSONValue) -> [IdentifierPresentation] {
        let rows = value.arrayValue ?? []
        var slots: [[JSONValue]] = []
        for row in rows {
            if let index = slots.firstIndex(where: {
                $0.first?["source"] == row["source"] && $0.first?["kind"] == row["kind"]
            }) {
                slots[index].append(row)
            } else {
                slots.append([row])
            }
        }
        return slots.flatMap { group in
            (group.filter { $0["isPrimary"]?.boolValue == true }
                + group.filter { $0["isPrimary"]?.boolValue != true })
                .compactMap(Self.init)
        }
    }

    /// Only committed, typed before/after rows describe applied effects. Missing evidence is not empty.
    public static func effects(before: JSONValue?, after: JSONValue?) -> [String] {
        guard let before, let after else { return [] }
        let previous = before == .null ? [] : before.arrayValue
        let current = after == .null ? [] : after.arrayValue
        guard let previous, let current,
            previous.allSatisfy({ Self($0) != nil }), current.allSatisfy({ Self($0) != nil })
        else { return [] }
        func sameKey(_ a: JSONValue, _ b: JSONValue) -> Bool {
            ["source", "kind", "externalId"].allSatisfy { a[$0] == b[$0] }
        }
        func describe(_ row: JSONValue) -> String {
            guard let shown = Self(row) else { return "" }
            return shown.text + (shown.url.map { " · \($0.absoluteString)" } ?? "")
        }
        var result: [String] = []
        for row in previous where !current.contains(where: { sameKey(row, $0) }) {
            result.append("Removed: \(describe(row))")
        }
        for row in current {
            guard let old = previous.first(where: { sameKey(row, $0) }) else {
                result.append("Added: \(describe(row))")
                continue
            }
            if old["isPrimary"] != row["isPrimary"] {
                result.append(
                    "\(row["isPrimary"]?.boolValue == true ? "Made primary" : "Made secondary"): \(describe(row))"
                )
            }
            let oldURL = storedURL(old)
            let newURL = storedURL(row)
            if oldURL != newURL {
                result.append(
                    "Changed URL: \(describe(row)) · \(oldURL ?? "(empty)") → \(newURL ?? "(empty)")"
                )
            }
        }
        return result
    }

    /// Read-side URL policy must not validate or repair a historical identity.
    private static func storedURL(_ row: JSONValue) -> String? {
        if row["source"]?.stringValue == "amazon", row["kind"]?.stringValue == "asin" { return nil }
        return row["url"]?.stringValue
    }

    public enum InputError: LocalizedError {
        case invalidBarcode
        public var errorDescription: String? { "Invalid barcode: enter a valid UPC, EAN, GTIN or ISBN." }
    }

    public static func storedRow(_ row: [String: JSONValue]) throws -> [String: JSONValue] {
        var row = row
        let source = row["source"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let source { row["source"] = .string(source) }
        guard let rawKind = row["kind"]?.stringValue, let kind = IdentifierKind(rawValue: rawKind),
            let rawValue = row["externalId"]?.stringValue
        else { return row }
        if kind.isBarcode {
            guard let gtin = ScanCodes.gtin14(rawValue) else { throw InputError.invalidBarcode }
            row["externalId"] = .string(gtin)
        }
        if source == "amazon", kind == .asin {
            row["url"] = .null
        } else if row["url"] == nil {
            row["url"] = .null
        }
        return row
    }
}
