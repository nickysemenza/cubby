import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Garden model")
struct GardenModelTests {
    /// `GardenRootView` and any route it can push to (`GardenPlantingRouteView`,
    /// `GardenEntryRouteView`, `GardenBedJournalView`) share one `GardenModel` per service
    /// instance via `GardenModel.SharedStore` instead of each independently re-fetching the
    /// overview, options, and guides — see that type's doc comment for why an `.environment(_:)`
    /// value cannot do this across `SectionView`'s `.navigationDestination`.
    @Test func sharedStoreFetchesOptionsOnceAcrossTwoDependentScreens() async throws {
        let service = StubGardenService()

        // Screen 1 (e.g. `GardenRootView`): first to ask, so it actually loads.
        let first = GardenModel.SharedStore.model(for: service)
        await first.loadIfNeeded()

        // Screen 2 (e.g. a planting pushed via `Route`): asks independently, but shares the
        // instance and must not re-fetch.
        let second = GardenModel.SharedStore.model(for: service)
        await second.loadIfNeeded()

        #expect(first === second)
        #expect(service.overviewCallCount == 1)
        #expect(service.optionsCallCount == 1)
        #expect(service.guidesCallCount == 1)
        #expect(second.phase == .loaded)
    }

    @Test func rememberSourceWritesBackOnlyWhenToggledAndDiffering() async throws {
        let service = StubGardenService()
        service.options = GardenOptions(
            ingredients: [.init(id: "ING-1", name: "Tomato")], locations: [.init(id: "LOC-1", name: "Bed")],
            products: [.init(id: "PRD-1", name: "Seeds", growsIngredientID: nil)]
        )
        let model = GardenModel(service: service)
        await model.load()

        let input = CreateGardenPlanting(
            ingredientID: "ING-1", locationID: "LOC-1", productID: "PRD-1", status: .growing)

        // Toggle off: never writes back, even though the association differs.
        _ = await model.create(input, rememberSource: false)
        #expect(service.setProductCalls.isEmpty)

        // Toggle on, and the product's current association (nil) differs from this crop: writes.
        _ = await model.create(input, rememberSource: true)
        #expect(service.setProductCalls.count == 1)
        #expect(service.setProductCalls.first?.id == "PRD-1")
        #expect(service.setProductCalls.first?.growsIngredientID == "ING-1")

        // The product now already grows this crop: toggling on again must not write again.
        service.options = GardenOptions(
            ingredients: [.init(id: "ING-1", name: "Tomato")], locations: [.init(id: "LOC-1", name: "Bed")],
            products: [.init(id: "PRD-1", name: "Seeds", growsIngredientID: "ING-1")]
        )
        _ = await model.create(input, rememberSource: true)
        #expect(service.setProductCalls.count == 1)
    }
}

/// A `GardenService` fake that counts calls and records writes; no network involved. `final class`
/// so `GardenModel.SharedStore` (keyed by `ObjectIdentifier`) can key off of it.
private final class StubGardenService: GardenService, @unchecked Sendable {
    var overview = GardenOverview(locations: [], finishedPlantings: [])
    var options = GardenOptions(ingredients: [], locations: [], products: [])
    var guides = GardenGuidesDocument(schemaVersion: 1, sources: [], guides: [])
    private(set) var overviewCallCount = 0
    private(set) var optionsCallCount = 0
    private(set) var guidesCallCount = 0
    private(set) var setProductCalls: [(id: String, growsIngredientID: String?)] = []

    func gardenOverview() async throws -> GardenOverview {
        overviewCallCount += 1
        return overview
    }
    func gardenOptions(search: String?) async throws -> GardenOptions {
        optionsCallCount += 1
        return options
    }
    func gardenGuides() async throws -> GardenGuidesDocument {
        guidesCallCount += 1
        return guides
    }
    func createGardenPlanting(_ input: CreateGardenPlanting) async throws {}
    func recordGardenEntry(_ input: RecordGardenEntry) async throws {}
    func startGardenPlanting(
        id: String, locationID: String, startedAt: Date, method: GardenStartMethod
    ) async throws {}
    func moveGardenPlanting(_ input: MoveGardenPlanting) async throws {}
    func splitGardenPlanting(_ input: SplitGardenPlanting) async throws {}
    func finishGardenPlanting(id: String, finishedAt: Date, note: String?) async throws {}
    func createGardenLocation(name: String, kind: GardenLocationKind, conditions: String?) async throws {}
    func updateGardenLocation(
        id: String, name: String?, kind: GardenLocationKind?, conditions: String?
    ) async throws {}
    func setGardenProduct(id: String, growsIngredientID: String?) async throws {
        setProductCalls.append((id: id, growsIngredientID: growsIngredientID))
    }
    func setGardenIngredient(id: String, guideKey: String?) async throws {}
    func updateGardenPlanting(_ input: EditGardenPlanting) async throws {}
    func gardenEntries(
        locationID: String?, plantingID: String?, page: Int
    ) async throws -> (items: [GardenEntry], hasMore: Bool) { (items: [], hasMore: false) }
    func gardenJournal(
        plantingID: String, includeBedContext: Bool, page: Int
    ) async throws -> (items: [GardenJournalEntry], hasMore: Bool) { (items: [], hasMore: false) }
    func gardenLocationHistory(plantingID: String) async throws -> [GardenLocationPeriod] { [] }
    func correctGardenLocationDates(
        plantingID: String, periods: [GardenLocationPeriod]
    ) async throws -> [GardenLocationPeriod] { periods }
    func updateGardenEntry(_ input: EditGardenEntry) async throws {}
}
