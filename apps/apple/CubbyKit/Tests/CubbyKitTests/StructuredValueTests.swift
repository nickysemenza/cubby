import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class StructuredStub: URLProtocol, @unchecked Sendable {
    static let handler = Mutex<StubNetworking.Handler?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubNetworking.startLoading(
            request, client: client, target: self, handler: Self.handler.withLock { $0 })
    }
    override func stopLoading() {}
    static func session() -> URLSession { StubNetworking.session(protocolClass: self) }
}

/// The structured-value editor's model: the manifest's `valueSchema` for every field a structured
/// renderer draws, the read-payload round trip, the wire schema, and the mapping of the server's
/// validation issues back onto positions inside a value. All data is synthetic.
@Suite("StructuredValue", .serialized)
@MainActor
struct StructuredValueTests {
    private static let structuredRenderers: Set<ControlRendererID> = [
        .externalIds, .labelNutrition, .sourceAliases, .sourceRefs, .structuredField, .unitMappings,
    ]

    private func schema(_ entity: EntityKey, _ field: String) throws -> ValueSchema {
        try #require(EntityCatalog[entity].field(field)?.valueSchema)
    }

    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: CredentialProvider(host: "localhost:3000", store: store),
            session: StructuredStub.session())
    }

    private static let mappingID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"

    /// A mapping as the server reads it back: the input keys plus read-only metadata.
    private static let readMapping: JSONValue = [
        "id": .string(mappingID),
        "a": ["value": 1, "unit": "cup"],
        "b": ["value": 120, "unit": "g"],
        "source": "manual",
        "sourceMetadata": ["provenance": "synthetic"],
        "createdAt": "2026-01-01T00:00:00.000Z",
    ]

    // MARK: - The manifest

    @Test func everyFieldAStructuredRendererDrawsDeclaresASchema() {
        var drawn = 0
        for descriptor in EntityCatalog.all {
            for field in descriptor.fields {
                let structured = field.controlRenderer.map(Self.structuredRenderers.contains) ?? false
                #expect(
                    (field.valueSchema != nil) == structured,
                    "\(descriptor.key.rawValue).\(field.key) valueSchema disagrees with its renderer")
                if structured { drawn += 1 }
            }
        }
        #expect(drawn >= 14)
    }

    @Test func unitMappingsDescribeRowsOfAmountsWithAnOpaqueId() throws {
        guard case .array(let item) = try schema(.product, "unitMappings").node,
            case .object(let fields) = item.node
        else { throw Failure("unitMappings is not rows of objects") }
        #expect(fields.map(\.key) == ["a", "b", "source", "id"])
        #expect(fields.first?.schema.node == .amount(upper: true))
        #expect(fields.last?.schema.isEdited == false)
        #expect(fields.last?.required == false)
    }

    @Test func labelNutritionIsANullableObjectWithAMapOfNutrients() throws {
        let nutrition = try schema(.product, "labelNutrition")
        #expect(nutrition.nullable)
        guard case .object(let fields) = nutrition.node,
            case .map(let keys, let value) = fields.first(where: { $0.key == "nutrients" })?.schema.node
        else { throw Failure("labelNutrition has no nutrients map") }
        #expect(keys.contains(LabeledOption(value: "saturated_fat", label: "Saturated fat")))
        #expect(value.node == .number(integer: false))
    }

    @Test func identityIsAVariantAndIngredientsReferenceTheirEntity() throws {
        guard case .variant(let discriminator, let cases) = try schema(.financialAccount, "identity").node
        else { throw Failure("identity is not a variant") }
        #expect(discriminator == "kind")
        #expect(cases.map(\.value).contains("credit_card"))
        let sections = try schema(.recipe, "sections")
        #expect(Self.references(in: sections).contains(.ingredient))
    }

    private static func references(in schema: ValueSchema) -> Set<EntityKey> {
        switch schema.node {
        case .reference(let entity): [entity]
        case .array(let item): references(in: item)
        case .map(_, let value): references(in: value)
        case .object(let fields): fields.reduce(into: []) { $0.formUnion(references(in: $1.schema)) }
        case .variant(_, let cases):
            cases.reduce(into: []) { found, option in
                for field in option.fields { found.formUnion(references(in: field.schema)) }
            }
        default: []
        }
    }

    // MARK: - Round trip

    @Test func projectionDropsReadOnlyKeysAndKeepsTheRowId() throws {
        let projected = StructuredValue.project(
            .array([Self.readMapping]), to: try schema(.product, "unitMappings"))
        #expect(
            projected
                == .array([
                    [
                        "id": .string(Self.mappingID), "a": ["value": 1, "unit": "cup"],
                        "b": ["value": 120, "unit": "g"], "source": "manual",
                    ]
                ]))
    }

    @Test func anUntouchedStructuredFieldStaysOutOfThePatch() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: ["id": "PRD-2345", "name": "Skillet", "unitMappings": [Self.readMapping]])
        #expect(try model.patch().isEmpty)
        #expect(!model.canSave)
    }

    @Test func editingOneRowSendsTheWholeArrayWithItsId() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: ["id": "PRD-2345", "unitMappings": [Self.readMapping]])
        var rows = try #require(model.draft["unitMappings"]?.arrayValue)
        rows[0] = .object(
            try #require(rows[0].objectValue).merging(["b": ["value": 100, "unit": "g"]]) { $1 })
        model.draft["unitMappings"] = .array(rows)
        let sent = try #require(try model.patch().values["unitMappings"]?.arrayValue)
        #expect(sent.count == 1)
        #expect(sent[0]["id"] == .string(Self.mappingID))
        #expect(sent[0]["b"]?["value"] == 100)
        #expect(sent[0]["sourceMetadata"] == nil)
    }

    @Test func aClearedNullableObjectIsSentAsACleared() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: [
                "id": "PRD-2345",
                "labelNutrition": [
                    "servingGrams": 44, "nutrients": ["protein": 3], "source": "synthetic label",
                    "createdAt": "ignored",
                ],
            ])
        #expect(try model.patch().isEmpty)
        model.draft["labelNutrition"] = .null
        #expect(try model.patch().cleared == ["labelNutrition"])
    }

    // MARK: - Wire value

    @Test func unfilledOptionalTextIsLeftOutAndRequiredTextIsKeptForTheServerToReject() throws {
        let refs = try schema(.financialTransaction, "sourceRefs")
        let wire = StructuredValue.wireValue(
            .array([["source": "", "externalId": "ext-1"]]), schema: refs)
        #expect(wire == .array([["source": "", "externalId": "ext-1"]]))
        let ids = try schema(.product, "externalIds")
        let row = StructuredValue.wireValue(
            .array([["source": "synthetic", "kind": "asin", "externalId": "B0", "url": ""]]), schema: ids)
        // `url` is optional and nullable: an emptied box clears it rather than sending "".
        #expect(row == .array([["source": "synthetic", "kind": "asin", "externalId": "B0", "url": .null]]))
        // `providerId` is optional and not nullable: an emptied box is simply absent.
        let claims = StructuredValue.wireValue(
            .array([
                [
                    "source": "synthetic-source", "providerId": "", "normalizedEvidence": ["amount": 5],
                    "reconciliation": ["decision": "amounts_match"],
                ]
            ]), schema: try schema(.ledgerTransfer, "sourceClaims"))
        #expect(claims.arrayValue?.first?.objectValue?.keys.contains("providerId") == false)
    }

    @Test func aMapDropsEmptyEntriesAndAVariantKeepsItsTag() throws {
        let nutrition = StructuredValue.wireValue(
            ["servingGrams": 44, "nutrients": ["protein": 3, "fat": .null], "source": .null],
            schema: try schema(.product, "labelNutrition"))
        #expect(nutrition["nutrients"] == ["protein": 3])
        let identity = StructuredValue.wireValue(
            ["kind": "bank_account", "institution": "", "accountType": "checking"],
            schema: try schema(.financialAccount, "identity"))
        #expect(identity["kind"] == "bank_account")
        #expect(identity["accountType"] == "checking")
        #expect(identity["institution"] == .null)
    }

    @Test func blankValuesCarryOnlyRequiredKeysAndAVariantsTag() throws {
        let identity = try schema(.financialAccount, "identity")
        #expect(
            StructuredValue.blank(identity)
                == ["kind": "credit_card", "issuer": .null, "network": .null])
        guard case .variant(let discriminator, let cases) = identity.node,
            let cash = cases.first(where: { $0.value == "cash" })
        else { throw Failure("no cash case") }
        #expect(StructuredValue.blankCase(discriminator, cash) == ["kind": "cash"])
        #expect(StructuredValue.blank(try schema(.product, "labelNutrition")) == .null)
        #expect(
            StructuredValue.blank(try schema(.product, "labelNutrition"), populated: true)
                == ["servingGrams": .null, "nutrients": [:], "source": .null])
    }

    @Test func aRequiredStructuredFieldStartsPopulatedOnCreate() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.financialAccount], mode: .create(prefill: [:]),
            client: try makeClient())
        #expect(model.draft["identity"]?["kind"] == "credit_card")
        #expect(!model.missingRequiredKeys.contains("identity"))
        #expect(model.createBody()["identity"]?["kind"] == "credit_card")
        #expect(model.createBody()["sourceAliases"] == nil)
    }

    @Test func positionsReadAndReplaceInsideRowsWithoutTouchingTheirSiblings() {
        let rows: JSONValue = [["a": ["value": 1, "unit": "cup"]], ["a": ["value": 2, "unit": "tbsp"]]]
        #expect(StructuredValue.value(at: ["1", "a", "unit"], in: rows) == "tbsp")
        #expect(StructuredValue.value(at: ["5", "a"], in: rows) == .null)
        let edited = StructuredValue.setting(3, at: ["0", "a", "value"], in: rows)
        #expect(StructuredValue.value(at: ["0", "a", "value"], in: edited) == 3)
        #expect(StructuredValue.value(at: ["1"], in: edited) == StructuredValue.value(at: ["1"], in: rows))
        // A key the row lacks is created.
        let created = StructuredValue.setting("manual", at: ["1", "source"], in: rows)
        #expect(StructuredValue.value(at: ["1", "source"], in: created) == "manual")
    }

    // MARK: - Validation issues

    @Test func drawsOnlyPositionsTheEditorShows() throws {
        let mappings = try schema(.product, "unitMappings")
        let value = StructuredValue.project(.array([Self.readMapping]), to: mappings)
        #expect(StructuredValue.draws(path: ["0", "a", "value"], in: value, schema: mappings))
        #expect(StructuredValue.draws(path: ["0", "source"], in: value, schema: mappings))
        #expect(!StructuredValue.draws(path: ["1", "a", "value"], in: value, schema: mappings))
        #expect(!StructuredValue.draws(path: ["0", "id"], in: value, schema: mappings))
        #expect(!StructuredValue.draws(path: ["0", "nope"], in: value, schema: mappings))
        #expect(!StructuredValue.draws(path: [], in: value, schema: mappings))
    }

    @Test func aRejectionLandsInsideTheValueOrOnTheFieldWhenNoPositionDrawsIt() async throws {
        defer { StructuredStub.handler.withLock { $0 = nil } }
        StructuredStub.handler.withLock { handler in
            handler = { _ in
                (
                    400,
                    Data(
                        #"{"code":"VALIDATION","message":"Invalid input","validationIssues":[{"code":"too_small","path":["unitMappings","0","a","value"],"message":"Too small"},{"code":"custom","path":["unitMappings","7","b"],"message":"No such row"},{"code":"custom","path":["unitMappings"],"message":"Duplicate edge"},{"code":"custom","path":["unitMappings","0","source"],"message":"Bad source"}]}"#
                            .utf8)
                )
            }
        }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: ["id": "PRD-2345", "unitMappings": [Self.readMapping]])
        model.draft["unitMappings"] = .array([
            .object(
                try #require(model.draft["unitMappings"]?.arrayValue?[0].objectValue)
                    .merging(["a": ["value": -1, "unit": "cup"]]) { $1 })
        ])
        #expect(await model.save() == false)
        #expect(model.nestedError("unitMappings", path: ["0", "a", "value"]) == "Too small")
        #expect(model.nestedError("unitMappings", path: ["0", "source"]) == "Bad source")
        #expect(model.fieldErrors["unitMappings"] == "No such row; Duplicate edge")
        #expect(model.bannerError == nil)
        #expect(model.draft["unitMappings"]?.arrayValue?.count == 1)
    }

    private struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }
}
