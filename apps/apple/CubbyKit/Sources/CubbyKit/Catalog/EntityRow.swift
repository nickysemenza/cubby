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

    /// The row's `raw` payload as a typed alias (`row.decode(ProductDetail.self)`), for a slot
    /// that needs more than keyed access. `raw` was projected from the decoded typed value with
    /// the same date spelling `JSONDecoder.cubby()` reads, so the round trip is lossless.
    public func decode<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try JSONDecoder.cubby().decode(T.self, from: JSONEncoder.cubby().encode(raw))
    }

    /// The entity's image ids in display order — the order `setImageOrder` rewrites. Read from a
    /// detail payload's `attachments`; a list row carries none and answers `[]`.
    public var imageIDs: [ImageCode] {
        raw["attachments"]?.arrayValue?.compactMap { $0["id"]?.stringValue.map { ImageCode($0) } } ?? []
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

        // The catalog's mobile `subtitle` columns, in declared priority; a row carries no hand-named key.
        let subtitle =
            fields.filter { $0.mobileSlot == "subtitle" }
            .sorted { ($0.mobilePriority ?? .max) < ($1.mobilePriority ?? .max) }
            .compactMap { field -> String? in
                guard let value = object[field.key]?.stringValue, !value.isEmpty else { return nil }
                return value
            }
            .first

        return EntityRow(
            id: id,
            title: title,
            subtitle: subtitle,
            imageURL: Self.imageURL(from: object),
            raw: object
        )
    }

    /// The server owns direct-versus-related precedence and preferred-representation choice.
    /// Native renders the preferred URL when present, falling back to the original for rows from
    /// older servers and images whose derivative is not ready.
    private static func imageURL(from object: JSONValue) -> URL? {
        guard let first = object["displayImages"]?[0] else { return nil }
        let value =
            first["representations"]?["preferred"]?.stringValue
            ?? first["url"]?.stringValue
        return value.flatMap(URL.init(string:))
    }
}
