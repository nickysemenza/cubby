import Foundation

/// One row of a server-composed display list (`display.itemsPath`): the title, an optional second
/// line and trailing figure already worded by the server, and the record the row opens when it
/// names one.
public struct DetailDisplayRow: Decodable, Sendable, Hashable {
    public let entity: EntityKey?
    public let id: String?
    public let title: String
    public let subtitle: String?
    public let trailing: String?

    private enum CodingKeys: String, CodingKey { case entity, id, title, subtitle, trailing }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        entity = try container.decodeIfPresent(String.self, forKey: .entity).flatMap(
            EntityKey.init(rawValue:))
        id = try container.decodeIfPresent(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        subtitle = try container.decodeIfPresent(String.self, forKey: .subtitle)
        trailing = try container.decodeIfPresent(String.self, forKey: .trailing)
    }
}

/// How a detail row reads its field: from what the declaration names, not from the shape of the
/// structured value. A client prints the server's words and rows; it never re-derives them.
extension FieldDescriptor {
    /// The text the detail record carries for this field (`display.detailLabelPath`): a
    /// server-composed sentence, possibly spanning lines. `nil` when the field declares none or the
    /// record has nothing to say.
    public func detailLabel(in raw: JSONValue) -> String? {
        detailLabelPath.flatMap { raw.pathText($0) }
    }

    /// The display rows the detail record carries for this field (`display.itemsPath`).
    public func detailItems(in raw: JSONValue) -> [DetailDisplayRow] {
        guard let itemsPath, let items = raw.pathValue(itemsPath)?.arrayValue else { return [] }
        return items.compactMap { item in
            (try? JSONEncoder().encode(item)).flatMap {
                try? JSONDecoder().decode(DetailDisplayRow.self, from: $0)
            }
        }
    }

    /// The value a detail row reads: the one at its declared `readPath` (`identity.kind`,
    /// `meta.url`) when the field has one, else the field's own value.
    public func detailValue(in raw: JSONValue) -> JSONValue? {
        if let readPath { return raw.pathValue(readPath) }
        return raw[key]
    }

    /// The declared label for a string value (`display.valueOptions`), if the field names one.
    public func optionLabel(for value: JSONValue) -> String? {
        guard let code = value.stringValue else { return nil }
        return valueOptions?.first { $0.value == code }?.label
    }
}
