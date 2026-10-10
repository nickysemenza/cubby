import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class HeroStub: URLProtocol, @unchecked Sendable {
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

/// The generic hero-action runner: a manifest verb maps to one generated operation, destructive
/// verbs cannot run unconfirmed, and the request body is exactly the plan's template filled from
/// the form. Synthetic ids throughout.
@Suite("HeroActionRunner", .timeLimit(.minutes(1)), .serialized)
struct HeroActionRunnerTests {
    private struct Seen: Sendable {
        let method: String?
        let path: String
        let body: [String: JSONValue]
        let query: String
    }

    private final class Recorder: Sendable {
        let seen = Mutex<[Seen]>([])
        var requests: [Seen] { seen.withLock { $0 } }
        var queries: [String] { requests.map(\.query) }
    }

    private func makeRunner() throws -> HeroActionRunner {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return HeroActionRunner(
            client: CubbyClient(
                baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
                session: HeroStub.session()))
    }

    private func capture(_ respond: @escaping @Sendable (URLRequest) -> (Int, Data)) -> Recorder {
        let recorder = Recorder()
        HeroStub.handler.withLock { handler in
            handler = { request in
                let data = (try? Self.requestBody(request)) ?? Data()
                let fields = (try? JSONDecoder().decode([String: JSONValue].self, from: data)) ?? [:]
                recorder.seen.withLock {
                    $0.append(
                        Seen(
                            method: request.httpMethod, path: request.url?.path ?? "", body: fields,
                            query: request.url?.query ?? ""))
                }
                return respond(request)
            }
        }
        return recorder
    }

    nonisolated private static func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }

    nonisolated private static let deleted = Data(
        #"{"action":"delete","entity":"task","deletedReferences":[],"affectedEdges":[],"sideEffects":{}}"#
            .utf8)
    nonisolated private static let discarded = Data(
        #"{"expenseId":"EXP-4K7M","storedQuantity":-2,"inventory":null,"sideEffects":{}}"#.utf8)

    private static func row(_ id: String, raw: JSONValue = [:]) -> EntityRow {
        EntityRow(id: id, title: "Sample", subtitle: nil, imageURL: nil, raw: raw)
    }

    // MARK: - Verb to operation

    @Test func everyImplementedVerbHasAPlanAndNothingElseDoes() {
        let coverage = NativeCoverageManifest.shared
        let implemented = Set(coverage.heroAction.filter { $0.value == .implemented }.keys)
        #expect(Set(coverage.heroActionPlan.keys) == implemented)
    }

    @Test func everyPlanOperationIsAGeneratedRouteTheRunnerHandles() throws {
        for (verb, plan) in NativeCoverageManifest.shared.heroActionPlan {
            guard case .operation(let operation) = plan.kind else { continue }
            #expect(OperationRoute.all[operation.operation] != nil, "\(verb): \(operation.operation)")
            #expect(HeroActionRunner.handledOperations.contains(operation.operation), "\(verb)")
            if let preview = operation.preview {
                #expect(OperationRoute.all[preview.operation] != nil, "\(verb) preview")
                #expect(HeroActionRunner.handledPreviews.contains(preview.operation), "\(verb) preview")
            }
        }
    }

    @Test func deleteResolvesToTheEntitysGeneratedDeleteRoute() throws {
        for key in EntityKey.allCases where key.nativeActions.contains(.delete) {
            let plan = try #require(HeroActionRunner.plan(for: .delete, on: key), "\(key)")
            let id = try #require(HeroActionRunner.operationID(for: plan, on: key), "\(key)")
            #expect(OperationRoute.all[id]?.method == .delete)
        }
        // The detail sheet's old "Preview delete impact" gate is now true for resource entities.
        #expect(EntityKey.task.nativeActions.contains(.delete))
    }

    @Test func aVerbIsOnlyOfferedOnEntitiesItsPlanNames() {
        #expect(HeroActionRunner.plan(for: .discard, on: .product) != nil)
        #expect(HeroActionRunner.plan(for: .discard, on: .task) == nil)
        #expect(HeroActionRunner.plan(for: .setStatus, on: .project) != nil)
        #expect(HeroActionRunner.plan(for: .markPurchased, on: .wish) != nil)
        #expect(HeroActionRunner.plan(for: .recordSale, on: .product) != nil)
        #expect(HeroActionRunner.plan(for: .addToInventory, on: .product) != nil)
        #expect(HeroActionRunner.plan(for: .delete, on: .task) != nil)
        // List/multi-select and toolbar verbs are classified elsewhere, not faked here.
        #expect(HeroActionRunner.plan(for: .bulkEdit, on: .task) == nil)
        #expect(HeroActionRunner.plan(for: .edit, on: .task) == nil)
    }

    // MARK: - Confirmation

    @Test func destructiveVerbsRequireConfirmation() throws {
        let delete = try #require(HeroActionRunner.plan(for: .delete, on: .task))
        let discard = try #require(HeroActionRunner.plan(for: .discard, on: .product))
        #expect(delete.confirmation == .destructive)
        #expect(discard.confirmation == .destructive)
        for (verb, entity) in [
            (EntityHeroActionID.addToInventory, EntityKey.product), (.recordSale, .product),
            (.setStatus, .project), (.markPurchased, .wish),
        ] {
            #expect(HeroActionRunner.plan(for: verb, on: entity)?.confirmation == HeroActionConfirmation.none)
        }
    }

    @Test func unconfirmedDeleteSendsNothing() async throws {
        let recorder = capture { _ in (200, Self.deleted) }
        let runner = try makeRunner()
        let plan = try #require(HeroActionRunner.plan(for: .delete, on: .task))
        await #expect(throws: HeroActionError.confirmationRequired) {
            try await runner.perform(
                plan, on: .task, row: Self.row("TSK-4K7M"), values: [:], confirmed: false)
        }
        #expect(recorder.requests.isEmpty)
    }

    @Test func confirmedDeleteCallsTheGeneratedDeleteRoute() async throws {
        let recorder = capture { _ in (200, Self.deleted) }
        let runner = try makeRunner()
        let plan = try #require(HeroActionRunner.plan(for: .delete, on: .task))
        _ = try await runner.perform(plan, on: .task, row: Self.row("TSK-4K7M"), values: [:], confirmed: true)
        let request = try #require(recorder.requests.first)
        #expect(request.method == "DELETE")
        #expect(request.path == "/api/v1/tasks/TSK-4K7M")
    }

    @Test func unconfirmedDiscardSendsNothing() async throws {
        let recorder = capture { _ in (200, Self.discarded) }
        let runner = try makeRunner()
        let plan = try #require(HeroActionRunner.plan(for: .discard, on: .product))
        await #expect(throws: HeroActionError.confirmationRequired) {
            try await runner.perform(
                plan, on: .product, row: Self.row("PRD-4K7M"), values: ["quantity": 2], confirmed: false)
        }
        #expect(recorder.requests.isEmpty)
    }

    // MARK: - Body

    @Test func discardBodyFillsSlotsAndNullsAHiddenShelf() throws {
        let plan = try #require(HeroActionRunner.plan(for: .discard, on: .product))
        guard case .operation(let operation) = plan.kind else {
            Issue.record("not an operation")
            return
        }
        let values = try HeroActionRunner.resolvedValues(
            operation.fields,
            values: [
                "quantity": 2, "trade": "other", "date": "2026-06-03", "reason": "  ",
                "adjustInventory": false, "inventoryEntryId": "INV-4K7M",
            ])
        let body = HeroActionRunner.fill(operation.body, rowID: "PRD-4K7M", values: values)
        #expect(body["productId"] == "PRD-4K7M")
        #expect(body["quantity"] == 2)
        // Mirrors the web dialog: a blank reason is null, and a shelf is only sent while the
        // shelf toggle is on.
        #expect(body["reason"] == .null)
        #expect(body["inventoryEntryId"] == .null)
        #expect(body["adjustInventory"] == false)
    }

    @Test func aMissingRequiredFieldIsRefusedBeforeAnyRequest() throws {
        let plan = try #require(HeroActionRunner.plan(for: .addToInventory, on: .product))
        guard case .operation(let operation) = plan.kind else {
            Issue.record("not an operation")
            return
        }
        #expect(throws: HeroActionError.missing("location")) {
            try HeroActionRunner.resolvedValues(
                operation.fields, values: ["amount": ["value": 1, "unit": "each"]])
        }
    }

    @Test func discardPostsTheFilledBody() async throws {
        let recorder = capture { _ in (200, Self.discarded) }
        let runner = try makeRunner()
        let plan = try #require(HeroActionRunner.plan(for: .discard, on: .product))
        _ = try await runner.perform(
            plan, on: .product, row: Self.row("PRD-4K7M"),
            values: [
                "quantity": 2, "trade": "other", "date": "2026-06-03", "adjustInventory": true,
                "inventoryEntryId": "INV-4K7M",
            ], confirmed: true)
        let request = try #require(recorder.requests.first)
        #expect(request.method == "POST")
        #expect(request.path == "/api/v1/product/discard")
        #expect(request.body["productId"] == "PRD-4K7M")
        #expect(request.body["inventoryEntryId"] == "INV-4K7M")
        #expect(request.body["date"] == "2026-06-03")
    }

    nonisolated private static let twoShelves = Data(
        #"{"productName":"Sample","shelves":[{"id":"INV-4K7M","amount":{"value":3,"unit":"each"},"location":{"id":"LOC-4K7M","name":"Workshop"}},{"id":"INV-5K7M","amount":{"value":12,"unit":"each"},"location":{"id":"LOC-5K7M","name":"Garage"}}],"ledgerOnly":false,"selectedShelf":null,"defaultQuantity":1,"needsShelfChoice":true,"warning":null}"#
            .utf8)

    nonisolated private static let oneShelf = Data(
        #"{"productName":"Sample","shelves":[{"id":"INV-4K7M","amount":{"value":0.5,"unit":"each"},"location":{"id":"LOC-4K7M","name":"Workshop"}}],"ledgerOnly":false,"selectedShelf":{"id":"INV-4K7M","amount":{"value":0.5,"unit":"each"},"location":{"id":"LOC-4K7M","name":"Workshop"}},"defaultQuantity":0.5,"needsShelfChoice":false,"warning":null}"#
            .utf8)

    @MainActor private func discardModel(_ preview: Data) throws -> (HeroActionModel, Recorder) {
        let recorder = capture { request in
            request.url?.path.hasSuffix("discardPreview") == true ? (200, preview) : (200, Self.discarded)
        }
        let plan = try #require(HeroActionRunner.plan(for: .discard, on: .product))
        let model = HeroActionModel(
            plan: plan, entity: .product, row: Self.row("PRD-4K7M"), runner: try makeRunner())
        return (model, recorder)
    }

    @MainActor @Test func discardCannotSubmitUntilTheServerAnswersAndAShelfIsChosen() async throws {
        let (model, _) = try discardModel(Self.twoShelves)
        // Before the first preview the verdict is unknown: never submit ahead of it.
        #expect(!model.canSubmit)
        await model.refreshPreview()
        #expect(model.shelfOptions.map(\.value) == ["INV-4K7M", "INV-5K7M"])
        // Several shelves, none chosen: the server owes the operator a choice, not a guess.
        #expect(!model.canSubmit)
    }

    @MainActor @Test func theServerSeedsTheSoleShelfAndTheDefaultQuantity() async throws {
        let (model, _) = try discardModel(Self.oneShelf)
        await model.refreshPreview()
        // Native never decides these: it renders the preview's selected shelf and default.
        #expect(model.values["inventoryEntryId"] == "INV-4K7M")
        #expect(model.values["quantity"] == 0.5)
        // The preview answered the form as it stood before seeding, so it must refresh first.
        #expect(!model.canSubmit)
        await model.refreshPreview()
        #expect(model.canSubmit)
    }

    @MainActor @Test func aServerDefaultNeverOverwritesAnEditEvenBackToTheSeed() async throws {
        let (model, _) = try discardModel(Self.oneShelf)
        // The person types the same value the form was seeded with: still their choice.
        model.setValue("quantity", 1)
        await model.refreshPreview()
        #expect(model.values["quantity"] == 1)
    }

    @MainActor @Test func aStalePreviewNeverEnablesSubmit() async throws {
        let (model, _) = try discardModel(Self.oneShelf)
        await model.refreshPreview()
        await model.refreshPreview()
        #expect(model.canSubmit)
        model.setValue("quantity", 7)
        #expect(!model.canSubmit)
        #expect(model.advisory == nil)
    }

    @MainActor @Test func aFailedPreviewClearsTheOldAnswer() async throws {
        let (model, _) = try discardModel(Self.oneShelf)
        await model.refreshPreview()
        await model.refreshPreview()
        #expect(model.canSubmit)
        _ = capture { _ in (500, Data()) }
        model.setValue("quantity", 2)
        await model.refreshPreview()
        #expect(model.preview == nil)
        #expect(!model.canSubmit)
    }

    @MainActor @Test func previewsSendNormalizedValues() async throws {
        let (model, recorder) = try discardModel(Self.twoShelves)
        model.setValue("inventoryEntryId", "")
        await model.refreshPreview()
        let query = try #require(recorder.queries.first)
        // A blank shelf is null (omitted), never an empty string the server would reject.
        #expect(!query.contains("inventoryEntryId"))
    }

    @MainActor @Test func submitStartsOnlyOnceForRepeatedTaps() async throws {
        let (model, recorder) = try discardModel(Self.oneShelf)
        await model.refreshPreview()
        await model.refreshPreview()
        let finished = Mutex(0)
        model.submit(confirmed: true) { _ in finished.withLock { $0 += 1 } }
        model.submit(confirmed: true) { _ in finished.withLock { $0 += 1 } }
        #expect(model.isRunning)
        await model.submission?.waitUnlessCancelled()
        #expect(recorder.requests.filter { $0.path.hasSuffix("/discard") }.count == 1)
        #expect(finished.withLock { $0 } == 1)
    }

    @Test func markPurchasedFlipsTheAcquiredFlagFromItsState() async throws {
        let recorder = capture { _ in (200, Data()) }
        let runner = try makeRunner()
        let plan = try #require(HeroActionRunner.plan(for: .markPurchased, on: .wish))
        _ = try? await runner.perform(
            plan, on: .wish, row: Self.row("WSH-4K7M", raw: ["acquiredAt": .null]), values: [:],
            confirmed: false)
        let unacquired = try #require(recorder.requests.first)
        #expect(unacquired.method == "PATCH")
        #expect(unacquired.path == "/api/v1/wishes/WSH-4K7M")
        #expect(unacquired.body["acquired"] == true)
        _ = try? await runner.perform(
            plan, on: .wish, row: Self.row("WSH-4K7M", raw: ["acquiredAt": "2026-06-03T00:00:00.000Z"]),
            values: [:], confirmed: false)
        #expect(recorder.requests.last?.body["acquired"] == false)
    }

    @Test func recordSaleOpensTheExpenseEditorSeededWithTheProduct() async throws {
        let runner = try makeRunner()
        let plan = try #require(HeroActionRunner.plan(for: .recordSale, on: .product))
        let outcome = try await runner.perform(
            plan, on: .product, row: Self.row("PRD-4K7M"), values: [:], confirmed: false)
        guard case .editor(let entity, let prefill, let context) = outcome else {
            Issue.record("expected editor")
            return
        }
        #expect(entity == .expense)
        #expect(prefill["productId"] == "PRD-4K7M")
        #expect(prefill["costType"] == "tools")
        // An explicit null overrides any default the editor would otherwise seed.
        #expect(prefill["projectId"] == .null)
        // The same disposition context web opens the expense editor with: its title and guidance
        // come from the plan, not from a native special case.
        #expect(context?.title == "Record Sale or Disposal")
        #expect(context?.description.contains("negative cost") == true)
    }

    @Test func aCreatePlanWithoutEditorCopyOpensAPlainEditor() throws {
        let plan = try JSONDecoder().decode(
            HeroActionPlan.self,
            from: Data(
                """
                {"kind":"create","label":"Add","symbol":"plus","entity":"task","entities":["product"],
                 "seed":{"productId":"$row.id"}}
                """.utf8))
        guard case .create(_, _, let editor) = plan.kind else {
            Issue.record("expected create")
            return
        }
        #expect(editor == nil)
    }
}
