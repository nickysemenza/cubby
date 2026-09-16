import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// A lookup service each test scripts; records which barcodes reached the server so a label
/// can be shown to resolve with no request at all.
final class StubLookupService: LookupService, Sendable {
    let products: Mutex<[String: [EntityRow]]>
    let catalog: Mutex<[String: UpcLookupOutput]>
    let calls = Mutex<[String]>([])

    init(products: [String: [EntityRow]] = [:], catalog: [String: UpcLookupOutput] = [:]) {
        self.products = Mutex(products)
        self.catalog = Mutex(catalog)
    }

    func products(matchingBarcode gtin: String) async throws -> [EntityRow] {
        calls.withLock { $0.append("products:\(gtin)") }
        return products.withLock { $0[gtin] ?? [] }
    }

    func lookupUPC(_ upc: String) async throws -> UpcLookupOutput {
        calls.withLock { $0.append("upc:\(upc)") }
        guard let hit = catalog.withLock({ $0[upc] }) else {
            throw CubbyAPIError(status: 404, operationID: "upc.lookup", detail: nil)
        }
        return hit
    }
}

@Suite("CodeLookup")
struct CodeLookupTests {
    private static func row(_ id: String, _ title: String) -> EntityRow {
        EntityRow(id: id, title: title, subtitle: nil, imageURL: nil, raw: .object(["id": .string(id)]))
    }

    private static let bulbs = UpcLookupOutput(
        upc: "00012345678905", name: "LED bulbs", manufacturer: nil, brand: nil, category: nil,
        description: nil,
        priceDollars: nil, imageUrl: nil, source: .upcitemdb, cached: false)

    @Test func labelsOfAnyKindResolveOfflineToALink() async throws {
        let service = StubLookupService()
        let lookup = CodeLookup(service: service)

        #expect(try await lookup.resolve("LOC-2345") == .link(.entity(.location, id: "LOC-2345")))
        #expect(try await lookup.resolve(" rcp-2345 ") == .link(.entity(.recipe, id: "RCP-2345")))
        #expect(
            try await lookup.resolve("https://cubby.nickysemenza.com/PRD-2345")
                == .link(.entity(.product, id: "PRD-2345")))
        #expect(
            try await lookup.resolve("cubby://audit?location=LOC-2345")
                == .link(.audit(location: LocationCode("LOC-2345"))))
        #expect(service.calls.withLock { $0 }.isEmpty)
    }

    /// A barcode reaches the server as the GTIN-14 it is stored as, whatever spelling was read.
    @Test func barcodeMatchingProductsReturnsThem() async throws {
        let rows = [Self.row("PRD-2345", "Bulbs"), Self.row("PRD-2346", "Bulbs, 4-pack")]
        let service = StubLookupService(products: ["00012345678905": rows])
        let outcome = try await CodeLookup(service: service).resolve("012345678905")

        #expect(outcome == .products(rows, code: "00012345678905"))
        #expect(service.calls.withLock { $0 } == ["products:00012345678905"])
    }

    @Test func isbnIsNormalizedBeforeTheServerSeesIt() async throws {
        let rows = [Self.row("PRD-2345", "A book")]
        let service = StubLookupService(products: ["09780306406157": rows])
        let outcome = try await CodeLookup(service: service).resolve("978-0-306-40615-7")

        #expect(outcome == .products(rows, code: "09780306406157"))
    }

    @Test func unknownBarcodeCarriesTheCatalogAnswerWhenThereIsOne() async throws {
        let service = StubLookupService(catalog: ["00012345678905": Self.bulbs])
        let outcome = try await CodeLookup(service: service).resolve("00012345678905")

        #expect(outcome == .unknownCode("00012345678905", catalog: Self.bulbs))
        #expect(service.calls.withLock { $0 } == ["products:00012345678905", "upc:00012345678905"])
    }

    @Test func aCatalogMissIsNotAFailure() async throws {
        let outcome = try await CodeLookup(service: StubLookupService()).resolve("012345678905")
        #expect(outcome == .unknownCode("00012345678905", catalog: nil))
    }

    @Test func anythingElseIsText() async throws {
        let service = StubLookupService()
        let lookup = CodeLookup(service: service)

        #expect(try await lookup.resolve("led bulbs") == .text("led bulbs"))
        #expect(try await lookup.resolve("https://example.com/") == .text("https://example.com/"))
        #expect(try await lookup.resolve("  ") == .text(""))
        #expect(service.calls.withLock { $0 }.isEmpty)
    }
}
