import CoreGraphics
import CubbyKit
import Foundation
import Synchronization
import Testing

@testable import Cubby

@MainActor
@Suite("Progressive photo matching", .serialized)
struct PhotoMatchStoreTests {
    @Test func ownerBadgeUsesDeterministicPrimaryAndOverflowCount() {
        #expect(PhotoGridBadge.text(for: ["MEAL-9", "PRJ-2", "MEAL-9"]) == "MEAL-9+1")
        #expect(PhotoGridBadge.text(for: ["TASK-2"]) == "TASK-2")
        #expect(PhotoGridBadge.text(for: ["", ""]) == nil)
        #expect(PhotoGridBadge.accessibilityDescription(for: ["LOC-4K7M"]) == "Owned by LOC-4K7M")
    }

    // MARK: - markAnalysis revision coalescing

    // Regression: a background sweep classifying thousands of photos one at a time used to bump
    // `revision` per photo, forcing every observer keyed on it (the ownership filter cache, the
    // grid's `FilteredMonthAssetsCache`) to invalidate and re-render on each one. `markAnalysis`
    // must leave `revision` untouched and instead publish through the coalesced `classifiedRevision`
    // (at most once per second or per 50 photos, whichever comes first).
    @Test func markAnalysisNeverBumpsRevisionAndCoalescesClassifiedRevision() {
        let store = PhotoMatchStore()
        let photoCount = 130
        for index in 0..<photoCount {
            store.markAnalysis([
                "asset-\(index)": PhotoAssetSnapshot(
                    localIdentifier: "asset-\(index)", modificationDate: nil, perceptualHash: nil,
                    hashRevision: 0, categories: [], topLabels: [], classifyVersion: 1, classifyMs: nil,
                    classifiedAt: Date(), fullAnalysis: nil, fullAnalysisVersion: nil)
            ])
        }
        #expect(store.revision == 0)
        let expectedCountBumps = Int((Double(photoCount) / 50).rounded(.up))
        #expect(store.classifiedRevision >= 1)
        #expect(store.classifiedRevision <= expectedCountBumps + 1)
    }

    // MARK: - PhotoGridCellState derivation

    @Test func cellStateRepresentsAStrongCandidateWithItsOwnerBadge() {
        let candidate = DedupCandidate(
            id: ImageCode("IMG-1"), basis: .content, confidence: .strong, distance: 0)
        let state = PhotoGridCellState.derive(
            storedCandidates: [candidate], strongDirectOwnerShortcodes: ["PRJ-2"], hasKnownResult: true,
            checked: true)
        #expect(state.represented)
        #expect(!state.possibleMatch)
        #expect(state.known)
        #expect(state.badgeText == "PRJ-2")
        #expect(state.accessibilityStatus == "Owned by PRJ-2")
    }

    @Test func cellStateIsAPossibleMatchWhenNoCandidateIsStrong() {
        let candidate = DedupCandidate(
            id: ImageCode("IMG-1"), basis: .content, confidence: .possible, distance: 3)
        let state = PhotoGridCellState.derive(
            storedCandidates: [candidate], strongDirectOwnerShortcodes: [], hasKnownResult: true,
            checked: true)
        #expect(!state.represented)
        #expect(state.possibleMatch)
        #expect(state.badgeText == nil)
        #expect(state.accessibilityStatus == "Possible Cubby match")
    }

    @Test func cellStateWithNoCandidatesReadsKnownOrUncheckedFromChecked() {
        let known = PhotoGridCellState.derive(
            storedCandidates: [], strongDirectOwnerShortcodes: [], hasKnownResult: true, checked: true)
        #expect(!known.represented)
        #expect(!known.possibleMatch)
        #expect(known.known)
        #expect(known.accessibilityStatus == "No known match")

        let unchecked = PhotoGridCellState.derive(
            storedCandidates: [], strongDirectOwnerShortcodes: [], hasKnownResult: true, checked: false)
        #expect(!unchecked.known)
        #expect(unchecked.accessibilityStatus == "Not checked")
    }

    @Test func ownerBadgeRequiresAStrongDirectImageMatch() async throws {
        let possibleClient = try client(
            index: """
                {"algorithmRevision":1,"items":[{"id":"IMG-2345","perceptualHash":"0123456789abcde0","sourceFingerprint":null,"width":3,"height":2,"directOwnerShortcodes":["PRJ-2"]}],"repair":[]}
                """)
        let possibleStore = PhotoMatchStore()
        let possibleItem = try selection(hash: "0123456789abcdef")
        try await possibleStore.check([possibleItem], client: possibleClient)
        #expect(possibleStore.storedCandidates(for: possibleItem.id).first?.confidence == .possible)
        #expect(possibleStore.ownerBadge(for: possibleItem.id) == nil)

        let strongClient = try client(
            index: """
                {"algorithmRevision":1,"items":[{"id":"IMG-6789","perceptualHash":"0123456789abcdef","sourceFingerprint":null,"width":2,"height":2,"directOwnerShortcodes":["TASK-2"]}],"repair":[]}
                """)
        let strongStore = PhotoMatchStore()
        let strongItem = try selection(hash: "0123456789abcdef")
        try await strongStore.check([strongItem], client: strongClient)
        #expect(strongStore.ownerBadge(for: strongItem.id) == "TASK-2")
    }

    @Test func failedRefreshPreservesKnownNoMatchVerdict() async throws {
        let client = try client(index: "{\"algorithmRevision\":1,\"items\":[],\"repair\":[]}")
        let store = PhotoMatchStore()
        let item = try selection(hash: "0123456789abcdef")
        try await store.check([item], client: client)
        PhotoMatchTestProtocol.response.withLock { $0 = Data("invalid response".utf8) }
        await store.refresh(client: client)
        #expect(store.error != nil)
        #expect(store.hasKnownResult(for: item.id))
        #expect(store.storedCandidates(for: item.id).isEmpty)
        #expect(!store.hasKnownResult(for: "unprocessed"))
        store.reset()
        #expect(!store.hasKnownResult(for: item.id))
    }

    @Test func equalContentAndSourceMatchesPreferStoredContentAfterMerging() async throws {
        let client = try client(
            index: """
                {"algorithmRevision":1,"items":[{"id":"IMG-2345","perceptualHash":"0123456789abcdef","sourceFingerprint":{"hash":"0123456789abcdef","aspectRatio":1},"width":2,"height":2,"directOwnerShortcodes":[]}],"repair":[]}
                """)
        let store = PhotoMatchStore()
        let first = try selection(hash: "0123456789abcdef")
        let second = try selection(hash: "0123456789abcdef")
        try await store.check([first, second], client: client)
        for item in [first, second] {
            #expect(store.storedCandidates(for: item.id).map(\.basis) == [.content, .source])
        }
        await store.refresh(client: client)
        #expect(store.storedCandidates(for: second.id).map(\.basis) == [.content, .source])
    }

    @Test func priorityRefreshUpdatesSelectionAndDrainsRemainingLibraryQueries() async throws {
        let client = try client(
            index: """
                {"algorithmRevision":1,"items":[{"id":"IMG-2345","perceptualHash":"0123456789abcdef","sourceFingerprint":null,"width":2,"height":2,"directOwnerShortcodes":[]}],"repair":[]}
                """)
        let store = PhotoMatchStore()
        defer { store.reset() }
        let selected = try selection(hash: "0123456789abcdef")
        try await store.check([selected], client: client)
        let query = try await selected.query()
        let background = Dictionary(uniqueKeysWithValues: (0..<65).map { ("library-\($0)", query) })
        await store.registerBatch(background)
        #expect(background.keys.allSatisfy { !store.storedCandidates(for: $0).isEmpty })
        PhotoMatchTestProtocol.response.withLock {
            $0 = Data(
                """
                {"algorithmRevision":1,"items":[{"id":"IMG-2345","perceptualHash":"fedcba9876543210","sourceFingerprint":null,"width":2,"height":2,"directOwnerShortcodes":[]}],"repair":[]}
                """.utf8)
        }
        await store.refresh(client: client, priorityIDs: [selected.id])
        #expect(store.storedCandidates(for: selected.id).isEmpty)
        for _ in 0..<100 {
            if background.keys.allSatisfy({ store.storedCandidates(for: $0).isEmpty }) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(background.keys.allSatisfy { store.storedCandidates(for: $0).isEmpty })
    }

    @Test func incompleteRepairDoesNotBlockSelectedPhotos() async throws {
        let client = try client(
            index: """
                {"algorithmRevision":1,"items":[{"id":"IMG-2345","perceptualHash":null,"sourceFingerprint":null,"width":null,"height":null,"directOwnerShortcodes":[]}],"repair":[{"id":"IMG-2345","url":"https://example.invalid/photo.jpg"}]}
                """)
        let store = PhotoMatchStore()
        let item = try selection(hash: "0123456789abcdef")
        try await store.check([item], client: client)
        #expect(store.hasIndex)
        #expect(store.remainingCount == 1)
        #expect(store.candidates[item.id]?.isEmpty == true)
    }

    @Test func selectedBatchMatchesSurviveIndexRefresh() async throws {
        let client = try client(index: "{\"algorithmRevision\":1,\"items\":[],\"repair\":[]}")
        let store = PhotoMatchStore()
        let first = try selection(hash: "0123456789abcdef")
        let second = try selection(hash: "0123456789abcdef")
        try await store.check([first, second], client: client)
        #expect(store.candidates[first.id]?.isEmpty == true)
        #expect(store.candidates[second.id]?.contains { $0.id.rawValue == "draft:\(first.id)" } == true)
        #expect(store.storedCandidates(for: second.id).isEmpty)
        await store.refresh(client: client)
        #expect(store.candidates[second.id]?.contains { $0.id.rawValue == "draft:\(first.id)" } == true)
    }

    @Test func storedContentAndSourceRecognitionRemainDistinct() async throws {
        let client = try client(
            index: """
                {"algorithmRevision":1,"items":[{"id":"IMG-2345","perceptualHash":"0123456789abcdef","sourceFingerprint":null,"width":2,"height":2,"directOwnerShortcodes":[]},{"id":"IMG-6789","perceptualHash":"fedcba9876543210","sourceFingerprint":{"hash":"0123456789abcdef","aspectRatio":1},"width":2,"height":2,"directOwnerShortcodes":[]}],"repair":[]}
                """)
        let store = PhotoMatchStore()
        let item = try selection(hash: "0123456789abcdef")
        try await store.check([item], client: client)
        #expect(
            store.candidates[item.id]?.contains { $0.id.rawValue == "IMG-2345" && $0.basis == .content }
                == true)
        #expect(
            store.candidates[item.id]?.contains { $0.id.rawValue == "IMG-6789" && $0.basis == .source }
                == true)
        store.reset()
        #expect(!store.hasIndex)
        #expect(store.candidates.isEmpty)
    }

    @Test func incompatibleIndexCannotApproveUploads() async throws {
        let client = try client(index: "{\"algorithmRevision\":2,\"items\":[],\"repair\":[]}")
        let store = PhotoMatchStore()
        do {
            try await store.check([try selection(hash: "0123456789abcdef")], client: client)
            Issue.record("An incompatible revision must fail selected-photo checking")
        } catch {
            #expect(!store.hasIndex)
        }
    }

    @Test func aCachedIndexDoesNotApproveAnIncompatibleRefresh() async throws {
        let client = try client(index: "{\"algorithmRevision\":1,\"items\":[],\"repair\":[]}")
        let store = PhotoMatchStore()
        let item = try selection(hash: "0123456789abcdef")
        try await store.check([item], client: client)
        PhotoMatchTestProtocol.response.withLock {
            $0 = Data("{\"algorithmRevision\":2,\"items\":[],\"repair\":[]}".utf8)
        }
        do {
            try await store.check([item], client: client)
            Issue.record("A cached revision-one index must not approve an incompatible refresh")
        } catch {
            #expect(store.error != nil)
        }
    }

    @Test func preparedAnalysisQueryAvoidsReReadingTheSelectedPhoto() async throws {
        let client = try client(index: "{\"algorithmRevision\":1,\"items\":[],\"repair\":[]}")
        let store = PhotoMatchStore()
        let item = try selectionWithoutQuery()
        let hash = try PerceptualHash64(hex: "0123456789abcdef")
        let query = HashQuery(
            perceptualHash: hash,
            aspectRatio: 1,
            sourceFingerprint: SourceFingerprint(hash: hash, aspectRatio: 1))

        try await store.check(
            [item], client: client, preparedQueries: [item.id: query], refreshIndex: true)

        #expect(store.hasKnownResult(for: item.id))
    }

    /// A cell reads `cellStateBox(for:).state` instead of `candidates`/`directOwnersByImageID`
    /// directly so it re-renders only on its own status change; this pins that a `registerBatch`
    /// touching one id republishes only that id's box, leaving an already-settled, untouched
    /// box's reference and value alone.
    @Test func cellStatePublicationTouchesOnlyTheIdsABatchUpdates() async throws {
        let client = try client(
            index: """
                {"algorithmRevision":1,"items":[{"id":"IMG-2345","perceptualHash":"0123456789abcdef","sourceFingerprint":null,"width":2,"height":2,"directOwnerShortcodes":["PRJ-2"]}],"repair":[]}
                """)
        let store = PhotoMatchStore()
        defer { store.reset() }
        await store.refresh(client: client)
        let matchingQuery = try await selection(hash: "0123456789abcdef").query()
        let noMatchQuery = try await selection(hash: "fedcba9876543210").query()

        // Settle "untouched" first: checked, with a known (empty) result.
        store.markChecked(["untouched"])
        await store.registerBatch(["untouched": noMatchQuery])
        let untouchedBox = store.cellStateBox(for: "untouched")
        let untouchedState = untouchedBox.state
        #expect(untouchedState.known)
        #expect(!untouchedState.represented)

        let touchedBox = store.cellStateBox(for: "touched")
        #expect(!touchedBox.state.represented)

        store.markChecked(["touched"])
        await store.registerBatch(["touched": matchingQuery])

        #expect(store.cellStateBox(for: "touched") === touchedBox)
        #expect(touchedBox.state.represented)
        #expect(touchedBox.state.badgeText == "PRJ-2")
        #expect(store.cellStateBox(for: "untouched") === untouchedBox)
        #expect(untouchedBox.state == untouchedState)
    }

    private func client(index: String) throws -> CubbyClient {
        PhotoMatchTestProtocol.response.withLock { $0 = Data(index.utf8) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PhotoMatchTestProtocol.self]
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("test-photos-token"), for: "photos.example.invalid")
        return CubbyClient(
            baseURL: URL(string: "https://photos.example.invalid")!,
            credentials: CredentialProvider(
                host: "photos.example.invalid", store: store),
            session: URLSession(configuration: configuration))
    }

    private func selection(hash: String) throws -> PhotoSelectionItem {
        let image = try #require(
            CGContext(
                data: nil, width: 2, height: 2, bitsPerComponent: 8,
                bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage())
        let file = try PhotoFile(
            url: URL(fileURLWithPath: "/unused-test-photo.png"), filename: "fixture.png",
            contentType: "image/png", size: 1, width: 2, height: 2)
        let hash = try PerceptualHash64(hex: hash)
        return PhotoSelectionItem(
            file: file, preview: image,
            query: HashQuery(
                perceptualHash: hash,
                aspectRatio: 1, sourceFingerprint: SourceFingerprint(hash: hash, aspectRatio: 1)))
    }

    private func selectionWithoutQuery() throws -> PhotoSelectionItem {
        let image = try #require(
            CGContext(
                data: nil, width: 2, height: 2, bitsPerComponent: 8,
                bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage())
        let file = try PhotoFile(
            url: URL(fileURLWithPath: "/photo-import-must-not-read-this-file.png"),
            filename: "fixture.png", contentType: "image/png", size: 1, width: 2, height: 2)
        return PhotoSelectionItem(file: file, preview: image)
    }
}

/// The synchronized response belongs only to this serialized suite; it never reaches a network.
nonisolated private final class PhotoMatchTestProtocol: URLProtocol, @unchecked Sendable {
    static let response = Mutex(Data())
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.response.withLock { $0 })
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
