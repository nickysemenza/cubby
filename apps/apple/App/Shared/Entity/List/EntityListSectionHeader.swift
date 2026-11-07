import CubbyKit
import SwiftUI

/// The pinned header of one grouped-list section: its label, its count over the whole filtered
/// set, and the server's totals for summed rail columns at the rail's own widths, so totals align
/// with the values beneath them. When the grouped field declares a filter, tapping the header
/// offers "Filter to this" (keep only this section) and "Hide" (keep the grouping, drop this
/// section).
struct EntityListSectionHeader: View {
    /// Each action is present only when the Group by choice's filter can express it.
    struct Actions {
        var filter: (() -> Void)?
        var hide: (() -> Void)?

        init(filter: (() -> Void)? = nil, hide: (() -> Void)? = nil) {
            self.filter = filter
            self.hide = hide
        }

        var isEmpty: Bool { filter == nil && hide == nil }
    }

    let section: EntityListSection
    let entity: EntityKey
    var actions = Actions()
    /// One cell per rail column; a column without a server total keeps its width blank.
    var totals: [RecordRailCell] = []
    var body: some View {
        Group {
            if actions.isEmpty {
                label(actionable: false)
            } else {
                Menu {
                    if let filter = actions.filter {
                        Button("Filter to this", systemImage: "line.3.horizontal.decrease", action: filter)
                            .accessibilityIdentifier("browse.\(entity.rawValue).section.\(section.id).filter")
                    }
                    if let hide = actions.hide {
                        Button("Hide", systemImage: "eye.slash", action: hide)
                            .accessibilityIdentifier("browse.\(entity.rawValue).section.\(section.id).hide")
                    }
                } label: {
                    label(actionable: true)
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .accessibilityHint("Filters to or hides this \(section.label)")
            }
        }
        .accessibilityIdentifier("browse.\(entity.rawValue).section.\(section.id)")
    }

    private func label(actionable: Bool) -> some View {
        HStack(spacing: FieldGuideTokens.Space.sm) {
            Text(section.label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
            Text(section.count.formatted())
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            if actionable {
                Image(systemName: "ellipsis")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: 0)
            RecordRailTotals(cells: totals)
        }
        // A list section header dims its content's hierarchical styles, and a Menu label (unlike
        // a Button's) does not reset them; anchor the hierarchy so the label reads as primary.
        .foregroundStyle(Color.primary)
        .padding(.horizontal, FieldGuideTokens.Space.md)
        .padding(.vertical, FieldGuideTokens.Space.xs)
        // A compact 28-point header; one with actions keeps the 44-point phone target.
        .frame(maxWidth: .infinity, minHeight: minHeight(actionable: actionable), alignment: .leading)
        .background(.bar)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func minHeight(actionable: Bool) -> CGFloat {
        #if os(iOS)
            actionable ? FieldGuideTokens.touchTarget : 28
        #else
            28
        #endif
    }
}

/// Rail totals at the rail's own column widths, so each sits over the values it sums; a column
/// without a total keeps its width blank. At accessibility sizes the totals read as one labeled
/// line instead.
struct RecordRailTotals: View {
    let cells: [RecordRailCell]
    @Environment(\.dynamicTypeSize) private var textSize
    @ScaledMetric(relativeTo: .subheadline) private var railScale: CGFloat = 1

    var body: some View {
        if cells.contains(where: { $0.value != nil }) {
            if textSize.isAccessibilitySize {
                Text(
                    cells.compactMap { cell in cell.value.map { "\(cell.label) \($0)" } }
                        .joined(separator: " · ")
                )
                .font(.caption.weight(.semibold))
                .monospacedDigit()
            } else {
                HStack(spacing: FieldGuideTokens.Space.sm) {
                    ForEach(cells) { cell in
                        Text(cell.value ?? "")
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .frame(width: cell.width * railScale, alignment: .trailing)
                            .accessibilityLabel(cell.value.map { "\(cell.label) total \($0)" } ?? "")
                    }
                }
            }
        }
    }
}

/// An ungrouped list's count line: "8 products" (and "filtered"), with the summed rail columns'
/// totals aligned over their columns. There is no group label to show, so it is not a header.
struct EntityListSummary: View {
    let text: String
    var totals: [RecordRailCell] = []
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        let layout =
            textSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(spacing: FieldGuideTokens.Space.sm))
        layout {
            Text(text)
                .font(.caption)
                .lineLimit(textSize.isAccessibilitySize ? nil : 1)
                .truncationMode(.tail)
            if !textSize.isAccessibilitySize { Spacer(minLength: 0) }
            RecordRailTotals(cells: totals)
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

#Preview("Section header actions") {
    VStack(spacing: 0) {
        EntityListSectionHeader(
            section: EntityListSection(id: "PCT-OUTER", label: "Outerwear", count: 4, rows: []),
            entity: .inventory, actions: .init(filter: {}, hide: {}),
            totals: [
                RecordRailCell(id: "qty", label: "Qty", value: nil, sub: nil, width: 44),
                RecordRailCell(id: "value", label: "Value", value: "$163.00", sub: nil, width: 72),
            ])
        EntityListSectionHeader(
            section: EntityListSection(
                id: EntityListSection.noValueKey, label: "No placement", count: 2, rows: []),
            entity: .inventory)
    }
}
