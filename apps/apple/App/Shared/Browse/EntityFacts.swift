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
    /// The single figure a list row earns on its trailing edge.
    static func trailing(key: EntityKey, row: EntityRow) -> String? {
        let raw = row.raw
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
        case .expense:
            return money(raw["total"]) ?? money(raw["cost"])
        case .purchase:
            return money(raw["total"])
        case .task:
            return raw["status"]?.stringValue?.capitalized ?? date(raw["dueDate"])
        case .recipe:
            if let servings = number(raw["servings"]) {
                return "\(format(servings)) servings"
            }
            return nil
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
        case .task:
            if let status = raw["status"]?.stringValue {
                stats.append(EntityStat(label: "Status", value: status.capitalized))
            }
            if let due = date(raw["dueDate"]) {
                stats.append(EntityStat(label: "Due", value: due))
            }
            if let project = raw["projectName"]?.stringValue {
                stats.append(EntityStat(label: "Project", value: project))
            }
        case .expense:
            if let total = money(raw["total"]) ?? money(raw["cost"]) {
                stats.append(EntityStat(label: "Cost", value: total))
            }
            if let when = date(raw["date"]) {
                stats.append(EntityStat(label: "Date", value: when))
            }
            if let vendor = raw["vendor"]?.stringValue {
                stats.append(EntityStat(label: "Vendor", value: vendor))
            }
        default:
            break
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
            guard let value = row.raw[field.key] else { continue }
            switch value {
            case .string(let string) where !string.isEmpty:
                let display = (field.kind == .date || field.kind == .timestamp) ? (date(value) ?? string) : string
                stats.append(EntityStat(label: field.label, value: display, mono: field.kind == .identifier))
            case .number(let number):
                stats.append(EntityStat(label: field.label, value: format(number)))
            case .bool(let flag):
                stats.append(EntityStat(label: field.label, value: flag ? "Yes" : "No"))
            default:
                continue
            }
            if stats.count >= 4 { break }
        }
        return stats
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

    /// ISO-8601 with or without fractional seconds, plus bare `yyyy-MM-dd` for date-only columns.
    static func formattedDate(_ string: String) -> String? {
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
        let dayOnly = Date.ISO8601FormatStyle(dateSeparator: .dash, dateTimeSeparator: .standard)
            .year().month().day()
        if let date = try? dayOnly.parse(string) {
            return date.formatted(date: .abbreviated, time: .omitted)
        }
        return nil
    }
}
