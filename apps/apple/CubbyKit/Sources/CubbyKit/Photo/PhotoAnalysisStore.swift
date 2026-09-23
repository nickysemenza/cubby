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

/// One photo's saved match result against a host's hash index. Valid only while the photo's
/// `modificationDate` and fingerprint `hashRevision` still match; `candidates` reflect the index
/// snapshot `PhotoMatchState.indexDigests` describes (see `PhotoMatchDelta`).
public struct StoredPhotoMatch: Sendable, Hashable {
    public let localIdentifier: String
    public let modificationDate: Date?
    public let hashRevision: Int
    public let candidates: [DedupCandidate]

    public init(
        localIdentifier: String, modificationDate: Date?, hashRevision: Int, candidates: [DedupCandidate]
    ) {
        self.localIdentifier = localIdentifier
        self.modificationDate = modificationDate
        self.hashRevision = hashRevision
        self.candidates = candidates
    }
}

/// Everything saved about matching at one host, read in one transaction.
public struct PhotoMatchState: Sendable {
    public let matches: [String: StoredPhotoMatch]
    /// The index the saved results reflect, as `ImageHashEntry.matchDigest` per entry. Empty
    /// before the first save, which makes every current entry a change.
    public let indexDigests: [ImageCode: UInt64]
}

public struct PhotoClassificationWrite: Sendable {
    public let localIdentifier: String
    public let categories: [String]
    public let topLabels: [PhotoLabelScore]
    public let classifyVersion: Int
    public let classifyMs: Double?

    public init(
        localIdentifier: String, categories: [String], topLabels: [PhotoLabelScore], classifyVersion: Int,
        classifyMs: Double?
    ) {
        self.localIdentifier = localIdentifier
        self.categories = categories
        self.topLabels = topLabels
        self.classifyVersion = classifyVersion
        self.classifyMs = classifyMs
    }
}

/// Settings-facing snapshot of the on-disk analysis database: where it lives, how big it is, and
/// what it holds. `url`/`bytesOnDisk` are nil/0 for an in-memory store (previews, tests).
public struct PhotoAnalysisStorageSummary: Sendable, Equatable {
    public let url: URL?
    public let bytesOnDisk: Int64
    public let rowCount: Int
    public let hashedCount: Int
    public let classifiedCount: Int
    public let syncedSightingCount: Int

    public init(
        url: URL?, bytesOnDisk: Int64, rowCount: Int, hashedCount: Int, classifiedCount: Int,
        syncedSightingCount: Int
    ) {
        self.url = url
        self.bytesOnDisk = bytesOnDisk
        self.rowCount = rowCount
        self.hashedCount = hashedCount
        self.classifiedCount = classifiedCount
        self.syncedSightingCount = syncedSightingCount
    }
}

/// A small, actor-isolated SQLite cache for perceptual hashes and local classifications.
///
/// The predecessor SwiftData file remains untouched. It is rebuildable cache data, and opening it
/// to convert rows would repeat the device freeze this database replaces.
public actor PhotoAnalysisStore {
    private static let table = "photo_analysis"
    private let database: DatabaseQueue
    /// nil for an in-memory store; otherwise the `.sqlite` file backing `database`, for
    /// `storageSummary()` to report and locate sidecar files against.
    private let fileURL: URL?

    private init(database: DatabaseQueue, fileURL: URL?) {
        self.database = database
        self.fileURL = fileURL
    }

    public static func make(inMemory: Bool = false) throws -> PhotoAnalysisStore {
        try make(fileURL: inMemory ? nil : try databaseURL())
    }

    /// Test-only entry point so a suite can point the store at a temp path instead of the real
    /// Application Support database. Production code always goes through `make(inMemory:)`.
    package static func make(fileURL: URL?) throws -> PhotoAnalysisStore {
        let database =
            if let fileURL {
                try DatabaseQueue(path: fileURL.path(percentEncoded: false))
            } else {
                try DatabaseQueue()
            }
        try migrator.migrate(database)
        return PhotoAnalysisStore(database: database, fileURL: fileURL)
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
        try upsertClassifications([
            PhotoClassificationWrite(
                localIdentifier: localIdentifier, categories: categories, topLabels: topLabels,
                classifyVersion: classifyVersion, classifyMs: classifyMs)
        ])
    }

    /// One transaction for a sweep's buffered results rather than one actor hop and write per
    /// classified photo.
    public func upsertClassifications(_ writes: [PhotoClassificationWrite]) throws {
        guard !writes.isEmpty else { return }
        let classifiedAt = Date.now.timeIntervalSinceReferenceDate
        try database.write { db in
            let statement = try db.cachedStatement(
                sql: """
                    INSERT INTO photo_analysis (
                      local_identifier, categories, top_labels, classify_version, classify_ms, classified_at
                    ) VALUES (:id, :categories, :topLabels, :classifyVersion, :classifyMs, :classifiedAt)
                    ON CONFLICT(local_identifier) DO UPDATE SET
                      categories = excluded.categories, top_labels = excluded.top_labels,
                      classify_version = excluded.classify_version, classify_ms = excluded.classify_ms,
                      classified_at = excluded.classified_at
                    """)
            for write in writes {
                try statement.execute(arguments: [
                    "id": write.localIdentifier,
                    "categories": try Self.encode(write.categories),
                    "topLabels": try Self.encode(write.topLabels),
                    "classifyVersion": write.classifyVersion,
                    "classifyMs": write.classifyMs,
                    "classifiedAt": classifiedAt,
                ])
            }
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
            try Int.fetchOne(db, sql: Self.classifiedCountSQL, arguments: [classifyVersion]) ?? 0
        }
    }

    private static let classifiedCountSQL = """
        SELECT COUNT(*) FROM photo_analysis
        WHERE classify_version >= ? OR full_analysis_version IS NOT NULL
        """

    /// Reads `fileURL`'s on-disk size plus its WAL/SHM/journal sidecars (whichever exist) and the
    /// row counts Settings shows, in one transaction so they describe the same instant.
    public func storageSummary(classifyVersion: Int) throws -> PhotoAnalysisStorageSummary {
        let bytesOnDisk = Self.bytesOnDisk(for: fileURL)
        return try database.read { db in
            let rowCount = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM photo_analysis") ?? 0
            let hashedCount =
                try Int.fetchOne(
                    db, sql: "SELECT COUNT(*) FROM photo_analysis WHERE perceptual_hash IS NOT NULL") ?? 0
            let classifiedCount =
                try Int.fetchOne(db, sql: Self.classifiedCountSQL, arguments: [classifyVersion]) ?? 0
            let syncedSightingCount =
                try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM library_sighting_sync") ?? 0
            return PhotoAnalysisStorageSummary(
                url: fileURL, bytesOnDisk: bytesOnDisk, rowCount: rowCount, hashedCount: hashedCount,
                classifiedCount: classifiedCount, syncedSightingCount: syncedSightingCount)
        }
    }

    private static func bytesOnDisk(for fileURL: URL?) -> Int64 {
        guard let fileURL else { return 0 }
        let sidecarSuffixes = ["", "-wal", "-shm", "-journal"]
        return sidecarSuffixes.reduce(into: Int64(0)) { total, suffix in
            let path = fileURL.path(percentEncoded: false) + suffix
            guard
                let size = try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int64
            else { return }
            total += size
        }
    }

    /// Deletes cached rows (analysis and saved matches, every host) for photos no longer in the
    /// library. Set-based through a temp table: the live set is ~the whole library, so the old
    /// per-id `DELETE` loop ran tens of thousands of statements. Returns the analysis rows removed.
    @discardableResult
    public func pruneMissing(_ assetIDs: Set<String>) throws -> Int {
        try database.write { db in
            try db.execute(sql: "CREATE TEMP TABLE IF NOT EXISTS live_asset (id TEXT PRIMARY KEY)")
            try db.execute(sql: "DELETE FROM live_asset")
            let insert = try db.cachedStatement(sql: "INSERT OR IGNORE INTO live_asset (id) VALUES (?)")
            for id in assetIDs { try insert.execute(arguments: [id]) }
            try db.execute(
                sql: "DELETE FROM photo_analysis WHERE local_identifier NOT IN (SELECT id FROM live_asset)")
            let removed = db.changesCount
            try db.execute(
                sql: "DELETE FROM photo_match WHERE local_identifier NOT IN (SELECT id FROM live_asset)")
            try db.execute(sql: "DELETE FROM live_asset")
            return removed
        }
    }

    public func matchState(host: String) throws -> PhotoMatchState {
        try database.read { db in
            var matches: [String: StoredPhotoMatch] = [:]
            let rows = try Row.fetchCursor(
                db,
                sql: """
                    SELECT local_identifier, modification_date, hash_revision, candidates
                    FROM photo_match WHERE host = ?
                    """,
                arguments: [host])
            while let row = try rows.next() {
                let id: String = row["local_identifier"]
                let modificationDateValue: Double? = row["modification_date"]
                let candidatesData: Data? = row["candidates"]
                matches[id] = StoredPhotoMatch(
                    localIdentifier: id,
                    modificationDate: modificationDateValue.map(Date.init(timeIntervalSinceReferenceDate:)),
                    hashRevision: row["hash_revision"],
                    candidates: try candidatesData.map {
                        try JSONDecoder().decode([DedupCandidate].self, from: $0)
                    }
                        ?? [])
            }
            var indexDigests: [ImageCode: UInt64] = [:]
            let digests = try Row.fetchCursor(
                db, sql: "SELECT image_id, digest FROM photo_match_index WHERE host = ?", arguments: [host])
            while let row = try digests.next() {
                let id: String = row["image_id"]
                let digest: Int64 = row["digest"]
                indexDigests[ImageCode(id)] = UInt64(bitPattern: digest)
            }
            return PhotoMatchState(matches: matches, indexDigests: indexDigests)
        }
    }

    /// Saves freshly computed results for photos matched against the index the saved snapshot
    /// already describes (the scan's cold photos).
    public func saveMatches(host: String, _ matches: [StoredPhotoMatch]) throws {
        guard !matches.isEmpty else { return }
        try database.write { db in try Self.upsertMatches(in: db, host: host, matches) }
    }

    /// Saves delta-updated results together with the index snapshot they now reflect, in one
    /// transaction — the results and the snapshot must never be persisted out of step.
    public func applyMatchDelta(
        host: String, matches: [StoredPhotoMatch], indexDigests: [ImageCode: UInt64]
    ) throws {
        try database.write { db in
            try Self.upsertMatches(in: db, host: host, matches)
            try db.execute(sql: "DELETE FROM photo_match_index WHERE host = ?", arguments: [host])
            let insert = try db.cachedStatement(
                sql: "INSERT INTO photo_match_index (host, image_id, digest) VALUES (?, ?, ?)")
            for (id, digest) in indexDigests {
                try insert.execute(arguments: [host, id.rawValue, Int64(bitPattern: digest)])
            }
        }
    }

    private static func upsertMatches(in db: Database, host: String, _ matches: [StoredPhotoMatch]) throws {
        let statement = try db.cachedStatement(
            sql: """
                INSERT INTO photo_match (
                  host, local_identifier, modification_date, hash_revision, candidates, checked_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(host, local_identifier) DO UPDATE SET
                  modification_date = excluded.modification_date,
                  hash_revision = excluded.hash_revision,
                  candidates = excluded.candidates,
                  checked_at = excluded.checked_at
                """)
        let checkedAt = Date.now.timeIntervalSinceReferenceDate
        for match in matches {
            // NULL for the overwhelmingly common "no match", so 90k rows stay small.
            let candidates = match.candidates.isEmpty ? nil : try encode(match.candidates)
            try statement.execute(arguments: [
                host, match.localIdentifier, match.modificationDate?.timeIntervalSinceReferenceDate,
                match.hashRevision, candidates, checkedAt,
            ])
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

    /// Reads only the fingerprint columns — this runs over the whole library at launch, and going
    /// through `snapshots(for:)` decoded every row's category/label JSON and copied its
    /// `full_analysis` BLOB just to throw them away.
    public func hashes(for localIdentifiers: [String]) throws -> [String: PhotoHashRecord] {
        guard !localIdentifiers.isEmpty else { return [:] }
        return try database.read { db in
            var results: [String: PhotoHashRecord] = [:]
            for start in stride(from: 0, to: localIdentifiers.count, by: 900) {
                let identifiers = Array(localIdentifiers[start..<min(start + 900, localIdentifiers.count)])
                let placeholders = Array(repeating: "?", count: identifiers.count).joined(separator: ", ")
                let rows = try Row.fetchCursor(
                    db,
                    sql: """
                        SELECT local_identifier, modification_date, perceptual_hash, hash_revision
                        FROM photo_analysis
                        WHERE perceptual_hash IS NOT NULL AND local_identifier IN (\(placeholders))
                        """,
                    arguments: StatementArguments(identifiers))
                while let row = try rows.next() {
                    let hash: Int64 = row["perceptual_hash"]
                    let modificationDateValue: Double? = row["modification_date"]
                    results[row["local_identifier"]] = PhotoHashRecord(
                        perceptualHash: PerceptualHash64(value: UInt64(bitPattern: hash)),
                        modificationDate: modificationDateValue.map(
                            Date.init(timeIntervalSinceReferenceDate:)),
                        hashRevision: row["hash_revision"])
                }
            }
            return results
        }
    }

    public func analysisStatuses(for localIdentifiers: [String]) throws -> [String: PhotoAnalysisStatus] {
        try snapshots(for: localIdentifiers).mapValues(\.status)
    }

    /// `includeFullAnalysis: false` skips copying the `full_analysis` BLOB (the snapshot's
    /// `fullAnalysis` is `nil`) — for whole-library status reads that never look at it.
    public func snapshots(
        for localIdentifiers: [String], includeFullAnalysis: Bool = true
    ) throws -> [String: PhotoAssetSnapshot] {
        guard !localIdentifiers.isEmpty else { return [:] }
        let select = includeFullAnalysis ? Self.selectSQL : Self.selectWithoutFullAnalysisSQL
        return try database.read { db in
            var results: [String: PhotoAssetSnapshot] = [:]
            for start in stride(from: 0, to: localIdentifiers.count, by: 900) {
                let end = min(start + 900, localIdentifiers.count)
                let identifiers = Array(localIdentifiers[start..<end])
                let placeholders = Array(repeating: "?", count: identifiers.count).joined(separator: ", ")
                let rows = try StoredRecord.fetchAll(
                    db,
                    sql: select + " WHERE local_identifier IN (\(placeholders))",
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

    private static let selectWithoutFullAnalysisSQL = """
        SELECT local_identifier, modification_date, perceptual_hash, hash_revision, categories,
               top_labels, classify_version, classify_ms, classified_at, NULL AS full_analysis,
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
        migrator.registerMigration("v3_photo_match") { db in
            try db.create(table: "photo_match") { table in
                table.column("host", .text).notNull()
                table.column("local_identifier", .text).notNull()
                table.column("modification_date", .double)
                table.column("hash_revision", .integer).notNull()
                table.column("candidates", .blob)
                table.column("checked_at", .double).notNull()
                table.primaryKey(["host", "local_identifier"])
            }
            try db.create(table: "photo_match_index") { table in
                table.column("host", .text).notNull()
                table.column("image_id", .text).notNull()
                table.column("digest", .integer).notNull()
                table.primaryKey(["host", "image_id"])
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
