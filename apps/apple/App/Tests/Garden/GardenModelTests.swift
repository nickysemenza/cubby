import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Garden model")
struct GardenModelTests {
    /// `GardenRootView` and the planting guide slot it can push to share one `GardenModel` per
    /// service instance via `GardenModel.SharedStore` instead of each independently re-fetching
    /// the overview, options, and guides — see that type's doc comment for why an
    /// `.environment(_:)` value cannot do this across `SectionView`'s `.navigationDestination`.
    @Test func sharedStoreFetchesOptionsOnceAcrossTwoDependentScreens() async throws {
        let service = StubGardenService()

        // Screen 1 (e.g. `GardenRootView`): first to ask, so it actually loads.
        let first = GardenModel.SharedStore.model(for: service)
        await first.loadIfNeeded()

        // Screen 2 (the guide slot on a pushed planting detail): asks independently, but shares
        // the instance and must not re-fetch.
        let second = GardenModel.SharedStore.model(for: service)
        await second.loadIfNeeded()

        #expect(first === second)
        #expect(service.overviewCallCount == 1)
        #expect(service.optionsCallCount == 1)
        #expect(service.guidesCallCount == 1)
        #expect(second.phase == .loaded)
    }
}

/// A `GardenService` fake that counts calls and records writes; no network involved. `final class`
/// so `GardenModel.SharedStore` (keyed by `ObjectIdentifier`) can key off of it.
private final class StubGardenService: GardenService, @unchecked Sendable {
    var overview = GardenOverviewOut(locations: [], finished: [], unassigned: [])
    var options = GardenOptions(ingredients: [], locations: [], products: [])
    var guides = GardenGuidesDocument(schemaVersion: ._1, sources: [], guides: [])
    private(set) var overviewCallCount = 0
    private(set) var optionsCallCount = 0
    private(set) var guidesCallCount = 0

    func gardenOverview() async throws -> GardenOverviewOut {
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
    func startGardenPlanting(
        id: String, locationID: String, startedAt: Date, method: GardenStartMethod
    ) async throws {}
    func moveGardenPlanting(_ input: GardenMovePlantingInput) async throws {}
    func splitGardenPlanting(_ input: GardenSplitPlantingInput) async throws {}
    func finishGardenPlanting(id: String, finishedAt: Date, note: String?) async throws {}
    func gardenLocationHistory(plantingID: String) async throws -> [GardenLocationPeriodOut] { [] }
    func correctGardenLocationDates(
        plantingID: String, periods: [GardenLocationPeriodOut]
    ) async throws -> [GardenLocationPeriodOut] { periods }
}
