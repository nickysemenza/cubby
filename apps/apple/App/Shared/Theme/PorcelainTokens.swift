import CubbyKit
import SwiftUI

/// Porcelain Transit: the web app's design language (apps/web/DESIGN.md) expressed as colors,
/// metrics, and type roles. System chrome stays stock SwiftUI so the iOS 26 SDK's own materials
/// (Liquid Glass on bars, tabs, and sheets) apply without us re-drawing them.
///
/// Three color channels never substitute for one another: cobalt is interaction, the five domain
/// lines are wayfinding, and positive/warning/destructive are condition.
enum PorcelainTokens {
    // Planes and ink.
    static let canvas = Color(hex: 0xF7F9FC)
    static let surface = Color(hex: 0xFFFFFF)
    static let inset = Color(hex: 0xF1F4F8)
    static let graphite = Color(hex: 0x171A21)
    static let graphiteSecondary = Color(hex: 0x667085)
    static let hairline = Color(hex: 0xD9DEE7)

    // Interaction.
    static let cobalt = Color(hex: 0x2563EB)

    // Condition.
    static let positive = Color(hex: 0x16845B)
    static let warning = Color(hex: 0xB66A00)
    static let destructive = Color(hex: 0xC93636)

    // Domain lines. Marks only — a dot, an icon tint, or a single hairline. Never a fill.
    static let cookSaffron = Color(hex: 0xD97706)
    static let pantryGreen = Color(hex: 0x16845B)
    static let planViolet = Color(hex: 0x6D5BD0)
    static let houseCyan = Color(hex: 0x147D92)
    static let financeMagenta = Color(hex: 0xB5477C)

    // Shapes: controls 6, panels 8, chips 5. Boundaries are 1px; no shadow at rest.
    static let radiusControl: CGFloat = 6
    static let radiusPanel: CGFloat = 8
    static let radiusChip: CGFloat = 5
    static let hairlineWidth: CGFloat = 1

    /// The 4/8/12/16/20/24 rhythm. Phone content is normal density; targets stay >= 44pt.
    enum Space {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 20
        static let xxl: CGFloat = 24
    }

    /// Minimum interactive height on phone.
    static let touchTarget: CGFloat = 44
    /// Detail column reading width on Mac.
    static let readingWidth: CGFloat = 720
}

/// The five stable domain lines. Cubby's native shell surfaces four of them as navigation groups;
/// `pantryGreen` exists as a token for pantry-specific marks the PoC does not draw yet.
enum AppDomain: String, CaseIterable, Identifiable {
    case house, cook, plan, finance

    var id: String { rawValue }

    var title: String {
        switch self {
        case .house: "House"
        case .cook: "Cook"
        case .plan: "Plan"
        case .finance: "Finance"
        }
    }

    var color: Color {
        switch self {
        case .house: PorcelainTokens.houseCyan
        case .cook: PorcelainTokens.cookSaffron
        case .plan: PorcelainTokens.planViolet
        case .finance: PorcelainTokens.financeMagenta
        }
    }

    /// The group glyph, used where a domain itself is the subject (a Browse header, a Mac sidebar
    /// row) rather than one entity within it.
    var symbol: String {
        switch self {
        case .house: "house"
        case .cook: "fork.knife"
        case .plan: "hammer"
        case .finance: "creditcard"
        }
    }
}

extension EntityKey {
    /// Which domain line an entity belongs to. Ingredients stay on Cook: the pantry line is about
    /// stock on hand, and an ingredient is a recipe-side identity.
    var domain: AppDomain {
        switch self {
        case .product, .inventory, .location, .usdaFood, .image: .house
        case .recipe, .ingredient, .cookbook, .meal: .cook
        case .project, .task, .wish: .plan
        case .vendor, .purchase, .expense, .financialAccount, .financialTransaction,
            .ledgerParty, .ledgerTransfer: .finance
        }
    }
}

/// Type roles from DESIGN.md, mapped onto system text styles so Dynamic Type keeps working.
/// Inter and JetBrains Mono are not bundled yet; the system face carries the same hierarchy.
extension Font {
    /// Detail identity only.
    static let porcelainDisplay = Font.largeTitle.weight(.semibold)
    /// Page identity and major regions.
    static let porcelainHeadline = Font.title2.weight(.semibold)
    /// Panels, rows, and section titles.
    static let porcelainTitle = Font.subheadline.weight(.semibold)
    /// Explanations and continuous reading.
    static let porcelainBody = Font.subheadline
    /// Quantities, money, dates, and aligned comparison values.
    static let porcelainData = Font.footnote.monospacedDigit()
    /// Compact metadata, sentence case.
    static let porcelainLabel = Font.caption.weight(.medium)
    /// Shortcodes and raw payloads: the second voice, and only ever for codes.
    static let porcelainCode = Font.footnote.monospaced()
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
