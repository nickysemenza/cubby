import CubbyKit
import Foundation
import SwiftUI

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

    /// The first declared mobile `subtitle` field with a visible value other than the title, in
    /// priority order, skipping `excluded` (the status field, which reads as line 2's mark, and rail
    /// fields, which already show in their columns). Read through `fact` so dates never print as
    /// raw ISO values.
    static func subtitleFact(
        descriptor: EntityDescriptor, row: EntityRow, excluding excluded: Set<String>
    ) -> Fact? {
        descriptor.fields
            .filter { $0.mobileSlot == "subtitle" && !excluded.contains($0.key) }
            .sorted { ($0.mobilePriority ?? .max) < ($1.mobilePriority ?? .max) }
            .lazy
            .compactMap { fact($0.key, descriptor: descriptor, row: row) }
            .first {
                isVisibleListFactValue($0.value) && $0.value.caseInsensitiveCompare(row.title) != .orderedSame
            }
    }

    /// A fact as line 2 prints it: a date reads as its compact calendar day, like the rail.
    static func lineText(_ fact: Fact) -> String {
        fact.dateValue.flatMap { DatePresentation.absolute(of: $0, compact: true) } ?? fact.value
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
        let normalized = DisplayFormat.text(value.trimmingCharacters(in: .whitespacesAndNewlines))
            .lowercased()
        return !["unknown", "not recorded", "unavailable", "not assessed", DisplayFormat.text(nil), "-"]
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
                text = FieldEnvelopePresentation.emptyLabel(
                    FieldEnvelope.of(row.raw, field: field), field: field)
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

    /// A row's status word and glyph, shown only when the record is not in the declared quiet
    /// (expected) state. The status field is the one whose options declare `quiet`, else the
    /// declared hero chip.
    struct Status: Sendable, Hashable {
        let fieldKey: String
        let text: String
        let option: LabeledOption?
    }

    static func statusField(descriptor: EntityDescriptor) -> FieldDescriptor? {
        descriptor.fields.first { $0.valueOptions?.contains { $0.quiet == true } == true }
            ?? descriptor.presentation.heroChip.flatMap(descriptor.field)
    }

    static func status(descriptor: EntityDescriptor, row: EntityRow) -> Status? {
        guard let field = statusField(descriptor: descriptor),
            let fact = fact(field.key, descriptor: descriptor, row: row),
            isVisibleListFactValue(fact.value)
        else { return nil }
        let option =
            EntityFieldValue.option(in: row.raw, field: field, surface: "list")
            ?? field.valueOptions?.first { $0.label == fact.value }
        if option?.quiet == true { return nil }
        return Status(fieldKey: field.key, text: option?.label ?? fact.value, option: option)
    }

    /// The declared `list.rail` columns for `row`: each column's value and sub value from the
    /// list projection, sized by the field's `display.width` bucket so values align down the list.
    static func rail(descriptor: EntityDescriptor, row: EntityRow) -> [RecordRailCell] {
        let closed = isClosed(descriptor: descriptor, row: row)
        return (descriptor.presentation.listRail ?? []).prefix(2).compactMap { column in
            guard let field = descriptor.field(column.field) else { return nil }
            let value = fact(field.key, descriptor: descriptor, row: row)
            let day = value.flatMap { railDay(field, fact: $0, row: row) }
            let shown = value.map { fact in
                day.flatMap { DatePresentation.absolute(of: $0, compact: true) } ?? fact.value
            }
            // An open deadline without a declared sub value shows how far off it is ("3d ago").
            let sub =
                column.sub.flatMap { fact($0, descriptor: descriptor, row: row) }.map(railText)
                ?? (field.dateRangeSemantics == "deadline" && !closed
                    ? day.flatMap { DatePresentation.value($0, compact: true)?.relative } : nil)
            return RecordRailCell(
                id: field.key, label: field.columnHeader,
                value: shown.flatMap { isVisibleListFactValue($0) ? $0 : nil },
                sub: sub.flatMap { isVisibleListFactValue($0) ? $0 : nil },
                width: railWidth(field), tone: railTone(field, value: value, day: day, closed: closed))
        }
    }

    /// Whether the record holds a declared terminal (`closed`) option, such as a done task: its
    /// work is over, so a passed deadline no longer reads as overdue.
    static func isClosed(descriptor: EntityDescriptor, row: EntityRow) -> Bool {
        descriptor.fields.contains { field in
            EntityFieldValue.option(in: row.raw, field: field, surface: "list")?.closed == true
        }
    }

    /// The calendar value a date rail compares against: a date's own value, else a range's end
    /// (its start when open-ended).
    private static func railDay(_ field: FieldDescriptor, fact: Fact, row: EntityRow) -> String? {
        if let date = fact.dateValue { return date }
        guard field.kind == .dateRange, let range = field.surfaceValue(in: row.raw, surface: "list") else {
            return nil
        }
        return range["end"]?.stringValue ?? range["start"]?.stringValue
    }

    /// The rail's fixed width: the declared bucket, else a width for the field's kind (a count
    /// is narrow, money and dates take the default).
    static func railWidth(_ field: FieldDescriptor) -> CGFloat {
        if let bucket = field.width { return RecordRowMetrics.railWidth(bucket: bucket) }
        let money = field.format == "currency" || field.format == "signedCurrency"
        if field.kind == .number, !money { return RecordRowMetrics.railWidth(bucket: "xs") }
        if field.kind == .date || field.kind == .timestamp || field.kind == .dateRange {
            return RecordRowMetrics.railWidth(bucket: "sm")
        }
        return RecordRowMetrics.railWidth(bucket: nil)
    }

    /// A rail date reads as its compact calendar day; other values print as the list worded them.
    private static func railText(_ fact: Fact) -> String {
        if let date = fact.dateValue, let day = DatePresentation.absolute(of: date, compact: true) {
            return day
        }
        return fact.value
    }

    /// Condition tone, always paired with the value's own sign or wording: a refund's minus sign
    /// reads muted, and a passed deadline (worded "… ago") on an open record reads destructive.
    private static func railTone(
        _ field: FieldDescriptor, value: Fact?, day: String?, closed: Bool
    ) -> RecordRailCell.Tone {
        guard let value else { return .plain }
        if field.format == "signedCurrency" || field.format == "currency",
            value.value.hasPrefix("-") || value.value.hasPrefix("−")
        {
            return .muted
        }
        if field.dateRangeSemantics == "deadline", !closed, let date = day,
            DatePresentation.value(date, compact: true)?.relative.hasSuffix("ago") == true
        {
            return .destructive
        }
        return .plain
    }

    /// The rail totals a group header shows: the server's per-section sum for each column
    /// declared `total: "sum"`, worded with the field's own list format.
    static func railTotals(descriptor: EntityDescriptor, sums: [String: Double]) -> [RecordRailCell] {
        (descriptor.presentation.listRail ?? []).prefix(2).compactMap { column in
            guard let field = descriptor.field(column.field) else { return nil }
            let total =
                column.total == "sum"
                ? sums[field.key].flatMap { EntityFieldValue.text(.number($0), field: field) } : nil
            return RecordRailCell(
                id: field.key, label: field.columnHeader, value: total, sub: nil, width: railWidth(field))
        }
    }

    /// The whole list's rail totals: for each column declared `total: "sum"`, the server's worded
    /// list total over that one field (`meta.totalLabels`). Other declared totals stay out of the
    /// rail, so no figure prints unlabeled or twice.
    static func railTotals(descriptor: EntityDescriptor, labels: [String: String]?) -> [RecordRailCell] {
        (descriptor.presentation.listRail ?? []).prefix(2).compactMap { column in
            guard let field = descriptor.field(column.field) else { return nil }
            let total =
                column.total == "sum"
                ? descriptor.presentation.listTotals.first { $0.keys == [field.key] }
                    .flatMap { labels?[$0.id] } : nil
            return RecordRailCell(
                id: field.key, label: field.columnHeader,
                value: total.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 },
                sub: nil, width: railWidth(field))
        }
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
