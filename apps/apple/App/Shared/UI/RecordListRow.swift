import SwiftUI

/// One visual row for entity records and event projections. Callers own data and navigation;
/// the row owns thumbnail fallback, identity/context, the trailing rail, and wrapping geometry.
struct RecordListRow<Context: View, Rail: View, Supplement: View>: View {
    let title: String
    var imageURL: URL? = nil
    var symbol: String = "square.dashed"
    var emoji: String? = nil
    var thumbnailSize: CGFloat = 36
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
                let layout =
                    textSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
                    : AnyLayout(RecordRowColumns(spacing: FieldGuideTokens.Space.sm))
                layout {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.subheadline.weight(.semibold))
                            .accessibilityIdentifier(titleIdentifier)
                            .fixedSize(horizontal: false, vertical: true)
                        context().font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    VStack(alignment: .trailing, spacing: 2) { rail() }
                        .font(.caption2).foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                }
                supplement().font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, FieldGuideTokens.Space.xs)
        .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Bound the rail during layout rather than updating state from the resulting geometry.
private struct RecordRowColumns: Layout {
    let spacing: CGFloat

    private func widths(proposal: ProposedViewSize, subviews: Subviews) -> (CGFloat, CGFloat) {
        let railIdeal = subviews[1].sizeThatFits(.unspecified).width
        let ideal = subviews[0].sizeThatFits(.unspecified).width + spacing + railIdeal
        let width = max(0, proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? ideal)
        let rail = min(railIdeal, width * 0.42)
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
