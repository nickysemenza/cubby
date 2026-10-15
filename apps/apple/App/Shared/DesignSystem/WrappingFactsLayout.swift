import SwiftUI

/// Packs record facts into the available width without hiding them behind horizontal scrolling.
struct WrappingFactsLayout: Layout {
    var spacing: CGFloat = 8

    private func arrangement(width: CGFloat, subviews: Subviews) -> (CGSize, [CGRect]) {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        for view in subviews {
            let ideal = view.sizeThatFits(.unspecified)
            let size = view.sizeThatFits(
                ProposedViewSize(width: min(ideal.width, width), height: nil))
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight
                lineHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return (CGSize(width: width, height: y + lineHeight), frames)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width =
            proposal.width.flatMap { $0.isFinite ? $0 : nil }
            ?? subviews.reduce(0) { $0 + $1.sizeThatFits(.unspecified).width + spacing }
        return arrangement(width: max(0, width), subviews: subviews).0
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let (_, frames) = arrangement(width: bounds.width, subviews: subviews)
        for (view, frame) in zip(subviews, frames) {
            view.place(
                at: CGPoint(
                    x: bounds.minX + frame.minX,
                    y: bounds.minY + frame.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(frame.size))
        }
    }
}

#Preview("Wrapping facts") {
    WrappingFactsLayout {
        Text("Quality: Needs data")
        Text("Classification: Inherited from a longer category name")
        Text("Updated recently")
    }
    .font(.caption)
    .frame(width: 240)
    .padding(12)
}
