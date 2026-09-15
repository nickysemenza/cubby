import CubbyKit
import Foundation

/// Canned data for every `#Preview` in the Garden feature. Kept beside the views (rather than in
/// the shared `PreviewFixtures`) since Garden owns this whole directory; nothing here touches the
/// network — `PreviewGardenService` answers every call in-memory and instantly.
///
/// `nonisolated`: the app target is MainActor by default, but `PreviewGardenService` is a
/// `Sendable` service whose async members run off the main actor and read these statics.
nonisolated enum GardenPreviewFixtures {
    static let tomatoIngredient = GardenOption(id: "ING-1001", name: "Tomato", gardenGuideKey: "tomato")
    static let basilIngredient = GardenOption(id: "ING-1002", name: "Basil", gardenGuideKey: nil)
    static let bedLocation = GardenOption(id: "LOC-2001", name: "Raised bed A")
    static let trayLocation = GardenOption(id: "LOC-2002", name: "Seed tray 1")
    static let seedProduct = GardenProductOption(
        id: "PRD-3001", name: "Burpee tomato seeds", growsIngredientID: tomatoIngredient.id)

    static let growingPlanting = GardenPlanting(
        id: "PLT-4001", ingredient: tomatoIngredient,
        product: .init(id: seedProduct.id, name: seedProduct.name),
        location: bedLocation, status: .growing, variety: "San Marzano", quantity: "6 plants",
        sownAt: Calendar.current.date(byAdding: .day, value: -40, to: .now),
        transplantedAt: Calendar.current.date(byAdding: .day, value: -10, to: .now),
        displayName: "Tomato · San Marzano")

    static let plannedPlanting = GardenPlanting(
        id: "PLT-4002", ingredient: basilIngredient, intendedLocation: trayLocation, status: .planned,
        plannedWindow: "Early spring", displayName: "Basil")

    static let finishedPlanting = GardenPlanting(
        id: "PLT-4003", ingredient: tomatoIngredient, location: bedLocation, status: .finished,
        finishedAt: Calendar.current.date(byAdding: .day, value: -5, to: .now), displayName: "Tomato")

    static let anchorEntry = GardenEntry(
        id: "GDE-5001", locationID: bedLocation.id, plantingID: growingPlanting.id, kind: .observation,
        observedAt: Calendar.current.date(byAdding: .day, value: -10, to: .now) ?? .now,
        note: "Transplanted from the tray.", harvestAmount: nil, images: [],
        locationName: bedLocation.name, plantingName: growingPlanting.displayName,
        displayName: "Note · \(bedLocation.name)", anchorsPeriod: true)

    static let harvestEntry = GardenEntry(
        id: "GDE-5002", locationID: bedLocation.id, plantingID: growingPlanting.id, kind: .harvest,
        observedAt: Calendar.current.date(byAdding: .day, value: -2, to: .now) ?? .now,
        note: "First ripe ones of the season.", harvestAmount: "6 tomatoes", images: [],
        locationName: bedLocation.name, plantingName: growingPlanting.displayName,
        displayName: "Harvest · \(bedLocation.name)")

    static let overview = GardenOverview(
        locations: [
            GardenLocation(
                id: bedLocation.id, name: bedLocation.name, gardenKind: "bed", conditions: "Full sun",
                plantings: [growingPlanting]),
            GardenLocation(
                id: trayLocation.id, name: trayLocation.name, gardenKind: "tray", conditions: nil,
                plantings: []),
        ],
        finishedPlantings: [finishedPlanting],
        unassignedPlantings: [plannedPlanting]
    )

    static let options = GardenOptions(
        ingredients: [tomatoIngredient, basilIngredient],
        locations: [bedLocation, trayLocation],
        products: [seedProduct],
        plantings: [
            .init(id: growingPlanting.id, name: "\(growingPlanting.displayName) · \(bedLocation.name)")
        ]
    )

    static let guideSource = GardenGuideSource(
        id: "SRC-1", name: "Extension Office Planting Guide",
        url: URL(string: "https://example.invalid/guides/tomato")!, publishedOrRevised: "2024",
        reviewedAt: "2026-01-01", basedOn: ["USDA hardiness zone data"], notes: nil)

    static let guides = GardenGuidesDocument(
        schemaVersion: 1,
        sources: [guideSource],
        guides: [
            GardenGuide(
                key: "tomato", name: "Tomato",
                windows: [
                    GardenGuideWindow(
                        id: "tomato-0", sourceID: guideSource.id, microclimate: "full-sun",
                        method: "transplant",
                        months: [4, 5], monthPart: nil, note: "After the last frost.")
                ])
        ]
    )
}

/// An in-memory `GardenService` for previews: every call answers immediately from
/// `GardenPreviewFixtures`, and every write is a no-op success. Never used outside `#Preview`.
final class PreviewGardenService: GardenService {
    func gardenOverview() async throws -> GardenOverview { GardenPreviewFixtures.overview }
    func gardenOptions(search: String?) async throws -> GardenOptions { GardenPreviewFixtures.options }
    func gardenGuides() async throws -> GardenGuidesDocument { GardenPreviewFixtures.guides }
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
    func setGardenProduct(id: String, growsIngredientID: String?) async throws {}
    func setGardenIngredient(id: String, guideKey: String?) async throws {}
    func updateGardenPlanting(_ input: EditGardenPlanting) async throws {}
    func gardenEntries(
        locationID: String?, plantingID: String?, page: Int
    ) async throws -> (items: [GardenEntry], hasMore: Bool) {
        (items: [GardenPreviewFixtures.harvestEntry, GardenPreviewFixtures.anchorEntry], hasMore: false)
    }
    func gardenJournal(
        plantingID: String, includeBedContext: Bool, page: Int
    ) async throws -> (items: [GardenJournalEntry], hasMore: Bool) {
        (
            items: [
                GardenJournalEntry(
                    entry: GardenPreviewFixtures.harvestEntry, context: .direct,
                    locationName: GardenPreviewFixtures.bedLocation.name,
                    plantingName: GardenPreviewFixtures.growingPlanting.displayName),
                GardenJournalEntry(
                    entry: GardenPreviewFixtures.anchorEntry, context: .direct,
                    locationName: GardenPreviewFixtures.bedLocation.name,
                    plantingName: GardenPreviewFixtures.growingPlanting.displayName),
            ], hasMore: false
        )
    }
    func gardenLocationHistory(plantingID: String) async throws -> [GardenLocationPeriod] {
        [
            GardenLocationPeriod(
                sequence: 0, location: GardenPreviewFixtures.bedLocation,
                inLocationSince: Calendar.current.date(byAdding: .day, value: -10, to: .now) ?? .now,
                endedOn: nil, startKind: .actual)
        ]
    }
    func correctGardenLocationDates(
        plantingID: String, periods: [GardenLocationPeriod]
    ) async throws -> [GardenLocationPeriod] { periods }
    func updateGardenEntry(_ input: EditGardenEntry) async throws {}
}
