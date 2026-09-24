import CubbyAPI
import Foundation

/// One expected inventory row in a bin, from `inventory.locationSnapshot`, with the product
/// reduced to what the walk matches and shows.
public struct RecountRow: Sendable, Hashable, Identifiable {
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
    /// The server's row timestamp, retained for display and diagnostics. Reconcile concurrency is
    /// guarded by `RecountSnapshot.token`, which also covers membership and ownership changes.
    public let updatedAt: Date
    public let placement: String
    public let product: Product
    public let locationID: LocationCode
    public let locationName: String

    public init(
        id: InventoryEntryCode,
        amount: Amount,
        updatedAt: Date,
        placement: String = "stock",
        product: Product,
        locationID: LocationCode,
        locationName: String
    ) {
        self.id = id
        self.amount = amount
        self.updatedAt = updatedAt
        self.placement = placement
        self.product = product
        self.locationID = locationID
        self.locationName = locationName
    }

    public init(_ out: InventoryWithLocationAndProductOut) {
        var barcodes: Set<String> = []
        for external in out.product.externalIds where external.kind == .gtin14 {
            barcodes.insert(external.externalId)
        }
        // InventoryDetailProductOut (the recount row's product shape) carries neither
        // `displayImages` nor `coverImageUrl` — only this status-tagged `images` array. Switch to
        // `out.product.displayImages.first?.url` once that field lands here, matching the
        // list-row image ladder in EntityRow.imageURL(from:).
        let cover = out.product.images.first { $0.status == .uploaded }.flatMap {
            URL(string: $0.representations?.preferred ?? $0.url)
        }
        self.init(
            id: out.id,
            amount: Amount(value: out.amount.value, unit: out.amount.unit, upperValue: out.amount.upperValue),
            updatedAt: out.updatedAt,
            placement: out.placement.rawValue,
            product: Product(
                id: out.product.id,
                name: out.product.name,
                manufacturer: out.product.manufacturer.isEmpty ? nil : out.product.manufacturer,
                primaryGtin: out.product.primaryGtin,
                barcodes: barcodes,
                coverImageURL: cover
            ),
            locationID: out.location.id,
            locationName: out.location.name
        )
    }

}

/// One atomic server view of a bin. The opaque token covers row membership and ownership state,
/// including facts that are not represented by the visible recount rows.
public struct RecountSnapshot: Sendable, Hashable {
    public let rows: [RecountRow]
    public let token: String

    public init(rows: [RecountRow], token: String) {
        self.rows = rows
        self.token = token
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

    /// The wire arm for `inventory.reconcileSession`; each carries only its own keys, since an
    /// unexpected key fails validation.
    public func resolution(for id: InventoryEntryCode) -> InventorySessionResolution {
        switch self {
        case .verify: .verify(.init(kind: .verify, inventoryEntryId: id))
        case .adjust(let amount):
            .adjust(.init(kind: .adjust, inventoryEntryId: id, amount: PositiveAmountInput(amount)))
        case .remove: .remove(.init(kind: .remove, inventoryEntryId: id))
        case .relocate(let target, _):
            .relocate(.init(kind: .relocate, inventoryEntryId: id, targetLocationId: target))
        }
    }
}

public struct RecountSummary: Sendable, Hashable, Codable {
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
