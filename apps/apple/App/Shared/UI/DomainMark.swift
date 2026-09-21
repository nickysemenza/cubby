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

/// The domain line(s) a top-level section works in. Capture acts on House records, and Browse and
/// Search preview all four lines because they span all of them. Today, Photos, and Dev are shell
/// surfaces and get no mark. The macOS sidebar shows this beside the row; the iOS tab bar cannot
/// carry a custom view, so there it sits in the section's navigation bar instead.
struct SectionDomainMarks: View {
    let section: AppSection

    var body: some View {
        switch section {
        case .capture:
            DomainMark(.house, size: 7)
        case .browse, .search, .graph:
            HStack(spacing: 3) {
                ForEach(AppDomain.allCases) { domain in
                    DomainMark(domain, size: 5)
                }
            }
        case .today, .activity, .photos, .dev:
            EmptyView()
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
        PanelDivider(inset: 0)
        ForEach(AppSection.allCases) { section in
            HStack(spacing: PorcelainTokens.Space.sm) {
                Text(section.title).font(.porcelainBody)
                SectionDomainMarks(section: section)
            }
        }
    }
    .padding(PorcelainTokens.Space.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(PorcelainTokens.canvas)
}
