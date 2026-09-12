import SwiftUI

/// A cover image in a 6pt rounded rect with a hairline. The placeholder is inset tone plus the
/// entity's own glyph, so a row without a photo still says what kind of record it is.
struct Thumb: View {
    let url: URL?
    var size: CGFloat = 56
    var symbol: String = "photo"

    var body: some View {
        RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl)
            .fill(PorcelainTokens.inset)
            .overlay {
                if let url {
                    AsyncImage(url: url) { phase in
                        if case .success(let image) = phase {
                            image.resizable().scaledToFill()
                        } else {
                            glyph
                        }
                    }
                } else {
                    glyph
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl)
                    .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
            )
            .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    private var glyph: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.34))
            .foregroundStyle(PorcelainTokens.graphiteSecondary)
    }
}

#Preview("Thumbs") {
    HStack(spacing: PorcelainTokens.Space.md) {
        Thumb(url: nil, size: 56, symbol: "shippingbox")
        Thumb(url: nil, size: 40, symbol: "mappin.and.ellipse")
        Thumb(url: nil, size: 96, symbol: "fork.knife")
    }
    .padding(PorcelainTokens.Space.lg)
    .background(PorcelainTokens.canvas)
}
