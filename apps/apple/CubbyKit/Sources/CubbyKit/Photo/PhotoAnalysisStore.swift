import Foundation
import SwiftData

/// One classifier hit, kept alongside its confidence so a debug overlay or "N of M analysed"
/// summary can show *why* a photo landed (or didn't land) in a category without re-running Vision.
public struct PhotoLabelScore: Codable, Hashable, Sendable {
    public let identifier: String
    public let confidence: Double

    public init(identifier: String, confidence: Double) {
        self.identifier = identifier
        self.confidence = confidence
    }
}

/// A photo's on-device analysis, as read back by the grid, the sweep, and Diagnostics.
/// `.pending` means nothing has classified this photo yet (a fresh install, or a photo the sweep
/// has not reached); `.analysed` always fires even when `categories` is empty, so a grid cell can
/// tell "checked, no category" apart from "not checked".
public enum PhotoAnalysisStatus: Sendable, Hashable {
    case pending
    case analysed(categories: [String])
}

/// One row per Photos-library (or imported-file) identifier: the perceptual hash used for
/// duplicate detection, and the on-device classification used for category filtering and the grid
/// dot. Both are optional independently — an asset can be hashed long before it is ever
/// classified, and `PhotoImportManifest`/Diagnostics can write a full analysis (hash included)
/// before the sweep ever reaches it.
@Model
public final class PhotoAssetRecord {
    @Attribute(.unique) public var localIdentifier: String = ""
    public var modificationDate: Date?
    /// `PerceptualHash64.value` (a `UInt64`) reinterpreted bit-for-bit — SwiftData has no unsigned
    /// integer column type. `PhotoAnalysisStore.hash(for:)`/`hashes(for:)` do the conversion.
    public var perceptualHash: Int64?
    public var hashRevision: Int = 0
    /// `PhotoCategory.key`s this asset's classification hit, at `classifyVersion`. Empty means
    /// "classified, matched nothing" — distinct from never having been classified at all
    /// (`classifiedAt == nil && fullAnalysisVersion == nil`).
    public var categories: [String] = []
    public var topLabels: [PhotoLabelScore] = []
    public var classifyVersion: Int = 0
    public var classifyMs: Double?
    public var classifiedAt: Date?
    /// JSON of a `PhotoLocalAnalysis`, written once `PhotoImportManifest.prepareIfNeeded` or the
    /// Diagnostics tab has already run the full (hash + classify + OCR + feature print) analysis,
    /// so a later Diagnostics open is instant and the sweep can skip re-classifying this photo.
    public var fullAnalysis: Data?
    public var fullAnalysisVersion: Int?

    public init(localIdentifier: String) {
        self.localIdentifier = localIdentifier
    }
}

/// A batch hash read's result: the hash plus enough of its provenance (`modificationDate`,
/// `hashRevision`) for the caller to decide locally whether it is still valid, without a second
/// actor round trip per asset.
public struct PhotoHashRecord: Sendable, Hashable {
    public let perceptualHash: PerceptualHash64
    public let modificationDate: Date?
    public let hashRevision: Int
}

/// A read-only, `Sendable` copy of one `PhotoAssetRecord`, safe to hand back across the actor
/// boundary (`PersistentModel`s themselves are not `Sendable`).
public struct PhotoAssetSnapshot: Sendable, Hashable {
    public let localIdentifier: String
    public let modificationDate: Date?
    public let perceptualHash: PerceptualHash64?
    public let hashRevision: Int
    public let categories: [String]
    public let topLabels: [PhotoLabelScore]
    public let classifyVersion: Int
    public let classifyMs: Double?
    public let classifiedAt: Date?
    public let fullAnalysis: Data?
    public let fullAnalysisVersion: Int?

    public var status: PhotoAnalysisStatus {
        (classifiedAt != nil || fullAnalysisVersion != nil) ? .analysed(categories: categories) : .pending
    }

    /// Public so a caller that classified a photo outside this store (the sweep's `onClassified`
    /// hook, ahead of its own `upsertClassification` write) can build the same shape `markAnalysis`
    /// consumes, instead of a second bespoke "analysis update" type.
    public init(
        localIdentifier: String, modificationDate: Date?, perceptualHash: PerceptualHash64?,
        hashRevision: Int, categories: [String], topLabels: [PhotoLabelScore], classifyVersion: Int,
        classifyMs: Double?, classifiedAt: Date?, fullAnalysis: Data?, fullAnalysisVersion: Int?
    ) {
        self.localIdentifier = localIdentifier
        self.modificationDate = modificationDate
        self.perceptualHash = perceptualHash
        self.hashRevision = hashRevision
        self.categories = categories
        self.topLabels = topLabels
        self.classifyVersion = classifyVersion
        self.classifyMs = classifyMs
        self.classifiedAt = classifiedAt
        self.fullAnalysis = fullAnalysis
        self.fullAnalysisVersion = fullAnalysisVersion
    }

    fileprivate init(_ record: PhotoAssetRecord) {
        self.init(
            localIdentifier: record.localIdentifier, modificationDate: record.modificationDate,
            perceptualHash: record.perceptualHash.map { PerceptualHash64(value: UInt64(bitPattern: $0)) },
            hashRevision: record.hashRevision, categories: record.categories, topLabels: record.topLabels,
            classifyVersion: record.classifyVersion, classifyMs: record.classifyMs,
            classifiedAt: record.classifiedAt, fullAnalysis: record.fullAnalysis,
            fullAnalysisVersion: record.fullAnalysisVersion)
    }
}

/// The `ModelContainer` this store's schema lives in — one file, replacing the old JSON hash
/// cache, at `Application Support/Cubby/PhotoAnalysis.store`.
public enum PhotoAnalysisContainer {
    public static let schema = Schema([PhotoAssetRecord.self])

    public static func storeURL() throws -> URL {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = support.appendingPathComponent("Cubby", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("PhotoAnalysis.store")
    }

    public static func make(inMemory: Bool = false) throws -> ModelContainer {
        let configuration: ModelConfiguration =
            inMemory
            ? ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
            : ModelConfiguration(schema: schema, url: try storeURL())
        return try ModelContainer(for: schema, configurations: configuration)
    }
}

/// Confines every `PhotoAssetRecord` read/write to one background actor context (SwiftData models
/// are not `Sendable`; see axiom-data's SwiftData guidance). `PhotoLibraryStore`/`PhotoMatchStore`
/// and the classification sweep all go through this instead of touching `ModelContext` directly.
@ModelActor
public actor PhotoAnalysisStore {
    public static func make(inMemory: Bool = false) throws -> PhotoAnalysisStore {
        PhotoAnalysisStore(modelContainer: try PhotoAnalysisContainer.make(inMemory: inMemory))
    }

    public func record(for localIdentifier: String) throws -> PhotoAssetSnapshot? {
        try fetch(localIdentifier).map(PhotoAssetSnapshot.init)
    }

    public func upsertHash(
        localIdentifier: String, modificationDate: Date?, perceptualHash: PerceptualHash64,
        revision: Int = PerceptualHash64.algorithmRevision
    ) throws {
        let record = try fetchOrInsert(localIdentifier)
        record.modificationDate = modificationDate
        record.perceptualHash = Int64(bitPattern: perceptualHash.value)
        record.hashRevision = revision
        try modelContext.save()
    }

    public func upsertClassification(
        localIdentifier: String, categories: [String], topLabels: [PhotoLabelScore],
        classifyVersion: Int, classifyMs: Double?
    ) throws {
        let record = try fetchOrInsert(localIdentifier)
        record.categories = categories
        record.topLabels = topLabels
        record.classifyVersion = classifyVersion
        record.classifyMs = classifyMs
        record.classifiedAt = Date()
        try modelContext.save()
    }

    /// Written by `PhotoImportManifest.prepareIfNeeded` and the Diagnostics tab once the full
    /// (hash + classify + OCR + feature print) analysis has run, so a later Diagnostics open is
    /// instant and the sweep treats this asset as already classified. `classifyVersion` is the
    /// caller's current classification version (`PhotoClassificationSweep.classifyVersion`,
    /// which this package cannot reference directly) — a full analysis is a superset of the
    /// classification, so it must also satisfy `ids(in:newerThan:)`'s version filter, not just
    /// `classifiedLocalIdentifiers`'s separate `fullAnalysisVersion != nil` check.
    public func upsertFullAnalysis(
        localIdentifier: String, analysis: Data, version: Int,
        categories: [String], topLabels: [PhotoLabelScore], classifyVersion: Int
    ) throws {
        let record = try fetchOrInsert(localIdentifier)
        record.fullAnalysis = analysis
        record.fullAnalysisVersion = version
        record.categories = categories
        record.topLabels = topLabels
        record.classifyVersion = classifyVersion
        record.classifiedAt = Date()
        try modelContext.save()
    }

    /// Every id currently holding `category` in its `categories`, at or above `classifyVersion` —
    /// an id classified at an older version (the taxonomy or scoring logic changed since) is
    /// treated as unanalysed for this query rather than silently kept.
    ///
    /// The `classifyVersion` filter runs in the `#Predicate` (a plain, indexable scalar column);
    /// `categories.contains(category)` is applied afterward, in memory. SwiftData's transformable
    /// `[String]` column has no queryable representation in the backing store, and a `#Predicate`
    /// calling `.contains` directly on it crashes the process rather than throwing — a personal
    /// photo library is small enough that filtering the version-matched rows in Swift is cheap.
    public func ids(in category: String, newerThan classifyVersion: Int) throws -> Set<String> {
        let predicate = #Predicate<PhotoAssetRecord> { $0.classifyVersion >= classifyVersion }
        var descriptor = FetchDescriptor(predicate: predicate)
        // Narrow projection: this query runs on every category-chip reload, and the default fetch
        // would materialize every matching record's `fullAnalysis` blob and `topLabels` just to
        // read an identifier and a category list.
        descriptor.propertiesToFetch = [\.localIdentifier, \.categories, \.classifyVersion, \.fullAnalysisVersion]
        let records = try modelContext.fetch(descriptor)
        return Set(records.filter { $0.categories.contains(category) }.map(\.localIdentifier))
    }

    /// Every id the sweep (or a full analysis) has already classified at or above
    /// `classifyVersion` — the sweep's skip-already-classified check and the resume-on-relaunch
    /// behavior both come from this being a durable, persisted set rather than an in-memory cursor.
    public func classifiedLocalIdentifiers(classifyVersion: Int) throws -> Set<String> {
        let predicate = #Predicate<PhotoAssetRecord> {
            $0.classifyVersion >= classifyVersion || $0.fullAnalysisVersion != nil
        }
        var descriptor = FetchDescriptor(predicate: predicate)
        // The sweep calls this once per pass to build its skip set — only the identifier matters.
        descriptor.propertiesToFetch = [\.localIdentifier]
        let records = try modelContext.fetch(descriptor)
        return Set(records.map(\.localIdentifier))
    }

    public func classifiedCount(newerThan classifyVersion: Int) throws -> Int {
        let predicate = #Predicate<PhotoAssetRecord> {
            $0.classifyVersion >= classifyVersion || $0.fullAnalysisVersion != nil
        }
        return try modelContext.fetchCount(FetchDescriptor(predicate: predicate))
    }

    /// Drops every record absent from the latest complete PhotoKit enumeration, mirroring
    /// `LibraryHashCache.prune(to:)`.
    @discardableResult
    public func pruneMissing(_ assetIDs: Set<String>) throws -> Int {
        var descriptor = FetchDescriptor<PhotoAssetRecord>()
        // Every launch's full-library refresh calls this; only the identifier is read below, so
        // there is no reason to fault in every record's `fullAnalysis` blob just to delete some.
        descriptor.propertiesToFetch = [\.localIdentifier]
        let all = try modelContext.fetch(descriptor)
        var removed = 0
        for record in all where !assetIDs.contains(record.localIdentifier) {
            modelContext.delete(record)
            removed += 1
        }
        guard removed > 0 else { return 0 }
        try modelContext.save()
        return removed
    }

    /// A single valid hash, or nil if none is stored or it no longer matches `modificationDate`
    /// (the asset changed since it was last hashed). Used by the per-cell thumbnail path, where a
    /// batch read would have nothing to batch.
    public func hash(
        for localIdentifier: String, modificationDate: Date?,
        revision: Int = PerceptualHash64.algorithmRevision
    ) throws -> PerceptualHash64? {
        guard let record = try fetch(localIdentifier), record.hashRevision == revision,
            record.modificationDate == modificationDate, let raw = record.perceptualHash
        else { return nil }
        return PerceptualHash64(value: UInt64(bitPattern: raw))
    }

    /// Batch hash read for a whole scan pass — one fetch for up to thousands of assets rather than
    /// one actor round trip per asset. Callers still validate `modificationDate`/`hashRevision`
    /// themselves against the live `PHAsset` locally.
    public func hashes(for localIdentifiers: [String]) throws -> [String: PhotoHashRecord] {
        guard !localIdentifiers.isEmpty else { return [:] }
        var result: [String: PhotoHashRecord] = [:]
        for snapshot in try snapshots(for: localIdentifiers).values {
            guard let hash = snapshot.perceptualHash else { continue }
            result[snapshot.localIdentifier] = PhotoHashRecord(
                perceptualHash: hash, modificationDate: snapshot.modificationDate,
                hashRevision: snapshot.hashRevision)
        }
        return result
    }

    /// Batch analysis-status read for the grid dot and the classification sweep's skip check.
    public func analysisStatuses(for localIdentifiers: [String]) throws -> [String: PhotoAnalysisStatus] {
        try snapshots(for: localIdentifiers).mapValues(\.status)
    }

    public func snapshots(for localIdentifiers: [String]) throws -> [String: PhotoAssetSnapshot] {
        guard !localIdentifiers.isEmpty else { return [:] }
        let ids = Set(localIdentifiers)
        let predicate = #Predicate<PhotoAssetRecord> { ids.contains($0.localIdentifier) }
        let records = try modelContext.fetch(FetchDescriptor(predicate: predicate))
        return Dictionary(uniqueKeysWithValues: records.map { ($0.localIdentifier, PhotoAssetSnapshot($0)) })
    }

    private func fetchOrInsert(_ localIdentifier: String) throws -> PhotoAssetRecord {
        if let existing = try fetch(localIdentifier) { return existing }
        let record = PhotoAssetRecord(localIdentifier: localIdentifier)
        modelContext.insert(record)
        return record
    }

    private func fetch(_ localIdentifier: String) throws -> PhotoAssetRecord? {
        var descriptor = FetchDescriptor<PhotoAssetRecord>(
            predicate: #Predicate { $0.localIdentifier == localIdentifier })
        descriptor.fetchLimit = 1
        return try modelContext.fetch(descriptor).first
    }
}

// MARK: - Legacy JSON migration

extension PhotoAnalysisStore {
    public static let legacyHashCacheURL = FileManager.default.urls(
        for: .cachesDirectory, in: .userDomainMask
    ).first!.appendingPathComponent("Cubby", isDirectory: true)
        .appendingPathComponent("library-photo-hashes-v1.json")

    /// The old `LibraryHashCache` JSON shape (that type itself is gone) — kept only long enough to
    /// read a prior install's file once, migrate it into this store, and delete it.
    private struct LegacyDocument: Decodable {
        struct Key: Decodable, Hashable {
            let localIdentifier: String
            let modificationDate: Date?
            let algorithmRevision: Int
        }
        struct Record: Decodable {
            let key: Key
            let hash: PerceptualHash64
        }
        let algorithmRevision: Int
        let entries: [Record]
    }

    /// Safe to call on every launch: a fresh install (no legacy file) and a launch after this has
    /// already run once (file already deleted) both no-op. `try?` around the whole call site is
    /// intentional — a corrupt or unreadable legacy file should never block the store from being
    /// usable; `upsertHash` alone rebuilds hashes from that point on.
    public func migrateLegacyHashCacheIfNeeded(fileURL: URL = PhotoAnalysisStore.legacyHashCacheURL) throws {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        // A corrupt legacy file still no-ops (the early `return` below) without deleting anything,
        // so a future launch with a fixed decoder gets another chance at it.
        guard let document = try? JSONDecoder().decode(LegacyDocument.self, from: data) else { return }
        for entry in document.entries {
            let record = try fetchOrInsert(entry.key.localIdentifier)
            record.modificationDate = entry.key.modificationDate
            record.perceptualHash = Int64(bitPattern: entry.hash.value)
            record.hashRevision = entry.key.algorithmRevision
        }
        // Delete only once the migrated rows are durably saved — deleting first (the previous
        // `defer`) would lose every hash in this file if `save()` threw partway through.
        try modelContext.save()
        try? FileManager.default.removeItem(at: fileURL)
    }
}
