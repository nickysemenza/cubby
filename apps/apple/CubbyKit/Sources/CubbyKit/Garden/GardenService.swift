import Foundation

/// Garden workflows remain explicit because moves and splits must atomically preserve historical
/// entries. `CubbyClient` gains this conformance at the generated OpenAPI boundary.
public protocol GardenService: Sendable {
    func gardenOverview() async throws -> GardenOverview
    func gardenOptions(search: String?) async throws -> GardenOptions
    func gardenGuides() async throws -> GardenGuidesDocument
    func createGardenPlanting(_ input: CreateGardenPlanting) async throws
    func recordGardenEntry(_ input: RecordGardenEntry) async throws
    func startGardenPlanting(
        id: String,
        locationID: String,
        startedAt: Date,
        method: GardenStartMethod
    ) async throws
    func moveGardenPlanting(_ input: MoveGardenPlanting) async throws
    func splitGardenPlanting(_ input: SplitGardenPlanting) async throws
    func finishGardenPlanting(id: String, finishedAt: Date, note: String?) async throws
    func createGardenLocation(name: String, kind: GardenLocationKind, conditions: String?) async throws
    func updateGardenLocation(
        id: String, name: String?, kind: GardenLocationKind?, conditions: String?
    ) async throws
    func setGardenProduct(id: String, growsIngredientID: String?) async throws
    func setGardenIngredient(id: String, guideKey: String?) async throws
    func updateGardenPlanting(_ input: EditGardenPlanting) async throws
    func gardenEntries(locationID: String?, plantingID: String?, page: Int) async throws -> (
        items: [GardenEntry], hasMore: Bool
    )
    func gardenJournal(
        plantingID: String, includeBedContext: Bool, page: Int
    ) async throws -> (items: [GardenJournalEntry], hasMore: Bool)
    func gardenLocationHistory(plantingID: String) async throws -> [GardenLocationPeriod]
    func correctGardenLocationDates(
        plantingID: String, periods: [GardenLocationPeriod]
    ) async throws -> [GardenLocationPeriod]
    func updateGardenEntry(_ input: EditGardenEntry) async throws
}
