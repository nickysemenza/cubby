import CoreGraphics
import CubbyKit
import Foundation

/// Models and sample data for `#Preview` blocks. Nothing here touches the Keychain or the
/// network: the token store is in-memory and the base URL points at a host that does not exist.
enum PreviewFixtures {
    static let previewURL = URL(string: "http://cubby.preview.invalid")!

    static func signedOutModel() -> AppModel {
        AppModel(store: InMemorySessionTokenStore(), baseURL: previewURL)
    }

    static func signedInModel() -> AppModel {
        let store = InMemorySessionTokenStore()
        try? store.save(.bearer("preview.token"), for: CubbyBaseURL.host(of: previewURL))
        let model = AppModel(store: store, baseURL: previewURL)
        Task { await model.restoreSession() }
        return model
    }

    static let sampleLocation = LocationCode("LOC-2345")

    static let sampleRows: [EntityRow] = [
        EntityRow(id: "PRD-2345", title: "Sample Product", subtitle: "Sample Manufacturer", imageURL: nil, raw: .object([:])),
        EntityRow(id: "PRD-3456", title: "Another Product", subtitle: nil, imageURL: nil, raw: .object([:])),
    ]

    /// A product-shaped detail row for `EntityDetailView`'s preview: enough fields to exercise
    /// every `displayValue(for:)` branch (string, date, boolean, array) without a network call.
    static let sampleDetailRow = EntityRow(
        id: "PRD-2345",
        title: "Cast Iron Skillet",
        subtitle: "Lodge",
        imageURL: nil,
        raw: .object([
            "id": .string("PRD-2345"),
            "name": .string("Cast Iron Skillet"),
            "manufacturer": .string("Lodge"),
            "category": .string("Cookware"),
            "createdAt": .string("2026-01-15T18:30:00.000Z"),
            "stockTracked": .bool(true),
            "tags": .array([.string("kitchen"), .string("cast-iron")]),
        ])
    )

    /// Ranked candidates for `IdentifyResultsSection` previews; distances are illustrative only.
    static let sampleCandidates: [IdentificationCandidate] = [
        IdentificationCandidate(productID: ProductCode("PRD-1001"), name: "Cast Iron Skillet", imageURL: URL(string: "https://example.invalid/covers/skillet.jpg")!, distance: 0.412),
        IdentificationCandidate(productID: ProductCode("PRD-1002"), name: "Enameled Dutch Oven", imageURL: URL(string: "https://example.invalid/covers/dutch-oven.jpg")!, distance: 0.877),
        IdentificationCandidate(productID: ProductCode("PRD-1003"), name: "Carbon Steel Wok", imageURL: URL(string: "https://example.invalid/covers/wok.jpg")!, distance: 1.203),
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
    static let sampleTodayTasks: [TodayTask] = [
        TodayTask(
            id: "TSK-1001", name: "Refill pantry staples list", status: "in_progress",
            dueDate: "2026-09-11", projectName: "Kitchen"
        ),
        TodayTask(
            id: "TSK-1002", name: "Ship the porcelain overhaul PR", status: "not_started",
            dueDate: "2026-09-12", projectName: "Cubby app"
        ),
        TodayTask(id: "TSK-1003", name: "Call the fridge repair vendor back", status: "not_started"),
    ]

    /// Today's `GET /api/v1/meals` rows, for `TodayView`'s preview.
    static let sampleTodayMeals: [TodayMeal] = [
        TodayMeal(
            id: "MEA-2001", name: "Dinner", mealType: "dinner", mealKind: "cooked",
            recipeNames: ["Braised Short Ribs", "Roasted Carrots"]
        ),
        TodayMeal(id: "MEA-2002", name: "Lunch", mealType: "lunch", mealKind: "leftovers"),
    ]

    /// `problems/getCounts`, for `TodayView`'s preview.
    static let sampleTodayProblems = TodayProblemCounts(total: 14, coverageTotal: 3)
}
