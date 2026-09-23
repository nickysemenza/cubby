import Foundation
import Testing

@testable import CubbyKit

@Suite("PhotoAnalysisStore")
struct PhotoAnalysisStoreTests {
    private func makeStore() throws -> PhotoAnalysisStore {
        try PhotoAnalysisStore.make(inMemory: true)
    }

    @Test func upsertHashRoundTripsThroughTheInt64Column() async throws {
        let store = try makeStore()
        let hash = PerceptualHash64(value: 0xFFFF_FFFF_FFFF_FFFF)
        let date = Date(timeIntervalSince1970: 100)
        try await store.upsertHash(localIdentifier: "asset-1", modificationDate: date, perceptualHash: hash)
        #expect(try await store.hash(for: "asset-1", modificationDate: date) == hash)
        #expect(try await store.hash(for: "asset-1", modificationDate: date.addingTimeInterval(1)) == nil)
        #expect(try await store.hash(for: "asset-1", modificationDate: date, revision: 99) == nil)
    }

    @Test func batchHashesReadEveryRequestedIDInOneFetch() async throws {
        let store = try makeStore()
        let hash1 = PerceptualHash64(value: 1)
        let hash2 = PerceptualHash64(value: 2)
        try await store.upsertHash(localIdentifier: "a", modificationDate: nil, perceptualHash: hash1)
        try await store.upsertHash(localIdentifier: "b", modificationDate: nil, perceptualHash: hash2)
        let batch = try await store.hashes(for: ["a", "b", "missing"])
        #expect(batch["a"]?.perceptualHash == hash1)
        #expect(batch["b"]?.perceptualHash == hash2)
        #expect(batch["missing"] == nil)
    }

    @Test func upsertClassificationDrivesCategoryAndCountQueries() async throws {
        let store = try makeStore()
        try await store.upsertClassification(
            localIdentifier: "plant-1", categories: ["plants"],
            topLabels: [PhotoLabelScore(identifier: "plant", confidence: 0.9)],
            classifyVersion: 1, classifyMs: 12)
        try await store.upsertClassification(
            localIdentifier: "food-1", categories: ["food"], topLabels: [], classifyVersion: 1,
            classifyMs: 8)
        try await store.upsertClassification(
            localIdentifier: "none-1", categories: [], topLabels: [], classifyVersion: 1, classifyMs: 5)

        #expect(try await store.ids(in: "plants", newerThan: 1) == ["plant-1"])
        #expect(try await store.ids(in: "food", newerThan: 1) == ["food-1"])
        #expect(try await store.ids(in: "plants", newerThan: 2).isEmpty)
        #expect(try await store.classifiedCount(newerThan: 1) == 3)
        #expect(try await store.classifiedCount(newerThan: 2) == 0)

        let statuses = try await store.analysisStatuses(for: ["plant-1", "none-1", "unclassified"])
        #expect(statuses["plant-1"] == .analysed(categories: ["plants"]))
        #expect(statuses["none-1"] == .analysed(categories: []))
        #expect(statuses["unclassified"] == nil)
    }

    @Test func fullAnalysisCountsAsClassifiedEvenWithoutAClassifyVersion() async throws {
        let store = try makeStore()
        try await store.upsertFullAnalysis(
            localIdentifier: "full-1", analysis: Data("{}".utf8), version: 1,
            categories: ["home"], topLabels: [], classifyVersion: 0)
        #expect(try await store.classifiedLocalIdentifiers(classifyVersion: 1) == ["full-1"])
        #expect(try await store.classifiedCount(newerThan: 1) == 1)
        let record = try #require(try await store.record(for: "full-1"))
        #expect(record.status == .analysed(categories: ["home"]))
        #expect(record.fullAnalysis == Data("{}".utf8))
    }

    // Regression: `upsertFullAnalysis` used to leave `classifyVersion == 0`, which
    // `ids(in:newerThan:)`'s scalar-column filter silently excluded — a photo imported by
    // full-analysis path (not the classification sweep) never appeared in a chip filter even
    // though its category was known.
    @Test func upsertFullAnalysisIsDiscoverableByACategoryChipFilter() async throws {
        let store = try makeStore()
        try await store.upsertFullAnalysis(
            localIdentifier: "full-plant", analysis: Data("{}".utf8), version: 1,
            categories: ["plants"], topLabels: [], classifyVersion: 1)
        #expect(try await store.ids(in: "plants", newerThan: 1) == ["full-plant"])
    }

    @Test func pruneMissingRemovesOnlyAssetsAbsentFromTheLatestScan() async throws {
        let store = try makeStore()
        try await store.upsertHash(
            localIdentifier: "kept", modificationDate: nil, perceptualHash: PerceptualHash64(value: 1))
        try await store.upsertHash(
            localIdentifier: "gone", modificationDate: nil, perceptualHash: PerceptualHash64(value: 2))
        #expect(try await store.pruneMissing(["kept"]) == 1)
        #expect(try await store.record(for: "gone") == nil)
        #expect(try await store.record(for: "kept") != nil)
    }

    @Test func legacyJSONCacheMigratesOnceAndDeletesTheFile() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fileURL = directory.appendingPathComponent("library-photo-hashes-v1.json")
        let date = Date(timeIntervalSince1970: 100)
        let expectedHash = PerceptualHash64(value: 42)
        // `PerceptualHash64` encodes as its hex string (`PerceptualHash.swift`), not a `{value:}`
        // object — this fixture mirrors the real `LibraryHashCache` JSON shape on disk.
        let legacyJSON = """
            {
              "algorithmRevision": 1,
              "entries": [
                {
                  "key": {
                    "localIdentifier": "legacy-asset",
                    "modificationDate": \(date.timeIntervalSinceReferenceDate),
                    "algorithmRevision": 1
                  },
                  "hash": "\(expectedHash.hex)"
                }
              ]
            }
            """
        try Data(legacyJSON.utf8).write(to: fileURL)

        let store = try makeStore()
        try await store.migrateLegacyHashCacheIfNeeded(fileURL: fileURL)

        #expect(try await store.hash(for: "legacy-asset", modificationDate: date) == expectedHash)
        #expect(!FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false)))

        // Re-running after the file is gone is a no-op, not an error — every launch calls this.
        try await store.migrateLegacyHashCacheIfNeeded(fileURL: fileURL)
        #expect(try await store.hash(for: "legacy-asset", modificationDate: date) == expectedHash)
    }

    @Test func aFreshInstallWithNoLegacyFileNoOps() async throws {
        let store = try makeStore()
        let missingURL = FileManager.default.temporaryDirectory.appendingPathComponent(
            "\(UUID().uuidString).json")
        try await store.migrateLegacyHashCacheIfNeeded(fileURL: missingURL)
        #expect(try await store.record(for: "anything") == nil)
    }

    // MARK: - v2_library_sighting_sync (PR 5)

    @Test func unsentLibrarySightingReportsFalse() async throws {
        let store = try makeStore()
        let sent = try await store.librarySightingSent(
            host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
            modificationDate: nil)
        #expect(!sent)
    }

    @Test func markingASightingSentMakesItSkippedForTheSameModificationDate() async throws {
        let store = try makeStore()
        let date = Date(timeIntervalSince1970: 1000)
        try await store.markLibrarySightingSent(
            host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
            modificationDate: date, cloudIdentifier: "cloud-1")
        let sent = try await store.librarySightingSent(
            host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
            modificationDate: date)
        #expect(sent)
    }

    @Test func aChangedModificationDateIsTreatedAsUnsentAgain() async throws {
        let store = try makeStore()
        let date = Date(timeIntervalSince1970: 1000)
        try await store.markLibrarySightingSent(
            host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
            modificationDate: date, cloudIdentifier: nil)
        let sentAfterEdit = try await store.librarySightingSent(
            host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
            modificationDate: date.addingTimeInterval(60))
        #expect(!sentAfterEdit)
    }

    @Test func nilModificationDatesAreComparedNullSafely() async throws {
        let store = try makeStore()
        try await store.markLibrarySightingSent(
            host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
            modificationDate: nil, cloudIdentifier: nil)
        #expect(
            try await store.librarySightingSent(
                host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
                modificationDate: nil))
    }

    @Test func differentHostsOrImagesAreIndependentSightings() async throws {
        let store = try makeStore()
        let date = Date(timeIntervalSince1970: 1000)
        try await store.markLibrarySightingSent(
            host: "a.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
            modificationDate: date, cloudIdentifier: nil)
        #expect(
            !(try await store.librarySightingSent(
                host: "b.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
                modificationDate: date)))
        #expect(
            !(try await store.librarySightingSent(
                host: "a.example", localIdentifier: "asset-1", imageId: "IMG-2", version: 1,
                modificationDate: date)))
    }

    @Test func storageSummaryReportsFileSizeAndRowCounts() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("PhotoAnalysis.sqlite")

        let store = try PhotoAnalysisStore.make(fileURL: fileURL)
        try await store.upsertHash(
            localIdentifier: "asset-1", modificationDate: nil, perceptualHash: PerceptualHash64(value: 1))
        try await store.upsertClassification(
            localIdentifier: "asset-1", categories: ["plants"], topLabels: [], classifyVersion: 1,
            classifyMs: 5)
        try await store.markLibrarySightingSent(
            host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
            modificationDate: nil, cloudIdentifier: nil)

        let summary = try await store.storageSummary(classifyVersion: 1)
        #expect(summary.url == fileURL)
        #expect(summary.rowCount == 1)
        #expect(summary.hashedCount == 1)
        #expect(summary.classifiedCount == 1)
        #expect(summary.syncedSightingCount == 1)
        #expect(summary.bytesOnDisk > 0)
    }

    @Test func markingTwiceUpsertsRatherThanAccumulatingRows() async throws {
        let store = try makeStore()
        let firstDate = Date(timeIntervalSince1970: 1000)
        let secondDate = Date(timeIntervalSince1970: 2000)
        try await store.markLibrarySightingSent(
            host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
            modificationDate: firstDate, cloudIdentifier: "cloud-1")
        try await store.markLibrarySightingSent(
            host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
            modificationDate: secondDate, cloudIdentifier: "cloud-2")
        // Only the latest `modificationDate` is remembered — the first is unsent again.
        #expect(
            !(try await store.librarySightingSent(
                host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
                modificationDate: firstDate)))
        #expect(
            try await store.librarySightingSent(
                host: "cubby.example", localIdentifier: "asset-1", imageId: "IMG-1", version: 1,
                modificationDate: secondDate))
    }

    private func match(_ id: String, _ candidates: [DedupCandidate] = [], date: Double = 1)
        -> StoredPhotoMatch
    {
        StoredPhotoMatch(
            localIdentifier: id, modificationDate: Date(timeIntervalSinceReferenceDate: date),
            hashRevision: PerceptualHash64.algorithmRevision, candidates: candidates)
    }

    @Test func savedMatchesRoundTripPerHostAndUpsertInPlace() async throws {
        let store = try makeStore()
        let candidate = DedupCandidate(
            id: ImageCode("IMG-1"), basis: .content, confidence: .strong, distance: 1)
        try await store.saveMatches(host: "a.example", [match("p1", [candidate]), match("p2")])
        try await store.saveMatches(host: "a.example", [match("p2", [candidate], date: 2)])
        try await store.saveMatches(host: "b.example", [match("p1")])
        let state = try await store.matchState(host: "a.example")
        #expect(state.matches.count == 2)
        #expect(state.matches["p1"]?.candidates == [candidate])
        // The second save replaced p2's row rather than adding one, and an empty result stored
        // as NULL reads back as no candidates.
        #expect(state.matches["p2"]?.candidates == [candidate])
        #expect(state.matches["p2"]?.modificationDate == Date(timeIntervalSinceReferenceDate: 2))
        #expect(try await store.matchState(host: "b.example").matches["p1"]?.candidates == [])
        #expect(state.indexDigests.isEmpty)
    }

    @Test func applyingADeltaReplacesTheIndexSnapshotWithTheRows() async throws {
        let store = try makeStore()
        try await store.applyMatchDelta(
            host: "a.example", matches: [match("p1")],
            indexDigests: [ImageCode("IMG-1"): 1, ImageCode("IMG-2"): UInt64.max])
        try await store.applyMatchDelta(
            host: "a.example", matches: [match("p2")], indexDigests: [ImageCode("IMG-2"): 7])
        let state = try await store.matchState(host: "a.example")
        // The snapshot is replaced, not merged: IMG-1 left the index.
        #expect(state.indexDigests == [ImageCode("IMG-2"): 7])
        #expect(Set(state.matches.keys) == ["p1", "p2"])
    }

    @Test func pruneRemovesMissingPhotosFromAnalysisAndSavedMatches() async throws {
        let store = try makeStore()
        for id in ["keep", "gone"] {
            try await store.upsertHash(
                localIdentifier: id, modificationDate: nil, perceptualHash: PerceptualHash64(value: 1))
        }
        try await store.saveMatches(host: "a.example", [match("keep"), match("gone")])
        #expect(try await store.pruneMissing(["keep"]) == 1)
        #expect(Set(try await store.hashes(for: ["keep", "gone"]).keys) == ["keep"])
        #expect(Set(try await store.matchState(host: "a.example").matches.keys) == ["keep"])
        // A second prune reuses the temp table without leftover ids keeping "gone" alive.
        #expect(try await store.pruneMissing([]) == 1)
    }

    @Test func batchClassificationWritesEveryRowAndSkipsTheFullAnalysisBlobOnRequest() async throws {
        let store = try makeStore()
        try await store.upsertFullAnalysis(
            localIdentifier: "full", analysis: Data([1, 2, 3]), version: 1, categories: ["food"],
            topLabels: [], classifyVersion: 1)
        try await store.upsertClassifications([
            PhotoClassificationWrite(
                localIdentifier: "a", categories: ["plants"], topLabels: [], classifyVersion: 3, classifyMs: 5
            ),
            PhotoClassificationWrite(
                localIdentifier: "b", categories: [], topLabels: [], classifyVersion: 3, classifyMs: nil),
        ])
        #expect(try await store.classifiedLocalIdentifiers(classifyVersion: 3) == ["a", "b", "full"])
        let light = try await store.snapshots(for: ["a", "full"], includeFullAnalysis: false)
        #expect(light["a"]?.categories == ["plants"])
        #expect(light["full"]?.fullAnalysis == nil)
        #expect(light["full"]?.fullAnalysisVersion == 1)
        #expect(try await store.snapshots(for: ["full"])["full"]?.fullAnalysis == Data([1, 2, 3]))
    }
}
