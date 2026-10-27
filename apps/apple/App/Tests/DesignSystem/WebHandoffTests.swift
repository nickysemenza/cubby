import CubbyKit
import Foundation
import Testing

@testable import Cubby

@Suite("Web handoff destinations")
struct WebHandoffTests {
    private let handoff = WebHandoff(baseURL: URL(string: "https://cubby.example.invalid")!)

    private func url(_ target: WebHandoff.Target) -> String { handoff.url(target).absoluteString }

    @Test func recordOpensItsShortcodeAndADeclaredSectionAsTheHash() {
        #expect(url(.record(key: .product, id: "PRD-4K7M")) == "https://cubby.example.invalid/PRD-4K7M")
        #expect(
            url(.record(key: .run, id: "RUN-4K7M", section: "photo-batch"))
                == "https://cubby.example.invalid/RUN-4K7M#photo-batch")
    }

    @Test func usdaUsesTheEntityAwareNumericCanonicalRoute() {
        #expect(url(.record(key: .usdaFood, id: "12345")) == "https://cubby.example.invalid/usda/12345")
    }

    @Test func routeSortsItsQueryAndCarriesNoFragment() {
        #expect(url(.route(path: "/work-queue")) == "https://cubby.example.invalid/work-queue")
        #expect(
            url(.route(path: "/expenses", query: ["view": "analytics", "group": "month"]))
                == "https://cubby.example.invalid/expenses?group=month&view=analytics")
    }

    @Test func copyPutsTheShortcodeOrTheTitleForExternalIDs() {
        #expect(RecordCopyText.text(key: .product, id: "PRD-4K7M", title: "Cedar shelf") == "PRD-4K7M")
        #expect(RecordCopyText.text(key: .usdaFood, id: "12345", title: "Oats, rolled") == "Oats, rolled")
    }
}
