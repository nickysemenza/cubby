import CubbyKit
import SwiftUI

/// A compact condition, always spelled out in words as well as color: a 1px semantic border over a
/// quiet tint, led by the state's glyph when the option declares one. A `category` option (a kind,
/// not a state) paints as a neutral chip with a color dot instead. Domain identity is a separate mark.
struct StatusChip: View {
    enum Tone {
        case neutral
        case positive
        case warning
        case destructive

        var color: Color {
            switch self {
            case .neutral: FieldGuideTokens.graphiteSecondary
            case .positive: FieldGuideTokens.positive
            case .warning: FieldGuideTokens.warning
            case .destructive: FieldGuideTokens.destructive
            }
        }
    }

    let text: String
    var tone: Tone = .neutral
    var color: Color? = nil
    /// The option's SF Symbol (`LabeledOption.glyph`).
    var symbol: String? = nil
    /// A kind rather than a state (`LabeledOption.role == "category"`).
    var category = false

    private var ink: Color { color ?? tone.color }
    private var isNeutral: Bool { category || (color == nil && tone == .neutral) }

    var body: some View {
        HStack(spacing: 3) {
            if category {
                Circle().fill(ink).frame(width: 6, height: 6).accessibilityHidden(true)
            } else if let symbol {
                Image(systemName: symbol)
                    .imageScale(.small)
                    .foregroundStyle(ink)
                    .accessibilityHidden(true)
            }
            Text(text)
        }
            .font(.caption.weight(.medium))
            .foregroundStyle(
                isNeutral
                    ? FieldGuideTokens.graphite
                    : ink.mix(with: FieldGuideTokens.graphite, by: 0.35, in: .device)
            )
            .padding(.horizontal, FieldGuideTokens.Space.sm - 2)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: FieldGuideTokens.radiusChip)
                    .fill(ink.opacity(isNeutral ? 0.06 : 0.08))
            )
            .overlay(
                RoundedRectangle(cornerRadius: FieldGuideTokens.radiusChip)
                    .strokeBorder(
                        ink.opacity(isNeutral ? 0.35 : 0.5),
                        lineWidth: FieldGuideTokens.hairlineWidth
                    )
            )
            .fixedSize(horizontal: false, vertical: true)
    }
}

extension StatusChip {
    /// A declared option's chip, or nil when its color has no adaptive asset.
    init?(text: String, option: LabeledOption) {
        guard let color = FieldGuideMetrics.optionColor(option.color) else { return nil }
        self.init(
            text: text, color: color, symbol: option.glyph?.sfSymbol,
            category: option.role == "category")
    }
}

#Preview("Status chips") {
    HStack(spacing: FieldGuideTokens.Space.sm) {
        StatusChip(text: "Added", tone: .positive)
        StatusChip(text: "Confirmed")
        StatusChip(text: "Elsewhere", tone: .warning)
        StatusChip(text: "Failed", tone: .destructive)
        StatusChip(text: "Best match")
        StatusChip(
            text: "In progress", color: FieldGuideTokens.info, symbol: "circle.lefthalf.filled")
        StatusChip(text: "Durable", color: FieldGuideTokens.categoryRamp[1], category: true)
    }
    .padding(FieldGuideTokens.Space.lg)
    .background(FieldGuideTokens.canvas)
}
