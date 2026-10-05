// Native conveniences on the generated manifest descriptors. Stored properties and Codable
// shapes come from packages/schemas/src/manifest-wire.ts; data stays a bundled JSON resource.
import CubbyAPISupport
import Foundation

extension CollectionActionID {
    public var scope: CollectionActionScope {
        NativeCoverageManifest.shared.collectionActionScope[rawValue] ?? .section
    }
}

extension FilterWire {
    public var names: [String] {
        switch self {
        case .param(let name): [name]
        case .range(let from, let to, let presence): [from, to] + (presence.map { [$0] } ?? [])
        }
    }
}

extension ListView {
    public var id: String {
        switch self {
        case .table: "table"
        case .shelf: "shelf"
        case .timeline: "timeline"
        case .slot(let id, _, _): id
        }
    }
    public var label: String {
        switch self {
        case .table: ListPresentationChoice.list.label
        case .shelf: ListPresentationChoice.cards.label
        case .timeline: "Timeline"
        case .slot(_, let label, _): label
        }
    }
}

extension ConnectedViewSpec {
    public var id: String { key }
}

extension EntityDescriptor {
    public func field(_ key: String) -> FieldDescriptor? { fields.first { $0.key == key } }
    public func filter(_ columnId: String) -> FilterDescriptor? { filters.first { $0.columnId == columnId } }
    public func relation(_ key: String) -> RelationDescriptor? { relations.first { $0.key == key } }
}

public enum EntityCatalog {
    /// Every declared entity, in declaration order. Decoded from the bundled manifest on first
    /// use; a manifest that does not decode is a build defect (`EntityManifestTests` fails CI).
    public static let all: [EntityDescriptor] = {
        guard let url = Bundle.module.url(forResource: "entity-manifest", withExtension: "json") else {
            fatalError("entity-manifest.json is missing from the CubbyKit bundle; run `pnpm generate`.")
        }
        do {
            return try JSONDecoder().decode([EntityDescriptor].self, from: Data(contentsOf: url))
        } catch {
            fatalError("entity-manifest.json does not decode: \(error)")
        }
    }()

    private static let byKey: [EntityKey: EntityDescriptor] = Dictionary(
        uniqueKeysWithValues: all.map { ($0.key, $0) }
    )

    // Total by construction: the manifest has one entry per `EntityKey` case because both are
    // generated from the same declared entity roster.
    public static subscript(key: EntityKey) -> EntityDescriptor {
        byKey[key]!
    }

    /// The descriptor whose canonical shortcode prefix a code carries (`PRD-…` → product).
    /// Prefix match only: the server resolves legacy `P-`/`L-` labels and validates the body.
    public static func descriptor(forShortcode code: String) -> EntityDescriptor? {
        let normalized = code.trimmingCharacters(in: .whitespaces).uppercased()
        return all.first { descriptor in
            descriptor.shortcodePrefix.map { normalized.hasPrefix($0) } ?? false
        }
    }
}
