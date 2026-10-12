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
    @State private var contentWidth: CGFloat = 0

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
                    : AnyLayout(HStackLayout(alignment: .top, spacing: FieldGuideTokens.Space.sm))
                layout {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.subheadline.weight(.semibold))
                            .accessibilityIdentifier(titleIdentifier)
                            .fixedSize(horizontal: false, vertical: true)
                        context().font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .layoutPriority(1)
                    VStack(alignment: .trailing, spacing: 2) { rail() }
                        .font(.caption2).foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                        .frame(
                            maxWidth: textSize.isAccessibilitySize || contentWidth == 0
                                ? nil : contentWidth * 0.42,
                            alignment: .trailing
                        )
                        .fixedSize(horizontal: !textSize.isAccessibilitySize, vertical: true)
                }
                supplement().font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) {
                $0.size.width
            } action: {
                contentWidth = $0
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, FieldGuideTokens.Space.xs)
        .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Relative timestamps show one localized unit, keeping the rail quiet as time advances.
struct RecordRowTimestamp: View {
    let date: Date

    var body: some View {
        Text(date, format: .relative(presentation: .named, unitsStyle: .abbreviated))
            .monospacedDigit()
    }
}

#Preview("Record status rail") {
    RecordListRow(title: "Synthetic workshop lantern", symbol: "lightbulb") {
        Text("Research · Background agent")
    } rail: {
        Text("Completed")
        RecordRowTimestamp(date: .now)
    } supplement: {
        EmptyView()
    }
    .padding(12)
}
