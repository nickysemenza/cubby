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
        var emoji: String? = nil
    }

    /// One item of a `resolvedList` value (a Product's owners): what to show, the record it
    /// names, and whether it is only inherited (drawn with the shared marker).
    struct ResolvedItem: Hashable {
        let label: String
        let reference: Reference?
        let inherited: Bool
    }

    /// The items of a `resolvedList` field; nil for any other format.
    static func resolvedItems(in raw: JSONValue, field: FieldDescriptor, surface: String) -> [ResolvedItem]? {
        guard field.format == "resolvedList" else { return nil }
        return resolvedItems(FieldResolutionPresentation.readValue(in: raw, field: field, surface: surface))
    }

    static func resolvedItems(_ value: JSONValue?) -> [ResolvedItem] {
        guard let value, value != .null,
            let items = try? JSONDecoder.cubby().decode(
                ResolvedList.self, from: JSONEncoder.cubby().encode(value))
        else { return [] }
        return items.map { item in
            ResolvedItem(
                label: item.label,
                reference: item.ref.flatMap { ref in
                    EntityKey(rawValue: ref.entityKind).map {
                        Reference(entity: $0, id: ref.entityId, name: item.label)
                    }
                },
                inherited: item.inherited)
        }
    }

    static func text(in raw: JSONValue, field: FieldDescriptor, surface: String) -> String? {
        if surface == "detail" {
            // A declared server-composed sentence is the whole answer: the structure behind it
            // is never re-worded here, and with no sentence the row is empty.
            if field.detailLabelPath != nil { return field.detailLabel(in: raw) }
            // A nested value (`identity.kind`, `meta.url`) is read where the declaration says.
            if field.readPath != nil { return text(field.detailValue(in: raw), field: field) }
        }
        return text(
            FieldResolutionPresentation.readValue(in: raw, field: field, surface: surface), field: field)
    }

    static func text(_ value: JSONValue?, field: FieldDescriptor) -> String? {
        guard let value, value != .null else { return nil }
        switch field.format {
        case "currency", "signedCurrency": return money(value)
        case "plainDate": return value.stringValue.map { DatePresentation.plainDate($0)?.absolute ?? $0 }
        case "timestamp": return date(value)
        case "amount": return amount(value)
        case "resolvedList":
            let labels = resolvedItems(value).map(\.label)
            return labels.isEmpty ? nil : labels.joined(separator: ", ")
        case "external-link":
            if let string = value.stringValue { return string.isEmpty ? nil : string }
            if let number = number(value) { return DisplayFormat.number(number) }
            return nil
        default: break
        }
        switch value {
        case .null: return nil
        case .string(let string):
            if string.isEmpty { return nil }
            if field.kind == .date { return DatePresentation.plainDate(string)?.absolute ?? string }
            if field.kind == .timestamp { return date(value) ?? string }
            if field.kind == .enum { return enumLabel(string, field: field) }
            // A non-enum field (a nested kind, a derived status) names its choices in `valueOptions`.
            return field.optionLabel(for: value) ?? string
        case .number(let number): return DisplayFormat.number(number)
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
    static func reference(in raw: JSONValue, field: FieldDescriptor, surface: String = "detail") -> Reference?
    {
        guard let target = field.reference, !target.multiple else { return nil }
        let stem = field.key.hasSuffix("Id") ? String(field.key.dropLast(2)) : field.key
        if let id = FieldResolutionPresentation.readValue(in: raw, field: field, surface: surface)?
            .stringValue, !id.isEmpty
        {
            return Reference(
                entity: target.entity, id: id,
                name: FieldResolutionPresentation.referenceName(in: raw, field: field, effectiveID: id),
                emoji: raw[stem + "Emoji"]?.stringValue ?? raw[stem]?["emoji"]?.stringValue)
        }
        if FieldResolutionPresentation(raw: raw, field: field) != nil { return nil }
        if let nested = raw[stem], let id = nested["id"]?.stringValue, !id.isEmpty {
            return Reference(
                entity: target.entity, id: id, name: nested["name"]?.stringValue,
                emoji: nested["emoji"]?.stringValue)
        }
        return nil
    }

    /// The trailing fact of a list row: the field the catalog places in the mobile `trailing` slot.
    static func trailing(descriptor: EntityDescriptor, raw: JSONValue) -> String? {
        guard let field = descriptor.fields.first(where: { $0.mobileSlot == "trailing" }) else { return nil }
        return text(raw[field.key], field: field)
    }

    static func enumLabel(_ raw: String, field: FieldDescriptor) -> String {
        (field.controlOptions ?? field.valueOptions)?.first { $0.value == raw }?.label ?? raw
    }

    static func optionColor(in raw: JSONValue, field: FieldDescriptor, surface: String) -> String? {
        let value =
            surface == "detail" && field.readPath != nil
            ? field.detailValue(in: raw)
            : FieldResolutionPresentation.readValue(in: raw, field: field, surface: surface)
        guard let code = value?.stringValue else { return nil }
        return (field.controlOptions ?? field.valueOptions)?.first { $0.value == code }?.color
    }

    // MARK: - Value readers

    static func number(_ value: JSONValue?) -> Double? {
        if let double = value?.doubleValue { return double }
        if let string = value?.stringValue { return Double(string) }
        return nil
    }

    static func money(_ value: JSONValue?) -> String? {
        guard let amount = number(value) else { return nil }
        return DisplayFormat.currency(amount)
    }

    /// `{ value, unit }` is Cubby's amount shape; a bare number means units. Rendered by the
    /// recipebridge unit formatter the web calls as WASM.
    static func amount(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        if let amount = number(value["value"]) {
            return ValueFormat.amount(
                unit: value["unit"]?.stringValue, value: amount,
                upperValue: number(value["upperValue"]) ?? number(value["upper_value"]))
        }
        if let amount = number(value) { return ValueFormat.amount(unit: nil, value: amount) }
        return nil
    }

    static func date(_ value: JSONValue?) -> String? {
        guard let string = value?.stringValue else { return nil }
        return formattedDate(string)
    }

    static func formattedDate(_ string: String) -> String? {
        DatePresentation.value(string)?.absolute
    }

    static func dateValue(in raw: JSONValue, field: FieldDescriptor, surface: String) -> String? {
        guard
            field.kind == .date || field.kind == .timestamp || field.format == "plainDate"
                || field.format == "timestamp"
        else { return nil }
        let value =
            surface == "detail" && field.readPath != nil
            ? field.detailValue(in: raw)
            : FieldResolutionPresentation.readValue(in: raw, field: field, surface: surface)
        guard let string = value?.stringValue, DatePresentation.value(string) != nil else { return nil }
        return string
    }
}
