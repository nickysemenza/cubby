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

    public init(
        id: String,
        entityType: String,
        title: String,
        subtitle: String? = nil,
        typeHint: String? = nil,
        imageURL: URL? = nil,
        matchKind: String,
        matchReason: String
    ) {
        self.id = id
        self.entityType = entityType
        self.title = title
        self.subtitle = subtitle
        self.typeHint = typeHint
        self.imageURL = imageURL
        self.matchKind = matchKind
        self.matchReason = matchReason
    }

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

/// The server's cap on a `search.find` query string.
extension SearchHit {
    public static let maxQueryLength = 100
    public static let maxLimit = 50
}
