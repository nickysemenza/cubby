import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class CollectionStub: URLProtocol, @unchecked Sendable {
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

/// The verbs a report `records` block offers: the plans name the operations, and the one generic
/// runner executes them. Synthetic ids only.
@Suite("Records verbs", .timeLimit(.minutes(1)), .serialized)
struct CollectionActionTests {
    private struct Seen: Sendable {
        let method: String?
        let path: String
        let body: [String: JSONValue]
        let query: String
    }

    private final class Recorder: Sendable {
        let seen = Mutex<[Seen]>([])
        var requests: [Seen] { seen.withLock { $0 } }
    }

    private func makeRunner() throws -> HeroActionRunner {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return HeroActionRunner(
            client: CubbyClient(
                baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
                session: CollectionStub.session()))
    }

    private func capture(_ respond: @escaping @Sendable (URLRequest) -> (Int, Data)) -> Recorder {
        let recorder = Recorder()
        CollectionStub.handler.withLock { handler in
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

    private static func row(_ id: String, raw: JSONValue = [:]) -> EntityRow {
        EntityRow(id: id, title: "Sample", subtitle: nil, imageURL: nil, raw: raw)
    }

    private func plan(_ action: CollectionActionID, _ entity: EntityKey) throws -> HeroActionPlan {
        try #require(HeroActionRunner.plan(for: action, on: entity), "\(action)")
    }

    // MARK: - Manifest

    @Test func everyDeclaredActionHasAPlanTheRunnerHandles() throws {
        let coverage = NativeCoverageManifest.shared
        #expect(Set(coverage.collectionActionPlan.keys) == Set(CollectionActionID.allCases.map(\.rawValue)))
        for action in CollectionActionID.allCases {
            let plan = try #require(coverage.collectionActionPlan[action.rawValue], "\(action)")
            let operation = try #require(plan.operation, "\(action) is an operation plan")
            #expect(OperationRoute.all[operation.operation] != nil, "\(action): \(operation.operation)")
            #expect(HeroActionRunner.handledOperations.contains(operation.operation), "\(action)")
            if let preview = operation.preview {
                #expect(OperationRoute.all[preview.operation] != nil, "\(action) preview")
                #expect(HeroActionRunner.handledPreviews.contains(preview.operation), "\(action) preview")
            }
            #expect(operation.confirmation == .none)
        }
    }

    @Test func aVerbIsOnlyOfferedOnTheEntitiesItsPlanNames() {
        #expect(HeroActionRunner.plan(for: .analyzeLocation, on: .location) != nil)
        #expect(HeroActionRunner.plan(for: .analyzeLocation, on: .product) == nil)
        #expect(HeroActionRunner.plan(for: .attachImage, on: .image) != nil)
    }

    @Test func onlyTheLabelReviewActsOnARow() throws {
        #expect(CollectionActionID.reviewLabelNutrition.scope == .row)
        for action in [CollectionActionID.analyzeLocation, .attachImage] {
            #expect(action.scope == .section, "\(action)")
        }
        // A row action's body reads the tapped row; none of the section actions do.
        let review = try #require(try plan(.reviewLabelNutrition, .product).operation)
        #expect(review.body["id"] == "$item.id")
    }

    // MARK: - Rows

    @Test func recordRowsCarryThumbnailBadgesAndTheInstant() throws {
        let report = try JSONDecoder.cubby().decode(
            EntityReportOut.self,
            from: Data(
                #"""
                {"blocks":[{"kind":"records","title":null,"empty":"None.","actions":["attachImage"],"rows":[
                  {"entity":"run","id":"RUN-4K7M","title":"Sample Vendor","subtitle":"line one\nline two","trailing":"failed",
                   "imageUrl":"https://media.example.test/a.jpg","badges":["login_expired"],"at":"2026-03-04T10:15:00.000Z",
                   "listLink":{"entity":"recipe","filters":{"source":"CKB-4K7M"}},"actions":["reviewLabelNutrition"]},
                  {"entity":null,"id":null,"title":"Plain","subtitle":null,"trailing":null}
                ]}]}
                """#.utf8))
        guard case .records(let records)? = ReportPresentation(report).blocks.first else {
            Issue.record("expected a records block")
            return
        }
        #expect(records.actions == [.attachImage])
        #expect(records.rows.map(\.title) == ["Sample Vendor", "Plain"])
        let first = try #require(records.rows.first)
        #expect(first.entity == .run && first.recordID == "RUN-4K7M")
        #expect(first.imageURL?.absoluteString == "https://media.example.test/a.jpg")
        #expect(first.badges == ["login_expired"])
        #expect(first.at == Date(timeIntervalSince1970: 1_772_619_300))
        // A row's list link resolves its URL key to the list's wire parameter, and the verbs are
        // the ones the server offered on this row.
        #expect(first.listLink?.entity == .recipe)
        #expect(first.listLink?.filterState.names == ["cookbookId"])
        #expect(first.actions == [.reviewLabelNutrition])
        // A row that names no record reads without a link, thumbnail, badge or instant.
        let plain = records.rows[1]
        #expect(plain.entity == nil && plain.imageURL == nil && plain.badges.isEmpty && plain.at == nil)
    }

    // MARK: - Plans

    @Test func theTappedRowFillsItsSlotAndNothingElseDoes() {
        let body = HeroActionRunner.fill(
            ["id": "$item.id", "locationId": "$row.id", "literal": "$item.name"],
            rowID: "PRD-4K7M", itemID: "IMG-4K7M", values: [:])
        #expect(body["id"] == "IMG-4K7M")
        #expect(body["locationId"] == "PRD-4K7M")
        #expect(body["literal"] == "$item.name")
        // A section action has no tapped row: its slot stays null instead of leaking a record id.
        #expect(HeroActionRunner.fill("$item.id", rowID: "PRD-4K7M", values: [:]) == .null)
    }

    @Test func analyzingNeedsAPhotoAndSaysWhy() throws {
        let analyze = try plan(.analyzeLocation, .location)
        #expect(
            HeroActionRunner.unmet(analyze, in: ["images": []])
                == "Add a photo to this location to analyze it.")
        #expect(HeroActionRunner.unmet(analyze, in: [:]) != nil)
        #expect(HeroActionRunner.unmet(analyze, in: ["images": [["id": "IMG-4K7M"]]]) == nil)
        // Plans without a requirement are always offered.
        #expect(HeroActionRunner.unmet(try plan(.attachImage, .image), in: [:]) == nil)
    }

    @Test func analyzingPostsTheLocationAndOffersTheServersPreviousVersusNewReview() async throws {
        let recorder = capture { _ in
            (
                200,
                Data(
                    #"{"description":"Shelves of jars and a tarp","confidence":"high","previousDescription":"Shelves of jars","cache":{"status":"miss","feature":"location-description","model":"sample-model","promptVersion":"1","inputFingerprint":"f"},"analyzedAt":"2026-06-03T00:00:00.000Z"}"#
                        .utf8)
            )
        }
        let outcome = try await makeRunner().perform(
            try plan(.analyzeLocation, .location), on: .location, row: Self.row("LOC-4K7M"),
            values: [:], confirmed: false)
        #expect(recorder.requests.first?.path == "/api/v1/ai/describeLocation")
        #expect(recorder.requests.first?.body["locationId"] == "LOC-4K7M")
        // The run already saved the description, so the review is an acknowledgement: it carries
        // both sides of the diff, the model and the answer's age, and the screens that show the
        // location refresh behind it. Keep and Hide change nothing, as on web.
        guard case .review(let review) = outcome else {
            Issue.record("expected a review")
            return
        }
        #expect(review.previous == "Shelves of jars")
        #expect(review.proposed == "Shelves of jars and a tarp")
        #expect(review.confidence == "high")
        #expect(review.model == "sample-model")
        #expect(review.cacheStatus == "miss")
        #expect(review.changed == [.location])
    }

    @Test func aFirstAnalysisHasNothingToCompareAgainst() async throws {
        _ = capture { _ in
            (
                200,
                Data(
                    #"{"description":"Shelves of jars","confidence":"low","previousDescription":null,"cache":{"status":"hit","feature":"location-description","model":"m","promptVersion":"1","inputFingerprint":"f"},"analyzedAt":"2026-06-03T00:00:00.000Z"}"#
                        .utf8)
            )
        }
        let outcome = try await makeRunner().perform(
            try plan(.analyzeLocation, .location), on: .location, row: Self.row("LOC-4K7M"),
            values: [:], confirmed: false)
        guard case .review(let review) = outcome else {
            Issue.record("expected a review")
            return
        }
        #expect(review.previous == nil)
        #expect(review.cacheStatus == "hit")
    }

    @Test func attachingTrimsTheShortcodeAndSendsAPurposeOnlyForProducts() async throws {
        let recorder = capture { request in
            let target = request.url?.path.hasSuffix("attachExisting") == true ? "PRD-4K7M" : ""
            return (200, Data(#"{"imageId":"IMG-4K7M","targetId":"\#(target)","reused":false}"#.utf8))
        }
        let runner = try makeRunner()
        let attach = try plan(.attachImage, .image)
        let product = try await runner.perform(
            attach, on: .image, row: Self.row("IMG-4K7M"),
            values: ["targetId": " prd-4k7m ", "purpose": "label"], confirmed: false)
        let sent = try #require(recorder.requests.first)
        #expect(sent.path == "/api/v1/image/attachExisting")
        #expect(sent.body["targetId"] == "PRD-4K7M")
        #expect(sent.body["purpose"] == "label")
        // The screens showing the image and the record it joined both refresh.
        guard case .completed(_, let changed) = product else {
            Issue.record("expected completion")
            return
        }
        #expect(changed == [.image, .product])

        _ = try await runner.perform(
            attach, on: .image, row: Self.row("IMG-4K7M"),
            values: ["targetId": "RCP-4K7M", "purpose": "label"], confirmed: false)
        // The server rejects a purpose on any record that is not a Product.
        #expect(recorder.requests.last?.body["targetId"] == "RCP-4K7M")
        #expect(recorder.requests.last?.body["purpose"] == nil)
    }

    @Test func attachingNeedsATarget() async throws {
        let recorder = capture { _ in (200, Data()) }
        await #expect(throws: HeroActionError.missing("targetId")) {
            try await makeRunner().perform(
                try plan(.attachImage, .image), on: .image, row: Self.row("IMG-4K7M"),
                values: ["targetId": "  "], confirmed: false)
        }
        #expect(recorder.requests.isEmpty)
    }

    // MARK: - Detected label nutrition

    private static let analyses: JSONValue = [
        "analyses": [
            [
                "preferred": false, "createdAt": "2026-01-01T00:00:00.000Z",
                "result": ["nutritionFacts": ["servingGrams": 1, "nutrients": [:]]],
            ],
            [
                "preferred": true, "createdAt": "2026-02-02T00:00:00.000Z",
                "result": ["nutritionFacts": ["servingGrams": 30, "nutrients": ["kcal": 120]]],
            ],
        ]
    ]

    @Test func detectedNutritionIsTheStampedPreferredAnalysis() throws {
        let value = try HeroActionRunner.detectedValue(in: Self.analyses, imageID: "IMG-4K7M", saved: nil)
        #expect(value["servingGrams"] == 30)
        #expect(value["nutrients"]?["kcal"] == 120)
        #expect(value["source"] == "Package label IMG-4K7M · analysis 2026-02-02T00:00:00.000Z")
    }

    @Test func detectedNutritionIsRefusedWhenAbsentOrAlreadySaved() throws {
        #expect(throws: HeroActionError.self) {
            try HeroActionRunner.detectedValue(in: ["analyses": []], imageID: "IMG-4K7M", saved: nil)
        }
        let saved: JSONValue = ["source": "Package label IMG-4K7M · analysis 2026-02-02T00:00:00.000Z"]
        #expect(throws: HeroActionError.self) {
            try HeroActionRunner.detectedValue(in: Self.analyses, imageID: "IMG-4K7M", saved: saved)
        }
        // A different label's saved evidence does not block this one.
        let other: JSONValue = ["source": "Package label IMG-5K7M · analysis 2026-02-02T00:00:00.000Z"]
        #expect(throws: Never.self) {
            try HeroActionRunner.detectedValue(in: Self.analyses, imageID: "IMG-4K7M", saved: other)
        }
    }
}
