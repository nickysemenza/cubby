import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class EditStub: URLProtocol, @unchecked Sendable {
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

/// The generic editor's wire contract: exactly the changed keys, `null` for a cleared nullable
/// key, never a locked key, and a validation rejection mapped back onto its fields with the draft
/// intact.
@Suite("GenericEntityEditModel", .serialized)
@MainActor
struct GenericEntityEditModelTests {
    private struct Seen: Sendable {
        let method: String?
        let path: String
        let body: [String: JSONValue]
    }

    private final class Recorder: Sendable {
        let seen = Mutex<[Seen]>([])
        var requests: [Seen] { seen.withLock { $0 } }
    }

    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
            session: EditStub.session())
    }

    /// Installs a handler that records every request and answers with `respond`.
    private func capture(_ respond: @escaping @Sendable (URLRequest) -> (Int, Data)) -> Recorder {
        let recorder = Recorder()
        EditStub.handler.withLock { handler in
            handler = { request in
                let data = (try? Self.requestBody(request)) ?? Data()
                let fields = (try? JSONDecoder().decode([String: JSONValue].self, from: data)) ?? [:]
                recorder.seen.withLock {
                    $0.append(Seen(method: request.httpMethod, path: request.url?.path ?? "", body: fields))
                }
                return respond(request)
            }
        }
        return recorder
    }

    nonisolated private static func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        let stream = try #require(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }

    // Minimal typed mutation results: the generated client decodes the response before the
    // model sees it, so the stub must answer with every required key of the item schema.
    nonisolated private static let productUpdated = Data(
        #"{"action":"update","entity":"product","item":{"id":"PRD-2345","name":"Sample","acquisitionOrigin":"unknown","aliases":[],"tags":[],"manufacturer":"x","model":null,"notes":null,"expectedQuantity":null,"categoryId":null,"images":[],"externalIds":[],"pricing":{"source":"explicit","knownExpenseCount":0,"unknownExpenseCount":0,"knownUnitCount":0,"partial":false},"usdaUnavailable":null,"stockTracked":null,"kind":null,"dataQuality":{"status":"complete","score":100,"facets":[],"gaps":[],"exceptions":[],"relatedGaps":[],"relatedExceptions":[]},"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","category":null,"itemImageCount":0,"labelImageCount":0,"labelImages":[],"classificationEvidence":"","coverImageUrl":null},"sideEffects":{}}"#
            .utf8)
    nonisolated private static let locationCreated = Data(
        #"{"action":"create","entity":"location","item":{"id":"LOC-9ABC","name":"Bin 9","aliases":[],"type":"box","notes":null,"lastBulkInventory":null,"aiDescription":null,"images":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","dataQuality":{"status":"complete","score":100,"facets":[],"gaps":[],"exceptions":[],"relatedGaps":[],"relatedExceptions":[]}},"sideEffects":{}}"#
            .utf8)

    private static let productOriginal: JSONValue = [
        "id": "PRD-2345", "name": "Skillet", "manufacturer": "Sample Co", "categoryId": "CAT-2224",
        "attachments": [["id": "IMG-2345"], ["id": "IMG-3456"], ["id": "IMG-4567"]],
    ]

    @Test func acknowledgingSavedCategoryPreservesNewerDraftAndSiblingChanges() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"),
            client: try makeClient(), original: ["spendingCategoryId": .null, "notes": "Saved note"])
        model.draft["notes"] = .string("Unsaved sibling")
        model.draft["spendingCategoryId"] = .string("SPC-8K7M")
        model.acknowledgeSavedField(
            "spendingCategoryId", value: .string("SPC-4K7M"), reviewedDraftValue: .null)
        #expect(model.original?["spendingCategoryId"] == .string("SPC-4K7M"))
        #expect(model.draft["spendingCategoryId"] == .string("SPC-8K7M"))
        #expect(try model.patch().values["spendingCategoryId"] == .string("SPC-8K7M"))
        #expect(try model.patch().values["notes"] == .string("Unsaved sibling"))
    }

    @Test func acknowledgedCategoryDoesNotReplayOnLaterSiblingSave() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"),
            client: try makeClient(), original: ["spendingCategoryId": .null, "notes": "Saved note"])
        model.draft["notes"] = .string("Unsaved sibling")
        model.acknowledgeSavedField(
            "spendingCategoryId", value: .string("SPC-4K7M"), reviewedDraftValue: .null)
        #expect(model.draft["spendingCategoryId"] == .string("SPC-4K7M"))
        #expect(try model.patch().values["spendingCategoryId"] == nil)
        #expect(try model.patch().values["notes"] == .string("Unsaved sibling"))
    }

    @Test func inheritedReadDoesNotBecomeStoredDraftOrUnchangedPatch() throws {
        let original: JSONValue = [
            "spendingCategoryId": "SPC-4K7M",
            "fieldResolutions": [
                "spendingCategoryId": [
                    "mode": "inherit", "storedValue": .null, "value": "SPC-4K7M", "fallbackValue": "SPC-4K7M",
                    "source": "purchase", "sourceEntity": .null, "matchesFallback": true, "canReset": false,
                ]
            ],
        ]
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"), client: try makeClient(),
            original: original)
        #expect(model.draft["spendingCategoryId"] == .null)
        #expect(try model.patch().values["spendingCategoryId"] == nil)
        #expect(!model.canSave)
    }

    @Test func resolutionResetStagesDeclaredPatchOnlyWhenServerAllowsIt() throws {
        func original(_ canReset: Bool) -> JSONValue {
            [
                "spendingCategoryId": "SPC-8K7M", "notes": "Keep this",
                "fieldResolutions": [
                    "spendingCategoryId": [
                        "mode": "explicit", "storedValue": "SPC-8K7M", "value": "SPC-8K7M",
                        "fallbackValue": "SPC-4K7M",
                        "source": "explicit", "sourceEntity": .null, "matchesFallback": false,
                        "canReset": .bool(canReset),
                    ]
                ],
            ]
        }
        let blocked = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"), client: try makeClient(),
            original: original(false))
        #expect(!blocked.stageResolutionReset("spendingCategoryId"))
        #expect(try blocked.patch().isEmpty)
        let allowed = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"), client: try makeClient(),
            original: original(true))
        #expect(allowed.stageResolutionReset("spendingCategoryId"))
        let resetPatch = try allowed.patch()
        #expect(resetPatch.values.isEmpty)
        #expect(resetPatch.cleared == ["spendingCategoryId"])
        #expect(allowed.draft["notes"] == .string("Keep this"))
    }

    @Test func acknowledgedFieldDoesNotKeepStaleResolutionEvidence() throws {
        let field = try #require(EntityCatalog[.expense].field("spendingCategoryId"))
        let original: JSONValue = [
            "spendingCategoryId": "SPC-4K7M",
            "fieldResolutions": [
                "spendingCategoryId": [
                    "mode": "inherit", "storedValue": .null, "value": "SPC-4K7M", "fallbackValue": "SPC-4K7M",
                    "source": "purchase", "sourceEntity": .null, "matchesFallback": true, "canReset": false,
                ]
            ],
        ]
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"), client: try makeClient(),
            original: original)
        model.acknowledgeSavedField(
            "spendingCategoryId", value: .string("SPC-8K7M"), reviewedDraftValue: .null)
        let saved = try #require(model.original)
        #expect(FieldResolutionPresentation(raw: saved, field: field) == nil)
        #expect(try model.patch().values["spendingCategoryId"] == nil)
    }

    @Test func editedAssignmentOrDependencyCannotPresentSavedResolutionAsCurrent() throws {
        let field = try #require(EntityCatalog[.expense].field("spendingCategoryId"))
        let original: JSONValue = [
            "spendingCategoryId": "SPC-8K7M", "purchaseId": "PUR-4K7M",
            "fieldResolutions": [
                "spendingCategoryId": [
                    "mode": "explicit", "storedValue": "SPC-8K7M", "value": "SPC-8K7M",
                    "fallbackValue": "SPC-4K7M", "source": "explicit", "sourceEntity": .null,
                    "matchesFallback": false, "canReset": true,
                ]
            ],
        ]
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.expense], mode: .update(id: "EXP-4K7M"),
            client: try makeClient(), original: original)
        #expect(model.resolutionForEditor(field) != nil)
        model.draft["purchaseId"] = .string("PUR-8K7M")
        #expect(model.resolutionForEditor(field) == nil)
        #expect(!model.stageResolutionReset(field.key))
        model.draft["purchaseId"] = .string("PUR-4K7M")
        #expect(model.resolutionForEditor(field) != nil)
        #expect(model.stageResolutionReset(field.key))
        #expect(model.resolutionForEditor(field) == nil)
        #expect(!model.stageResolutionReset(field.key))
    }

    @Test func updateSendsExactlyTheChangedAndClearedKeys() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        let seen = capture { _ in (200, Self.productUpdated) }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: Self.productOriginal)
        #expect(!model.canSave)
        model.draft["manufacturer"] = "Lodge"
        model.draft["categoryId"] = .null
        #expect(model.canSave)
        let saved = await model.save()
        #expect(saved)
        #expect(model.savedID == "PRD-2345")
        let requests = seen.requests
        #expect(requests.count == 1)
        #expect(requests.first?.method == "PATCH")
        #expect(requests.first?.path == "/api/v1/products/PRD-2345")
        #expect(requests.first?.body == ["manufacturer": "Lodge", "categoryId": .null])
    }

    @Test func createPostsTheDraftAndReturnsTheID() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        let seen = capture { _ in (201, Self.locationCreated) }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.location], mode: .create(prefill: ["type": "area"]),
            client: try makeClient())
        #expect(model.missingRequiredKeys.contains("name"))
        #expect(!model.canSave)
        model.draft["name"] = "Bin 9"
        #expect(model.canSave)
        let saved = await model.save()
        #expect(saved)
        #expect(model.savedID == "LOC-9ABC")
        let requests = seen.requests
        #expect(requests.first?.method == "POST")
        #expect(requests.first?.path == "/api/v1/locations")
        #expect(requests.first?.body == ["name": "Bin 9", "type": "area"])
    }

    /// A failed read leaves no original to save; retrying the read must clear its error so the
    /// editor doesn't present the stale read failure as a refused save.
    @Test func retriedLoadClearsTheEarlierReadFailure() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        let productRead = try Fixtures.data(named: "product-get.json")
        let attempts = Mutex(0)
        // Reads carry no body, so this stub skips `capture`'s body recording.
        EditStub.handler.withLock { handler in
            handler = { _ in
                let attempt = attempts.withLock { count in
                    count += 1
                    return count
                }
                return attempt == 1
                    ? (500, Data(#"{"code":"INTERNAL","message":"upstream unavailable"}"#.utf8))
                    : (200, productRead)
            }
        }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient())
        await model.load()
        #expect(model.original == nil)
        #expect(model.bannerError != nil)
        #expect(!model.canSave)
        await model.load()
        #expect(model.original != nil)
        #expect(model.bannerError == nil)
    }

    @Test func validationRejectionLandsOnTheFieldAndKeepsTheDraft() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        _ = capture { _ in
            (
                400,
                Data(
                    #"{"code":"VALIDATION","message":"Invalid input","validationIssues":[{"code":"too_small","path":["name"],"message":"Name is required"}]}"#
                        .utf8)
            )
        }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: Self.productOriginal)
        model.draft["name"] = "x"
        let saved = await model.save()
        #expect(!saved)
        #expect(model.fieldErrors == ["name": "Name is required"])
        #expect(model.bannerError == nil)
        #expect(model.draft["name"] == "x")
        #expect(model.savedID == nil)
    }

    /// No entity declares `readOnlyOnUpdate` today; exercise the generic locking engine against
    /// a synthetic descriptor so the rule doesn't silently rot: a draft value for a locked key is
    /// dropped from the patch, and an update that changes only a locked key has nothing to send.
    @Test func lockedKeysNeverEnterTheBody() throws {
        let descriptor = Self.syntheticDescriptor(readOnlyOnUpdate: ["status"])
        let original: JSONValue = ["id": "X-1", "status": "growing", "note": "x"]
        let model = GenericEntityEditModel(
            descriptor: descriptor, mode: .update(id: "X-1"), client: try makeClient(), original: original)
        #expect(model.readOnly("status"))
        #expect(!model.readOnly("note"))
        model.draft["status"] = "finished"
        #expect(try model.patch().isEmpty)
        model.draft["note"] = "y"
        #expect(try model.patch().values == ["note": "y"])
    }

    /// No entity declares `readOnlyWhen` today; exercise the generic engine against a
    /// synthetic descriptor so the rule doesn't silently rot.
    @Test func readOnlyWhenLocksOnTheOriginalValue() throws {
        let rule = ReadOnlyRule(field: "kind", equals: .string("locked"), fields: ["note"])
        let descriptor = Self.syntheticDescriptor(readOnlyWhen: [rule])
        let client = try makeClient()
        let locked = GenericEntityEditModel(
            descriptor: descriptor, mode: .update(id: "X-1"), client: client,
            original: ["id": "X-1", "kind": "locked", "note": "x"])
        #expect(locked.readOnly("note"))
        let unlocked = GenericEntityEditModel(
            descriptor: descriptor, mode: .update(id: "X-2"), client: client,
            original: ["id": "X-2", "kind": "open", "note": "x"])
        #expect(!unlocked.readOnly("note"))
        let free = GenericEntityEditModel(
            descriptor: descriptor, mode: .create(prefill: [:]), client: client)
        #expect(!free.readOnly("note"))
    }

    /// A minimal `EntityDescriptor` for exercising `GenericEntityEditModel`'s field-independent
    /// engine (locking, patch diffing) without depending on any real catalog entity's shape.
    private static func syntheticDescriptor(
        readOnlyOnUpdate: [String] = [], readOnlyWhen: [ReadOnlyRule] = []
    ) -> EntityDescriptor {
        EntityDescriptor(
            key: .gardenEntry, singular: "record", plural: "records", basePath: "records",
            shortcodePrefix: nil, titleField: "id", domain: nil, sfSymbol: "circle", emoji: "📓",
            recordEmojiField: nil,
            searchable: false,
            primarySearch: nil,
            timeline: nil, fields: [], filters: [], relations: [],
            presentation: EntityPresentation(
                detailVariant: .standard, heroChip: nil, heroStats: [], heroBreadcrumb: nil,
                heroImages: false, heroActions: [], detailSections: [], connectedViews: [],
                listViews: [], listTotals: [], shelfSubtitle: [],
                listActions: [], timelineFields: [], lifecycle: nil, editSections: nil,
                readOnlyOnUpdate: readOnlyOnUpdate, readOnlyWhen: readOnlyWhen,
                editDateRanges: [], savedViews: []))
    }

    @Test func imageOrderTravelsOnlyWhenReordered() async throws {
        defer { EditStub.handler.withLock { $0 = nil } }
        let seen = capture { _ in (200, Self.productUpdated) }
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .update(id: "PRD-2345"), client: try makeClient(),
            original: Self.productOriginal)
        model.removedImages = [ImageCode("IMG-3456")]
        model.imageOrder = [ImageCode("IMG-2345"), ImageCode("IMG-4567")]
        #expect(model.canSave)
        #expect(await model.save())
        #expect(seen.requests.first?.body == ["removeImageIds": ["IMG-3456"]])

        model.imageOrder = [ImageCode("IMG-4567"), ImageCode("IMG-2345")]
        model.pendingUploads = [ImageCode("IMG-5678")]
        #expect(await model.save())
        let body = seen.requests.last?.body
        #expect(body?["imageOrder"] == ["IMG-4567", "IMG-2345"])
        #expect(body?["pendingImageIds"] == ["IMG-5678"])
    }

    @Test func sectionsFallBackToControlSectionGrouping() throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[.product], mode: .create(prefill: [:]), client: try makeClient())
        let sections = model.sections
        #expect(!sections.isEmpty)
        let placed = Set(sections.flatMap(\.fields))
        #expect(placed == Set(model.visibleFields.map(\.key)))
        #expect(model.visibleFields.allSatisfy { $0.inCreate && $0.controlKind != nil })
    }

    @Test(arguments: [EntityKey.ingredient, .wish, .meal])
    func smallEditorsUseOneMainSection(key: EntityKey) throws {
        let model = GenericEntityEditModel(
            descriptor: EntityCatalog[key], mode: .create(prefill: [:]), client: try makeClient())
        #expect(model.sections.map(\.id) == ["main"])
    }
}
