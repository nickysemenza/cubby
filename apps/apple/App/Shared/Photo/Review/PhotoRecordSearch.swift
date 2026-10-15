import CubbyKit
import Foundation

/// Ranked Cubby record lookup for photo import. The server owns lexical relevance (including
/// shortcodes); this adapter only limits the result to routes that can actually receive photos and
/// hydrates each hit into the row needed by the manifest's storage routes.
@MainActor
enum PhotoRecordSearch {
    struct Match: Sendable {
        let key: EntityKey
        let row: EntityRow
        let hit: SearchHit
    }

    static func page(
        query: String, descriptor: EntityDescriptor, client: CubbyClient, page: Int, pageSize: Int
    ) async throws -> ListPage<EntityRow> {
        let matches = try await matches(query: query, allowedSources: [descriptor.key], client: client)
        let start = max(0, (page - 1) * pageSize)
        let rows = start < matches.count ? Array(matches.dropFirst(start).prefix(pageSize)).map(\.row) : []
        return ListPage(
            items: rows,
            meta: ListPageMeta(pageIndex: page, pageSize: pageSize, totalCount: matches.count))
    }

    static func matches(
        query: String, allowedSources: Set<EntityKey>, client: CubbyClient
    ) async throws -> [Match] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !allowedSources.isEmpty else { return [] }
        let sources = allowedSources.sorted { $0.rawValue < $1.rawValue }
        let hits = try await client.search(trimmed, kinds: sources, limit: SearchHit.maxLimit)
        var matches: [Match] = []
        for hit in hits {
            try Task.checkCancellation()
            guard let key = hit.key, allowedSources.contains(key),
                let row = try await client.row(EntityCatalog[key], id: hit.id)
            else { continue }
            matches.append(Match(key: key, row: row, hit: hit))
        }
        return matches
    }

    /// Whole OCR snippets are searched before their individual lines. This preserves useful label
    /// phrases such as a product name while still allowing a precise shortcode to stand alone.
    static func queries(for analysis: PhotoLocalAnalysis) -> [String] {
        let text = analysis.recognizedText
            .sorted { lhs, rhs in
                lhs.confidence == rhs.confidence ? lhs.text < rhs.text : lhs.confidence > rhs.confidence
            }
            .map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.count >= 3 }
        // With nothing left after trimming, the joined query would be "" and
        // still be returned (Cubby-iOS-Tests caught this once CI ran it).
        guard !text.isEmpty else { return [] }
        let combined = text.prefix(4).joined(separator: " ")
        var seen = Set<String>()
        return ([combined] + text).filter { seen.insert($0.lowercased()).inserted }
    }
}
