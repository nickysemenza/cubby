import Foundation

/// The few request shapes the app composes before they become generated input bodies. Everything
/// read from the wire is a generated type (see `Generated/APITypes.swift`).

public struct StrayMove: Sendable, Hashable {
    public let entryId: InventoryEntryCode
    /// `nil` moves the whole row; a number moves that many units.
    public let quantity: Double?

    public init(entryId: InventoryEntryCode, quantity: Double? = nil) {
        self.entryId = entryId
        self.quantity = quantity
    }
}
