import Foundation

/// Hand-authored domain types. These are the only shapes views, models, and the CLI see; the
/// generated OpenAPI types stop at `Mapping.swift`.

public struct LocationCode: RawRepresentable, Sendable, Hashable, Codable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
}

public struct ProductCode: RawRepresentable, Sendable, Hashable, Codable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
}

public struct InventoryEntryCode: RawRepresentable, Sendable, Hashable, Codable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
}

public struct ProductSummary: Sendable, Hashable, Identifiable {
    public let id: ProductCode
    public let name: String
    public let manufacturer: String?
    public let coverImageURL: URL?

    public init(id: ProductCode, name: String, manufacturer: String?, coverImageURL: URL?) {
        self.id = id
        self.name = name
        self.manufacturer = manufacturer
        self.coverImageURL = coverImageURL
    }
}

public enum ScanOutcome: String, Sendable, Hashable {
    /// A new inventory row was created at this location.
    case added
    /// An existing row here was stamped as seen; its amount is untouched.
    case confirmed
    /// The product only lives elsewhere; nothing was written. Resolve via strays.
    case queued
}

public struct ScannedProduct: Sendable, Hashable {
    public let id: ProductCode
    public let name: String
    public let created: Bool
    public let manufacturer: String?
    public let hasPrice: Bool
}

public struct Stray: Sendable, Hashable, Identifiable {
    public var id: InventoryEntryCode { entryId }
    public let entryId: InventoryEntryCode
    public let locationId: LocationCode
    public let locationName: String
    /// Whether the source row holds more than one unit, so moving it whole would relocate stock
    /// the scan never saw.
    public let ambiguousQuantity: Bool
}

public struct ScanResult: Sendable, Hashable {
    public let outcome: ScanOutcome
    public let product: ScannedProduct
    public let strays: [Stray]
}

public struct StrayMove: Sendable, Hashable {
    public let entryId: InventoryEntryCode
    /// `nil` moves the whole row; a number moves that many units.
    public let quantity: Double?

    public init(entryId: InventoryEntryCode, quantity: Double? = nil) {
        self.entryId = entryId
        self.quantity = quantity
    }
}

public struct StrayResolution: Sendable, Hashable {
    public struct Skipped: Sendable, Hashable {
        public let entryId: InventoryEntryCode
        public let reason: String
        public let message: String
    }
    public let moved: Int
    public let skipped: [Skipped]
}

public struct FoundProduct: Sendable, Hashable {
    public let product: ProductSummary
    public let created: Bool
}

public struct AgentAnswer: Sendable, Hashable {
    public struct Source: Sendable, Hashable {
        public let entityType: String
        public let id: String
        public let name: String
        public let detail: String?
    }
    public let answer: String
    public let sources: [Source]
}

/// What `upc.lookup` knows about a barcode, from the cache or the upstream catalog.
public struct UPCLookup: Sendable, Hashable {
    public let upc: String
    public let name: String
    public let manufacturer: String?
    public let category: String?
    public let priceDollars: Double?
    public let imageURL: URL?
    /// `manual` (someone typed it into Cubby) or `upcitemdb`.
    public let source: String
    public let cached: Bool

    public init(
        upc: String,
        name: String,
        manufacturer: String?,
        category: String?,
        priceDollars: Double?,
        imageURL: URL?,
        source: String,
        cached: Bool
    ) {
        self.upc = upc
        self.name = name
        self.manufacturer = manufacturer
        self.category = category
        self.priceDollars = priceDollars
        self.imageURL = imageURL
        self.source = source
        self.cached = cached
    }
}

/// One pickable location: the shortcode, its name, and its parent's name when it has one.
public struct LocationOption: Sendable, Hashable, Identifiable {
    public let id: LocationCode
    public let name: String
    public let path: String?

    public init(id: LocationCode, name: String, path: String?) {
        self.id = id
        self.name = name
        self.path = path
    }
}

/// Row counts from `dashboard.counts`, keyed by `EntityKey.rawValue`.
public struct DashboardCounts: Sendable, Hashable {
    public let byEntityKey: [String: Int]

    public init(byEntityKey: [String: Int]) {
        self.byEntityKey = byEntityKey
    }

    public func count(for key: EntityKey) -> Int? {
        byEntityKey[key.rawValue]
    }
}

/// A quantity as the API spells it everywhere: `{value, unit, upperValue?}`.
public struct Amount: Codable, Sendable, Hashable {
    public var value: Double
    public var unit: String
    public var upperValue: Double?

    public init(value: Double, unit: String, upperValue: Double? = nil) {
        self.value = value
        self.unit = unit
        self.upperValue = upperValue
    }
}
