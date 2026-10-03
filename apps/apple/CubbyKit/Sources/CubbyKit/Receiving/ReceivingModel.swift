import CubbyAPI
import CubbyAPISupport
import Foundation
import Observation

/// One live stock row for the Product being received.
public struct ReceivingStock: Sendable, Hashable, Identifiable {
    public let id: InventoryEntryCode
    public let locationID: LocationCode
    public let locationName: String
    public let value: Double
    public let unit: String

    public init(
        id: InventoryEntryCode, locationID: LocationCode, locationName: String, value: Double, unit: String
    ) {
        self.id = id
        self.locationID = locationID
        self.locationName = locationName
        self.value = value
        self.unit = unit
    }
}

/// An open Product match candidate (agent proposal or detector pair) that may be the same item.
public struct ReceivingMatch: Sendable, Hashable, Identifiable {
    public var id: ProductCode { candidateID }
    public let candidateID: ProductCode
    public let candidateName: String
    public let stockOnHand: Int
    public let evidence: String?
    public let warnings: [String]

    public init(
        candidateID: ProductCode, candidateName: String, stockOnHand: Int, evidence: String?,
        warnings: [String]
    ) {
        self.candidateID = candidateID
        self.candidateName = candidateName
        self.stockOnHand = stockOnHand
        self.evidence = evidence
        self.warnings = warnings
    }

    public var noticeTitle: String { "This may already be counted as \(candidateName)" }
}

/// What "receive" will do at a chosen location. The server picks it (`inventory.receivingContext`);
/// the client only looks it up.
public enum ReceivingPlan: Sendable, Hashable {
    /// A one-of-a-kind item relocates; `from` is the shelf it already occupies.
    case move(entry: InventoryEntryCode, from: LocationCode)
    case add(entry: InventoryEntryCode, unit: String)
    case create
}

/// The server's receiving context: stock, matches, and the defaults every client renders as-is.
public struct ReceivingSnapshot: Sendable, Hashable {
    public let productID: ProductCode
    public let productName: String
    public let stock: [ReceivingStock]
    public let matches: [ReceivingMatch]
    public let alreadyCounted: Bool
    /// `nil` when the Product is already counted, so units are never added without typing.
    public let defaultQuantity: Double?
    public let defaultUnit: String
    /// The plan at a location that holds none of this Product's stock.
    public let suggestedPlan: ReceivingPlan
    /// The plan at each location that does hold stock; overrides `suggestedPlan` there.
    public let locationPlans: [LocationCode: ReceivingPlan]

    public init(
        productID: ProductCode, productName: String, stock: [ReceivingStock], matches: [ReceivingMatch],
        alreadyCounted: Bool, defaultQuantity: Double?, defaultUnit: String, suggestedPlan: ReceivingPlan,
        locationPlans: [LocationCode: ReceivingPlan]
    ) {
        self.productID = productID
        self.productName = productName
        self.stock = stock
        self.matches = matches
        self.alreadyCounted = alreadyCounted
        self.defaultQuantity = defaultQuantity
        self.defaultUnit = defaultUnit
        self.suggestedPlan = suggestedPlan
        self.locationPlans = locationPlans
    }
}

public struct ReceivingLocation: Sendable, Hashable, Identifiable {
    public let id: LocationCode
    public let name: String
    public let path: String?

    public init(id: LocationCode, name: String, path: String?) {
        self.id = id
        self.name = name
        self.path = path
    }
}

public struct ReceivingAmount: Sendable, Hashable {
    public let value: Double
    public let unit: String

    public init(value: Double, unit: String) {
        self.value = value
        self.unit = unit
    }
}

/// The three reviewed outcomes of `inventory.receiveExpense`.
public enum ReceivingAction: Sendable, Hashable {
    case move(entry: InventoryEntryCode)
    case add(entry: InventoryEntryCode, amount: ReceivingAmount)
    case create(amount: ReceivingAmount)
}

/// What receiving needs from the server. `CubbyClient` conforms; tests stub it.
public protocol ReceivingService: Sendable {
    func receivingSnapshot(productID: ProductCode) async throws -> ReceivingSnapshot
    func receivingLocations() async throws -> [ReceivingLocation]
    func receive(expenseID: String, productID: ProductCode, locationID: LocationCode, action: ReceivingAction)
        async throws
}

/// State behind the receive sheet. Receiving is always explicit (buying never stocks inventory):
/// a Product that is already counted opens on "Nothing new arrived", and units are written only
/// after "Additional units arrived", a typed positive quantity (or a move), and a location.
/// The server rechecks the choice against current stock; its refusal text is shown verbatim.
@MainActor
@Observable
public final class ReceivingModel {
    public enum Phase: Sendable, Hashable {
        case loading, loaded, failed(String)
    }

    public enum Decision: Sendable, Hashable {
        case nothingNew, additionalUnits
    }

    public typealias Plan = ReceivingPlan

    public let expenseID: String
    public let productID: ProductCode
    public private(set) var phase: Phase = .loading
    public private(set) var snapshot: ReceivingSnapshot?
    public private(set) var locations: [ReceivingLocation] = []
    public private(set) var decision: Decision = .additionalUnits
    public private(set) var isReceiving = false
    public private(set) var didReceive = false
    public private(set) var refusal: String?
    public var locationID: LocationCode?
    public var quantityText = ""
    public var unit = ""

    private let service: any ReceivingService

    public init(expenseID: String, productID: ProductCode, service: any ReceivingService) {
        self.expenseID = expenseID
        self.productID = productID
        self.service = service
    }

    public func load() async {
        phase = .loading
        do {
            async let loadedSnapshot = service.receivingSnapshot(productID: productID)
            async let loadedLocations = service.receivingLocations()
            let (snapshot, locations) = try await (loadedSnapshot, loadedLocations)
            self.snapshot = snapshot
            self.locations = locations
            decision = snapshot.alreadyCounted ? .nothingNew : .additionalUnits
            quantityText = snapshot.defaultQuantity.map(Self.quantityString) ?? ""
            unit = snapshot.defaultUnit
            phase = .loaded
        } catch {
            phase = .failed(error.userMessage)
        }
    }

    private static func quantityString(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }

    public var alreadyCounted: Bool { snapshot?.alreadyCounted ?? false }
    public var stockedMatches: [ReceivingMatch] { snapshot?.matches.filter { $0.stockOnHand > 0 } ?? [] }
    public var ownUnits: Double { snapshot?.stock.reduce(0) { $0 + $1.value } ?? 0 }

    public func chooseAdditionalUnits() { decision = .additionalUnits }

    public var quantity: Double? {
        guard let value = Double(quantityText.trimmingCharacters(in: .whitespaces)), value.isFinite, value > 0
        else { return nil }
        return value
    }

    public var plan: Plan {
        guard let snapshot else { return .create }
        return locationID.flatMap { snapshot.locationPlans[$0] } ?? snapshot.suggestedPlan
    }

    public var canReceive: Bool {
        guard phase == .loaded, decision == .additionalUnits, !isReceiving, let locationID else {
            return false
        }
        switch plan {
        case .move(_, let from): return from != locationID
        case .add, .create: return quantity != nil
        }
    }

    public func receive() async {
        guard canReceive, let locationID else { return }
        let action: ReceivingAction
        switch plan {
        case .move(let entry, _):
            action = .move(entry: entry)
        case .add(let entry, let entryUnit):
            guard let quantity else { return }
            action = .add(entry: entry, amount: ReceivingAmount(value: quantity, unit: entryUnit))
        case .create:
            guard let quantity else { return }
            let trimmed = unit.trimmingCharacters(in: .whitespaces)
            action = .create(
                amount: ReceivingAmount(
                    value: quantity, unit: trimmed.isEmpty ? (snapshot?.defaultUnit ?? "") : trimmed))
        }
        isReceiving = true
        refusal = nil
        defer { isReceiving = false }
        do {
            try await service.receive(
                expenseID: expenseID, productID: productID, locationID: locationID, action: action)
            didReceive = true
        } catch {
            refusal = error.userMessage
        }
    }
}

extension CubbyClient: ReceivingService {
    public func receivingSnapshot(productID: ProductCode) async throws -> ReceivingSnapshot {
        async let context = inventoryReceivingContext(.init(productId: productID.rawValue))
        async let product = row(EntityCatalog[.product], id: productID.rawValue)
        let (loaded, productRow) = try await (context, product)
        return ReceivingSnapshot(
            productID: productID,
            productName: productRow?.title ?? productID.rawValue,
            stock: loaded.stock.map {
                ReceivingStock(
                    id: $0.id, locationID: $0.locationId, locationName: $0.locationName,
                    value: $0.amount.value, unit: $0.amount.unit)
            },
            matches: loaded.matches.map {
                ReceivingMatch(
                    candidateID: $0.candidate.id, candidateName: $0.candidate.name,
                    stockOnHand: $0.candidate.inventoryCount, evidence: $0.evidence, warnings: $0.warnings)
            },
            alreadyCounted: loaded.alreadyCounted, defaultQuantity: loaded.defaultQuantity,
            defaultUnit: loaded.defaultUnit, suggestedPlan: ReceivingPlan(loaded.suggestedPlan),
            locationPlans: Dictionary(
                loaded.locationPlans.map { ($0.locationId, ReceivingPlan($0.plan)) },
                uniquingKeysWith: { first, _ in first }))
    }

    public func receivingLocations() async throws -> [ReceivingLocation] {
        try await locationOptions(page: 1, pageSize: 200).items.map {
            ReceivingLocation(id: $0.id, name: $0.name, path: $0.parent?.name)
        }
    }

    public func receive(
        expenseID: String, productID: ProductCode, locationID: LocationCode, action: ReceivingAction
    ) async throws {
        let wire: InventoryReceiveExpenseInput.ActionPayload
        switch action {
        case .move(let entry):
            wire = .move(.init(kind: .move, entryId: entry))
        case .add(let entry, let amount):
            wire = .add(
                .init(kind: .add, entryId: entry, amount: .init(value: amount.value, unit: amount.unit)))
        case .create(let amount):
            wire = .create(.init(kind: .create, amount: .init(value: amount.value, unit: amount.unit)))
        }
        _ = try await receiveExpense(
            .init(expenseId: expenseID, expectedProductId: productID, locationId: locationID, action: wire))
    }
}

extension ReceivingPlan {
    init(_ wire: InventoryReceivingPlan) {
        switch wire {
        case .move(let move): self = .move(entry: move.entryId, from: move.fromLocationId)
        case .add(let add): self = .add(entry: add.entryId, unit: add.unit)
        case .create: self = .create
        }
    }
}
