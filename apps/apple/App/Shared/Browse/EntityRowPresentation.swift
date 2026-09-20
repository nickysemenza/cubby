import CubbyKit
import Foundation

/// The native counterpart of the web recipe-source renderer. It deliberately decodes only the
/// small source envelope needed by list/detail presentation, rather than inventing a Recipe model
/// for a JSON field that remains output-only in the generic catalog.
enum RecipeSourcePresentation: Sendable, Hashable {
    case book(title: String, cookbookID: String?)
    case external(host: String, url: URL)

    static func parse(_ value: JSONValue?) -> RecipeSourcePresentation? {
        guard let object = value?.objectValue, let type = object["type"]?.stringValue else {
            return nil
        }
        switch type {
        case "book":
            guard let title = object["book"]?.stringValue, !title.isEmpty else { return nil }
            return .book(title: title, cookbookID: object["cookbookId"]?.stringValue)
        case "website", "notion":
            guard let rawURL = object["url"]?.stringValue, let url = URL(string: rawURL) else {
                return nil
            }
            let host =
                url.host?.replacingOccurrences(
                    of: "^www\\.", with: "", options: .regularExpression
                ) ?? rawURL
            return .external(host: host, url: url)
        default:
            return nil
        }
    }

    var label: String {
        switch self {
        case .book(let title, _): title
        case .external(let host, _): host
        }
    }
}

/// Presentation data for the compact native row. The resolver is deliberately pure: it only
/// reads the rich list projection and catalog declarations, so relation sections and main lists
/// cannot drift into per-row fetches or hand-maintained entity switch statements.
struct EntityRowPresentation: Sendable, Hashable {
    struct Fact: Sendable, Hashable, Identifiable {
        let id: String
        let label: String?
        let value: String
        let isDate: Bool

        init(id: String, label: String? = nil, value: String, isDate: Bool = false) {
            self.id = id
            self.label = label
            self.value = value
            self.isDate = isDate
        }
    }

    let title: String
    let facts: [Fact]
    let shortcode: String
    let imageURL: URL?

    var factLine: String? {
        let values = facts.map { fact in
            guard let label = fact.label, !label.isEmpty else { return fact.value }
            return "\(label): \(fact.value)"
        }
        return values.isEmpty ? nil : values.joined(separator: " · ")
    }

    var accessibilityText: String {
        ([title]
            + facts.map { fact in
                if let label = fact.label, !label.isEmpty { return "\(label), \(fact.value)" }
                return fact.value
            } + [shortcode]).joined(separator: ", ")
    }

    static func resolve(
        descriptor: EntityDescriptor,
        row: EntityRow,
        columns: [String]? = nil,
        photoMode: Bool = false
    ) -> EntityRowPresentation {
        let selectedKeys = columns ?? defaultKeys(descriptor: descriptor)
        var facts: [Fact] = []
        var seen = Set<String>()

        func append(_ columnID: String, label: String? = nil) {
            guard seen.insert(columnID).inserted,
                let field = descriptor.fields.first(where: { $0.key == columnID || $0.columnId == columnID })
            else { return }
            let key = field.key
            if let renderer = field.listRenderer,
                case .implemented = NativePresentationCoverage.list(renderer),
                let source = RecipeSourcePresentation.parse(row.raw[key])
            {
                facts.append(Fact(id: key, label: label ?? field.label, value: source.label))
                return
            }
            if let reference = EntityFieldValue.reference(in: row.raw, field: field) {
                facts.append(
                    Fact(
                        id: key, label: label ?? field.label,
                        value: reference.name ?? reference.id))
            } else if let value = EntityFieldValue.text(row.raw[key], field: field) {
                facts.append(
                    Fact(
                        id: key, label: label ?? field.label, value: value,
                        isDate: field.kind == .date || field.kind == .timestamp))
            }
        }

        // The chooser already labels the photo's capture day in its section header. Its rows
        // instead promote the candidate entity's own semantic date so nearby records remain
        // distinguishable without repeating the same photo date on every row.
        if photoMode {
            for key in ["date", "observedOn"] { append(key) }
        }
        for key in selectedKeys { append(key) }

        if let updated = row.raw["updatedAt"]?.stringValue,
            !facts.contains(where: { $0.id == "updatedAt" }),
            let formatted = EntityFieldValue.formattedDate(updated)
        {
            facts.append(Fact(id: "updatedAt", label: "Edited", value: formatted, isDate: true))
        }

        return EntityRowPresentation(
            title: row.title, facts: facts, shortcode: row.id,
            imageURL: row.imageURL)
    }

    private static func defaultKeys(descriptor: EntityDescriptor) -> [String] {
        descriptor.fields
            .filter {
                $0.showInList && !$0.listHidden && $0.key != descriptor.titleField && $0.key != "id"
                    && ($0.kind != .json || $0.listRenderer != nil)
            }
            .sorted {
                let left = ($0.listOrder ?? .max, $0.key)
                let right = ($1.listOrder ?? .max, $1.key)
                return left < right
            }
            .map(\.key)
    }
}
