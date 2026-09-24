import CubbyKit
import Foundation

/// The one place a catalog field's raw JSON becomes display text: `format` first (`currency`,
/// `signedCurrency`, `plainDate`, `timestamp`, `external-link`, `amount`), then `kind`. Nothing
/// here issues a request; a value the projection did not carry is simply absent (`nil`).
nonisolated enum EntityFieldValue {
    /// A reference field's target: the id under the field's own key, and the display name the
    /// server projected beside it (`<key minus Id>Name`, or a nested `<stem>.name`).
    struct Reference: Hashable {
        let entity: EntityKey
        let id: String
        let name: String?
    }

    static func text(_ value: JSONValue?, field: FieldDescriptor) -> String? {
        guard let value, value != .null else { return nil }
        switch field.format {
        case "currency": return money(value)
        case "signedCurrency":
            guard let amount = number(value) else { return nil }
            return (amount > 0 ? "+" : "") + amount.formatted(.currency(code: "USD"))
        case "plainDate", "timestamp": return date(value)
        case "amount": return amount(value)
        case "external-link":
            if let string = value.stringValue { return string.isEmpty ? nil : string }
            if let number = number(value) { return format(number) }
            return nil
        default: break
        }
        switch value {
        case .null: return nil
        case .string(let string):
            if string.isEmpty { return nil }
            if field.kind == .date || field.kind == .timestamp { return date(value) ?? string }
            return field.kind == .enum ? enumLabel(string, field: field) : string
        case .number(let number): return format(number)
        case .bool(let flag): return flag ? "Yes" : "No"
        case .array(let items):
            if items.isEmpty { return nil }
            if items.allSatisfy({ $0.stringValue != nil }) {
                return items.compactMap(\.stringValue).joined(separator: ", ")
            }
            return "\(items.count) item\(items.count == 1 ? "" : "s")"
        case .object:
            return amount(value)
        }
    }

    /// A `reference` field's target read off the row: the id (`raw[key]`, or the nested
    /// `raw[stem].id` a list projection embeds instead) and its projected name when present.
    static func reference(in raw: JSONValue, field: FieldDescriptor) -> Reference? {
        guard let target = field.reference, !target.multiple else { return nil }
        let stem = field.key.hasSuffix("Id") ? String(field.key.dropLast(2)) : field.key
        if let id = raw[field.key]?.stringValue, !id.isEmpty {
            return Reference(
                entity: target.entity, id: id,
                name: raw["\(stem)Name"]?.stringValue ?? raw[stem]?["name"]?.stringValue)
        }
        if let nested = raw[stem], let id = nested["id"]?.stringValue, !id.isEmpty {
            return Reference(entity: target.entity, id: id, name: nested["name"]?.stringValue)
        }
        return nil
    }

    /// The trailing fact of a list row: the field the catalog places in the mobile `trailing` slot.
    static func trailing(descriptor: EntityDescriptor, raw: JSONValue) -> String? {
        guard let field = descriptor.fields.first(where: { $0.mobileSlot == "trailing" }) else { return nil }
        return text(raw[field.key], field: field)
    }

    static func enumLabel(_ raw: String, field: FieldDescriptor) -> String {
        field.controlOptions?.first { $0.value == raw }?.label ?? "Unknown option"
    }

    // MARK: - Value readers

    static func number(_ value: JSONValue?) -> Double? {
        if let double = value?.doubleValue { return double }
        if let string = value?.stringValue { return Double(string) }
        return nil
    }

    static func format(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15
            ? Int(value).formatted()
            : value.formatted(.number.precision(.fractionLength(0...2)))
    }

    static func money(_ value: JSONValue?) -> String? {
        guard let amount = number(value) else { return nil }
        return amount.formatted(.currency(code: "USD"))
    }

    /// `{ value, unit }` is Cubby's amount shape; a bare number means units.
    static func amount(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        if let quantity = number(value["value"]) {
            let unit = value["unit"]?.stringValue
            return unit.map { "\(format(quantity)) \($0)" } ?? format(quantity)
        }
        if let quantity = number(value) { return format(quantity) }
        return nil
    }

    static func date(_ value: JSONValue?) -> String? {
        guard let string = value?.stringValue else { return nil }
        return formattedDate(string)
    }

    /// ISO-8601 with or without fractional seconds, plus bare `yyyy-MM-dd` for date-only columns,
    /// which keeps its calendar day regardless of the device zone.
    static func formattedDate(_ string: String, locale: Locale = .current) -> String? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: string) {
            return date.formatted(date: .abbreviated, time: .shortened)
        }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: string) {
            return date.formatted(date: .abbreviated, time: .shortened)
        }
        if string.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil {
            let utc = TimeZone(secondsFromGMT: 0)!
            let input = DateFormatter()
            input.calendar = Calendar(identifier: .gregorian)
            input.locale = Locale(identifier: "en_US_POSIX")
            input.timeZone = utc
            input.dateFormat = "yyyy-MM-dd"
            input.isLenient = false
            guard let date = input.date(from: string) else { return nil }

            let output = DateFormatter()
            output.calendar = Calendar(identifier: .gregorian)
            output.locale = locale
            output.timeZone = utc
            output.dateStyle = .medium
            output.timeStyle = .none
            return output.string(from: date)
        }
        return nil
    }
}
