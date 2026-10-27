import Foundation

/// A generic entity's raw JSON, projected into the handful of fields Browse and the CLI actually
/// render. Every entity in `EntityCatalog` maps through here — there is no per-entity Swift type.
public struct EntityRow: Identifiable, Sendable, Hashable {
    public let id: String
    public let title: String
    public let subtitle: String?
    public let imageURL: URL?
    public let raw: JSONValue

    public init(
        id: String, title: String, subtitle: String?, imageURL: URL?, raw: JSONValue
    ) {
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
        try raw.decoded(T.self)
    }

    /// The entity's image ids in display order — the order `setImageOrder` rewrites. Read from a
    /// detail payload's `attachments`; a list row carries none and answers `[]`.
    public var imageIDs: [ImageCode] {
        raw["attachments"]?.arrayValue?.compactMap { $0["id"]?.stringValue.map { ImageCode($0) } } ?? []
    }
}

extension EntityDescriptor {
    public func recordSymbol(in row: EntityRow) -> String {
        guard let field = recordIconEntityField,
            let value = row.raw.recordValue(field)?.stringValue,
            let entity = EntityKey(rawValue: value)
        else { return sfSymbol }
        return EntityCatalog[entity].sfSymbol
    }

    public func recordEmoji(in row: EntityRow) -> String? {
        recordEmojiField.flatMap { row.raw.recordValue($0)?.stringValue }
    }

    /// Projects a raw list/detail row into an `EntityRow`. `nil` when the object carries no `id` —
    /// the one field every entity is guaranteed to have.
    public func row(from object: JSONValue) -> EntityRow? {
        guard let id = object["id"]?.stringValue else { return nil }

        let title: String
        if let value = object.recordValue(titleField)?.stringValue, !value.isEmpty {
            title = value
        } else {
            title = id
        }

        // The catalog's mobile `subtitle` columns, in declared priority; a row carries no hand-named key.
        let subtitle =
            fields.filter { $0.mobileSlot == "subtitle" }
            .sorted { ($0.mobilePriority ?? .max) < ($1.mobilePriority ?? .max) }
            .compactMap { field -> String? in
                let base = field.key.hasSuffix("Id") ? String(field.key.dropLast(2)) : field.key
                let value: String?
                if field.reference != nil {
                    if let envelope = FieldEnvelope.of(object, field: field) {
                        let id = envelope.effectiveValue?.stringValue
                        value =
                            id.flatMap {
                                FieldEnvelopePresentation.referenceName(
                                    in: object, field: field, effectiveID: $0)
                            } ?? id
                    } else {
                        value =
                            field.labelPath.flatMap { object.pathText($0) }
                            ?? object[base]?["name"]?.stringValue
                            ?? object["\(base)Name"]?.stringValue
                            ?? object[field.key]?["name"]?.stringValue
                            ?? object[field.key]?.stringValue
                    }
                } else {
                    value = field.surfaceValue(in: object, surface: "list")?.stringValue.map { code in
                        (field.controlOptions ?? field.valueOptions)?.first { $0.value == code }?.label
                            ?? code
                    }
                }
                guard let value, !value.isEmpty else {
                    return nil
                }
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
        guard let first = object.recordValue("displayImages")?[0] else { return nil }
        let value =
            first["representations"]?["preferred"]?.stringValue
            ?? first["url"]?.stringValue
        return value.flatMap(URL.init(string:))
    }
}
