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
    /// Same-record classification policies are projected by the manifest, never owned by native.
    public func applicabilityRefusal(in raw: JSONValue) -> String? {
        for policy in applicability ?? [] {
            let allowed = raw.pathText(policy.readPath).flatMap { policy.byValue[$0] } ?? policy.otherwise
            if !allowed { return policy.reason }
        }
        return nil
    }

    /// The text the detail record carries for this field (`display.detailLabelPath`): a
    /// server-composed sentence, possibly spanning lines. `nil` when the field declares none or the
    /// record has nothing to say.
    public func detailLabel(in raw: JSONValue) -> String? {
        detailLabelPath.flatMap { raw.pathText($0) }
    }

    /// The display rows the detail record carries for this field (`display.itemsPath`).
    public func detailItems(in raw: JSONValue) -> [DetailDisplayRow] {
        guard let itemsPath, let items = raw.pathValue(itemsPath)?.arrayValue else { return [] }
        return items.compactMap { try? $0.decoded(DetailDisplayRow.self) }
    }

    /// The value a detail row reads: the one at its declared `readPath` (`identity.kind`,
    /// `meta.url`) when the field has one, else the field's own value.
    public func detailValue(in raw: JSONValue) -> JSONValue? {
        if let readPath { return raw.pathValue(readPath) }
        return raw[key]
    }

    /// The value a surface reads, as the web does. Detail reads the declared `readPath`; other
    /// surfaces prefer a declared surface projection, then `readPath`. With neither, the field
    /// (or its resolved effective value).
    public func surfaceValue(in raw: JSONValue, surface: String) -> JSONValue? {
        if readPath != nil, surface == "detail" || explanation?.projections[surface] == nil {
            return detailValue(in: raw)
        }
        return FieldResolutionPresentation.readValue(in: raw, field: self, surface: surface)
    }

    /// The declared label for a string value (`display.valueOptions`), if the field names one.
    public func optionLabel(for value: JSONValue) -> String? {
        guard let code = value.stringValue else { return nil }
        return valueOptions?.first { $0.value == code }?.label
    }
}
