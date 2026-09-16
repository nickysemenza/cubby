import CubbyAPI
import Foundation

/// The garden workflows that stay explicit RPCs because a move, split, or finish must atomically
/// preserve historical entries; every other garden read and write is a generic resource
/// operation. `CubbyClient` gains this conformance at the generated OpenAPI boundary.
public protocol GardenService: Sendable {
    func gardenOverview() async throws -> GardenOverviewOut
    func gardenOptions(search: String?) async throws -> GardenOptions
    func gardenGuides() async throws -> GardenGuidesDocument
    func startGardenPlanting(
        id: String,
        locationID: String,
        startedAt: Date,
        method: GardenStartMethod
    ) async throws
    func moveGardenPlanting(_ input: GardenMovePlantingInput) async throws
    func splitGardenPlanting(_ input: GardenSplitPlantingInput) async throws
    func finishGardenPlanting(id: String, finishedAt: Date, note: String?) async throws
    func gardenLocationHistory(plantingID: String) async throws -> [GardenLocationPeriodOut]
    func correctGardenLocationDates(
        plantingID: String, periods: [GardenLocationPeriodOut]
    ) async throws -> [GardenLocationPeriodOut]
}
