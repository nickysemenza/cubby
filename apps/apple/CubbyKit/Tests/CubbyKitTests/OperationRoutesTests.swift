import Foundation
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

    /// `imageAttachableEntities` and `EntityDescriptor.acceptsImages` are meant to be the same
    /// fact read two ways (`PhotoTests` exercises `acceptsImages` per entity); this checks the
    /// correspondence holds across the whole catalog, not just the handful spot-checked above.
    @Test func imageAttachableEntitiesMatchesAcceptsImagesAcrossTheCatalog() {
        let accepting = Set(EntityCatalog.all.filter(\.acceptsImages).map { $0.key.rawValue })
        #expect(accepting == OperationRoute.imageAttachableEntities)
    }

    /// `apps/apple/openapi/native-operations.json` is the hand-kept allowlist of RPC operation ids
    /// (every `resources.*` id is generated automatically, per its own `$comment`) that feeds
    /// `apps/web/scripts/generate-http-openapi.ts`. Every id it lists must have made it into the
    /// generated table, or the config and the table have drifted apart.
    @Test func everyNativeOperationHasAGeneratedRoute() throws {
        struct Config: Decodable {
            struct Operation: Decodable { let id: String }
            let operations: [Operation]
        }
        // Tests/CubbyKitTests/OperationRoutesTests.swift -> apps/apple/openapi/native-operations.json
        let configURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // CubbyKitTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // CubbyKit/
            .deletingLastPathComponent()  // apple/
            .appendingPathComponent("openapi/native-operations.json")
        let config = try JSONDecoder().decode(Config.self, from: try Data(contentsOf: configURL))
        #expect(!config.operations.isEmpty)
        for operation in config.operations {
            #expect(OperationRoute.all[operation.id] != nil, "missing generated route for \(operation.id)")
        }
    }
}
