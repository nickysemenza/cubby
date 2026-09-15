import SwiftUI

/// A system group for workspaces whose content does not fit a List or Form.
struct Panel<Content: View>: View {
    private let padding: CGFloat
    private let spacing: CGFloat
    private let content: Content

    /// - Parameters:
    ///   - padding: internal padding; pass `0` when the panel holds full-bleed rows that own theirs.
    ///   - spacing: gap between stacked children.
    init(
        padding: CGFloat = PorcelainTokens.Space.md,
        spacing: CGFloat = PorcelainTokens.Space.md,
        @ViewBuilder content: () -> Content
    ) {
        self.padding = padding
        self.spacing = spacing
        self.content = content()
    }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: spacing) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(padding)
        }
    }
}

/// The hairline between two rows inside a zero-padding `Panel`.
struct PanelDivider: View {
    var inset: CGFloat = PorcelainTokens.Space.md

    var body: some View {
        Divider().padding(.leading, inset)
    }
}

/// A label/value row for panel interiors: quiet label left, value right. `data` switches the value
/// to tabular figures so stacked quantities, money, and dates align down the column.
struct LabeledRow: View {
    let label: String
    let value: String
    var data = false
    var mono = false
    var tone: Color = PorcelainTokens.graphite

    var body: some View {
        LabeledContent(label) {
            Text(value)
                .font(valueFont)
                .foregroundStyle(tone)
                .textSelection(.enabled)
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.sm)
    }

    private var valueFont: Font {
        if mono { return .porcelainCode }
        return data ? .porcelainData : .porcelainBody
    }
}

#Preview("Panel") {
    ScrollView {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.lg) {
            Panel {
                Eyebrow("Session")
                Text("Signed in to cubby.nickysemenza.com")
                    .font(.porcelainBody)
            }
            Panel(padding: 0, spacing: 0) {
                LabeledRow(label: "Host", value: "cubby.nickysemenza.com")
                PanelDivider()
                LabeledRow(label: "On hand", value: "3", data: true)
                PanelDivider()
                LabeledRow(label: "Shortcode", value: "PRD-2345", mono: true)
            }
        }
        .padding(PorcelainTokens.Space.lg)
    }
    .background(PorcelainTokens.canvas)
}
