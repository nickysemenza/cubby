import CubbyAPI
import Foundation
import Testing

@testable import CubbyKit

@Suite("Generated ↔ domain mapping")
struct MappingTests {
    @Test func scanResponseMapsToScanResult() throws {
        let response = try Fixtures.decode(ScanOut.self, from: "scan-added.json")
        let result = ScanResult(response)
        #expect(result.outcome == .added)
        #expect(result.product.id == ProductCode("PRD-2345"))
        #expect(result.product.created)
        #expect(result.strays.isEmpty)
    }

    @Test func queuedScanCarriesStrays() throws {
        let response = try Fixtures.decode(ScanOut.self, from: "scan-queued.json")
        let result = ScanResult(response)
        #expect(result.outcome == .queued)
        #expect(!result.strays.isEmpty)
        let stray = try #require(result.strays.first)
        #expect(stray.locationId.rawValue.hasPrefix("LOC-"))
    }

    @Test func productGetMapsToSummary() throws {
        let response = try Fixtures.decode(ProductDetailOut.self, from: "product-get.json")
        let summary = ProductSummary(response)
        #expect(summary.id == ProductCode("PRD-2345"))
        #expect(summary.name == "Sample Product")
        #expect(summary.manufacturer == "Sample Manufacturer")
    }

    /// The `code` field is an anyOf/oneOf tower in the generated types; on the wire it must be the
    /// flat `{kind, value}` object the server expects.
    @Test func scanInputEncodesFlatCodeObject() throws {
        let input = ScanInput(location: LocationCode("LOC-2345"), code: .barcode("012345678905"))
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.cubby().encode(input))
        #expect(json["locationId"] == "LOC-2345")
        #expect(json["code"]?["kind"] == "barcode")
        #expect(json["code"]?["value"] == "012345678905")

        let product = ScanInput(location: LocationCode("LOC-2345"), code: .product(ProductCode("PRD-2345")))
        let productJSON = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.cubby().encode(product))
        #expect(productJSON["code"]?["kind"] == "product")
        #expect(productJSON["code"]?["value"] == "PRD-2345")
    }

    @Test func resolveStraysInputEncodesMoves() throws {
        let input = ResolveStraysInput(
            target: LocationCode("LOC-2345"),
            moves: [
                StrayMove(entryId: InventoryEntryCode("INV-2345")),
                StrayMove(entryId: InventoryEntryCode("INV-3456"), quantity: 2),
            ]
        )
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder.cubby().encode(input))
        #expect(json["targetLocationId"] == "LOC-2345")
        #expect(json["moves"]?[0]?["quantity"] == nil)
        #expect(json["moves"]?[1]?["quantity"]?["value"] == 2)
        #expect(json["moves"]?[1]?["quantity"]?["unit"] == "each")
    }

    /// Builds a `DashboardCountsOut` payload from the generated catalog instead of a hand-typed
    /// fixture, so the countable-entity list here can never drift from `EntityCatalog`. Each
    /// countable entity gets a distinct synthetic count (`100 + index`); `usdaFoods` — the one
    /// key in the payload that is NOT an `EntityKey.rawValue` — gets its own sentinel, since
    /// `DashboardCounts.init` maps it to `.usdaFood` by hand rather than through the catalog loop.
    private static func syntheticDashboardCountsPayload() -> (
        json: Data, expected: [EntityKey: Int], usdaFoodsCount: Int
    ) {
        let countable = EntityCatalog.all.filter(\.countable)
        var json: [String: Int] = [:]
        var expected: [EntityKey: Int] = [:]
        for (index, descriptor) in countable.enumerated() {
            let count = 100 + index
            json[descriptor.key.rawValue] = count
            expected[descriptor.key] = count
        }
        let usdaFoodsCount = 42
        json["usdaFoods"] = usdaFoodsCount
        let data = try! JSONSerialization.data(withJSONObject: json)
        return (data, expected, usdaFoodsCount)
    }

    @Test func dashboardCountsMapsUsdaFoodsToTheStableKey() throws {
        let (json, _, usdaFoodsCount) = Self.syntheticDashboardCountsPayload()
        let out = try JSONDecoder.cubby().decode(DashboardCountsOut.self, from: json)
        let counts = DashboardCounts(out)
        #expect(counts.count(for: .usdaFood) == usdaFoodsCount)
    }

    /// Regression for a mapper that hand-listed 17 keys and silently dropped `planting` and
    /// `gardenEntry` when those entities' routes shipped. Every `countable` `EntityKey` — driven
    /// by the generated catalog, not a hand-kept list here — must decode to its synthetic count;
    /// a future omission in `DashboardCounts.init` fails this.
    @Test func dashboardCountsCoversEveryCountableEntity() throws {
        let (json, expected, usdaFoodsCount) = Self.syntheticDashboardCountsPayload()
        let out = try JSONDecoder.cubby().decode(DashboardCountsOut.self, from: json)
        let counts = DashboardCounts(out)
        for (entity, expectedCount) in expected {
            #expect(
                counts.count(for: entity) == expectedCount,
                "Countable entity \(entity.rawValue) has the wrong dashboard count"
            )
        }
        #expect(counts.count(for: .usdaFood) == usdaFoodsCount)
    }

    @Test func todayBriefingMapsNextTasks() throws {
        let out = try Fixtures.decode(TodayBriefingOut.self, from: "today-briefing.json")
        let tasks = out.next.map(TodayTask.init)
        #expect(tasks.count == 2)
        #expect(tasks[0].id == "TSK-2345")
        #expect(tasks[0].projectName == "Sample Project")
        #expect(tasks[1].projectId == nil)
    }

    /// `MealOut.name` is optional; a nameless meal falls back to the capitalised meal type.
    @Test func todayMealFallsBackToTheCapitalisedMealTypeWhenNameless() throws {
        let page = try Fixtures.decode(Components.Schemas.MealListPage.self, from: "meals-today.json")
        let meal = try #require(page.items.first)
        let today = TodayMeal(meal)
        #expect(today.name == "Dinner")
        #expect(today.mealKind == "cooked")
        #expect(today.recipeNames == ["Sample Recipe"])
    }

    /// `UploadInput.init(entity:)` derives `entityType` from `EntityKey.rawValue.uppercased()`
    /// instead of hand-listing cases, so every case of the generated `EntityImage` enum must be
    /// reachable from some `EntityKey`. Regression for a hand-listed switch that silently
    /// dropped a newly added case (e.g. `gardenEntry`) when the OpenAPI enum grew.
    @Test func uploadInputEntityTypeCoversEveryEntityImageCase() throws {
        for imageCase in Components.Schemas.EntityImage.allCases {
            let entity = try #require(
                EntityKey.allCases.first { $0.rawValue.uppercased() == imageCase.rawValue },
                "No EntityKey maps to EntityImage case \(imageCase.rawValue)"
            )
            let input = UploadInput(filename: "photo.jpg", size: 10, format: .jpeg, entity: entity)
            #expect(input.entityType == imageCase)
        }
    }

    /// An entity outside `EntityImage`'s enum (e.g. `vendor`) uploads untyped: `entityType` is
    /// `nil`, matching the old hand-listed switch's `default: break` semantics.
    @Test func uploadInputEntityTypeIsNilOutsideEntityImage() throws {
        let input = UploadInput(filename: "photo.jpg", size: 10, format: .jpeg, entity: .vendor)
        #expect(input.entityType == nil)
    }

    /// The server's `"<crop name>[ · <variety>]"` display name (`docs/terminology.md` § Garden)
    /// maps straight through rather than being recomputed on-device.
    @Test func gardenPlantingMapsDisplayName() throws {
        let out = GardenPlantingOut(
            id: "PLT-2345", ingredientId: "ING-2345", status: .growing, displayName: "Tomato · San Marzano",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000), ingredientName: "Tomato")
        #expect(GardenPlanting(out).displayName == "Tomato · San Marzano")
    }

    /// A `move` entry, and the anchor entry `startPlanting` writes when a planting first enters a
    /// location, carry `anchorsPeriod: true` so clients lock their structural fields
    /// (`docs/terminology.md` § Garden); the display name maps straight through too.
    @Test func gardenEntryMapsAnchorsPeriodAndDisplayName() throws {
        let anchor = GardenEntryOut(
            id: "GDE-2345", locationId: "LOC-2345", kind: .observation, observedOn: "2026-01-15",
            images: [], displayName: "Note · Jan 15 · Raised bed A",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000), locationName: "Raised bed A",
            anchorsPeriod: true)
        let mappedAnchor = GardenEntry(anchor)
        #expect(mappedAnchor.anchorsPeriod)
        #expect(mappedAnchor.displayName == "Note · Jan 15 · Raised bed A")

        let ordinary = GardenEntryOut(
            id: "GDE-3456", locationId: "LOC-2345", kind: .harvest, observedOn: "2026-01-16",
            images: [], displayName: "Harvest · Jan 16 · Raised bed A",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000), locationName: "Raised bed A",
            anchorsPeriod: false)
        #expect(!GardenEntry(ordinary).anchorsPeriod)
    }
}
