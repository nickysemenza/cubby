import SwiftUI

/// One visual row for entity records and event projections. Callers own data and navigation:
/// a navigable row wraps the whole row in its one link, never a link on the title (B1). A row
/// command sits beside that link, outside it. The row owns thumbnail fallback, identity/context,
/// the trailing rail, and wrapping geometry.
///
/// iPhone rows are about 56 points with a 40-point thumbnail; Mac rows keep 44 points and a
/// 32-point thumbnail for denser comparison beside native selection.
struct RecordListRow<Context: View, Rail: View, Supplement: View>: View {
    let title: String
    var imageURL: URL? = nil
    var symbol: String = "square.dashed"
    var emoji: String? = nil
    var thumbnailSize: CGFloat = RecordRowMetrics.thumbnail
    var previewImage: Image? = nil
    var titleIdentifier: String = ""
    @ViewBuilder var context: () -> Context
    @ViewBuilder var rail: () -> Rail
    @ViewBuilder var supplement: () -> Supplement
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
            if let previewImage {
                previewImage.resizable().scaledToFill()
                    .frame(width: thumbnailSize, height: thumbnailSize)
                    .clipShape(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl))
                    .accessibilityHidden(true)
            } else {
                Thumb(url: imageURL, size: thumbnailSize, symbol: symbol, emoji: emoji)
            }
            VStack(alignment: .leading, spacing: 2) {
                // Accessibility sizes stack the rail under the title by type size alone, never
                // from measured geometry, so the row cannot feed its width back into state.
                let layout =
                    textSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                    : AnyLayout(RecordRowColumns(spacing: FieldGuideTokens.Space.sm))
                layout {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(RecordRowMetrics.titleFont)
                            .lineLimit(textSize.isAccessibilitySize ? nil : 1)
                            .truncationMode(.tail)
                            .accessibilityIdentifier(titleIdentifier)
                            .fixedSize(horizontal: false, vertical: true)
                        context().font(RecordRowMetrics.contextFont).foregroundStyle(.secondary)
                            .lineLimit(textSize.isAccessibilitySize ? nil : 1)
                            .truncationMode(.tail)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    VStack(alignment: textSize.isAccessibilitySize ? .leading : .trailing, spacing: 2) {
                        rail()
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                    .multilineTextAlignment(textSize.isAccessibilitySize ? .leading : .trailing)
                    .fixedSize(horizontal: false, vertical: true)
                }
                supplement().font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, RecordRowMetrics.verticalPadding)
        .frame(maxWidth: .infinity, minHeight: RecordRowMetrics.minHeight, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Shared record row geometry, also read by group headers and selection marks that align with it.
enum RecordRowMetrics {
    #if os(iOS)
        static let thumbnail: CGFloat = 40
        static let minHeight: CGFloat = 56
        static let verticalPadding: CGFloat = 7
        static let titleFont = Font.subheadline.weight(.semibold)
        static let contextFont = Font.footnote
    #else
        static let thumbnail: CGFloat = 32
        static let minHeight: CGFloat = FieldGuideTokens.touchTarget
        static let verticalPadding: CGFloat = 5
        static let titleFont = Font.subheadline.weight(.medium)
        static let contextFont = Font.caption
    #endif

    /// A rail column's width for a field's declared `display.width` bucket, so a column keeps one
    /// width down the list and in its group header. Undeclared fields take a width for their kind.
    static func railWidth(bucket: String?) -> CGFloat {
        switch bucket {
        case "xs": 44
        case "sm": 72
        case "lg": 96
        case "xl": 112
        default: 80
        }
    }
}

/// One declared rail column: a tabular primary value over an optional sub value.
struct RecordRailCell: Identifiable, Hashable {
    enum Tone: Hashable { case plain, muted, destructive }

    let id: String
    /// The field label, spoken and shown at accessibility sizes where the column loses its header.
    let label: String
    let value: String?
    let sub: String?
    let width: CGFloat
    var tone: Tone = .plain
}

/// Up to two fixed-width rail columns. At accessibility sizes the columns become one wrapping
/// labeled line under the title ("Qty 3 · Value $4.29"); the switch reads the type size, never
/// the row's measured width.
struct RecordRailColumns: View {
    let cells: [RecordRailCell]
    @Environment(\.dynamicTypeSize) private var textSize
    @ScaledMetric(relativeTo: .subheadline) private var scale: CGFloat = 1

    var body: some View {
        if textSize.isAccessibilitySize {
            Text(
                cells.compactMap { cell in
                    guard let value = cell.value else { return nil }
                    return (["\(cell.label) \(value)"] + [cell.sub].compactMap { $0 }).joined(separator: " ")
                }.joined(separator: " · ")
            )
            .font(.footnote)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
                ForEach(cells) { cell in
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(cell.value ?? "—")
                            .font(.subheadline)
                            .foregroundStyle(color(cell))
                        if let sub = cell.sub {
                            Text(sub).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(width: cell.width * scale, alignment: .trailing)
                }
            }
        }
    }

    private func color(_ cell: RecordRailCell) -> Color {
        switch cell.tone {
        case .plain: cell.value == nil ? Color.secondary : Color.primary
        case .muted: Color.secondary
        case .destructive: FieldGuideTokens.destructive
        }
    }
}

/// Bound the rail during layout rather than updating state from the resulting geometry.
private struct RecordRowColumns: Layout {
    let spacing: CGFloat

    private func widths(proposal: ProposedViewSize, subviews: Subviews) -> (CGFloat, CGFloat) {
        let railIdeal = subviews[1].sizeThatFits(.unspecified).width
        let ideal = subviews[0].sizeThatFits(.unspecified).width + spacing + railIdeal
        let width = max(0, proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? ideal)
        // Fixed rail columns keep their declared width; a free trailing value stays bounded.
        let rail = min(railIdeal, width * 0.5)
        return (max(0, width - spacing - rail), rail)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let (identityWidth, railWidth) = widths(proposal: proposal, subviews: subviews)
        let identity = subviews[0].sizeThatFits(.init(width: identityWidth, height: nil))
        let rail = subviews[1].sizeThatFits(.init(width: railWidth, height: nil))
        return CGSize(width: identityWidth + spacing + railWidth, height: max(identity.height, rail.height))
    }

    func placeSubviews(
        in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
    ) {
        let (identityWidth, railWidth) = widths(
            proposal: .init(width: bounds.width, height: nil), subviews: subviews)
        subviews[0].place(
            at: bounds.origin, anchor: .topLeading,
            proposal: .init(width: identityWidth, height: nil))
        subviews[1].place(
            at: CGPoint(x: bounds.maxX, y: bounds.minY), anchor: .topTrailing,
            proposal: .init(width: railWidth, height: nil))
    }
}

#Preview("Record status rail") {
    RecordListRow(title: "Synthetic workshop lantern", symbol: "lightbulb") {
        Text("Research · Background agent")
    } rail: {
        Text("Completed")
        DateDisplay(date: .now)
    } supplement: {
        EmptyView()
    }
    .padding(12)
}

#Preview("Rail columns") {
    List {
        ForEach(0..<3) { index in
            RecordListRow(title: ["Oat milk, barista 1 L", "Cordless drill 18 V", "Basil seeds"][index]) {
                Text("Pantry › Shelf B")
            } rail: {
                RecordRailColumns(cells: [
                    RecordRailCell(
                        id: "qty", label: "Qty", value: ["3", "1", "2"][index], sub: "ea", width: 44),
                    RecordRailCell(
                        id: "value", label: "Value", value: ["$4.29", "$129.00", "$3.49"][index],
                        sub: "Oct 28",
                        width: 72),
                ])
            } supplement: {
                EmptyView()
            }
        }
    }
    .listStyle(.plain)
}
