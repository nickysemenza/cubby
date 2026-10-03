import CubbyKit
import SwiftUI

/// Shared brand decisions on native surfaces. Controls, navigation, and text sizing remain SwiftUI.
enum FieldGuideTokens {
    static let canvas = Color("Canvas")
    static let surface = Color("Surface")
    static let inset = Color("Inset")
    static let hairline = Color("Hairline")
    static let graphite = Color.primary
    static let graphiteSecondary = Color.secondary

    // Interaction and attention are separate roles.
    static let interaction = Color("AccentColor")
    static let signal = Color("Signal")

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

    // Geometry comes from the same source as web CSS.
    static let radiusControl = FieldGuideMetrics.radiusControl
    static let radiusPanel = FieldGuideMetrics.radiusPanel
    static let radiusChip = FieldGuideMetrics.radiusChip
    static let hairlineWidth: CGFloat = 1

    /// The 4/8/12/16/20/24 rhythm. Phone content is normal density; targets stay >= 44pt.
    enum Space {
        static let xs = FieldGuideMetrics.space1
        static let sm = FieldGuideMetrics.space2
        static let md = FieldGuideMetrics.space3
        static let lg = FieldGuideMetrics.space4
        static let xl = FieldGuideMetrics.space5
        static let xxl = FieldGuideMetrics.space6
    }

    /// Minimum interactive height on phone.
    static let touchTarget: CGFloat = 44
    /// Detail column reading width on Mac.
    static let readingWidth: CGFloat = 720
}

/// The same five manifest domains appear in native and web navigation.
enum AppDomain: String, CaseIterable, Identifiable {
    case house, cook, pantry, plan, finance

    var id: String { rawValue }

    /// The manifest's own line, whose title and glyph are generated from
    /// `WAYFINDING_DOMAIN_PRESENTATION` so native and web name every domain alike.
    var wayfinding: WayfindingDomain {
        switch self {
        case .house: .house
        case .cook: .cook
        case .pantry: .pantry
        case .plan: .plan
        case .finance: .finance
        }
    }

    var title: String { wayfinding.title }

    var color: Color {
        switch self {
        case .house: FieldGuideTokens.houseCyan
        case .cook: FieldGuideTokens.cookSaffron
        case .pantry: FieldGuideTokens.pantryGreen
        case .plan: FieldGuideTokens.planViolet
        case .finance: FieldGuideTokens.financeMagenta
        }
    }

    /// The group glyph, used where a domain itself is the subject (a Browse header, a Mac sidebar
    /// row) rather than one entity within it.
    var symbol: String { wayfinding.sfSymbol }
}

extension AppDomain {
    init(_ domain: WayfindingDomain) {
        self =
            switch domain {
            case .cook: .cook
            case .pantry: .pantry
            case .plan: .plan
            case .finance: .finance
            case .house: .house
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

/// Editorial headings use a system serif; all reading and controls retain Dynamic Type.
extension Font {
    /// Detail identity only.
    static let fieldGuideDisplay = Font.system(.largeTitle, design: .serif).weight(.semibold)
    /// Page identity and major regions.
    static let fieldGuideHeadline = Font.system(.title2, design: .serif).weight(.semibold)
    /// Panels, rows, and section titles.
    static let fieldGuideTitle = Font.subheadline.weight(.semibold)
    /// Explanations and continuous reading.
    static let fieldGuideBody = Font.body
    /// Quantities, money, dates, and aligned comparison values.
    static let fieldGuideData = Font.body.monospacedDigit()
    /// Compact metadata, sentence case.
    static let fieldGuideLabel = Font.caption.weight(.medium)
    /// Shortcodes and raw payloads: the second voice, and only ever for codes.
    static let fieldGuideCode = Font.footnote.monospaced()
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
