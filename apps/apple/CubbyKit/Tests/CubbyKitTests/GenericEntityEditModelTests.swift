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
        #"{"action":"update","entity":"product","item":{"id":"PRD-2345","name":"Sample","aliases":[],"tags":[],"manufacturer":"x","model":null,"notes":null,"expectedQuantity":null,"categoryId":null,"images":[],"externalIds":[],"pricing":{"source":"explicit","knownExpenseCount":0,"unknownExpenseCount":0,"knownUnitCount":0,"partial":false},"usdaUnavailable":null,"stockTracked":null,"dataQuality":{"status":"complete","score":100,"facets":[],"gaps":[],"exceptions":[],"relatedGaps":[],"relatedExceptions":[]},"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","category":null,"itemImageCount":0,"labelImageCount":0,"labelImages":[],"classificationEvidence":"","coverImageUrl":null},"sideEffects":{"backgroundBatches":[]}}"#
            .utf8)
    nonisolated private static let locationCreated = Data(
        #"{"action":"create","entity":"location","item":{"id":"LOC-9ABC","name":"Bin 9","aliases":[],"notes":null,"lastBulkInventory":null,"aiDescription":null,"images":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"sideEffects":{"backgroundBatches":[]}}"#
            .utf8)

    private static let productOriginal: JSONValue = [
        "id": "PRD-2345", "name": "Skillet", "manufacturer": "Sample Co", "categoryId": "CAT-2224",
        "attachments": [["id": "IMG-2345"], ["id": "IMG-3456"], ["id": "IMG-4567"]],
    ]

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
            searchable: false,
            primarySearch: nil,
            timeline: nil, fields: [], filters: [], relations: [],
            presentation: EntityPresentation(
                detailVariant: .standard, heroChip: nil, heroStats: [], heroBreadcrumb: nil,
                heroImages: false, heroActions: [], detailSections: [], listViews: [], shelfSubtitle: [],
                listActions: [], timelineFields: [], lifecycle: nil, editSections: nil,
                readOnlyOnUpdate: readOnlyOnUpdate, readOnlyWhen: readOnlyWhen))
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
}
