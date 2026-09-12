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
}
