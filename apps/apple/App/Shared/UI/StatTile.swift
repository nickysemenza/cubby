import SwiftUI

/// One decision-relevant fact: eyebrow label, a figure in tabular digits, and an optional
/// qualifier. Meant for a two-column grid on a detail screen — not a dashboard of KPI cards, so
/// the figure stays `.title3` and the tile carries no shadow and no color fill.
struct StatTile: View {
    let label: String
    let value: String
    var detail: String?
    var mono = false

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
            Eyebrow(label)
            Text(value)
                .font(mono ? .porcelainCode : .title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(PorcelainTokens.graphite)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
                .textSelection(.enabled)
            if let detail {
                Text(detail)
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(PorcelainTokens.Space.md)
        // Stretch to the grid row's height: two tiles side by side must read as one row, not as
        // two cards that happen to be adjacent.
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel).fill(PorcelainTokens.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
        )
    }
}

#Preview("Stat tiles") {
    LazyVGrid(
        columns: Array(repeating: GridItem(.flexible(), spacing: PorcelainTokens.Space.md), count: 2),
        spacing: PorcelainTokens.Space.md
    ) {
        StatTile(label: "On hand", value: "3", detail: "2 locations")
        StatTile(label: "Price", value: "$24.95")
        StatTile(label: "Category", value: "Cookware")
        StatTile(label: "Barcode", value: "00075536010014", mono: true)
    }
    .padding(PorcelainTokens.Space.lg)
    .background(PorcelainTokens.canvas)
}
