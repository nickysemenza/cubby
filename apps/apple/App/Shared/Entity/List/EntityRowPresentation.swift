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
            let host = url.host.map { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 } ?? rawURL
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
    struct TitleParts: Sendable, Hashable {
        let title: String
        let subtitle: String?
    }

    struct Fact: Sendable, Hashable, Identifiable {
        /// One run of a fact's text; an inherited run carries the shared marker after it.
        struct Segment: Sendable, Hashable {
            let text: String
            let inherited: Bool
        }

        let id: String
        let label: String?
        let value: String
        let isDate: Bool
        let dateValue: String?
        let segments: [Segment]

        init(
            id: String, label: String? = nil, value: String, isDate: Bool = false, dateValue: String? = nil,
            inherited: Bool = false
        ) {
            self.init(
                id: id, label: label, segments: [Segment(text: value, inherited: inherited)], isDate: isDate,
                dateValue: dateValue)
        }

        /// A comma-joined `resolvedList` (a Product's owners), marking each inherited item.
        init(
            id: String, label: String? = nil, segments: [Segment], isDate: Bool = false,
            dateValue: String? = nil
        ) {
            self.id = id
            self.label = label
            self.value = segments.map(\.text).joined(separator: ", ")
            self.isDate = isDate
            self.dateValue = dateValue
            self.segments = segments
        }

        var inherited: Bool { segments.contains(where: \.inherited) }

        /// The value read aloud: each inherited run says so, since the marker is an image.
        var spokenValue: String {
            segments.map { $0.inherited ? "\($0.text), inherited" : $0.text }.joined(separator: ", ")
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
                if let label = fact.label, !label.isEmpty { return "\(label), \(fact.spokenValue)" }
                return fact.spokenValue
            }).joined(separator: ", ")
    }

    static func resolve(
        descriptor: EntityDescriptor,
        row: EntityRow,
        columns: [String]? = nil,
        photoMode: Bool = false
    ) -> EntityRowPresentation {
        let declaredKeys = columns ?? defaultColumns(descriptor: descriptor)
        let selectedKeys =
            descriptor.fields.contains { $0.key == "dataQuality" }
            ? ["dataQuality"] + declaredKeys.filter { $0 != "dataQuality" } : declaredKeys
        var facts: [Fact] = []
        var seen = Set<String>()

        func append(_ columnID: String) {
            guard seen.insert(columnID).inserted,
                let fact = fact(columnID, descriptor: descriptor, row: row)
            else { return }
            facts.append(fact)
        }

        // The chooser already labels the photo's capture day in its section header. Its rows
        // instead promote the candidate entity's own semantic date so nearby records remain
        // distinguishable without repeating the same photo date on every row.
        if photoMode {
            for key in ["date", "observedOn"] { append(key) }
        }
        for key in selectedKeys { append(key) }

        return EntityRowPresentation(
            title: row.title, facts: facts, shortcode: row.id,
            imageURL: row.imageURL)
    }

    /// The caption declared for the identity column. Fields with their own list column are
    /// omitted so a title subtitle never repeats a value beside the title.
    static func titleSubtitle(descriptor: EntityDescriptor, row: EntityRow) -> Fact? {
        guard descriptor.presentation.titleSubtitle else { return nil }
        for key in descriptor.presentation.shelfSubtitle {
            guard let field = descriptor.field(key), !field.showInList,
                let caption = fact(key, descriptor: descriptor, row: row)
            else { continue }
            return caption
        }
        return nil
    }

    /// A composed title may include a declared reference name after the canonical ` · `
    /// separator. When the manifest asks for a title subtitle and supplies no separate caption,
    /// put that reference suffix on the row's second line instead of wrapping the title.
    static func titleParts(
        descriptor: EntityDescriptor, row: EntityRow, subtitle: String? = nil
    ) -> TitleParts {
        let existingSubtitle =
            subtitle ?? titleSubtitle(descriptor: descriptor, row: row)?.value
            ?? row.subtitle
        guard descriptor.presentation.titleSubtitle,
            !isVisibleListFactValue(existingSubtitle ?? "")
        else {
            return TitleParts(title: row.title, subtitle: nil)
        }

        for field in descriptor.fields where field.reference != nil {
            guard let referenceName = fact(field.key, descriptor: descriptor, row: row)?.value,
                isVisibleListFactValue(referenceName)
            else { continue }
            let suffix = " · \(referenceName)"
            guard row.title.hasSuffix(suffix) else { continue }
            let title = String(row.title.dropLast(suffix.count))
            guard !title.isEmpty else { continue }
            return TitleParts(title: title, subtitle: referenceName)
        }
        return TitleParts(title: row.title, subtitle: nil)
    }

    /// Empty and placeholder values add no information to the compact context line.
    static func isVisibleListFactValue(_ value: String) -> Bool {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !["", "unknown", "not recorded", "unavailable", "not assessed", "—", "-"]
            .contains(normalized)
    }

    static func needsData(in row: EntityRow) -> Bool {
        row.raw.recordValue("dataQuality")?["status"]?.stringValue == "needs_data"
    }

    /// One column's fact for `row`, the unit `resolve` assembles; a table cell asks for its own
    /// column alone rather than resolving the row's data-quality column with it.
    static func fact(_ columnID: String, descriptor: EntityDescriptor, row: EntityRow) -> Fact? {
        guard let field = descriptor.fields.first(where: { $0.key == columnID || $0.columnId == columnID })
        else { return nil }
        let key = field.key
        if field.listRenderer == .dataQuality {
            let text: String
            if field.readKey == nil {
                text = "Not assessed"
            } else if let status = row.raw.recordValue(key)?["status"]?.stringValue {
                text = field.valueOptions?.first { $0.value == status }?.label ?? "Unavailable"
            } else {
                text = "Unavailable"
            }
            return Fact(id: key, label: field.label, value: text)
        }
        if field.listRenderer == .spendingCategorySummary,
            let value = row.raw.recordValue(key),
            let summary = try? value.decoded(SpendingCategorySummary.self)
        {
            let names = summary.categories.map(\.name).joined(separator: ", ")
            let text =
                names.isEmpty ? summary.classificationLabel : "\(summary.classificationLabel): \(names)"
            return Fact(id: key, label: field.label, value: text)
        }
        if let names = FieldEnvelopePresentation.allocatedReferenceLabel(in: row.raw, field: field) {
            return Fact(id: key, label: field.label, value: names)
        }
        // A declared `labelPath` is the text the server composed (or the name of the record
        // a reference cell links to); nothing here re-derives the figure.
        // Date self-labels keep the shared formatter below for both visible and spoken text.
        let isSelfLabeledDate = field.labelPath == key && (field.kind == .date || field.kind == .timestamp)
        if !isSelfLabeledDate, let path = field.labelPath, let text = row.raw.pathText(path) {
            return Fact(id: key, label: field.label, value: text)
        }
        if let renderer = field.listRenderer,
            case .implemented = NativePresentationCoverage.list(renderer),
            let source = RecipeSourcePresentation.parse(row.raw.recordValue(key))
        {
            return Fact(id: key, label: field.label, value: source.label)
        }
        if let items = EntityFieldValue.resolvedItems(in: row.raw, field: field, surface: "list") {
            if !items.isEmpty {
                return Fact(
                    id: key, label: field.label,
                    segments: items.map { Fact.Segment(text: $0.label, inherited: $0.inherited) })
            } else if let emptyLabel = field.emptyLabel {
                return Fact(id: key, label: field.label, value: emptyLabel)
            }
            return nil
        }
        let envelope = FieldEnvelope.of(row.raw, field: field)
        let inherited = envelope?.isInherited ?? false
        if let reference = EntityFieldValue.reference(in: row.raw, field: field, surface: "list") {
            return Fact(
                id: key, label: field.label, value: reference.name ?? reference.id, inherited: inherited)
        } else if let value = EntityFieldValue.text(in: row.raw, field: field, surface: "list")
            ?? envelope?.visibleEmptyLabel(field: field)
        {
            return Fact(
                id: key, label: field.label, value: value,
                isDate: field.kind == .date || field.kind == .timestamp,
                dateValue: EntityFieldValue.dateValue(in: row.raw, field: field, surface: "list"),
                inherited: inherited)
        }
        return nil
    }

    static func listContextKeys(descriptor: EntityDescriptor) -> Set<String> {
        Set(
            descriptor.presentation.detailSections.flatMap { section -> [String] in
                if case .relation(let spec) = section.kind { return spec.contextFields }
                return []
            })
    }

    /// The columns a row shows when its caller names none. A list resolves this once and passes
    /// it to every row: it filters and sorts the descriptor's fields.
    static func defaultColumns(descriptor: EntityDescriptor) -> [String] {
        let contextKeys = listContextKeys(descriptor: descriptor)
        // Relation context can replace a separate web column while remaining a native list fact.
        return descriptor.fields
            .filter {
                $0.showInList && (!$0.listHidden || contextKeys.contains($0.key))
                    && $0.key != descriptor.titleField && $0.key != "id"
                    && ($0.kind != .json || $0.listRenderer != nil || $0.labelPath != nil
                        || $0.format == "resolvedList" || $0.mobileSlot != nil)
            }
            .sorted {
                let left = ($0.listOrder ?? .max, $0.key)
                let right = ($1.listOrder ?? .max, $1.key)
                return left < right
            }
            .map(\.key)
    }
}
