import CubbyKit
import Foundation
import SwiftUI

/// Specialist rows use the same manifest renderer and lazy explanation as ordinary entity rows.
struct EntityQualityFact: View {
    let key: EntityKey
    let id: String
    let raw: JSONValue

    var body: some View {
        if EntityCatalog[key].field("dataQuality") != nil,
            EntityRowPresentation.needsData(
                in: EntityRow(id: id, title: "", subtitle: nil, imageURL: nil, raw: raw))
        {
            HStack(spacing: FieldGuideTokens.Space.xs) {
                Circle().fill(FieldGuideTokens.warning).frame(width: 6, height: 6)
                Text("Needs data")
            }
            .font(.caption.weight(.medium))
            .accessibilityLabel("Needs data")
        }
    }
}

/// The manifest-driven record row every Swift list shares (Browse, Today meals, relations,
/// pickers, journals). Line 1 is the title; line 2 leads with the status word and glyph only
/// when the record is not in its declared quiet state, then at most two facts. Declared
/// `list.rail` columns sit at the trailing edge at fixed widths; an entity without a rail keeps
/// one free trailing value over its date. Everything is read off `row.raw` — never an extra
/// request — and one spoken label covers the whole row.
struct EntityRowView: View {
    let key: EntityKey
    let row: EntityRow
    var columns: [String]? = nil
    var photoMode = false
    /// Facts supplied by the containing section need no second copy in the row.
    var contextFields: Set<String> = []
    /// Preview-only image injection keeps the production row on the shared URL-backed Thumb
    /// while allowing previews to exercise the real image geometry and clipping.
    var previewImage: Image? = nil
    var showsFallbackImage = true
    @Environment(\.dynamicTypeSize) private var textSize

    /// One manifest projection feeds both visible lines and the complete spoken row label.
    private struct Layout {
        let presentation: EntityRowPresentation
        let title: String
        let status: EntityRowPresentation.Status?
        let facts: [EntityRowPresentation.Fact]
        let subtitleText: String?
        let rail: [RecordRailCell]
        /// Free trailing value and date, for an entity that declares no rail.
        let trailingValue: EntityRowPresentation.Fact?
        let date: EntityRowPresentation.Fact?
        let needsData: Bool
        /// The declared `presentation.state` and `progress`, drawn on their own line.
        let state: RecordState?
        let progress: ProgressValue?
    }

    private var layout: Layout {
        let descriptor = EntityCatalog[key]
        let presentation = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, columns: columns, photoMode: photoMode)
        let status = EntityRowPresentation.status(descriptor: descriptor, row: row)
        let statusKey = EntityRowPresentation.statusField(descriptor: descriptor)?.key
        let rail = EntityRowPresentation.rail(descriptor: descriptor, row: row)
            .filter { !contextFields.contains($0.id) }
        let railKeys = Set(
            (descriptor.presentation.listRail ?? []).prefix(2).flatMap {
                [$0.field] + [$0.sub].compactMap { $0 }
            })

        // The status field reads as line 2's mark (or stays quiet) and rail fields read in their
        // columns; neither repeats as the subtitle.
        let headerKeys = descriptor.presentation.recordState == nil ? [] : descriptor.headerFieldKeys
        let stateKeys = headerKeys.subtracting(descriptor.presentation.detailLines.map(\.field))
        let lineExcluded = railKeys.union([statusKey].compactMap { $0 }).union(contextFields)
            .union(stateKeys)
        let titleSubtitle = EntityRowPresentation.titleSubtitle(descriptor: descriptor, row: row)
            .flatMap { lineExcluded.contains($0.id) ? nil : $0 }
        let mobileSubtitle = EntityRowPresentation.subtitleFact(
            descriptor: descriptor, row: row, excluding: lineExcluded)
        // Line 2 never repeats the title (an Expense named after its Product).
        func addsToTitle(_ fact: EntityRowPresentation.Fact) -> Bool {
            fact.id != descriptor.titleField && EntityRowPresentation.isVisibleListFactValue(fact.value)
                && fact.value.caseInsensitiveCompare(row.title) != .orderedSame
        }
        // A two-line row with a declared state reads its subtitle fields together (Why · Outcome).
        let secondary =
            descriptor.presentation.titleSubtitle && descriptor.presentation.recordState != nil
            ? Array(
                EntityRowPresentation.subtitleFacts(descriptor: descriptor, row: row, excluding: lineExcluded)
                    .filter(addsToTitle).prefix(2)) : []
        let subtitle = [titleSubtitle, mobileSubtitle].compactMap { $0 }.first(where: addsToTitle)
        // An empty subtitle lets a composed title move its reference suffix to line 2.
        let titleParts = EntityRowPresentation.titleParts(
            descriptor: descriptor, row: row, subtitle: subtitle?.value ?? "")
        let subtitleText =
            secondary.isEmpty
            ? subtitle.map(EntityRowPresentation.lineText) ?? titleParts.subtitle
            : secondary.map(EntityRowPresentation.lineText).joined(separator: " · ")

        // Without a declared rail, the highest-priority trailing fact and a semantic date keep
        // the free trailing slot. The status field already reads on line 2.
        var trailingValue: EntityRowPresentation.Fact?
        var date: EntityRowPresentation.Fact?
        if rail.isEmpty {
            date = presentation.facts.first {
                $0.isDate && $0.id != "dataQuality" && !contextFields.contains($0.id)
            }
            trailingValue = presentation.facts.filter {
                !$0.isDate && $0.id != "dataQuality" && $0.id != statusKey
                    && !contextFields.contains($0.id)
                    && descriptor.field($0.id)?.mobileSlot == "trailing"
            }.min { left, right in
                (descriptor.field(left.id)?.mobilePriority ?? 0)
                    < (descriptor.field(right.id)?.mobilePriority ?? 0)
            }
        }
        let omitted = Set(
            ["dataQuality", statusKey, subtitle?.id, trailingValue?.id, date?.id].compactMap { $0 }
        ).union(railKeys).union(contextFields).union(stateKeys).union(secondary.map(\.id))
        let facts = presentation.facts.filter { !omitted.contains($0.id) && addsToTitle($0) }
        return Layout(
            presentation: presentation, title: titleParts.title, status: status, facts: facts,
            subtitleText: subtitleText.flatMap {
                EntityRowPresentation.isVisibleListFactValue($0) ? $0 : nil
            },
            rail: rail, trailingValue: trailingValue, date: date,
            needsData: EntityRowPresentation.needsData(in: row),
            state: descriptor.recordState(in: row.raw), progress: descriptor.recordProgress(in: row.raw))
    }

    var body: some View {
        let layout = layout
        let presentation = layout.presentation
        RecordListRow(
            title: layout.title, imageURL: presentation.imageURL,
            symbol: EntityCatalog[key].recordSymbol(in: row), emoji: EntityCatalog[key].recordEmoji(in: row),
            previewImage: previewImage, titleIdentifier: "entity.row.title.\(key.rawValue).\(row.id)",
            showsFallbackImage: showsFallbackImage
        ) {
            // RecordListRow owns line 2's clamp (one line, unbounded at accessibility sizes); a
            // nested limit here would still truncate context there. Accessibility sizes stack
            // the status mark over the facts instead of sharing one cramped line.
            let lineLayout =
                textSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                : AnyLayout(HStackLayout(spacing: FieldGuideTokens.Space.xs))
            lineLayout {
                FieldValueStatus(raw: row.raw)
                if let status = layout.status { statusMark(status) }
                if layout.needsData {
                    Circle().fill(FieldGuideTokens.warning).frame(width: 6, height: 6)
                }
                let facts = lineFacts(layout)
                if !facts.isEmpty {
                    Text(facts.joined(separator: " · "))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } rail: {
            if !layout.rail.isEmpty {
                RecordRailColumns(cells: layout.rail)
            } else {
                if let value = layout.trailingValue {
                    InheritedMarker.text(value.segments)
                        .monospacedDigit()
                        .accessibilityLabel(value.spokenValue)
                }
                if let date = layout.date?.dateValue {
                    RelativeDateDisplay(value: date)
                }
            }
        } supplement: {
            if layout.state != nil || layout.progress != nil {
                WrappingFactsLayout(spacing: FieldGuideTokens.Space.sm) {
                    if let state = layout.state { StateBadge(state: state) }
                    if let progress = layout.progress {
                        ProgressMeter(value: progress, variant: .row, paused: layout.state?.role == .paused)
                    }
                }
            }
            ForEach(presentation.facts) { fact in
                if let field = EntityCatalog[key].field(fact.id) {
                    FieldProvenanceCaption(raw: row.raw, field: field)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            accessibilityText(for: layout) + (FieldValueStatus.isUpdating(in: row.raw) ? ", Updating" : ""))
    }

    /// Line 2's facts after the status mark: placement or subtitle first, at most two in all.
    private func lineFacts(_ layout: Layout) -> [String] { lineItems(layout).map(\.text) }

    /// Line 2 after the status mark, at most two items: Needs data, the declared breadcrumb (a
    /// Product's placement), the subtitle, then the remaining facts. `spoken` labels a fact.
    private func lineItems(_ layout: Layout) -> [(text: String, spoken: String)] {
        let descriptor = EntityCatalog[key]
        let breadcrumb = descriptor.presentation.heroBreadcrumb
        func item(_ fact: EntityRowPresentation.Fact) -> (text: String, spoken: String) {
            (
                EntityRowPresentation.lineText(fact),
                "\(descriptor.field(fact.id)?.label ?? fact.id): \(fact.spokenValue)"
            )
        }
        var items: [(text: String, spoken: String)] = []
        if layout.needsData { items.append(("Needs data", "Needs data")) }
        if let lead = layout.facts.first(where: { $0.id == breadcrumb }) { items.append(item(lead)) }
        if let subtitle = layout.subtitleText { items.append((subtitle, subtitle)) }
        items += layout.facts.filter { $0.id != breadcrumb }.map(item)
        return Array(items.prefix(2))
    }

    /// The status word with its declared glyph; color is never its only channel.
    private func statusMark(_ status: EntityRowPresentation.Status) -> some View {
        let tint = FieldGuideMetrics.optionColor(status.option?.color) ?? FieldGuideTokens.graphiteSecondary
        return HStack(spacing: 2) {
            Image(systemName: status.option?.glyph?.sfSymbol ?? "circle.fill")
                .imageScale(.small)
                .foregroundStyle(tint)
            Text(status.text)
                .foregroundStyle(tint.mix(with: FieldGuideTokens.graphite, by: 0.35, in: .device))
        }
        .fixedSize()
    }

    private func accessibilityText(for layout: Layout) -> String {
        let descriptor = EntityCatalog[key]
        func label(_ id: String) -> String { descriptor.field(id)?.label ?? id }
        var parts = [layout.title]
        if let status = layout.status { parts.append(status.text) }
        if let state = layout.state {
            parts.append(([state.label] + [state.trailing].compactMap { $0 }).joined(separator: ", "))
        }
        if let progress = layout.progress { parts.append(progress.label) }
        parts += lineItems(layout).map(\.spoken)
        parts += layout.rail.compactMap { cell in
            cell.value.map {
                (["\(cell.label): \($0)"] + [cell.sub].compactMap { $0 }).joined(separator: ", ")
            }
        }
        if let value = layout.trailingValue { parts.append("\(label(value.id)): \(value.spokenValue)") }
        if let date = layout.date {
            let value = date.dateValue.flatMap { DatePresentation.value($0)?.text } ?? date.spokenValue
            parts.append("\(label(date.id)): \(value)")
        }
        if photoMode { parts.append(layout.presentation.shortcode) }
        return parts.joined(separator: ", ")
    }
}

private struct RelativeDateDisplay: View {
    let value: String
    @Environment(\.locale) private var locale

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            if let display = DatePresentation.value(value, now: context.date, compact: true, locale: locale) {
                Text(display.relative)
                    .monospacedDigit()
                    .help(display.exact)
                    .accessibilityLabel(display.text)
            } else {
                Text(value)
            }
        }
    }
}

#Preview("Compact rows · image", traits: .modifier(SignedInPreview())) {
    List {
        EntityRowView(
            key: .product,
            row: EntityScreenFixture.product.listPage.items[4],
            previewImage: Image(decorative: PreviewFixtures.sampleProbeImage, scale: 1))
    }
    .listStyle(.plain)
    .fieldGuideScreen()
}

#Preview("Rows", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        List {
            ForEach(EntityScreenFixture.product.listPage.items) { row in
                NavigationLink(value: Route.entityDetail(.product, id: row.id)) {
                    EntityRowView(key: .product, row: row)
                }
            }
        }
        .listStyle(.plain)
        .fieldGuideScreen()
        .navigationTitle("Products")
    }
}

#Preview("Compact rows · accessibility", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        List {
            EntityRowView(
                key: .product,
                row: EntityRow(
                    id: "PRD-9999",
                    title: "A very long product title that should expand without clipping",
                    subtitle: nil,
                    imageURL: nil,
                    raw: [
                        "id": "PRD-9999",
                        "name": "A very long product title that should expand without clipping",
                        "brandId": "VEN-2345", "brandName": "Sample Manufacturer",
                        "onHandUnits": 3, "expenseTotal": 21.5,
                        "updatedAt": "2026-09-12T10:00:00.000Z",
                    ]))
        }
        .listStyle(.plain)
        .fieldGuideScreen()
        .preferredColorScheme(.dark)
        .environment(\.dynamicTypeSize, .accessibility3)
    }
}
