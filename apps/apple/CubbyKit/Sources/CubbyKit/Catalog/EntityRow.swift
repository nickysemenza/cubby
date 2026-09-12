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
            imageURL: Self.imageURL(from: object),
            raw: object
        )
    }

    /// The resolved `coverImageUrl` — a public R2 URL — and nothing else: every payload's
    /// `images` is an array of image shortcodes, not of image objects, so there is no URL to
    /// fall back to. Only `resources.product.get` derives a cover, so every other entity's row
    /// has no image.
    private static func imageURL(from object: JSONValue) -> URL? {
        guard let cover = object["coverImageUrl"]?.stringValue else { return nil }
        return URL(string: cover)
    }
}
