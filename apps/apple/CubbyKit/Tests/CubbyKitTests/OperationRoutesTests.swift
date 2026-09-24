import Foundation
import Testing

@testable import CubbyKit

/// The table is generated from the OpenAPI document and gated by `pnpm check`; these pin the
/// shape the raw client and CLI rely on rather than re-reading the spec.
@Suite("OperationRoute.all (generated)")
struct OperationRoutesTests {
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
        // Vendor owns a single logo FK rather than an image-association gallery.
        #expect(!OperationRoute.imageAttachableEntities.contains("vendor"))
    }

    /// `imageAttachableEntities` and `EntityDescriptor.acceptsImages` are meant to be the same
    /// fact read two ways (`PhotoTests` exercises `acceptsImages` per entity); this checks the
    /// correspondence holds across the whole catalog, not just the handful spot-checked above.
    @Test func imageAttachableEntitiesMatchesAcceptsImagesAcrossTheCatalog() {
        let accepting = Set(EntityCatalog.all.filter(\.acceptsImages).map { $0.key.rawValue })
        #expect(accepting == OperationRoute.imageAttachableEntities)
    }

    /// `apps/apple/openapi/openapi-generator-config.yaml` lists every operation id the generated
    /// client carries (`native:` flags on the web contracts and entity declarations, plus the
    /// automatic resource ids), written by `scripts/generator/http-api/native.ts`. Every id it
    /// lists must have made it into the generated table, or the config and the table have drifted.
    @Test func everyNativeOperationHasAGeneratedRoute() throws {
        // Tests/CubbyKitTests/OperationRoutesTests.swift -> apps/apple/openapi/openapi-generator-config.yaml
        let configURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // CubbyKitTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // CubbyKit/
            .deletingLastPathComponent()  // apple/
            .appendingPathComponent("openapi/openapi-generator-config.yaml")
        // Read only the flat `    - <id>` list under `operations:`. The same filter can also carry
        // schema-only native wire models, which deliberately have no HTTP route.
        let config = try String(contentsOf: configURL, encoding: .utf8)
        let marker = "  operations:\n"
        let operationsStart = try #require(config.range(of: marker)?.upperBound)
        let ids = config[operationsStart...]
            .split(separator: "\n")
            .compactMap { line -> String? in
                guard line.hasPrefix("    - ") else { return nil }
                return String(line.dropFirst(6))
            }
        #expect(!ids.isEmpty)
        for id in ids {
            #expect(OperationRoute.all[id] != nil, "missing generated route for \(id)")
        }
    }
}
