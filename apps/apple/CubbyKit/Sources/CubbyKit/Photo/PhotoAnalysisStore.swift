import Foundation
import GRDB

public struct PhotoLabelScore: Codable, Hashable, Sendable {
    public let identifier: String
    public let confidence: Double

    public init(identifier: String, confidence: Double) {
        self.identifier = identifier
        self.confidence = confidence
    }
}

public enum PhotoAnalysisStatus: Sendable, Hashable {
    case pending
    case analysed(categories: [String])
}

public struct PhotoHashRecord: Sendable, Hashable {
    public let perceptualHash: PerceptualHash64
    public let modificationDate: Date?
    public let hashRevision: Int
}

/// One `library_sighting_sync` row's identity, keyed exactly like `librarySightingSent`'s
/// single-row lookup — `librarySightingsSent(host:version:)` returns a set of these so
/// `LibraryMetadataSync` can pre-filter a whole candidate batch against one query instead of one
/// `SELECT` per candidate.
public struct SentSightingKey: Hashable, Sendable {
    public let localIdentifier: String
    public let imageId: String
    public let modificationDate: Date?

    public init(localIdentifier: String, imageId: String, modificationDate: Date?) {
        self.localIdentifier = localIdentifier
        self.imageId = imageId
        self.modificationDate = modificationDate
    }
}

/// A Sendable copy of one local cache row. SQLite records stay confined inside `PhotoAnalysisStore`.
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
}

/// A small, actor-isolated SQLite cache for perceptual hashes and local classifications.
///
/// The predecessor SwiftData file remains untouched. It is rebuildable cache data, and opening it
/// to convert rows would repeat the device freeze this database replaces.
public actor PhotoAnalysisStore {
    private static let table = "photo_analysis"
    private let database: DatabaseQueue

    private init(database: DatabaseQueue) {
        self.database = database
    }

    public static func make(inMemory: Bool = false) throws -> PhotoAnalysisStore {
        let database =
            if inMemory {
                try DatabaseQueue()
            } else {
                try DatabaseQueue(path: try databaseURL().path(percentEncoded: false))
            }
        try migrator.migrate(database)
        return PhotoAnalysisStore(database: database)
    }

    public static func databaseURL() throws -> URL {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = support.appendingPathComponent("Cubby", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("PhotoAnalysis.sqlite")
    }

    public func record(for localIdentifier: String) throws -> PhotoAssetSnapshot? {
        try database.read { db in
            try StoredRecord.fetchOne(
                db, sql: Self.selectSQL + " WHERE local_identifier = ?", arguments: [localIdentifier])?
                .snapshot
        }
    }

    public func upsertHash(
        localIdentifier: String, modificationDate: Date?, perceptualHash: PerceptualHash64,
        revision: Int = PerceptualHash64.algorithmRevision
    ) throws {
        try database.write { db in
            try Self.upsertHash(
                in: db, localIdentifier: localIdentifier, modificationDate: modificationDate,
                perceptualHash: perceptualHash, revision: revision)
        }
    }

    public func upsertClassification(
        localIdentifier: String, categories: [String], topLabels: [PhotoLabelScore],
        classifyVersion: Int, classifyMs: Double?
    ) throws {
        try database.write { db in
            try db.execute(
                sql: """
                    INSERT INTO photo_analysis (
                      local_identifier, categories, top_labels, classify_version, classify_ms, classified_at
                    ) VALUES (:id, :categories, :topLabels, :classifyVersion, :classifyMs, :classifiedAt)
                    ON CONFLICT(local_identifier) DO UPDATE SET
                      categories = excluded.categories, top_labels = excluded.top_labels,
                      classify_version = excluded.classify_version, classify_ms = excluded.classify_ms,
                      classified_at = excluded.classified_at
                    """,
                arguments: [
                    "id": localIdentifier,
                    "categories": try Self.encode(categories),
                    "topLabels": try Self.encode(topLabels),
                    "classifyVersion": classifyVersion,
                    "classifyMs": classifyMs,
                    "classifiedAt": Date.now.timeIntervalSinceReferenceDate,
                ])
        }
    }

    public func upsertFullAnalysis(
        localIdentifier: String, analysis: Data, version: Int,
        categories: [String], topLabels: [PhotoLabelScore], classifyVersion: Int
    ) throws {
        try database.write { db in
            try db.execute(
                sql: """
                    INSERT INTO photo_analysis (
                      local_identifier, categories, top_labels, classify_version, classified_at,
                      full_analysis, full_analysis_version
                    ) VALUES (
                      :id, :categories, :topLabels, :classifyVersion, :classifiedAt,
                      :analysis, :analysisVersion
                    )
                    ON CONFLICT(local_identifier) DO UPDATE SET
                      categories = excluded.categories, top_labels = excluded.top_labels,
                      classify_version = excluded.classify_version, classified_at = excluded.classified_at,
                      full_analysis = excluded.full_analysis,
                      full_analysis_version = excluded.full_analysis_version
                    """,
                arguments: [
                    "id": localIdentifier,
                    "categories": try Self.encode(categories),
                    "topLabels": try Self.encode(topLabels),
                    "classifyVersion": classifyVersion,
                    "classifiedAt": Date.now.timeIntervalSinceReferenceDate,
                    "analysis": analysis,
                    "analysisVersion": version,
                ])
        }
    }

    public func ids(in category: String, newerThan classifyVersion: Int) throws -> Set<String> {
        try database.read { db in
            let rows = try StoredRecord.fetchAll(
                db, sql: Self.selectSQL + " WHERE classify_version >= ?", arguments: [classifyVersion])
            return Set(rows.lazy.filter { $0.categories.contains(category) }.map(\.localIdentifier))
        }
    }

    public func classifiedLocalIdentifiers(classifyVersion: Int) throws -> Set<String> {
        try database.read { db in
            Set(
                try String.fetchAll(
                    db,
                    sql: """
                        SELECT local_identifier FROM photo_analysis
                        WHERE classify_version >= ? OR full_analysis_version IS NOT NULL
                        """,
                    arguments: [classifyVersion]))
        }
    }

    /// `LibraryMetadataSync`'s send-once gate: true when this exact `(host, localIdentifier,
    /// imageId, version)` was already sent with this same `modificationDate` — a changed
    /// `modificationDate` (the asset was edited in Photos) makes this `false` again, so the sync
    /// resends.
    public func librarySightingSent(
        host: String, localIdentifier: String, imageId: String, version: Int, modificationDate: Date?
    ) throws -> Bool {
        try database.read { db in
            try Bool.fetchOne(
                db,
                sql: """
                    SELECT EXISTS(
                      SELECT 1 FROM library_sighting_sync
                      WHERE host = ? AND local_identifier = ? AND image_id = ? AND version = ?
                        AND modification_date IS ?
                    )
                    """,
                arguments: [
                    host, localIdentifier, imageId, version,
                    modificationDate?.timeIntervalSinceReferenceDate,
                ]) ?? false
        }
    }

    /// Records a successful `ImageSighting` write so a later pass does not resend it — upserted on
    /// `(host, local_identifier, image_id, version)`, so a resend (a changed `modificationDate`)
    /// replaces the prior row rather than accumulating one per edit.
    public func markLibrarySightingSent(
        host: String, localIdentifier: String, imageId: String, version: Int, modificationDate: Date?,
        cloudIdentifier: String?
    ) throws {
        try database.write { db in
            try db.execute(
                sql: """
                    INSERT INTO library_sighting_sync (
                      host, local_identifier, image_id, version, modification_date, cloud_identifier, sent_at
                    ) VALUES (
                      :host, :localIdentifier, :imageId, :version, :modificationDate, :cloudIdentifier, :sentAt
                    )
                    ON CONFLICT(host, local_identifier, image_id, version) DO UPDATE SET
                      modification_date = excluded.modification_date,
                      cloud_identifier = excluded.cloud_identifier,
                      sent_at = excluded.sent_at
                    """,
                arguments: [
                    "host": host,
                    "localIdentifier": localIdentifier,
                    "imageId": imageId,
                    "version": version,
                    "modificationDate": modificationDate?.timeIntervalSinceReferenceDate,
                    "cloudIdentifier": cloudIdentifier,
                    "sentAt": Date.now.timeIntervalSinceReferenceDate,
                ])
        }
    }

    /// Batch form of `librarySightingSent`, for `LibraryMetadataSync`'s pre-run filter: one query
    /// for every sighting already recorded at this `(host, version)`, rather than one `SELECT` per
    /// candidate — planning a run against a mostly-synced library (thousands of already-sent
    /// candidates) must not serialize thousands of single-row lookups before `totalCount` can even
    /// be computed.
    public func librarySightingsSent(host: String, version: Int) throws -> Set<SentSightingKey> {
        try database.read { db in
            let rows = try SentSightingRow.fetchAll(
                db,
                sql: """
                    SELECT local_identifier, image_id, modification_date
                    FROM library_sighting_sync
                    WHERE host = ? AND version = ?
                    """,
                arguments: [host, version])
            return Set(rows.map(\.key))
        }
    }

    public func classifiedCount(newerThan classifyVersion: Int) throws -> Int {
        try database.read { db in
            try Int.fetchOne(
                db,
                sql: """
                    SELECT COUNT(*) FROM photo_analysis
                    WHERE classify_version >= ? OR full_analysis_version IS NOT NULL
                    """,
                arguments: [classifyVersion]) ?? 0
        }
    }

    @discardableResult
    public func pruneMissing(_ assetIDs: Set<String>) throws -> Int {
        try database.write { db in
            let storedIDs = try String.fetchAll(db, sql: "SELECT local_identifier FROM photo_analysis")
            let missing = storedIDs.filter { !assetIDs.contains($0) }
            for id in missing {
                try db.execute(sql: "DELETE FROM photo_analysis WHERE local_identifier = ?", arguments: [id])
            }
            return missing.count
        }
    }

    public func hash(
        for localIdentifier: String, modificationDate: Date?,
        revision: Int = PerceptualHash64.algorithmRevision
    ) throws -> PerceptualHash64? {
        guard let snapshot = try record(for: localIdentifier), snapshot.hashRevision == revision,
            snapshot.modificationDate == modificationDate, let hash = snapshot.perceptualHash
        else { return nil }
        return hash
    }

    public func hashes(for localIdentifiers: [String]) throws -> [String: PhotoHashRecord] {
        try snapshots(for: localIdentifiers).reduce(into: [:]) { result, element in
            let (id, snapshot) = element
            guard let hash = snapshot.perceptualHash else { return }
            result[id] = PhotoHashRecord(
                perceptualHash: hash, modificationDate: snapshot.modificationDate,
                hashRevision: snapshot.hashRevision)
        }
    }

    public func analysisStatuses(for localIdentifiers: [String]) throws -> [String: PhotoAnalysisStatus] {
        try snapshots(for: localIdentifiers).mapValues(\.status)
    }

    public func snapshots(for localIdentifiers: [String]) throws -> [String: PhotoAssetSnapshot] {
        guard !localIdentifiers.isEmpty else { return [:] }
        return try database.read { db in
            var results: [String: PhotoAssetSnapshot] = [:]
            for start in stride(from: 0, to: localIdentifiers.count, by: 900) {
                let end = min(start + 900, localIdentifiers.count)
                let identifiers = Array(localIdentifiers[start..<end])
                let placeholders = Array(repeating: "?", count: identifiers.count).joined(separator: ", ")
                let rows = try StoredRecord.fetchAll(
                    db,
                    sql: Self.selectSQL + " WHERE local_identifier IN (\(placeholders))",
                    arguments: StatementArguments(identifiers))
                for row in rows { results[row.localIdentifier] = row.snapshot }
            }
            return results
        }
    }

    public static let legacyHashCacheURL = FileManager.default.urls(
        for: .cachesDirectory, in: .userDomainMask
    ).first!.appendingPathComponent("Cubby", isDirectory: true)
        .appendingPathComponent("library-photo-hashes-v1.json")

    public func migrateLegacyHashCacheIfNeeded(fileURL: URL = PhotoAnalysisStore.legacyHashCacheURL) throws {
        guard let data = try? Data(contentsOf: fileURL),
            let document = try? JSONDecoder().decode(LegacyDocument.self, from: data)
        else { return }
        try database.write { db in
            for entry in document.entries {
                try Self.upsertHash(
                    in: db, localIdentifier: entry.key.localIdentifier,
                    modificationDate: entry.key.modificationDate, perceptualHash: entry.hash,
                    revision: entry.key.algorithmRevision)
            }
        }
        try? FileManager.default.removeItem(at: fileURL)
    }

    private static let selectSQL = """
        SELECT local_identifier, modification_date, perceptual_hash, hash_revision, categories,
               top_labels, classify_version, classify_ms, classified_at, full_analysis,
               full_analysis_version
        FROM photo_analysis
        """

    private static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1_photo_analysis") { db in
            try db.create(table: table) { table in
                table.column("local_identifier", .text).primaryKey()
                table.column("modification_date", .double)
                table.column("perceptual_hash", .integer)
                table.column("hash_revision", .integer).notNull().defaults(to: 0)
                table.column("categories", .blob).notNull()
                table.column("top_labels", .blob).notNull()
                table.column("classify_version", .integer).notNull().defaults(to: 0)
                table.column("classify_ms", .double)
                table.column("classified_at", .double)
                table.column("full_analysis", .blob)
                table.column("full_analysis_version", .integer)
            }
            try db.create(index: "photo_analysis_classify_version", on: table, columns: ["classify_version"])
        }
        migrator.registerMigration("v2_library_sighting_sync") { db in
            try db.create(table: "library_sighting_sync") { table in
                table.column("host", .text).notNull()
                table.column("local_identifier", .text).notNull()
                table.column("image_id", .text).notNull()
                table.column("version", .integer).notNull()
                table.column("modification_date", .double)
                table.column("cloud_identifier", .text)
                table.column("sent_at", .double).notNull()
                table.primaryKey(["host", "local_identifier", "image_id", "version"])
            }
        }
        return migrator
    }

    private static func encode<T: Encodable>(_ value: T) throws -> Data {
        try JSONEncoder().encode(value)
    }

    private static func upsertHash(
        in db: Database, localIdentifier: String, modificationDate: Date?, perceptualHash: PerceptualHash64,
        revision: Int
    ) throws {
        try db.execute(
            sql: """
                INSERT INTO photo_analysis (
                  local_identifier, modification_date, perceptual_hash, hash_revision, categories,
                  top_labels, classify_version
                ) VALUES (:id, :modificationDate, :hash, :revision, :categories, :topLabels, 0)
                ON CONFLICT(local_identifier) DO UPDATE SET
                  modification_date = excluded.modification_date,
                  perceptual_hash = excluded.perceptual_hash,
                  hash_revision = excluded.hash_revision
                """,
            arguments: [
                "id": localIdentifier,
                "modificationDate": modificationDate?.timeIntervalSinceReferenceDate,
                "hash": Int64(bitPattern: perceptualHash.value),
                "revision": revision,
                "categories": try encode([String]()),
                "topLabels": try encode([PhotoLabelScore]()),
            ])
    }
}

private struct SentSightingRow: FetchableRecord {
    let key: SentSightingKey

    init(row: Row) throws {
        let localIdentifier: String = row["local_identifier"]
        let imageId: String = row["image_id"]
        let modificationDateValue: Double? = row["modification_date"]
        key = SentSightingKey(
            localIdentifier: localIdentifier, imageId: imageId,
            modificationDate: modificationDateValue.map(Date.init(timeIntervalSinceReferenceDate:)))
    }
}

private struct StoredRecord: FetchableRecord {
    let localIdentifier: String
    let modificationDate: Date?
    let perceptualHash: PerceptualHash64?
    let hashRevision: Int
    let categories: [String]
    let topLabels: [PhotoLabelScore]
    let classifyVersion: Int
    let classifyMs: Double?
    let classifiedAt: Date?
    let fullAnalysis: Data?
    let fullAnalysisVersion: Int?

    init(row: Row) throws {
        localIdentifier = row["local_identifier"]
        let modificationDateValue: Double? = row["modification_date"]
        modificationDate = modificationDateValue.map(Date.init(timeIntervalSinceReferenceDate:))
        let hashValue: Int64? = row["perceptual_hash"]
        perceptualHash = hashValue.map { PerceptualHash64(value: UInt64(bitPattern: $0)) }
        hashRevision = row["hash_revision"]
        let categoriesData: Data = row["categories"]
        categories = try JSONDecoder().decode([String].self, from: categoriesData)
        let topLabelsData: Data = row["top_labels"]
        topLabels = try JSONDecoder().decode([PhotoLabelScore].self, from: topLabelsData)
        classifyVersion = row["classify_version"]
        classifyMs = row["classify_ms"]
        let classifiedAtValue: Double? = row["classified_at"]
        classifiedAt = classifiedAtValue.map(Date.init(timeIntervalSinceReferenceDate:))
        fullAnalysis = row["full_analysis"]
        fullAnalysisVersion = row["full_analysis_version"]
    }

    var snapshot: PhotoAssetSnapshot {
        PhotoAssetSnapshot(
            localIdentifier: localIdentifier, modificationDate: modificationDate,
            perceptualHash: perceptualHash, hashRevision: hashRevision, categories: categories,
            topLabels: topLabels, classifyVersion: classifyVersion, classifyMs: classifyMs,
            classifiedAt: classifiedAt, fullAnalysis: fullAnalysis,
            fullAnalysisVersion: fullAnalysisVersion)
    }
}

private struct LegacyDocument: Decodable {
    struct Key: Decodable {
        let localIdentifier: String
        let modificationDate: Date?
        let algorithmRevision: Int
    }
    struct Record: Decodable {
        let key: Key
        let hash: PerceptualHash64
    }
    let entries: [Record]
}
