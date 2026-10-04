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
        .externalIds, .labelNutrition, .sourceAliases, .sourceRefs, .unitMappings,
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
                if structured {
                    #expect(field.valueSchema != nil, "\(descriptor.key.rawValue).\(field.key) has no schema")
                }
                // The shared `structured-field` id is drawn only for the fields the generator opts in
                // (`nativeCoverage.structuredField`); no other renderer carries a schema.
                if field.valueSchema != nil {
                    drawn += 1
                    #expect(structured || field.controlRenderer == .structuredField)
                }
            }
        }
        #expect(drawn == 14)
    }

    @Test func aRecipeSectionLineReadsItsTargetsIdFromTheNestedRecord() throws {
        let lines = try #require(
            EntityCatalog[.recipe].field("sections")?.valueSchema)
        guard case .array(let section) = lines.node, case .object(let sectionFields) = section.node,
            let ingredients = sectionFields.first(where: { $0.key == "ingredients" })?.schema,
            case .array(let line) = ingredients.node, case .variant(_, let cases) = line.node
        else { throw Failure("recipe.sections is not an array of sections of variant lines") }
        let targets = Dictionary(
            uniqueKeysWithValues: cases.map { ($0.value, $0.fields.compactMap { $0.readPath }) })
        #expect(targets == ["ingredient": ["ingredient.id"], "recipe": ["recipe.id"]])
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

    /// A synthetic variant schema, so the editor's variant handling is exercised without depending
    /// on a declared field's exact cases.
    private static let accountKind = ValueSchema(
        node: .variant(
            discriminator: "kind",
            cases: [
                .init(value: "cash", label: "Cash", fields: []),
                .init(
                    value: "bank", label: "Bank",
                    fields: [
                        .init(
                            key: "institution", label: "Institution", required: true,
                            schema: ValueSchema(nullable: true, node: .text(format: nil))),
                        .init(
                            key: "accountType", label: "Type", required: true,
                            schema: ValueSchema(
                                node: .enum(options: [LabeledOption(value: "checking", label: "Checking")]))),
                    ]),
            ]))

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

    private struct Vector: Decodable {
        let entity: EntityKey
        let field: String
        let read: JSONValue
        let input: JSONValue
    }

    /// Each native-edited field's read payload, projected and shaped, is exactly the input the
    /// server accepts (`structured-roundtrip.json`; the web suite parses the same `input`s with
    /// the update schemas).
    @Test func everyEditedFieldRoundTripsItsReadPayloadToItsInput() throws {
        struct File: Decodable { let vectors: [Vector] }
        let vectors = try GoldenVectors.decode(File.self, named: "structured-roundtrip").vectors
        let edited = EntityCatalog.all.flatMap { descriptor in
            descriptor.fields.filter { $0.valueSchema != nil }.map { "\(descriptor.key.rawValue).\($0.key)" }
        }
        #expect(Set(edited) == Set(vectors.map { "\($0.entity.rawValue).\($0.field)" }))
        for vector in vectors {
            let schema = try schema(vector.entity, vector.field)
            let projected = StructuredValue.project(vector.read, to: schema)
            #expect(
                StructuredValue.wireValue(projected, schema: schema) == vector.input,
                "\(vector.entity.rawValue).\(vector.field)")
            // Untouched through the editor model, the field is not in the patch.
            let model = GenericEntityEditModel(
                descriptor: EntityCatalog[vector.entity], mode: .update(id: "X-1"),
                client: try makeClient(), original: .object([vector.field: vector.read]))
            #expect(try model.patch().isEmpty, "\(vector.entity.rawValue).\(vector.field) patch")
        }
    }

    /// A new account has no default identity kind: the form stays unsaveable until one is chosen.
    @Test func aNewAccountMustChooseItsIdentityKind() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.financialAccount], mode: .create(prefill: [:]),
            client: try makeClient())
        #expect(model.missingRequiredKeys.contains("identity"))
        let identity = try schema(.financialAccount, "identity")
        guard case .variant(let discriminator, let cases) = identity.node,
            let cash = cases.first(where: { $0.value == "cash" })
        else { throw Failure("identity is not a variant with a cash case") }
        model.draft["identity"] = StructuredValue.blankCase(discriminator, cash)
        #expect(!model.missingRequiredKeys.contains("identity"))
    }

    /// An edited claim goes back under the identity it was read with (`sourceKey`), never a
    /// provider id the read cannot supply, so the server keeps the claim instead of rehashing it.
    @Test func anEditedSourceClaimKeepsItsIdentityKey() throws {
        let vector = try sourceClaimVector()
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-2222"),
            client: try makeClient(), original: .object(["sourceClaims": vector.read]))
        #expect(try model.patch().isEmpty)
        let reviewed = StructuredValue.setting(
            ["decision": "accept_target_amount", "note": "Reviewed"], at: ["0", "reconciliation"],
            in: model.draft["sourceClaims"] ?? .null)
        model.draft["sourceClaims"] = reviewed
        let sent = try #require(model.patch().values["sourceClaims"]?.arrayValue?.first)
        #expect(sent["sourceKey"] == vector.input.arrayValue?.first?["sourceKey"])
        #expect(sent["providerId"] == nil)
        #expect(sent["reconciliation"]?["decision"] == "accept_target_amount")
    }

    @Test func anAccountsIdentityKindIsCreateOnlyAndCardNumbersCarryANotice() throws {
        #expect(try schema(.financialAccount, "identity").createOnly == true)
        #expect(try schema(.financialAccount, "cardNumbers").notice?.contains("matched") == true)
        #expect(try schema(.vendor, "agentHints").createOnly == nil)
    }

    private func sourceClaimVector() throws -> Vector {
        struct File: Decodable { let vectors: [Vector] }
        let vectors = try GoldenVectors.decode(File.self, named: "structured-roundtrip").vectors
        return try #require(vectors.first { $0.entity == .expense && $0.field == "sourceClaims" })
    }

    @Test func storedEmptyTextOrNullsDoNotMakeAnUntouchedRowLookEdited() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: [
                "id": "PRD-2345",
                "unitMappings": [
                    ["a": ["value": 1, "unit": "cup"], "b": ["value": 2, "unit": "g"], "source": ""]
                ],
                "externalIds": [["source": "synthetic", "kind": "asin", "externalId": "B0", "url": ""]],
            ])
        #expect(try model.patch().isEmpty)
        #expect(!model.canSave)
    }

    @Test func aRangeAmountKeepsAndSendsItsUpperValue() throws {
        let mappings = try schema(.product, "unitMappings")
        let row: JSONValue = [
            "a": ["value": 1, "unit": "cup", "upperValue": 2], "b": ["value": 100, "unit": "g"],
            "source": .null,
        ]
        let wire = StructuredValue.wireValue(.array([row]), schema: mappings)
        #expect(wire.arrayValue?.first?["a"]?["upperValue"] == 2)
        // A cleared range end is absent (the input is `.positive().optional()`), never `null`.
        let cleared = StructuredValue.setting(.null, at: ["a", "upperValue"], in: row)
        let sent = StructuredValue.wireValue(.array([cleared]), schema: mappings)
        #expect(sent.arrayValue?.first?["a"]?.objectValue?.keys.contains("upperValue") == false)
        #expect(StructuredValue.draws(path: ["0", "a", "upperValue"], in: .array([row]), schema: mappings))
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
        // An empty optional list is absent, not `[]` (the input is `.min(1).optional()`).
        let optionalList = ValueSchema(
            node: .object(fields: [
                .init(
                    key: "note", label: "Note", required: false,
                    schema: ValueSchema(node: .text(format: nil))),
                .init(
                    key: "items", label: "Items", required: false,
                    schema: ValueSchema(node: .array(item: ValueSchema(node: .text(format: nil))))),
            ]))
        let sent = StructuredValue.wireValue(["note": "", "items": []], schema: optionalList)
        #expect(sent == .object([:]))
    }

    @Test func aMapDropsEmptyEntriesAndAVariantKeepsItsTag() throws {
        let nutrition = StructuredValue.wireValue(
            ["servingGrams": 44, "nutrients": ["protein": 3, "fat": .null], "source": .null],
            schema: try schema(.product, "labelNutrition"))
        #expect(nutrition["nutrients"] == ["protein": 3])
        let identity = StructuredValue.wireValue(
            ["kind": "bank", "institution": "", "accountType": "checking"], schema: Self.accountKind)
        #expect(identity["kind"] == "bank")
        #expect(identity["accountType"] == "checking")
        #expect(identity["institution"] == .null)
    }

    @Test func blankValuesCarryOnlyRequiredKeysAndAVariantsTag() throws {
        let identity = Self.accountKind
        // No case is chosen for the person: a default variant would be a silent identity.
        #expect(StructuredValue.blank(identity) == .null)
        guard case .variant(let discriminator, let cases) = identity.node,
            let cash = cases.first(where: { $0.value == "cash" })
        else { throw Failure("no cash case") }
        #expect(StructuredValue.blankCase(discriminator, cash) == ["kind": "cash"])
        #expect(StructuredValue.blank(try schema(.product, "labelNutrition")) == .null)
        #expect(
            StructuredValue.blank(try schema(.product, "labelNutrition"), populated: true)
                == ["servingGrams": .null, "nutrients": [:], "source": .null])
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
