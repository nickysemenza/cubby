import Foundation

/// One place a product is physically stocked, from a product detail's `inventoryEntry[]`.
public struct ProductStockLocation: Sendable, Hashable, Identifiable {
    public let id: String
    public let locationID: LocationCode
    public let locationName: String
    /// Ancestor names joined with " › ", or `nil` at a root.
    public let ancestorPath: String?
    public let amount: Amount?
    public let placement: String?

    public init(
        id: String, locationID: LocationCode, locationName: String, ancestorPath: String?, amount: Amount?,
        placement: String?
    ) {
        self.id = id
        self.locationID = locationID
        self.locationName = locationName
        self.ancestorPath = ancestorPath
        self.amount = amount
        self.placement = placement
    }
}

/// Reads the relationship arrays a product detail payload carries alongside its scalar fields.
/// Shared by the detail screen and the "where is" intent so both answer from one parse.
public enum ProductRelations {
    /// Every place this product is physically stocked, from `inventoryEntry`.
    public static func stockedAt(from row: EntityRow) -> [ProductStockLocation] {
        guard let entries = row.raw["inventoryEntry"]?.arrayValue else { return [] }
        return entries.compactMap { entry in
            guard let id = entry["id"]?.stringValue,
                let location = entry["location"],
                let locationID = location["id"]?.stringValue
            else { return nil }
            let ancestorNames =
                location["ancestors"]?.arrayValue?.compactMap { $0["name"]?.stringValue } ?? []
            return ProductStockLocation(
                id: id,
                locationID: LocationCode(locationID),
                locationName: location["name"]?.stringValue ?? locationID,
                ancestorPath: ancestorNames.isEmpty ? nil : ancestorNames.joined(separator: " › "),
                amount: amount(entry["amount"]),
                placement: entry["placement"]?.stringValue
            )
        }
    }

    /// The product's image ids, in display order — which is the order `setImageOrder` rewrites.
    /// The payload carries shortcodes only: there is no per-image url or status to read, so a
    /// gallery cannot be rendered from a detail row alone.
    public static func imageIDs(from row: EntityRow) -> [ImageCode] {
        guard let images = row.raw["images"]?.arrayValue else { return [] }
        return images.compactMap { value in value.stringValue.map { ImageCode($0) } }
    }

    private static func amount(_ value: JSONValue?) -> Amount? {
        guard let value, let quantity = value["value"]?.doubleValue, let unit = value["unit"]?.stringValue
        else { return nil }
        return Amount(value: quantity, unit: unit, upperValue: value["upperValue"]?.doubleValue)
    }
}
