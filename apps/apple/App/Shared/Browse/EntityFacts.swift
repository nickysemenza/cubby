import CubbyKit
import Foundation

/// One fact worth a tile on a detail screen.
struct EntityStat: Identifiable {
    var id: String { label }
    let label: String
    let value: String
    var detail: String?
    var mono = false
}

/// Reads decision-relevant facts straight out of a row's `raw` JSON.
///
/// Entity payloads differ per entity and the app has one generic list and one generic detail
/// screen, so the alternative to this lookup is showing every row identically. Nothing here issues
/// a request: if the projection did not carry the value, the fact is simply absent.
enum EntityFacts {
    /// The single figure a list row earns on its trailing edge: the column the catalog places in
    /// the mobile `trailing` slot, else the nested projection a product, location or inventory row
    /// carries (those read nested keys the field metadata cannot name).
    static func trailing(key: EntityKey, row: EntityRow) -> String? {
        let raw = row.raw
        if let field = EntityCatalog[key].fields.first(where: { $0.mobileSlot == "trailing" }),
            let value = formatted(raw[field.key], as: field)
        {
            return value
        }
        switch key {
        case .product:
            if let onHand = number(raw["onHandUnits"]) {
                return "\(format(onHand)) on hand"
            }
            if let expected = number(raw["expectedQuantity"]) {
                return "\(format(expected)) expected"
            }
            return nil
        case .location:
            if let count = number(raw["itemCount"]) ?? number(raw["childCount"]) {
                return "\(format(count)) items"
            }
            return raw["path"]?.stringValue
        case .inventory:
            return amount(raw["amount"])
        default:
            return nil
        }
    }

    /// Up to four tiles for the detail stats grid. Falls back to the first scalar fields the
    /// catalog marks `showInDetail`, so an entity nobody has hand-tuned still says something.
    static func stats(descriptor: EntityDescriptor, row: EntityRow) -> [EntityStat] {
        let raw = row.raw
        var stats: [EntityStat] = []

        switch descriptor.key {
        case .product:
            if let onHand = number(raw["onHandUnits"]) {
                stats.append(EntityStat(label: "On hand", value: format(onHand), detail: "units"))
            } else if let entries = raw["inventoryEntry"]?.arrayValue, !entries.isEmpty {
                stats.append(
                    EntityStat(
                        label: "On hand", value: format(Double(entries.count)),
                        detail: entries.count == 1 ? "location" : "locations"
                    )
                )
            } else if let expected = number(raw["expectedQuantity"]) {
                stats.append(EntityStat(label: "Expected", value: format(expected), detail: "units"))
            }
            // `pricing.effectivePrice` reflects the derived/explicit split; `price` is the plain
            // fallback for entities the pricing endpoint hasn't touched.
            if let price = money(raw["pricing"]?["effectivePrice"]) ?? money(raw["price"]) {
                stats.append(EntityStat(label: "Price", value: price, detail: "valuation"))
            }
            if let category = raw["category"]?.stringValue ?? raw["model"]?.stringValue {
                stats.append(EntityStat(label: "Category", value: category))
            }
            if let gtin = raw["primaryGtin"]?.stringValue ?? raw["upc"]?.stringValue {
                stats.append(EntityStat(label: "Barcode", value: gtin, mono: true))
            }
        case .location:
            // Type and the parent link move into the identity block (`EntityDetailContent`); these
            // three stay exactly as `DetailRelations` expects them, capped short of the generic
            // fallback below so a leaf location doesn't also grow a redundant "Type" tile.
            if let directCount = number(raw["directItemCount"]) {
                stats.append(EntityStat(label: "Items here", value: format(directCount)))
            }
            if let totalCount = number(raw["totalItemCount"]) {
                stats.append(EntityStat(label: "Items in tree", value: format(totalCount)))
            }
            if let children = raw["children"]?.arrayValue {
                stats.append(EntityStat(label: "Sub-locations", value: format(Double(children.count))))
            }
        case .inventory:
            if let amount = amount(raw["amount"]) {
                stats.append(EntityStat(label: "Amount", value: amount))
            }
            if let location = raw["locationName"]?.stringValue ?? raw["locationId"]?.stringValue {
                stats.append(EntityStat(label: "Location", value: location, mono: location.hasPrefix("LOC-")))
            }
            if let verified = date(raw["verifiedAt"]) {
                stats.append(EntityStat(label: "Verified", value: verified))
            }
        default:
            // The columns the catalog places on the mobile card, in priority order, then the
            // scalar `showInDetail` fields.
            let placed = descriptor.fields.filter { $0.mobileSlot != nil }
                .sorted { ($0.mobilePriority ?? .max) < ($1.mobilePriority ?? .max) }
            for field in placed {
                if let value = formatted(raw[field.key], as: field) {
                    stats.append(
                        EntityStat(label: field.label, value: value, mono: field.kind == .identifier))
                }
            }
        }

        if stats.count < 4, descriptor.key != .location {
            stats += fallbackStats(descriptor: descriptor, row: row, excluding: Set(stats.map(\.label)))
        }
        return Array(stats.prefix(4))
    }

    /// Scalar `showInDetail` fields in catalog order, skipping the ones the identity block already
    /// shows and anything that is not a single readable value.
    private static func fallbackStats(
        descriptor: EntityDescriptor,
        row: EntityRow,
        excluding: Set<String>
    ) -> [EntityStat] {
        let skipped: Set<String> = ["id", "name", descriptor.titleField]
        var stats: [EntityStat] = []
        for field in descriptor.fields.sorted(by: { ($0.detailOrder ?? .max) < ($1.detailOrder ?? .max) }) {
            guard field.showInDetail, !skipped.contains(field.key), !excluding.contains(field.label) else {
                continue
            }
            guard let value = formatted(row.raw[field.key], as: field) else { continue }
            stats.append(EntityStat(label: field.label, value: value, mono: field.kind == .identifier))
            if stats.count >= 4 { break }
        }
        return stats
    }

    /// One scalar as the catalog says to show it: `format` (`currency`, `plainDate`, `timestamp`)
    /// first, then the field kind. Anything that is not a single readable value is `nil`.
    static func formatted(_ value: JSONValue?, as field: FieldDescriptor) -> String? {
        guard let value else { return nil }
        switch field.format {
        case "currency": return money(value)
        case "plainDate", "timestamp": return date(value)
        default: break
        }
        switch value {
        case .string(let string) where !string.isEmpty:
            if field.kind == .date || field.kind == .timestamp { return date(value) ?? string }
            return field.kind == .`enum`
                ? string.replacingOccurrences(of: "_", with: " ").capitalized : string
        case .number(let number): return format(number)
        case .bool(let flag): return flag ? "Yes" : "No"
        default: return nil
        }
    }

    // MARK: - Value readers

    static func number(_ value: JSONValue?) -> Double? {
        if let double = value?.doubleValue { return double }
        if let string = value?.stringValue { return Double(string) }
        return nil
    }

    static func amountText(_ amount: Amount) -> String {
        amount.unit.isEmpty ? format(amount.value) : "\(format(amount.value)) \(amount.unit)"
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

    /// ISO-8601 with or without fractional seconds, plus bare `yyyy-MM-dd` for date-only columns.
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
