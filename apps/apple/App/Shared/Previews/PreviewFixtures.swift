import CoreGraphics
import CubbyKit
import Foundation
import SwiftUI

/// Models and sample data for `#Preview` blocks. Nothing here touches the Keychain or the
/// network: the token store is in-memory and the base URL points at a host that does not exist.
enum PreviewFixtures {
    static let previewURL = URL(string: "http://cubby.preview.invalid")!

    /// A wire-shaped fixture, decoded exactly as the generated client decodes a response. A
    /// fixture that fails to decode is a programming error in the preview, not a runtime state.
    nonisolated static func decode<T: Decodable>(_ json: String) -> T {
        do {
            return try JSONDecoder.cubby().decode(T.self, from: Data(json.utf8))
        } catch {
            fatalError("Preview fixture does not decode as \(T.self): \(error)")
        }
    }

    static func signedOutModel() -> AppModel {
        AppModel.preview(signedIn: false, baseURL: previewURL)
    }

    static func signedInModel() -> AppModel {
        AppModel.preview(signedIn: true, baseURL: previewURL)
    }

    static let sampleLocation = LocationCode("LOC-2345")

    static let sampleRows: [EntityRow] = [
        EntityRow(
            id: "PRD-2345", title: "Sample Product", subtitle: "Sample Manufacturer", imageURL: nil,
            raw: .object([:])),
        EntityRow(id: "PRD-3456", title: "Another Product", subtitle: nil, imageURL: nil, raw: .object([:])),
    ]

    /// A product-shaped detail row for `EntityDetailView`'s preview: enough fields to exercise
    /// every `EntityFieldValue.text` branch (string, date, boolean, array) without a network call.
    static let sampleDetailRow = EntityRow(
        id: "PRD-2345",
        title: "Cast Iron Skillet",
        subtitle: "Lodge",
        imageURL: nil,
        raw: .object([
            "id": .string("PRD-2345"),
            "name": .string("Cast Iron Skillet"),
            "manufacturer": .string("Lodge"),
            "categoryId": .string("CAT-2224"),
            "category": .object([
                "id": .string("CAT-2224"), "name": .string("Tools"),
                "path": .array([.object(["id": .string("CAT-2224"), "name": .string("Tools")])]),
                "feature": .string("tools"),
            ]),
            "createdAt": .string("2026-01-15T18:30:00.000Z"),
            "stockTracked": .bool(true),
            "tags": .array([.string("kitchen"), .string("cast-iron")]),
        ])
    )

    /// A product movement timeline for `EntityTimelineView`'s preview: one confident interval,
    /// one open unconfirmed one, a sale marker, and two date groups.
    static let sampleTimeline: EntityTimelineOut = decode(
        """
        {"groups": [
           {"key": "2026-03-02", "date": "2026-03-02", "label": "Sample Vendor order",
            "link": {"entity": "purchase", "id": "PUR-2345"},
            "events": [
              {"id": "EXP-2345", "kind": "purchase", "label": "Sample Product", "amount": 12.5,
               "link": {"entity": "product", "id": "PRD-2345"}, "detail": "1 each"},
              {"id": "audit:1", "kind": "audit:update", "label": "Updated"}]},
           {"key": "2026-03-09", "date": "2026-03-09",
            "events": [{"id": "EXP-3456", "kind": "sale", "label": "Sample Product", "amount": -4}]}],
         "rows": [{"id": "PRD-2345", "name": "Sample Product",
                   "intervals": [{"start": "2026-03-02", "end": "2026-03-09", "confident": true},
                                 {"start": "2026-03-09", "confident": false}],
                   "markers": [{"date": "2026-03-09", "kind": "sale"}]}],
         "stats": [{"key": "events", "label": "Events", "value": "3"}],
         "notes": [], "extent": {"from": "2026-03-02", "to": "2026-03-09"},
         "meta": {"totalCount": 1, "pageIndex": 0, "pageSize": 200}}
        """)

    /// Ranked candidates for `IdentifyResultsSection` previews; distances are illustrative only.
    static let sampleCandidates: [IdentificationCandidate] = [
        IdentificationCandidate(
            productID: ProductCode("PRD-1001"), name: "Cast Iron Skillet",
            imageURL: URL(string: "https://example.invalid/covers/skillet.jpg")!, distance: 0.412),
        IdentificationCandidate(
            productID: ProductCode("PRD-1002"), name: "Enameled Dutch Oven",
            imageURL: URL(string: "https://example.invalid/covers/dutch-oven.jpg")!, distance: 0.877),
        IdentificationCandidate(
            productID: ProductCode("PRD-1003"), name: "Carbon Steel Wok",
            imageURL: URL(string: "https://example.invalid/covers/wok.jpg")!, distance: 1.203),
    ]

    /// A synthesized solid-color image so the probe thumbnail has something to render in
    /// `#Preview`s without decoding a real photo.
    static let sampleProbeImage: CGImage = {
        let size = 160
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = CGContext(
            data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
            space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.setFillColor(CGColor(red: 0.85, green: 0.87, blue: 0.91, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        return context.makeImage()!
    }()

    /// `task.todayBriefing`'s `next` rows, for `TodayView`'s preview.
    static let sampleTodayTasks: [TaskTodayBriefingItemOut] = decode(
        """
        [{"id": "TSK-1001", "name": "Refill pantry staples list", "status": "in_progress",
          "dueDate": "2026-09-11", "dueEndDate": null, "projectId": "PRJ-1001", "projectName": "Kitchen"},
         {"id": "TSK-1002", "name": "Ship the porcelain overhaul PR", "status": "not_started",
          "dueDate": "2026-09-12", "dueEndDate": null, "projectId": "PRJ-1002", "projectName": "Cubby app"},
         {"id": "TSK-1003", "name": "Call the fridge repair vendor back", "status": "not_started",
          "dueDate": null, "dueEndDate": null, "projectId": null, "projectName": null}]
        """)

    /// Today's `GET /api/v1/meals` rows, for `TodayView`'s preview.
    static let sampleTodayMeals: [MealListItem] = decode(
        """
        [\(meal(id: "MEA-2001", name: "Dinner", type: "dinner", kind: "cooked", recipes: ["Braised Short Ribs", "Roasted Carrots"])),
         \(meal(id: "MEA-2002", name: "Lunch", type: "lunch", kind: "leftovers", recipes: []))]
        """)

    private static func meal(id: String, name: String, type: String, kind: String, recipes: [String])
        -> String
    {
        let recipeRows = recipes.enumerated().map { index, recipe in
            """
            {"id": "\(id)-\(index)", "mealId": "\(id)", "recipeId": "RCP-\(index)",
             "recipe": {"id": "RCP-\(index)", "name": "\(recipe)", "servings": null, "yield": null, "totals": null},
             "scale": 1, "sortOrder": \(index),
             "estimatedYieldGrams": null, "actualYieldGrams": null, "scaledTotals": \(totals),
             "createdAt": "2026-09-14T10:00:00.000Z", "updatedAt": "2026-09-14T10:00:00.000Z"}
            """
        }
        return """
            {"id": "\(id)", "date": "2026-09-14", "name": "\(name)", "sortOrder": null, "mealType": "\(type)",
             "mealKind": "\(kind)", "recipes": [\(recipeRows.joined(separator: ","))], "totals": \(totals),
             "images": [], "displayName": "\(name)", "createdAt": "2026-09-14T10:00:00.000Z",
             "updatedAt": "2026-09-14T10:00:00.000Z", "displayImages": []}
            """
    }

    private static let totals = """
        {"cost": {"status": "unavailable", "reason": "no_data"}, "nutrition": {}}
        """

    /// `PhotoDiagnosticsView`'s preview: one entity passing its routing policy, one missing, and a
    /// Foundation Models decision — enough to exercise every section without a real Vision run.
    static let samplePhotoDiagnosticsReport: PhotoDiagnosticsReport = decode(
        """
        {"file": {"filename": "shelf.jpg", "contentType": "image/jpeg", "width": 3024, "height": 4032,
                   "capturedAt": "2026-09-12T20:28:43.000Z", "aspectRatio": 1.3333},
         "hashes": {"sha256": "4bc854c1e872345c8869713bcb39092f6ba6a40a9edcacd357131bd8694f907",
                    "perceptualHash": "d362ab134d00fb3d",
                    "sourceFingerprint": {"hash": "d362ab134d00fb3d", "aspectRatio": 1.3333}},
         "classifications": [{"identifier": "plant", "confidence": 0.895},
                              {"identifier": "foliage", "confidence": 0.72}],
         "recognizedText": [{"text": "Lodge", "confidence": 0.91}],
         "featurePrint": {"revision": "vision-feature-print-2", "bytes": 4352, "data": null},
         "routing": [
           {"entity": "planting", "emoji": "🌱", "classifierIdentifier": "plant", "classifierConfidence": 0.895,
            "minimumScore": 0.76, "meetsMinimumScore": true, "wantedLabels": ["plant", "garden"],
            "candidateFields": ["name"], "temporalFields": ["plantedOn"], "ocrFields": []},
           {"entity": "product", "emoji": "📦", "classifierIdentifier": null, "classifierConfidence": null,
            "minimumScore": 0.72, "meetsMinimumScore": false, "wantedLabels": ["product"],
            "candidateFields": ["name", "manufacturer"], "temporalFields": [], "ocrFields": ["name"]}],
         "suggestedSource": "planting",
         "semanticModel": "available",
         "semantic": {"status": "used",
                      "decisions": [{"photoID": "shelf.jpg", "routeID": "planting-self",
                                     "candidateID": "type:planting", "explanation": "Deterministic local evidence"}]},
         "timings": {"analyzeMs": 102, "semanticMs": 340}}
        """)

    /// `problems/getCounts`, for `TodayView`'s preview; every per-check count is zero. The list
    /// is every check the server counts (`ProblemsCount.byType` requires each key), so a new
    /// check fails this preview loudly instead of silently rendering a stale shape.
    static let sampleTodayProblems: ProblemsCount = {
        let checks = [
            "duplicateInventory", "duplicateProductIdentities", "orphanedProducts",
            "partiallyImportedCookbooks", "soldButStillStocked", "kitsCountedTwice",
            "unlinkedExitExpenses", "purchaselessExitExpenses", "toolsUsedOutsideOwnership",
            "productsWithNoImages", "entitiesMissingEmbeddings", "staleParentRecipes",
            "understatedCostMeals", "unknownParkedItems", "inventoryWithoutPricePath",
            "weightSoldProducts", "manufacturerSpellingVariants", "duplicateVendors",
            "vendorsWithoutLogos", "purchasesNotReconciling",
            "purchaseFinancialSettlementMismatches", "duplicateSpendCandidates",
            "duplicateFinancialTransactionSourceRefs", "duplicateFinancialAccountSourceAliases",
            "financialTransactionAllocationDefects", "invalidFinancialJson",
            "referentialLivenessViolations", "dependencyCycles", "incompleteStatementImports",
            "ingredientsWithPartialCoverage", "productsWithIslandedMappings",
            "productsWithTitleDerivableSize", "productsWithBetterUpcData", "overdueTasks",
            "stalledProjects", "projectsMissingBudget", "pastDuePlannedExpenses",
            "unclassifiedExpenses", "blockedWorkProjects", "projectsWithDateDrift",
            "ingredientsWithoutProduct", "staleLocations", "productsWithoutMappings",
            "productsMissingPrice", "unvaluedBucketProducts", "neverVerifiedInventory",
            "locationsWithoutAiDescription", "emptyLocations", "negativeExpectedQuantity",
            "unusedIngredientsWithProduct", "unusedIngredientsWithoutProduct",
        ]
        let byType = checks.map { "\"\($0)\": 0" }.joined(separator: ", ")
        return decode("{\"total\": 14, \"coverageTotal\": 3, \"byType\": {\(byType)}}")
    }()

    static let sampleMealNutrition: MealNutritionOut = decode(
        """
        {"meals": [\(lunch)],
         "people": [
           {"eater": {"id": "LDP-1001", "name": "Alex"},
            "totals": \(macros(642, 31.4, 78.2, 22.7, status: "partial")),
            "meals": [{"meal": \(lunch), "totals": \(macros(642, 31.4, 78.2, 22.7, status: "partial"))}],
            "foods": [
              {"sourceKind": "recipe", "mealRecipeId": "meal-recipe-preview-1", "recipeId": "RCP-1001",
               "sourceMealId": "MEL-2001", "meal": \(lunch), "name": "Tomato tart", "amount": null,
               "grams": 245, "weight": \(complete(245)), "batchShare": \(complete(1)),
               "totals": \(macros(512, 18.4, 62.2, 21.1))},
              {"sourceKind": "product", "id": "meal-food-preview-1", "productId": "PRD-1001",
               "meal": \(lunch), "name": "Greek yogurt", "amount": null, "grams": 170,
               "weight": \(complete(170)), "batchShare": \(complete(1)),
               "totals": \(macros(130, 13, 16, nil))}]},
           {"eater": {"id": "LDP-1002", "name": "Sam"},
            "totals": \(macros(488, 21.8, 59.5, 18.6)),
            "meals": [{"meal": \(lunch), "totals": \(macros(488, 21.8, 59.5, 18.6))}],
            "foods": [
              {"sourceKind": "recipe", "mealRecipeId": "meal-recipe-preview-2", "recipeId": "RCP-1001",
               "sourceMealId": "MEL-2001", "meal": \(lunch), "name": "Tomato tart", "amount": null,
               "grams": 220, "weight": \(complete(220)), "batchShare": \(complete(1)),
               "totals": \(macros(488, 21.8, 59.5, 18.6))}]}]}
        """)

    private static let lunch = """
        {"id": "MEL-2001", "date": "2026-09-14", "name": "Garden lunch", "mealType": "lunch"}
        """

    private static func complete(_ value: Double) -> String {
        "{\"status\": \"complete\", \"lower\": \(value), \"upper\": null, \"coverage\": {\"covered\": 1, \"total\": 1}}"
    }

    private static func macros(
        _ kcal: Double, _ protein: Double, _ carbs: Double, _ fat: Double?, status: String = "complete"
    ) -> String {
        func estimate(_ value: Double?) -> String {
            guard let value else { return "{\"status\": \"unavailable\", \"reason\": \"no_data\"}" }
            return
                "{\"status\": \"\(status)\", \"lower\": \(value), \"upper\": null, \"coverage\": {\"covered\": 1, \"total\": 1}}"
        }
        return """
            {"cost": {"status": "unavailable", "reason": "no_data"},
             "nutrition": {"kcal": \(estimate(kcal)), "protein": \(estimate(protein)),
                           "carbs": \(estimate(carbs)), "fat": \(estimate(fat))},
             "macros": {"calories": \(estimate(kcal)), "protein": \(estimate(protein)),
                        "carbs": \(estimate(carbs)), "fat": \(estimate(fat)),
                        "partial": \(status == "partial")}}
            """
    }
}

struct SignedInPreview: PreviewModifier {
    static func makeSharedContext() -> Void {}
    func body(content: Content, context: Void) -> some View {
        PreviewSession(signedIn: true) { content }
    }
}

struct SignedOutPreview: PreviewModifier {
    static func makeSharedContext() -> Void {}
    func body(content: Content, context: Void) -> some View {
        PreviewSession(signedIn: false) { content }
    }
}

private struct PreviewSession<Content: View>: View {
    private let content: Content
    @State private var model: AppModel

    init(signedIn: Bool, @ViewBuilder content: () -> Content) {
        self.content = content()
        _model = State(
            initialValue: signedIn ? PreviewFixtures.signedInModel() : PreviewFixtures.signedOutModel())
    }

    var body: some View { content.environment(model) }
}

/// No mutable state is shared across requests; URLProtocol calls are answered synchronously.
nonisolated private final class PreviewNetworkResponse: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
    }
    override func stopLoading() {}
}

/// Unseeded preview reads fail locally instead of resolving a dummy hostname or using credentials.
enum PreviewURLProtocol {
    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PreviewNetworkResponse.self]
        return URLSession(configuration: configuration)
    }
}
