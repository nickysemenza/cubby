import AppIntents
import CubbyKit
import Foundation

/// One catalog entity as Siri and Shortcuts see it. There is no per-entity type: the id is the
/// shortcode, the kind comes from its prefix, and the display fields come from the same
/// `EntityDescriptor.row(from:)` projection Browse uses.
nonisolated struct CubbyEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Cubby Item")
    static let defaultQuery = CubbyEntityQuery()

    let id: String
    let kind: EntityKey
    let title: String
    let subtitle: String?
    let imageURL: URL?

    init(row: EntityRow, kind: EntityKey) {
        id = row.id
        self.kind = kind
        title = row.title
        subtitle = row.subtitle
        imageURL = row.imageURL
    }

    init?(hit: SearchHit) {
        guard let key = hit.key, EntityCatalog[key].isIntentExposed else { return nil }
        id = hit.id
        kind = key
        title = hit.title
        subtitle = hit.subtitle
        imageURL = hit.imageURL
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(title)",
            subtitle: "\(subtitle ?? EntityCatalog[kind].singular)",
            image: imageURL.map { DisplayRepresentation.Image(url: $0) }
        )
    }

    var link: CubbyLink { .entity(kind, id: id) }
}

/// Resolves entities by shortcode, by free text (through `search.find` across every exposed
/// kind), and suggests the ones recently used from Shortcuts.
nonisolated struct CubbyEntityQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [CubbyEntity] {
        let client = try await IntentContext.client()
        var out: [CubbyEntity] = []
        for id in identifiers {
            if let entity = try? await IntentContext.entity(id: id, client: client) { out.append(entity) }
        }
        return out
    }

    func entities(matching string: String) async throws -> [CubbyEntity] {
        let client = try await IntentContext.client()
        return try await client.search(string, limit: 10).compactMap(CubbyEntity.init(hit:))
    }

    func suggestedEntities() async throws -> [CubbyEntity] {
        try await entities(for: RecentEntities.ids())
    }
}

/// A catalog kind as a pickable value, so "Find" can be narrowed without a hand-written enum:
/// the options are `EntityCatalog.intentExposed`, read at query time.
nonisolated struct CubbyKind: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Kind")
    static let defaultQuery = CubbyKindQuery()

    let id: String

    var key: EntityKey? { EntityKey(rawValue: id) }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(key.map { EntityCatalog[$0].plural.capitalized } ?? id)")
    }
}

nonisolated struct CubbyKindQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [CubbyKind] {
        identifiers.compactMap { id in
            EntityKey(rawValue: id).flatMap { EntityCatalog[$0].isIntentExposed ? CubbyKind(id: id) : nil }
        }
    }

    func suggestedEntities() async throws -> [CubbyKind] {
        EntityCatalog.intentExposed.map { CubbyKind(id: $0.key.rawValue) }
    }
}
