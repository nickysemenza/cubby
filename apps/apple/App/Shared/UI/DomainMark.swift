import CubbyKit
import SwiftUI

/// Where am I? An 8pt dot, or the entity's own glyph tinted, in the domain's line color. Never a
/// fill and never a status: a green pantry mark is not a success state.
struct DomainMark: View {
    enum Style {
        case dot
        case symbol
    }

    private let domain: AppDomain
    private let glyph: String?
    private let style: Style
    private let size: CGFloat

    init(_ key: EntityKey, style: Style = .dot, size: CGFloat = 8) {
        self.domain = key.domain
        self.glyph = entitySymbol(for: key)
        self.style = style
        self.size = size
    }

    init(_ domain: AppDomain, style: Style = .dot, size: CGFloat = 8) {
        self.domain = domain
        self.glyph = domain.symbol
        self.style = style
        self.size = size
    }

    var body: some View {
        switch style {
        case .dot:
            Circle()
                .fill(domain.color)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        case .symbol:
            Image(systemName: glyph ?? domain.symbol)
                .font(.system(size: size))
                .foregroundStyle(domain.color)
                .accessibilityHidden(true)
        }
    }
}

#Preview("Domain marks") {
    VStack(alignment: .leading, spacing: PorcelainTokens.Space.md) {
        ForEach(AppDomain.allCases) { domain in
            HStack(spacing: PorcelainTokens.Space.sm) {
                DomainMark(domain)
                DomainMark(domain, style: .symbol, size: 14)
                Text(domain.title).font(.porcelainTitle)
            }
        }
        PanelDivider(inset: 0)
        HStack(spacing: PorcelainTokens.Space.sm) {
            DomainMark(.product)
            Text("Products").font(.porcelainBody)
            DomainMark(.expense)
            Text("Expenses").font(.porcelainBody)
        }
    }
    .padding(PorcelainTokens.Space.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PorcelainTokens.canvas)
}
