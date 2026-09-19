import Foundation
import Testing

@testable import CubbyKit

// SwiftData's `ModelContainer` construction is not safe to race across concurrently-running
// tests (observed: an intermittent segfault when this suite's in-memory containers were built in
// parallel with the rest of the target) — serialize this suite only, like `StubURLProtocol`'s
// per-suite network stub convention (apps/apple/AGENTS.md's "Language and style").
@Suite("PhotoAnalysisStore", .serialized)
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
            categories: ["home"], topLabels: [])
        #expect(try await store.classifiedLocalIdentifiers(classifyVersion: 1) == ["full-1"])
        #expect(try await store.classifiedCount(newerThan: 1) == 1)
        let record = try #require(try await store.record(for: "full-1"))
        #expect(record.status == .analysed(categories: ["home"]))
        #expect(record.fullAnalysis == Data("{}".utf8))
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
}
