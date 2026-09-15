import CubbyKit
import Nuke
import NukeUI
import SwiftUI

/// A cover image in a 6pt rounded rect with a hairline. The placeholder is inset tone plus the
/// entity's own glyph, so a row without a photo still says what kind of record it is.
///
/// Every cover URL is a public R2 URL (`EntityRow.imageURL`'s doc comment) — no auth header, so
/// Nuke's default `DataLoader` (its own ephemeral `URLSession`, not `URLSession.cubbyShared`)
/// fetches it exactly as the `AsyncImage` this replaced did.
struct Thumb: View {
    let url: URL?
    var size: CGFloat = 56
    var symbol: String = "photo"

    @Environment(\.displayScale) private var displayScale
    @State private var useCanonicalURL = false

    var body: some View {
        RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl)
            .fill(PorcelainTokens.inset)
            .overlay {
                if let url {
                    LazyImage(request: request(for: url, transformed: !useCanonicalURL)) { state in
                        if let image = state.image {
                            image.resizable().scaledToFill()
                        } else {
                            glyph
                        }
                    }
                    .onCompletion { result in
                        if case .failure = result, !useCanonicalURL {
                            useCanonicalURL = true
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
            .onChange(of: url) {
                useCanonicalURL = false
            }
    }

    /// Fetches the Cloudflare-transformed rung for this rendered width (the same URL the web
    /// mints, so both clients share one edge-cache entry), then downsizes that rung to the thumb's
    /// actual pixel size so the decoded bitmap never exceeds what is drawn.
    private func request(for url: URL, transformed: Bool) -> ImageRequest {
        let pixels = size * displayScale
        return ImageRequest(
            url: transformed ? ImageTransform.transformed(url, renderedWidth: size) : url,
            processors: [ImageProcessors.Resize(size: CGSize(width: pixels, height: pixels))])
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
