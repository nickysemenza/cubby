import CubbyKit
import SwiftUI

/// Semantic native appearance. Legacy token names keep specialized workbenches consistent while
/// their content uses the system's lists, forms, controls, and adaptive surfaces (see ../DESIGN.md).
enum PorcelainTokens {
    #if os(macOS)
        static let canvas = Color(nsColor: .windowBackgroundColor)
        static let surface = Color(nsColor: .controlBackgroundColor)
        static let inset = Color(nsColor: .underPageBackgroundColor)
        static let hairline = Color(nsColor: .separatorColor)
    #else
        static let canvas = Color(uiColor: .systemGroupedBackground)
        static let surface = Color(uiColor: .secondarySystemGroupedBackground)
        static let inset = Color(uiColor: .tertiarySystemGroupedBackground)
        static let hairline = Color(uiColor: .separator)
    #endif
    static let graphite = Color.primary
    static let graphiteSecondary = Color.secondary

    // Interaction.
    static let cobalt = Color("AccentColor")

    // Condition.
    static let positive = Color("Positive")
    static let warning = Color("Warning")
    static let destructive = Color("Destructive")

    // Domain lines. Marks only — a dot, an icon tint, or a single hairline. Never a fill.
    static let cookSaffron = Color("Cook")
    static let pantryGreen = Color("Pantry")
    static let planViolet = Color("Plan")
    static let houseCyan = Color("House")
    static let financeMagenta = Color("Finance")

    /// A category-agnostic chart ramp: a photo category is tinted by its *index* into this array
    /// (`PhotoCategoryTint`), never by its key, so a category rename never touches this list.
    static let chartRamp: [Color] = [cookSaffron, pantryGreen, planViolet, houseCyan, financeMagenta]

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

extension AppDomain {
    /// The declaration vocabulary has five lines; the native shell draws four. Pantry marks
    /// exist as a token (`pantryGreen`) but not as a navigation group, so pantry records file
    /// under House here.
    init(_ domain: WayfindingDomain) {
        self =
            switch domain {
            case .cook: .cook
            case .plan: .plan
            case .finance: .finance
            case .house, .pantry: .house
            }
    }
}

extension EntityKey {
    /// Which domain line an entity belongs to, from `presentation.domain` in the entity
    /// declarations. An entity on no line (image) files under House.
    var domain: AppDomain {
        EntityCatalog[self].domain.map(AppDomain.init) ?? .house
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
    static let porcelainBody = Font.body
    /// Quantities, money, dates, and aligned comparison values.
    static let porcelainData = Font.body.monospacedDigit()
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
