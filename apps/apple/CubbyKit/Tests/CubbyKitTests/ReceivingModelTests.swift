import CubbyAPISupport
import Foundation
import Testing

@testable import CubbyKit

/// Receiving never changes stock by default: a Product the server reports as already counted opens
/// on "Nothing new arrived", and units are only written after "Additional units arrived" plus a typed
/// positive quantity and a location. Which Products are counted, the prefill, the unit, and the
/// move/add/create plan are the server's (`inventory.receivingContext`, tested in
/// `receiving-guidance.unit.test.ts`); these tests pin that the model renders them as given.
@Suite("receivingModel")
@MainActor
struct ReceivingModelTests {
    final class FakeService: ReceivingService, @unchecked Sendable {
        // Only touched from the @MainActor test bodies, one await at a time.
        var snapshot: ReceivingSnapshot
        var failure: Error?
        private(set) var received: [(String, LocationCode, ReceivingAction)] = []

        init(snapshot: ReceivingSnapshot) { self.snapshot = snapshot }

        func receivingSnapshot(productID: ProductCode) async throws -> ReceivingSnapshot { snapshot }
        func receivingLocations() async throws -> [ReceivingLocation] {
            [
                ReceivingLocation(id: ReceivingModelTests.pantry, name: "Pantry", path: nil),
                ReceivingLocation(id: ReceivingModelTests.garage, name: "Garage", path: nil),
            ]
        }
        func receive(
            expenseID: String, productID: ProductCode, locationID: LocationCode, action: ReceivingAction
        ) async throws {
            if let failure { throw failure }
            received.append((expenseID, locationID, action))
        }
    }

    struct Refusal: Error, LocalizedError {
        var errorDescription: String? {
            "CONSTRAINT_VIOLATION: This Product is already stocked here; review and choose Add to count."
        }
    }

    struct LoadFailing: ReceivingService {
        func receivingSnapshot(productID: ProductCode) async throws -> ReceivingSnapshot { throw Refusal() }
        func receivingLocations() async throws -> [ReceivingLocation] { [] }
        func receive(
            expenseID: String, productID: ProductCode, locationID: LocationCode, action: ReceivingAction
        )
            async throws
        {}
    }

    nonisolated static let pantry = LocationCode("LOC-AAAA")
    nonisolated static let garage = LocationCode("LOC-BBBB")

    static func snapshot(
        stock: [ReceivingStock] = [], matches: [ReceivingMatch] = [], alreadyCounted: Bool = false,
        suggestedPlan: ReceivingPlan = .create, locationPlans: [LocationCode: ReceivingPlan] = [:]
    ) -> ReceivingSnapshot {
        ReceivingSnapshot(
            productID: ProductCode("PRD-4K7M"), productName: "Sample flour", stock: stock,
            matches: matches, alreadyCounted: alreadyCounted, defaultQuantity: alreadyCounted ? nil : 1,
            defaultUnit: "each", suggestedPlan: suggestedPlan, locationPlans: locationPlans)
    }

    static let pantryStock = ReceivingStock(
        id: InventoryEntryCode("INV-1111"), locationID: pantry, locationName: "Pantry", value: 2, unit: "each"
    )

    static let stockedMatch = ReceivingMatch(
        candidateID: ProductCode("PRD-9ZZZ"), candidateName: "Flour 5 lb", stockOnHand: 3,
        evidence: "same GTIN", warnings: ["Both sides are stocked; merging sums them."])

    func loaded(_ snapshot: ReceivingSnapshot, service: FakeService? = nil) async -> (
        ReceivingModel, FakeService
    ) {
        let fake = service ?? FakeService(snapshot: snapshot)
        let model = ReceivingModel(expenseID: "EXP-1", productID: snapshot.productID, service: fake)
        await model.load()
        return (model, fake)
    }

    @Test func existingStockDefaultsToNothingNewAndBlocksReceiving() async {
        let (model, fake) = await loaded(Self.snapshot(stock: [Self.pantryStock], alreadyCounted: true))
        #expect(model.alreadyCounted)
        #expect(model.decision == .nothingNew)
        model.locationID = Self.garage
        model.quantityText = "1"
        #expect(!model.canReceive)
        await model.receive()
        #expect(fake.received.isEmpty)
    }

    @Test func stockedMatchAloneAlsoDefaultsToNothingNew() async {
        let (model, _) = await loaded(
            Self.snapshot(matches: [Self.stockedMatch], alreadyCounted: true))
        #expect(model.decision == .nothingNew)
        #expect(model.stockedMatches.map(\.candidateName) == ["Flour 5 lb"])
        #expect(model.stockedMatches[0].noticeTitle == "This may already be counted as Flour 5 lb")
        #expect(model.stockedMatches[0].warnings == ["Both sides are stocked; merging sums them."])
    }

    @Test func serverVerdictDecidesCountedNotTheClient() async {
        let unstocked = ReceivingMatch(
            candidateID: ProductCode("PRD-8YYY"), candidateName: "Bagged flour", stockOnHand: 0,
            evidence: nil, warnings: [])
        let (model, _) = await loaded(Self.snapshot(matches: [unstocked]))
        #expect(!model.alreadyCounted)
        #expect(model.decision == .additionalUnits)
    }

    @Test func additionalUnitsNeedAnExplicitPositiveQuantityAndLocation() async {
        let (model, fake) = await loaded(Self.snapshot(stock: [Self.pantryStock], alreadyCounted: true))
        model.chooseAdditionalUnits()
        #expect(model.quantityText.isEmpty)
        model.locationID = Self.pantry
        #expect(!model.canReceive)
        for bad in ["0", "-1", "abc", "nan", "inf"] {
            model.quantityText = bad
            #expect(!model.canReceive, "\(bad) must not enable receiving")
        }
        model.quantityText = "2"
        model.locationID = nil
        #expect(!model.canReceive)
        model.locationID = Self.pantry
        #expect(model.canReceive)
        #expect(fake.received.isEmpty)
    }

    @Test func entryAtChosenLocationAddsInItsUnit() async {
        let (model, fake) = await loaded(
            Self.snapshot(
                stock: [Self.pantryStock], alreadyCounted: true,
                locationPlans: [Self.pantry: .add(entry: Self.pantryStock.id, unit: "each")]))
        model.chooseAdditionalUnits()
        model.locationID = Self.pantry
        model.quantityText = "1.5"
        #expect(model.plan == .add(entry: Self.pantryStock.id, unit: "each"))
        await model.receive()
        #expect(model.didReceive)
        #expect(fake.received.count == 1)
        #expect(
            fake.received[0].2
                == .add(entry: Self.pantryStock.id, amount: ReceivingAmount(value: 1.5, unit: "each")))
    }

    @Test func otherLocationCreatesWithTypedUnit() async {
        let (model, fake) = await loaded(
            Self.snapshot(
                stock: [Self.pantryStock], alreadyCounted: true,
                locationPlans: [Self.pantry: .add(entry: Self.pantryStock.id, unit: "each")]))
        model.chooseAdditionalUnits()
        model.locationID = Self.garage
        model.quantityText = "4"
        model.unit = "bag"
        #expect(model.plan == .create)
        await model.receive()
        #expect(fake.received[0].2 == .create(amount: ReceivingAmount(value: 4, unit: "bag")))
    }

    @Test func uniqueItemAlreadyStockedMovesAndNeedsADifferentLocation() async {
        let move = ReceivingPlan.move(entry: Self.pantryStock.id, from: Self.pantry)
        let (model, fake) = await loaded(
            Self.snapshot(stock: [Self.pantryStock], alreadyCounted: true, suggestedPlan: move))
        model.chooseAdditionalUnits()
        #expect(model.plan == move)
        model.locationID = Self.pantry
        #expect(!model.canReceive)
        model.locationID = Self.garage
        #expect(model.canReceive)
        await model.receive()
        #expect(fake.received[0].2 == .move(entry: Self.pantryStock.id))
    }

    @Test func freshProductDefaultsToOneUnitButStillNeedsLocation() async {
        let (model, _) = await loaded(Self.snapshot())
        #expect(model.decision == .additionalUnits)
        #expect(model.quantityText == "1")
        #expect(model.unit == "each")
        #expect(!model.canReceive)
        model.locationID = Self.garage
        #expect(model.canReceive)
    }

    @Test func serverRefusalIsShownVerbatimAndNothingIsMarkedReceived() async {
        let service = FakeService(snapshot: Self.snapshot())
        service.failure = Refusal()
        let (model, _) = await loaded(service.snapshot, service: service)
        model.locationID = Self.pantry
        await model.receive()
        #expect(!model.didReceive)
        #expect(
            model.refusal
                == "CONSTRAINT_VIOLATION: This Product is already stocked here; review and choose Add to count."
        )
        #expect(model.canReceive)
    }

    @Test func loadFailureSurfacesTheRawError() async {
        let model = ReceivingModel(
            expenseID: "EXP-1", productID: ProductCode("PRD-4K7M"), service: LoadFailing())
        await model.load()
        #expect(
            model.phase
                == .failed(
                    "CONSTRAINT_VIOLATION: This Product is already stocked here; review and choose Add to count."
                ))
    }
}
