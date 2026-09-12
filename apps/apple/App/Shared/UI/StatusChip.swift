import SwiftUI

/// A compact condition, always spelled out in words as well as color: a 1px semantic border over a
/// quiet tint. Status only — domain identity is a separate mark.
struct StatusChip: View {
    enum Tone {
        case neutral
        case positive
        case warning
        case destructive

        var color: Color {
            switch self {
            case .neutral: PorcelainTokens.graphiteSecondary
            case .positive: PorcelainTokens.positive
            case .warning: PorcelainTokens.warning
            case .destructive: PorcelainTokens.destructive
            }
        }
    }

    let text: String
    var tone: Tone = .neutral

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .foregroundStyle(tone == .neutral ? PorcelainTokens.graphite : tone.color)
            .padding(.horizontal, PorcelainTokens.Space.sm - 2)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: PorcelainTokens.radiusChip)
                    .fill(tone.color.opacity(tone == .neutral ? 0.06 : 0.08))
            )
            .overlay(
                RoundedRectangle(cornerRadius: PorcelainTokens.radiusChip)
                    .strokeBorder(
                        tone.color.opacity(tone == .neutral ? 0.35 : 0.5),
                        lineWidth: PorcelainTokens.hairlineWidth
                    )
            )
            .fixedSize()
    }
}

#Preview("Status chips") {
    HStack(spacing: PorcelainTokens.Space.sm) {
        StatusChip(text: "Added", tone: .positive)
        StatusChip(text: "Confirmed")
        StatusChip(text: "Elsewhere", tone: .warning)
        StatusChip(text: "Failed", tone: .destructive)
        StatusChip(text: "Best match")
    }
    .padding(PorcelainTokens.Space.lg)
    .background(PorcelainTokens.canvas)
}
