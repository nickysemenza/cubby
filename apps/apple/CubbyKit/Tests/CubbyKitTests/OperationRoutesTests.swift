import Testing

@testable import CubbyKit

/// The table is generated from the OpenAPI document and gated by `pnpm check`; these pin the
/// shape the raw client and CLI rely on rather than re-reading the spec.
@Suite("OperationRoute.all (generated)")
struct OperationRoutesTests {
    @Test func coversTheWholeAPI() {
        #expect(OperationRoute.all.count > 300)
        #expect(OperationRoute.all.values.allSatisfy { $0.path.hasPrefix("/api/v1/") })
    }

    @Test func bodyAndPathShapes() throws {
        let scan = try OperationRoute.lookup("inventory.scanAtLocation")
        #expect(scan.method == .post)
        #expect(scan.hasBody)
        #expect(scan.queryParameters.isEmpty)

        let get = try OperationRoute.lookup("resources.product.get")
        #expect(get.method == .get)
        #expect(get.pathParameters == ["id"])
        #expect(get.path == "/api/v1/products/{id}")

        let lookup = try OperationRoute.lookup("upc.lookup")
        #expect(lookup.queryParameters == ["upc"])
        #expect(!lookup.hasBody)
    }

    @Test func noOperationMixesBodyAndQuery() {
        #expect(OperationRoute.all.values.allSatisfy { !($0.hasBody && !$0.queryParameters.isEmpty) })
    }

    @Test func unknownIdThrowsStatusZero() {
        #expect(throws: CubbyAPIError.self) { try OperationRoute.lookup("nope.nothing") }
    }

    @Test func imageAttachableEntitiesAreTheOnesWithPendingImageIds() {
        #expect(OperationRoute.imageAttachableEntities.contains("product"))
        #expect(OperationRoute.imageAttachableEntities.contains("purchase"))
        #expect(!OperationRoute.imageAttachableEntities.contains("task"))
    }
}
