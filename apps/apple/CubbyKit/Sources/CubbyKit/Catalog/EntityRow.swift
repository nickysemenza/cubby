import Foundation

/// A generic entity's raw JSON, projected into the handful of fields Browse and the CLI actually
/// render. Every entity in `EntityCatalog` maps through here — there is no per-entity Swift type.
public struct EntityRow: Identifiable, Sendable, Hashable {
    public let id: String
    public let title: String
    public let subtitle: String?
    public let imageURL: URL?
    public let raw: JSONValue

    public init(id: String, title: String, subtitle: String?, imageURL: URL?, raw: JSONValue) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.imageURL = imageURL
        self.raw = raw
    }
}

extension EntityDescriptor {
    /// Projects a raw list/detail row into an `EntityRow`. `nil` when the object carries no `id` —
    /// the one field every entity is guaranteed to have.
    public func row(from object: JSONValue) -> EntityRow? {
        guard let id = object["id"]?.stringValue else { return nil }

        let title: String
        if let value = object[titleField]?.stringValue, !value.isEmpty {
            title = value
        } else {
            title = id
        }

        let subtitle = object["manufacturer"]?.stringValue ?? object["category"]?.stringValue

        return EntityRow(
            id: id,
            title: title,
            subtitle: subtitle,
            imageURL: (key == .image
                ? object["url"]?.stringValue.flatMap(URL.init(string:)) : Self.imageURL(from: object)),
            raw: object
        )
    }

    /// The server resolves every image-bearing entity's displayable images, in display order,
    /// into `displayImages: [{id, url}]` on the list row — the entity's own gallery/cover, or a
    /// linked product's photos for ingredient/inventory/expense/wish, with a location→identity
    /// product or cookbook→physical copy fallback. `displayImages[0].url` is the list contract
    /// for every such entity and wins first; native code derives no cover of its own.
    /// `coverImageUrl` is a leftover on detail/picker shapes that never grew a `displayImages`
    /// field, and is checked second.
    private static func imageURL(from object: JSONValue) -> URL? {
        if let first = object["displayImages"]?[0]?["url"]?.stringValue {
            return URL(string: first)
        }
        guard let cover = object["coverImageUrl"]?.stringValue else { return nil }
        return URL(string: cover)
    }
}
