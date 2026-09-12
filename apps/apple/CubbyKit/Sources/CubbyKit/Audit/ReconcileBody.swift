/// One bin's recount, as `inventory.reconcileSession` accepts it. The guard on the server
/// (`bulk.ts` reconcile) is exact: the id set must equal the bin's live rows, every id must be
/// resolved exactly once, and `snapshotUpdatedAt` must match the bin's max `updatedAt` to the
/// millisecond.
public struct ReconcileBody: Sendable, Hashable {
    public struct Resolution: Sendable, Hashable {
        public let inventoryEntryId: InventoryEntryCode
        public let resolution: RecountResolution

        public init(_ resolution: RecountResolution, for id: InventoryEntryCode) {
            self.inventoryEntryId = id
            self.resolution = resolution
        }
    }

    public let locationId: LocationCode
    public let expectedInventoryEntryIds: [InventoryEntryCode]
    /// The bin's newest `updatedAt`, verbatim from the server; `nil` for an empty bin.
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
}
