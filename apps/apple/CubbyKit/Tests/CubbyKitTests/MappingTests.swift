import CubbyAPI
import Foundation
import Testing

@testable import CubbyKit

@Suite("Generated ↔ domain mapping")
struct MappingTests {
    private struct RelationshipDiscoveryFixture: Decodable {
        let exploration: Components.Schemas.EntityGraphExploreOutput
        let recommendations: Components.Schemas.EntityRecommendationsOut
        let inventoryRecommendations: Components.Schemas.EntityRecommendationsOut
        let productRecommendations: Components.Schemas.EntityRecommendationsOut
    }

    @Test func sharedRelationshipDiscoveryFixtureMapsAcrossGeneratedAndDomainModels() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let repoRoot =
            testFile
            .deletingLastPathComponent()  // CubbyKitTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // CubbyKit
            .deletingLastPathComponent()  // apple
            .deletingLastPathComponent()  // apps
            .deletingLastPathComponent()  // repository root
        let fixtureURL =
            repoRoot
            .appending(path: "packages/schemas/fixtures/relationship-discovery.json")
        let fixture = try JSONDecoder.cubby().decode(
            RelationshipDiscoveryFixture.self,
            from: Data(contentsOf: fixtureURL)
        )
        let root = EntityReference(entity: .expense, id: "EXP-4K7M")
        let graph = EntityGraph(root: root, output: fixture.exploration)
        let recommendations = EntityRecommendations(fixture.recommendations)
        let inventoryRecommendations = EntityRecommendations(fixture.inventoryRecommendations)
        let productRecommendations = EntityRecommendations(fixture.productRecommendations)

        let projectPath = try #require(
            graph.paths.first { $0.destination == EntityReference(entity: .project, id: "PRJ-7M4K") })
        #expect(projectPath.nodeReferences.count == 4)
        #expect(projectPath.edgeIDs.count == 3)
        #expect(graph.completion.requestedDepth == 3)
        #expect(graph.completion.reachedDepth == 3)

        guard case .expenseProject(_, _, let proposals) = try #require(recommendations.groups.first)
        else {
            Issue.record("Expected the shared fixture's expense-project recommendation")
            return
        }
        let proposal = try #require(proposals.first)
        #expect(proposal.target.id == "PRJ-7M4K")
        #expect(proposal.sameTradeCount == 2)
        #expect(proposal.exactProductCount == 1)
        #expect(proposal.supportingExpenses.map(\.id) == ["EXP-7M4K"])

        guard
            case .inventoryPlacement(let inventoryStatus, let currentLocation, let inventoryProposals) =
                try #require(inventoryRecommendations.groups.first)
        else {
            Issue.record("Expected the shared fixture's inventory-placement recommendation")
            return
        }
        #expect(inventoryStatus == .ready)
        #expect(currentLocation?.id == "LOC-4K7M")
        #expect(inventoryProposals.first?.target.id == "LOC-7M4K")

        guard
            case .productRelated(let productStatus, let productProposals) =
                try #require(productRecommendations.groups.first)
        else {
            Issue.record("Expected the shared fixture's product-related recommendation")
            return
        }
        #expect(productStatus == .unavailable)
        #expect(productProposals.first?.target.id == "PRD-7M4K")
        #expect(productProposals.first?.evidence.first?.signal == "Shared tags")
    }

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

    @Test func todayMealUsesTheServersDisplayName() throws {
        let page = try Fixtures.decode(Components.Schemas.MealListPage.self, from: "meals-today.json")
        let meal = try #require(page.items.first)
        let today = TodayMeal(meal)
        #expect(today.name == "Server meal label")
        #expect(today.mealKind == "cooked")
        #expect(today.recipeNames == ["Sample Recipe"])
    }

    @Test func mealNutritionPreservesMacroEstimateStatesAndFoodSources() throws {
        let out = try Fixtures.decode(MealNutritionOut.self, from: "meal-nutrition.json")
        let summary = MealNutritionSummary(out)
        let person = try #require(summary.people.first)
        let food = try #require(person.foods.first)

        #expect(summary.meals.first?.displayName == "Sample lunch")
        #expect(person.totals.calories == .partial(lower: 642, upper: nil))
        #expect(person.totals.protein == .complete(lower: 31.4, upper: nil))
        #expect(person.totals.carbs == .unavailable)
        #expect(person.totals.fat == .pending)
        #expect(person.meals.first?.meal.id == "MEL-2345")
        #expect(person.meals.first?.totals.calories == .partial(lower: 642, upper: nil))
        #expect(food.grams == 170)
        #expect(food.source == .product(id: "meal-food-preview-1", productID: "PRD-2345"))
        #expect(food.totals.fat == .unavailable)
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
