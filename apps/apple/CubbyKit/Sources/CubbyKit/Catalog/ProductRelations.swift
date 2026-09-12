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

    public init(id: String, locationID: LocationCode, locationName: String, ancestorPath: String?, amount: Amount?, placement: String?) {
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
            let ancestorNames = location["ancestors"]?.arrayValue?.compactMap { $0["name"]?.stringValue } ?? []
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

    /// Uploaded product images, in payload order. A `PENDING`/`FAILED` image has no fetchable file.
    public static func gallery(from row: EntityRow) -> [(id: String, url: URL)] {
        guard let images = row.raw["images"]?.arrayValue else { return [] }
        return images.compactMap { image in
            guard image["status"]?.stringValue == "UPLOADED",
                let id = image["id"]?.stringValue,
                let urlString = image["url"]?.stringValue,
                let url = URL(string: urlString)
            else { return nil }
            return (id, url)
        }
    }

    private static func amount(_ value: JSONValue?) -> Amount? {
        guard let value, let quantity = value["value"]?.doubleValue, let unit = value["unit"]?.stringValue else { return nil }
        return Amount(value: quantity, unit: unit, upperValue: value["upperValue"]?.doubleValue)
    }
}
