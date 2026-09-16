import CubbyKit
import Foundation

/// Canned data for every `#Preview` in the Garden feature. Kept beside the views (rather than in
/// the shared `PreviewFixtures`) since Garden owns this whole directory; nothing here touches the
/// network — `PreviewGardenService` answers every call in-memory and instantly. The wire shapes
/// are decoded from JSON exactly as the generated client would decode them.
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

    private static func day(_ offset: Int) -> String {
        PlainDate(Calendar.current.date(byAdding: .day, value: offset, to: .now) ?? .now).rawValue
    }

    private static func planting(
        id: String, ingredient: GardenOption, status: String, product: GardenProductOption? = nil,
        location: GardenOption? = nil, intended: GardenOption? = nil, variety: String? = nil,
        quantity: String? = nil, plannedWindow: String? = nil, sowedOn: String? = nil,
        transplantedOn: String? = nil, finishedOn: String? = nil, displayName: String
    ) -> GardenPlantingOut {
        PreviewFixtures.decode(
            """
            {"id": "\(id)", "ingredientId": "\(ingredient.id)", "ingredientName": "\(ingredient.name)",
             "gardenGuideKey": \(ingredient.gardenGuideKey.map { "\"\($0)\"" } ?? "null"),
             "sourceProductId": \(product.map { "\"\($0.id)\"" } ?? "null"),
             "sourceProductName": \(product.map { "\"\($0.name)\"" } ?? "null"),
             "locationId": \(location.map { "\"\($0.id)\"" } ?? "null"),
             "locationName": \(location.map { "\"\($0.name)\"" } ?? "null"),
             "intendedLocationId": \(intended.map { "\"\($0.id)\"" } ?? "null"),
             "intendedLocationName": \(intended.map { "\"\($0.name)\"" } ?? "null"),
             "parentPlantingId": null, "status": "\(status)",
             "variety": \(variety.map { "\"\($0)\"" } ?? "null"), "quantity": \(quantity.map { "\"\($0)\"" } ?? "null"),
             "notes": null, "plannedWindow": \(plannedWindow.map { "\"\($0)\"" } ?? "null"), "plannedDate": null,
             "sowedOn": \(sowedOn.map { "\"\($0)\"" } ?? "null"),
             "transplantedOn": \(transplantedOn.map { "\"\($0)\"" } ?? "null"),
             "finishedOn": \(finishedOn.map { "\"\($0)\"" } ?? "null"),
             "displayName": "\(displayName)",
             "createdAt": "2026-03-01T10:00:00.000Z", "updatedAt": "2026-03-01T10:00:00.000Z"}
            """)
    }

    static let growingPlanting = planting(
        id: "PLT-4001", ingredient: tomatoIngredient, status: "growing", product: seedProduct,
        location: bedLocation, variety: "San Marzano", quantity: "6 plants", sowedOn: day(-40),
        transplantedOn: day(-10), displayName: "Tomato · San Marzano")

    static let plannedPlanting = planting(
        id: "PLT-4002", ingredient: basilIngredient, status: "planned", intended: trayLocation,
        plannedWindow: "Early spring", displayName: "Basil")

    static let finishedPlanting = planting(
        id: "PLT-4003", ingredient: tomatoIngredient, status: "finished", location: bedLocation,
        finishedOn: day(-5), displayName: "Tomato")

    private static func entry(
        id: String, kind: String, observedOn: String, note: String, harvestAmount: String? = nil,
        displayName: String, anchorsPeriod: Bool = false
    ) -> GardenEntryOut {
        PreviewFixtures.decode(
            """
            {"id": "\(id)", "locationId": "\(bedLocation.id)", "plantingId": "\(growingPlanting.id)",
             "kind": "\(kind)", "observedOn": "\(observedOn)", "note": "\(note)",
             "harvestAmount": \(harvestAmount.map { "\"\($0)\"" } ?? "null"), "images": [],
             "displayName": "\(displayName)", "createdAt": "2026-03-01T10:00:00.000Z",
             "updatedAt": "2026-03-01T10:00:00.000Z", "locationName": "\(bedLocation.name)",
             "plantingName": "\(growingPlanting.displayName)", "anchorsPeriod": \(anchorsPeriod)}
            """)
    }

    static let anchorEntry = entry(
        id: "GDE-5001", kind: "observation", observedOn: day(-10), note: "Transplanted from the tray.",
        displayName: "Note · \(bedLocation.name)", anchorsPeriod: true)

    static let harvestEntry = entry(
        id: "GDE-5002", kind: "harvest", observedOn: day(-2), note: "First ripe ones of the season.",
        harvestAmount: "6 tomatoes", displayName: "Harvest · \(bedLocation.name)")

    static let overview = GardenOverviewOut(
        locations: [
            GardenLocationSummaryOut(
                id: LocationCode(bedLocation.id), name: bedLocation.name, gardenKind: .bed,
                gardenConditions: "Full sun", plantings: [growingPlanting]),
            GardenLocationSummaryOut(
                id: LocationCode(trayLocation.id), name: trayLocation.name, gardenKind: .tray,
                gardenConditions: nil, plantings: []),
        ],
        finished: [finishedPlanting],
        unassigned: [plannedPlanting]
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
        url: "https://example.invalid/guides/tomato", publishedOrRevised: "2024",
        reviewedAt: "2026-01-01", basedOn: ["USDA hardiness zone data"], notes: nil)

    static let guides = GardenGuidesDocument(
        schemaVersion: ._1,
        sources: [guideSource],
        guides: [
            GardenGuide(
                key: "tomato", name: "Tomato", aliases: [],
                windows: [
                    GardenGuideWindow(
                        sourceId: guideSource.id, microclimate: .sunny, method: .transplant,
                        months: [4, 5], monthPart: nil, notes: "After the last frost.")
                ], notes: nil)
        ]
    )

    static let journal: [GardenJournalEntryOut] = [harvestEntry, anchorEntry].map { entry in
        PreviewFixtures.decode(
            """
            {"id": "\(entry.id)", "locationId": "\(entry.locationId.rawValue)", "plantingId": "\(entry.plantingId ?? "")",
             "kind": "\(entry.kind.rawValue)", "observedOn": "\(entry.observedOn.rawValue)",
             "note": \(entry.note.map { "\"\($0)\"" } ?? "null"),
             "harvestAmount": \(entry.harvestAmount.map { "\"\($0)\"" } ?? "null"), "images": [],
             "displayName": "\(entry.displayName)", "createdAt": "2026-03-01T10:00:00.000Z",
             "updatedAt": "2026-03-01T10:00:00.000Z", "locationName": "\(entry.locationName)",
             "plantingName": \(entry.plantingName.map { "\"\($0)\"" } ?? "null"),
             "anchorsPeriod": \(entry.anchorsPeriod), "context": "direct"}
            """)
    }
}

/// An in-memory `GardenService` for previews: every call answers immediately from
/// `GardenPreviewFixtures`, and every write is a no-op success. Never used outside `#Preview`.
final class PreviewGardenService: GardenService {
    func gardenOverview() async throws -> GardenOverviewOut { GardenPreviewFixtures.overview }
    func gardenOptions(search: String?) async throws -> GardenOptions { GardenPreviewFixtures.options }
    func gardenGuides() async throws -> GardenGuidesDocument { GardenPreviewFixtures.guides }
    func createGardenPlanting(_ input: GardenCreatePlantingInput) async throws {}
    func recordGardenEntry(_ input: GardenRecordEntryInput) async throws {}
    func startGardenPlanting(
        id: String, locationID: String, startedAt: Date, method: GardenStartMethod
    ) async throws {}
    func moveGardenPlanting(_ input: GardenMovePlantingInput) async throws {}
    func splitGardenPlanting(_ input: GardenSplitPlantingInput) async throws {}
    func finishGardenPlanting(id: String, finishedAt: Date, note: String?) async throws {}
    func createGardenLocation(name: String, kind: GardenLocationKind, conditions: String?) async throws {}
    func updateGardenLocation(
        id: String, name: String?, kind: GardenLocationKind?, conditions: String?
    ) async throws {}
    func setGardenProduct(id: String, growsIngredientID: String?) async throws {}
    func setGardenIngredient(id: String, guideKey: String?) async throws {}
    func updateGardenPlanting(id: String, _ data: PlantingUpdateData) async throws {}
    func gardenEntries(
        locationID: String?, plantingID: String?, page: Int
    ) async throws -> (items: [GardenEntryOut], hasMore: Bool) {
        (items: [GardenPreviewFixtures.harvestEntry, GardenPreviewFixtures.anchorEntry], hasMore: false)
    }
    func gardenJournal(
        plantingID: String, includeBedContext: Bool, page: Int
    ) async throws -> (items: [GardenJournalEntryOut], hasMore: Bool) {
        (items: GardenPreviewFixtures.journal, hasMore: false)
    }
    func gardenLocationHistory(plantingID: String) async throws -> [GardenLocationPeriodOut] {
        [
            GardenLocationPeriodOut(
                sequence: 0, locationId: LocationCode(GardenPreviewFixtures.bedLocation.id),
                locationName: GardenPreviewFixtures.bedLocation.name,
                inLocationSince: PlainDate(
                    Calendar.current.date(byAdding: .day, value: -10, to: .now) ?? .now),
                endedOn: nil, startKind: .actual)
        ]
    }
    func correctGardenLocationDates(
        plantingID: String, periods: [GardenLocationPeriodOut]
    ) async throws -> [GardenLocationPeriodOut] { periods }
    func updateGardenEntry(id: String, _ data: GardenEntryUpdateData) async throws {}
}
