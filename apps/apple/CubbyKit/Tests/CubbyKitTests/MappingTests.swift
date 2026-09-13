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

    @Test func dashboardCountsMapsUsdaFoodsToTheStableKey() throws {
        let out = try Fixtures.decode(DashboardCountsOut.self, from: "dashboard-counts.json")
        let counts = DashboardCounts(out)
        #expect(counts.count(for: .product) == 12)
        #expect(counts.count(for: .usdaFood) == 7)
        #expect(counts.count(for: .financialTransaction) == 30)
    }

    /// Regression for a mapper that hand-listed 17 keys and silently dropped `planting` and
    /// `gardenEntry` when those entities' routes shipped. Every `countable` `EntityKey` — driven
    /// by the generated catalog, not a hand-kept list here — must decode to a real count from the
    /// fixture; a future omission in either the fixture or `DashboardCounts.init` fails this.
    @Test func dashboardCountsCoversEveryCountableEntity() throws {
        let out = try Fixtures.decode(DashboardCountsOut.self, from: "dashboard-counts.json")
        let counts = DashboardCounts(out)
        for entity in EntityKey.allCases where EntityCatalog[entity].countable {
            #expect(
                counts.count(for: entity) != nil,
                "Countable entity \(entity.rawValue) has no dashboard count"
            )
        }
        #expect(counts.count(for: .planting) == 0)
        #expect(counts.count(for: .gardenEntry) == 0)
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
}
