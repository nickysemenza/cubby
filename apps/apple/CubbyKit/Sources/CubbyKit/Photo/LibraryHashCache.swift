import Foundation

public actor LibraryHashCache {
    public enum Failure: Error, Sendable, Equatable { case unsupportedRevision(Int) }

    public static let defaultFileURL = FileManager.default.urls(
        for: .cachesDirectory, in: .userDomainMask
    ).first!.appendingPathComponent("Cubby", isDirectory: true)
        .appendingPathComponent("library-photo-hashes-v1.json")

    private struct CacheKey: Sendable, Hashable, Codable {
        let localIdentifier: String
        let modificationDate: Date?
        let algorithmRevision: Int
    }

    private struct AssetRevision: Sendable, Hashable {
        let localIdentifier: String
        let algorithmRevision: Int
    }

    private struct Document: Sendable, Codable {
        let algorithmRevision: Int
        let entries: [Record]
    }

    private struct Record: Sendable, Codable {
        let key: CacheKey
        let hash: PerceptualHash64
    }

    private let fileURL: URL
    private var entries: [AssetRevision: Record]
    private var unsavedCount = 0

    public init(fileURL: URL = defaultFileURL) {
        self.fileURL = fileURL
        if let data = try? Data(contentsOf: fileURL),
            let document = try? JSONDecoder().decode(Document.self, from: data),
            document.algorithmRevision == PerceptualHash64.algorithmRevision,
            document.entries.allSatisfy({ $0.key.algorithmRevision == document.algorithmRevision })
        {
            var loaded: [AssetRevision: Record] = [:]
            for record in document.entries.sorted(by: {
                ($0.key.modificationDate ?? .distantPast)
                    < ($1.key.modificationDate ?? .distantPast)
            }) {
                loaded[
                    AssetRevision(
                        localIdentifier: record.key.localIdentifier,
                        algorithmRevision: record.key.algorithmRevision)] = record
            }
            entries = loaded
        } else {
            entries = [:]
        }
    }

    public func hash(
        forLocalIdentifier localIdentifier: String,
        modificationDate: Date?,
        revision: Int = PerceptualHash64.algorithmRevision
    ) -> PerceptualHash64? {
        guard revision == PerceptualHash64.algorithmRevision else { return nil }
        let record = entries[
            AssetRevision(localIdentifier: localIdentifier, algorithmRevision: revision)]
        guard record?.key.modificationDate == modificationDate else { return nil }
        return record?.hash
    }

    public func store(
        _ hash: PerceptualHash64,
        forLocalIdentifier localIdentifier: String,
        modificationDate: Date?,
        revision: Int = PerceptualHash64.algorithmRevision
    ) throws {
        guard revision == PerceptualHash64.algorithmRevision else {
            throw Failure.unsupportedRevision(revision)
        }
        let key = CacheKey(
            localIdentifier: localIdentifier,
            modificationDate: modificationDate,
            algorithmRevision: revision)
        let asset = AssetRevision(localIdentifier: localIdentifier, algorithmRevision: revision)
        let previous = entries[asset]
        guard previous?.key != key || previous?.hash != hash else { return }
        entries[asset] = Record(key: key, hash: hash)
        unsavedCount += 1
        if unsavedCount >= 64 { try flush() }
    }

    /// Removes hashes for assets absent from the latest complete PhotoKit enumeration.
    @discardableResult
    public func prune(to assetIDs: Set<String>) throws -> Int {
        let staleAssets = entries.keys.filter { !assetIDs.contains($0.localIdentifier) }
        guard !staleAssets.isEmpty else { return 0 }
        for asset in staleAssets { entries.removeValue(forKey: asset) }
        unsavedCount += staleAssets.count
        if unsavedCount >= 64 { try flush() }
        return staleAssets.count
    }

    public func flush() throws {
        guard unsavedCount > 0 else { return }
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let document = Document(
            algorithmRevision: PerceptualHash64.algorithmRevision,
            entries: entries.values.sorted {
                if $0.key.localIdentifier != $1.key.localIdentifier {
                    return $0.key.localIdentifier < $1.key.localIdentifier
                }
                return ($0.key.modificationDate ?? .distantPast)
                    < ($1.key.modificationDate ?? .distantPast)
            })
        let data = try JSONEncoder().encode(document)
        try data.write(to: fileURL, options: .atomic)
        unsavedCount = 0
    }
}
