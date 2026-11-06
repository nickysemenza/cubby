import CoreGraphics
import CubbyKit
import Foundation
import SwiftUI
import Synchronization

/// Models and sample data for `#Preview` blocks. Nothing here touches the Keychain or the
/// network: the token store is in-memory and the base URL points at a host that does not exist.
enum PreviewFixtures {
    static let previewURL = URL(string: "http://cubby.preview.invalid")!

    /// A wire-shaped fixture, decoded exactly as the generated client decodes a response. A
    /// fixture that fails to decode is a programming error in the preview, not a runtime state.
    nonisolated static func decode<T: Decodable>(_ json: String) -> T {
        decode(Data(json.utf8))
    }

    /// A generated fixture: `Fixtures/<name>.json`, written by `pnpm generate` from the zod
    /// schemas (`apps/web/tooling/checks/apple-preview-fixtures.ts`) and bundled as a resource.
    nonisolated static func fixture<T: Decodable>(_ name: String) -> T {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json"),
            let data = try? Data(contentsOf: url)
        else { fatalError("Preview fixture \(name).json is missing; run pnpm generate") }
        return decode(data)
    }

    private nonisolated static func decode<T: Decodable>(_ data: Data) -> T {
        do {
            return try JSONDecoder.cubby().decode(T.self, from: data)
        } catch {
            fatalError("Preview fixture does not decode as \(T.self): \(error)")
        }
    }

    static func signedOutModel() -> AppModel {
        AppModel.preview(signedIn: false, baseURL: previewURL)
    }

    static func signedInModel() -> AppModel {
        AppModel.preview(signedIn: true, baseURL: previewURL)
    }

    static let sampleLocation = LocationCode("LOC-2345")

    static let sampleRows: [EntityRow] = [
        EntityRow(
            id: "PRD-2345", title: "Sample Product", subtitle: "Sample Manufacturer", imageURL: nil,
            raw: .object([:])),
        EntityRow(id: "PRD-3456", title: "Another Product", subtitle: nil, imageURL: nil, raw: .object([:])),
    ]

    /// A product-shaped detail row covering every `EntityFieldValue.text` branch (string, date,
    /// boolean, array) for value-formatting tests. Screen previews use `EntityScreenFixture`.
    static let sampleDetailRow = EntityRow(
        id: "PRD-2345",
        title: "Cast Iron Skillet",
        subtitle: "Lodge",
        imageURL: nil,
        raw: .object([
            "id": .string("PRD-2345"),
            "name": .string("Cast Iron Skillet"),
            "brandId": .string("VEN-2345"), "brandName": .string("Lodge"),
            "categoryId": .string("CAT-2224"),
            "category": .object([
                "id": .string("CAT-2224"), "name": .string("Tools"),
                "path": .array([.object(["id": .string("CAT-2224"), "name": .string("Tools")])]),
                "feature": .string("tools"),
            ]),
            "createdAt": .string("2026-01-15T18:30:00.000Z"),
            "stockTracked": .bool(true),
            "tags": .array([.string("kitchen"), .string("cast-iron")]),
        ])
    )

    /// A product movement timeline for `EntityTimelineView`'s preview: one confident interval,
    /// one open unconfirmed one, a sale marker, and two date groups.
    static let sampleTimeline: EntityTimelineOut = fixture("sampleTimeline")

    /// Ranked candidates for `IdentifyResultsSection` previews; distances are illustrative only.
    static let sampleCandidates: [IdentificationCandidate] = [
        IdentificationCandidate(
            productID: ProductCode("PRD-1001"), name: "Cast Iron Skillet",
            imageURL: URL(string: "https://example.invalid/covers/skillet.jpg")!, distance: 0.412),
        IdentificationCandidate(
            productID: ProductCode("PRD-1002"), name: "Enameled Dutch Oven",
            imageURL: URL(string: "https://example.invalid/covers/dutch-oven.jpg")!, distance: 0.877),
        IdentificationCandidate(
            productID: ProductCode("PRD-1003"), name: "Carbon Steel Wok",
            imageURL: URL(string: "https://example.invalid/covers/wok.jpg")!, distance: 1.203),
    ]

    /// A synthesized solid-color image so the probe thumbnail has something to render in
    /// `#Preview`s without decoding a real photo.
    static let sampleProbeImage: CGImage = {
        let size = 160
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = CGContext(
            data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
            space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.setFillColor(CGColor(red: 0.85, green: 0.87, blue: 0.91, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        return context.makeImage()!
    }()

    /// The shared task briefing report used by Today.
    static let sampleTodayBriefing: EntityReportOut = fixture("sampleTodayBriefing")

    /// Today's meal list rows, for `TodayView`'s preview.
    static let sampleTodayMeals: [EntityRow] = {
        let raw: [JSONValue] = fixture("sampleTodayMeals")
        return raw.compactMap { EntityCatalog[.meal].row(from: $0) }
    }()

    /// `PhotoDiagnosticsView`'s preview: one entity passing its routing policy, one missing, and a
    /// Foundation Models decision — enough to exercise every section without a real Vision run.
    static let samplePhotoDiagnosticsReport: PhotoDiagnosticsReport = decode(
        """
        {"file": {"filename": "shelf.jpg", "contentType": "image/jpeg", "width": 3024, "height": 4032,
                   "capturedAt": "2026-09-12T20:28:43.000Z", "aspectRatio": 1.3333},
         "hashes": {"sha256": "4bc854c1e872345c8869713bcb39092f6ba6a40a9edcacd357131bd8694f907",
                    "perceptualHash": "d362ab134d00fb3d",
                    "sourceFingerprint": {"hash": "d362ab134d00fb3d", "aspectRatio": 1.3333}},
         "classifications": [{"identifier": "plant", "confidence": 0.895},
                              {"identifier": "foliage", "confidence": 0.72}],
         "recognizedText": [{"text": "Lodge", "confidence": 0.91}],
         "featurePrint": {"revision": "vision-feature-print-2", "bytes": 4352, "data": null},
         "routing": [
           {"entity": "planting", "emoji": "🌱", "classifierIdentifier": "plant", "classifierConfidence": 0.895,
            "minimumScore": 0.76, "meetsMinimumScore": true, "wantedLabels": ["plant", "garden"],
            "candidateFields": ["name"], "temporalFields": ["plantedOn"], "ocrFields": []},
           {"entity": "product", "emoji": "📦", "classifierIdentifier": null, "classifierConfidence": null,
            "minimumScore": 0.72, "meetsMinimumScore": false, "wantedLabels": ["product"],
            "candidateFields": ["name", "brandName"], "temporalFields": [], "ocrFields": ["name"]}],
         "suggestedSource": "planting",
         "semanticModel": "available",
         "semantic": {"status": "used",
                      "decisions": [{"photoID": "shelf.jpg", "routeID": "planting-self",
                                     "candidateID": "type:planting", "explanation": "Deterministic local evidence"}]},
         "timings": {"analyzeMs": 102, "semanticMs": 340}}
        """)

    static let sampleMealNutrition: MealNutritionOut = fixture("sampleMealNutrition")
}

struct SignedInPreview: PreviewModifier {
    static func makeSharedContext() -> Void {}
    func body(content: Content, context: Void) -> some View {
        PreviewSession(signedIn: true) { content }
    }
}

struct SignedOutPreview: PreviewModifier {
    static func makeSharedContext() -> Void {}
    func body(content: Content, context: Void) -> some View {
        PreviewSession(signedIn: false) { content }
    }
}

private struct PreviewSession<Content: View>: View {
    private let content: Content
    @State private var model: AppModel

    init(signedIn: Bool, @ViewBuilder content: () -> Content) {
        self.content = content()
        _model = State(
            initialValue: signedIn ? PreviewFixtures.signedInModel() : PreviewFixtures.signedOutModel())
    }

    var body: some View { content.environment(model) }
}

/// Requests are answered synchronously: a read registered in `PreviewOperationResponses` gets its
/// `{ok: true, data}` envelope, and everything else fails locally.
nonisolated private final class PreviewNetworkResponse: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url,
            let data = PreviewOperationResponses.response(
                operation: url.lastPathComponent, body: Self.body(of: request)),
            let response = HTTPURLResponse(
                url: url, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    /// URLSession may hand a protocol the body as a stream instead of `httpBody`.
    private static func body(of request: URLRequest) -> JSONValue? {
        var data = request.httpBody
        if data == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&chunk, maxLength: chunk.count)
                guard count > 0 else { break }
                buffer.append(chunk, count: count)
            }
            data = buffer
        }
        return data.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
    }
}

/// Generated secondary reads for preview records (`<entity>DetailReads.json`), keyed by the record
/// id each request names, so a detail preview's reports and summary records render synthetic data.
nonisolated enum PreviewOperationResponses {
    private struct Reads: Decodable {
        let operations: [String: JSONValue]
        let connectedRecords: [String: JSONValue]
    }

    private static let registered = Mutex<[String: Reads]>([:])

    static func register(fixture name: String, recordID: String) {
        let reads: Reads = PreviewFixtures.screenFixture(name)
        registered.withLock { $0[recordID] = reads }
    }

    static func response(operation: String, body: JSONValue?) -> Data? {
        let input = body?["input"] ?? body
        // A read names its record under a different key per operation (`id`, `source.entityId`,
        // `scope.id`, timeline filters), so match any registered id the input mentions.
        let all = registered.withLock { $0 }
        let reads = input.flatMap { strings(in: $0).compactMap { all[$0] }.first }
        guard let reads else { return nil }
        let data: JSONValue?
        switch operation {
        case "entity.connectedRecords":
            data = input?["viewKey"]?.stringValue.flatMap { reads.connectedRecords[$0] }
        case "entityReport.get":
            let slot = input?["slot"]?.stringValue
            data =
                reads.operations["entityReport.getMany"]?["reports"]?.arrayValue?
                .first { $0["slot"]?.stringValue == slot }?["report"]
        default:
            data = reads.operations[operation]
        }
        guard let data else { return nil }
        return try? JSONEncoder().encode(JSONValue.object(["ok": .bool(true), "data": data]))
    }

    private static func strings(in value: JSONValue) -> [String] {
        switch value {
        case .string(let string): [string]
        case .array(let items): items.flatMap(strings(in:))
        case .object(let fields): fields.values.flatMap(strings(in:))
        default: []
        }
    }
}

/// Unseeded preview reads fail locally instead of resolving a dummy hostname or using credentials.
enum PreviewURLProtocol {
    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PreviewNetworkResponse.self]
        return URLSession(configuration: configuration)
    }
}
