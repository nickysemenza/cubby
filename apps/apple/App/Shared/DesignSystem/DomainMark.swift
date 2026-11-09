import CubbyKit
import SwiftUI

/// A record-context mark: neutral beside records. Wayfinding (the Library catalog, matching the
/// Mac sidebar) passes `hued` for the domain's glyph color, and section headers use `.chip`, the
/// small rounded square in the domain hue that web and the Mac sidebar draw.
struct DomainMark: View {
    enum Style {
        case dot
        case symbol
        /// A section header's domain chip: always hued.
        case chip
    }

    private let domain: AppDomain
    private let glyph: String?
    private let style: Style
    private let size: CGFloat
    private let hued: Bool
    /// The symbol grows with Dynamic Type from its declared point size; the dot stays a mark.
    @ScaledMetric(relativeTo: .body) private var symbolScale: CGFloat = 1

    init(_ key: EntityKey, style: Style = .dot, size: CGFloat = 8, hued: Bool = false) {
        self.domain = key.domain
        self.glyph = entitySymbol(for: key)
        self.style = style
        self.size = size
        self.hued = hued
    }

    init(_ domain: AppDomain, style: Style = .dot, size: CGFloat = 8, hued: Bool = false) {
        self.domain = domain
        self.glyph = domain.symbol
        self.style = style
        self.size = size
        self.hued = hued
    }

    var body: some View {
        switch style {
        case .dot:
            Circle()
                .fill(hued ? AnyShapeStyle(domain.color) : AnyShapeStyle(.tertiary))
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        case .symbol:
            Image(systemName: glyph ?? domain.symbol)
                .font(.system(size: size * symbolScale))
                .foregroundStyle(hued ? AnyShapeStyle(domain.color) : AnyShapeStyle(.secondary))
                .accessibilityHidden(true)
        case .chip:
            RoundedRectangle(cornerRadius: 2)
                .fill(domain.color)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}

#Preview("Domain marks") {
    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
        ForEach(AppDomain.allCases) { domain in
            HStack(spacing: FieldGuideTokens.Space.sm) {
                DomainMark(domain)
                DomainMark(domain, style: .symbol, size: 14)
                DomainMark(domain, style: .chip, size: 6)
                DomainMark(domain, style: .symbol, size: 14, hued: true)
                Text(domain.title).font(.fieldGuideTitle)
            }
        }
        PanelDivider(inset: 0)
        HStack(spacing: FieldGuideTokens.Space.sm) {
            DomainMark(.product)
            Text("Products").font(.fieldGuideBody)
            DomainMark(.expense)
            Text("Expenses").font(.fieldGuideBody)
        }
    }
    .padding(FieldGuideTokens.Space.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(FieldGuideTokens.canvas)
}
