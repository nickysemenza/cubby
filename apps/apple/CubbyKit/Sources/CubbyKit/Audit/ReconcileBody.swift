/// The wire body of `inventory.reconcileSession`. Hand-encoded because the guard on the server
/// (`bulk.ts` reconcile) is exact: the id set must equal the bin's rows, every id resolved once,
/// and `snapshotUpdatedAt` must match the max `updatedAt` to the millisecond — and be an
/// explicit `null` for an empty bin, never absent.
public struct ReconcileBody: Encodable, Sendable, Hashable {
    public struct Resolution: Encodable, Sendable, Hashable {
        public let kind: String
        public let inventoryEntryId: InventoryEntryCode
        public let amount: Amount?
        public let targetLocationId: LocationCode?

        public init(_ resolution: RecountResolution, for id: InventoryEntryCode) {
            inventoryEntryId = id
            switch resolution {
            case .verify:
                kind = "verify"; amount = nil; targetLocationId = nil
            case .adjust(let amount):
                kind = "adjust"; self.amount = amount; targetLocationId = nil
            case .remove:
                kind = "remove"; amount = nil; targetLocationId = nil
            case .relocate(let target, _):
                kind = "relocate"; amount = nil; targetLocationId = target
            }
        }

        private enum CodingKeys: String, CodingKey { case kind, inventoryEntryId, amount, targetLocationId }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(kind, forKey: .kind)
            try container.encode(inventoryEntryId, forKey: .inventoryEntryId)
            // Each oneOf arm carries only its own keys; an unexpected key fails validation.
            try container.encodeIfPresent(amount, forKey: .amount)
            try container.encodeIfPresent(targetLocationId, forKey: .targetLocationId)
        }
    }

    public let locationId: LocationCode
    public let expectedInventoryEntryIds: [InventoryEntryCode]
    public let snapshotUpdatedAt: String?
    public let resolutions: [Resolution]

    public init(
        locationId: LocationCode,
        expectedInventoryEntryIds: [InventoryEntryCode],
        snapshotUpdatedAt: String?,
        resolutions: [Resolution]
    ) {
        self.locationId = locationId
        self.expectedInventoryEntryIds = expectedInventoryEntryIds
        self.snapshotUpdatedAt = snapshotUpdatedAt
        self.resolutions = resolutions
    }

    private enum CodingKeys: String, CodingKey {
        case locationId, expectedInventoryEntryIds, snapshotUpdatedAt, resolutions
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(locationId, forKey: .locationId)
        try container.encode(expectedInventoryEntryIds, forKey: .expectedInventoryEntryIds)
        // `encode` (not `encodeIfPresent`) so an empty bin sends `null`, which is required.
        try container.encode(snapshotUpdatedAt, forKey: .snapshotUpdatedAt)
        try container.encode(resolutions, forKey: .resolutions)
    }
}
