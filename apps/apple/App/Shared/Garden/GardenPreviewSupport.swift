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

    /// The growing planting as the generic detail reads it (`EntityRow.raw`), for slot previews.
    static let growingPlantingRow: EntityRow = {
        let raw = (try? JSONValue(encoding: growingPlanting)) ?? .null
        return EntityCatalog[.planting].row(from: raw)
            ?? EntityRow(
                id: growingPlanting.id, title: growingPlanting.displayName, subtitle: nil,
                imageURL: nil, raw: raw)
    }()

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
}

/// An in-memory `GardenService` for previews: every call answers immediately from
/// `GardenPreviewFixtures`, and every write is a no-op success. Never used outside `#Preview`.
final class PreviewGardenService: GardenService {
    func gardenOverview() async throws -> GardenOverviewOut { GardenPreviewFixtures.overview }
    func gardenOptions(search: String?) async throws -> GardenOptions { GardenPreviewFixtures.options }
    func gardenGuides() async throws -> GardenGuidesDocument { GardenPreviewFixtures.guides }
    func startGardenPlanting(
        id: String, locationID: String, startedAt: Date, method: GardenStartMethod
    ) async throws {}
    func moveGardenPlanting(_ input: GardenMovePlantingInput) async throws {}
    func splitGardenPlanting(_ input: GardenSplitPlantingInput) async throws {}
    func finishGardenPlanting(id: String, finishedAt: Date, note: String?) async throws {}
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
}
