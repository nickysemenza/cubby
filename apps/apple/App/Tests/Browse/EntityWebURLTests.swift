import CubbyKit
import Foundation
import Testing

@testable import Cubby

@Suite("Entity web destinations")
@MainActor
struct EntityWebURLTests {
    @Test func usdaUsesTheEntityAwareNumericCanonicalRoute() {
        let model = AppModel(
            store: InMemorySessionTokenStore(),
            baseURL: URL(string: "https://cubby.example.invalid")!)

        #expect(
            model.webURL(for: .usdaFood, id: "12345").absoluteString
                == "https://cubby.example.invalid/usda/12345")
        #expect(
            model.webURL(for: .product, id: "PRD-4K7M").absoluteString
                == "https://cubby.example.invalid/PRD-4K7M")
    }
}
