import Foundation

/// One `search.find` hit. `entityType` is the server's discriminator; it spells entity keys the
/// way `EntityKey` does, so `key` resolves for every catalog entity and is `nil` only for a kind
/// the catalog has not learned yet.
public struct SearchHit: Sendable, Hashable, Identifiable, Decodable {
    public let id: String
    public let entityType: String
    public let title: String
    public let subtitle: String?
    public let typeHint: String?
    public let imageURL: URL?
    public let matchKind: String
    public let matchReason: String

    public var key: EntityKey? { EntityKey(rawValue: entityType) }

    private enum CodingKeys: String, CodingKey {
        case id, entityType, title, subtitle, typeHint, imageUrl, matchKind, matchReason
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        entityType = try container.decode(String.self, forKey: .entityType)
        title = try container.decode(String.self, forKey: .title)
        subtitle = try container.decodeIfPresent(String.self, forKey: .subtitle)
        typeHint = try container.decodeIfPresent(String.self, forKey: .typeHint)
        imageURL = try container.decodeIfPresent(String.self, forKey: .imageUrl).flatMap(URL.init(string:))
        matchKind = try container.decode(String.self, forKey: .matchKind)
        matchReason = try container.decode(String.self, forKey: .matchReason)
    }
}

extension CubbyRawClient {
    /// `GET /api/v1/search/find`. `kinds` narrows to those entity types; `nil` searches every
    /// intent-exposed entity. The query is capped at the server's 100 characters.
    public func search(_ text: String, kinds: [EntityKey]? = nil, limit: Int = 10) async throws -> [SearchHit] {
        let query = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100))
        guard !query.isEmpty else { return [] }
        let types = (kinds ?? EntityCatalog.intentExposed.map(\.key)).map { JSONValue.string($0.rawValue) }
        return try await call(
            "search.find",
            query: ["query": .string(query), "entityTypes": .array(types), "limit": .number(Double(min(max(limit, 1), 50)))],
            as: [SearchHit].self
        )
    }
}
