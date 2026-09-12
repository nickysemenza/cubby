import Foundation

/// One expected inventory row in a bin, from `inventory.getByLocationIds`. Hand-decoded so the
/// server's `updatedAt` string survives verbatim: `reconcileSession` compares the snapshot to
/// the millisecond, and a Date round-trip could change the spelling.
public struct RecountRow: Sendable, Hashable, Identifiable, Decodable {
    public struct Product: Sendable, Hashable {
        public let id: ProductCode
        public let name: String
        public let manufacturer: String?
        public let primaryGtin: String?
        /// Every GTIN-14 the product answers to: `primaryGtin` plus `gtin_14` external ids.
        public let barcodes: Set<String>
        public let coverImageURL: URL?

        public init(
            id: ProductCode,
            name: String,
            manufacturer: String? = nil,
            primaryGtin: String? = nil,
            barcodes: Set<String> = [],
            coverImageURL: URL? = nil
        ) {
            self.id = id
            self.name = name
            self.manufacturer = manufacturer
            self.primaryGtin = primaryGtin
            self.barcodes = barcodes.union(primaryGtin.map { [$0] } ?? [])
            self.coverImageURL = coverImageURL
        }
    }

    public let id: InventoryEntryCode
    public let amount: Amount
    public let updatedAtRaw: String
    public let placement: String
    public let product: Product
    public let locationID: LocationCode
    public let locationName: String

    public init(
        id: InventoryEntryCode,
        amount: Amount,
        updatedAtRaw: String,
        placement: String = "stock",
        product: Product,
        locationID: LocationCode,
        locationName: String
    ) {
        self.id = id
        self.amount = amount
        self.updatedAtRaw = updatedAtRaw
        self.placement = placement
        self.product = product
        self.locationID = locationID
        self.locationName = locationName
    }

    private enum CodingKeys: String, CodingKey {
        case id, amount, updatedAt, placement, product, location
    }
    private enum ProductKeys: String, CodingKey {
        case id, name, manufacturer, primaryGtin, externalIds, images
    }
    private enum ExternalIDKeys: String, CodingKey { case kind, externalId }
    private enum ImageKeys: String, CodingKey { case url, status }
    private enum LocationKeys: String, CodingKey { case id, name }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(InventoryEntryCode.self, forKey: .id)
        amount = try container.decode(Amount.self, forKey: .amount)
        updatedAtRaw = try container.decode(String.self, forKey: .updatedAt)
        placement = try container.decodeIfPresent(String.self, forKey: .placement) ?? "stock"

        let product = try container.nestedContainer(keyedBy: ProductKeys.self, forKey: .product)
        let primaryGtin = try product.decodeIfPresent(String.self, forKey: .primaryGtin)
        var barcodes: Set<String> = []
        var externalIDs = try product.nestedUnkeyedContainer(forKey: .externalIds)
        while !externalIDs.isAtEnd {
            let entry = try externalIDs.nestedContainer(keyedBy: ExternalIDKeys.self)
            if try entry.decode(String.self, forKey: .kind) == "gtin_14" {
                barcodes.insert(try entry.decode(String.self, forKey: .externalId))
            }
        }
        var cover: URL?
        if product.contains(.images) {
            var images = try product.nestedUnkeyedContainer(forKey: .images)
            while !images.isAtEnd, cover == nil {
                let image = try images.nestedContainer(keyedBy: ImageKeys.self)
                if try image.decodeIfPresent(String.self, forKey: .status) == "UPLOADED" {
                    cover = try image.decodeIfPresent(String.self, forKey: .url).flatMap(URL.init(string:))
                }
            }
        }
        self.product = Product(
            id: try product.decode(ProductCode.self, forKey: .id),
            name: try product.decode(String.self, forKey: .name),
            manufacturer: try product.decodeIfPresent(String.self, forKey: .manufacturer),
            primaryGtin: primaryGtin,
            barcodes: barcodes,
            coverImageURL: cover
        )

        let location = try container.nestedContainer(keyedBy: LocationKeys.self, forKey: .location)
        locationID = try location.decode(LocationCode.self, forKey: .id)
        locationName = try location.decode(String.self, forKey: .name)
    }

    /// The `snapshotUpdatedAt` for a bin: the verbatim `updatedAt` of the most recently updated
    /// row, or `nil` for an empty bin. Compared as dates, returned as the original string.
    public static func snapshotTimestamp(_ rows: [RecountRow]) -> String? {
        let transcoder = LenientISO8601DateTranscoder()
        let dated = rows.compactMap { row in (try? transcoder.decode(row.updatedAtRaw)).map { (row.updatedAtRaw, $0) } }
        if dated.count == rows.count {
            return dated.max { $0.1 < $1.1 }?.0
        }
        // A timestamp the transcoder cannot parse: fall back to the lexical order, which for the
        // API's fixed `YYYY-MM-DDTHH:mm:ss.sssZ` spelling is the chronological one.
        return rows.map(\.updatedAtRaw).max()
    }

    /// Left-pads a scanned 8/12/13-digit barcode to the GTIN-14 the server stores.
    public static func gtin14(_ digits: String) -> String {
        String(repeating: "0", count: max(0, 14 - digits.count)) + digits
    }
}

/// One staged, uncommitted decision about an expected row. Nothing is written until the bin
/// commits the whole resolved set at once.
public enum RecountResolution: Sendable, Hashable {
    case verify
    case adjust(Amount)
    case remove
    case relocate(LocationCode, name: String)

    public var isChange: Bool {
        if case .verify = self { return false }
        return true
    }
}

public struct RecountSummary: Sendable, Hashable {
    public var verified = 0
    public var adjusted = 0
    public var removed = 0
    public var relocated = 0
    /// Unexpected products scanned in a bin that the server created rows for.
    public var added = 0
    /// Bins adopted into the bin being counted.
    public var adopted = 0
    public var binsDone = 0
    public var binsSkipped = 0

    public init() {}

    public var changed: Int { adjusted + removed + relocated }

    mutating func tally(_ resolutions: [RecountResolution]) {
        for resolution in resolutions {
            switch resolution {
            case .verify: verified += 1
            case .adjust: adjusted += 1
            case .remove: removed += 1
            case .relocate: relocated += 1
            }
        }
    }
}
