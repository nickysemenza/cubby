import CubbyKit
import SwiftUI

#if os(iOS)
    import UIKit
#elseif os(macOS)
    import AppKit
#endif

/// Shared brand decisions on native surfaces. Controls, navigation, and text sizing remain SwiftUI.
enum FieldGuideTokens {
    #if os(iOS)
        static let canvas = Color(uiColor: .systemGroupedBackground)
        static let surface = Color(uiColor: .secondarySystemGroupedBackground)
        static let inset = Color(uiColor: .tertiarySystemGroupedBackground)
        static let hairline = Color(uiColor: .separator)
    #else
        static let canvas = Color(nsColor: .windowBackgroundColor)
        static let surface = Color(nsColor: .controlBackgroundColor)
        static let inset = Color(nsColor: .underPageBackgroundColor)
        static let hairline = Color(nsColor: .separatorColor)
    #endif
    static let graphite = Color.primary
    static let graphiteSecondary = Color.secondary

    // Interaction and attention are separate roles. The accent is the web's Warm neutral link
    // blue; `Work` holds the same palette's state and progress colours. Surfaces and text stay
    // system colours.
    static let interaction = Color(light: 0x2A47C2, dark: 0x8FA3F0)
    static let signal = Color("Signal")

    // Condition.
    static let positive = Color("Positive")
    static let warning = Color("Warning")
    static let destructive = Color("Destructive")
    static let info = Color("Info")
    static let neutralStatus = Color("NeutralStatus")

    /// Work state and progress, from the web Warm neutral palette. Dark values are lightened to
    /// keep at least 4.5:1 against the dark system backgrounds; light values clear it on white.
    enum Work {
        static let needs = FieldGuideTokens.interaction
        static let needsInk = Color(light: 0xFFFFFF, dark: 0x0B1640)
        static let running = Color(light: 0x0E6A86, dark: 0x6CC3DE)
        static let done = Color(light: 0x2D6A39, dark: 0x7CC78A)
        static let failed = Color(light: 0xA8251C, dark: 0xF28B80)
        static let stalled = Color(light: 0x744A08, dark: 0xE8B75F)
        static let stalledMark = Color(light: 0xA86C12, dark: 0xE3B061)
        static let queued = Color(light: 0x8E8578, dark: 0xA39A8E)
        static let paused = Color(light: 0x857B6E, dark: 0x9E9488)
        static let progressDone = Color(light: 0x3A342D, dark: 0xD9D2C7)
    }

    /// Kinds that are not states: cycled in declaration order (`colorizeEnumOptions`).
    static let categoryRamp: [Color] = (1...8).map { Color("Category\($0)") }

    // Geometry comes from the same source as web CSS.
    static let radiusControl = FieldGuideMetrics.radiusControl
    static let radiusPanel = FieldGuideMetrics.radiusPanel
    static let radiusChip = FieldGuideMetrics.radiusChip
    static let hairlineWidth: CGFloat = 1

    /// The compact 4/8/12/12/16/16 rhythm: `lg` equals `md` and `xxl` equals `xl`, so screen edges
    /// and section gaps stay tight. Density never shrinks a phone target below 44pt.
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

/// The same seven manifest domains appear in native and web navigation.
enum AppDomain: String, CaseIterable, Identifiable {
    case plan, cook, pantry, garden, house, purchases, finance

    static var allCases: [AppDomain] {
        SidebarManifest.sections.compactMap { $0.domain.map(AppDomain.init) }
    }

    var id: String { rawValue }

    /// The manifest's own line, whose title and glyph are generated from
    /// `WAYFINDING_DOMAIN_PRESENTATION` so native and web name every domain alike.
    var wayfinding: WayfindingDomain {
        switch self {
        case .plan: .plan
        case .cook: .cook
        case .pantry: .pantry
        case .garden: .garden
        case .house: .house
        case .purchases: .purchases
        case .finance: .finance
        }
    }

    var title: String { wayfinding.title }

    var color: Color { FieldGuideMetrics.domainColor(rawValue) ?? .secondary }

    /// The group glyph, used where a domain itself is the subject (a Browse header, a Mac sidebar
    /// row) rather than one entity within it.
    var symbol: String { wayfinding.sfSymbol }
}

extension AppDomain {
    init(_ domain: WayfindingDomain) {
        self =
            switch domain {
            case .plan: .plan
            case .cook: .cook
            case .pantry: .pantry
            case .garden: .garden
            case .house: .house
            case .purchases: .purchases
            case .finance: .finance
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

/// Native text styles preserve system typography and Dynamic Type.
extension Font {
    /// Dashboard and sign-in identity (Mac Today, Login), and a record title on Mac.
    static let fieldGuideDisplay = Font.largeTitle.weight(.semibold)
    /// Page identity and major regions.
    static let fieldGuideHeadline = Font.title2.weight(.semibold)
    /// A record detail's hero title. Phone steps down to the headline size so the title does not
    /// push the record's data below the first screen; Mac keeps the display size.
    static var fieldGuideRecordTitle: Font {
        #if os(iOS)
            fieldGuideHeadline
        #else
            fieldGuideDisplay
        #endif
    }
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
    /// A light and dark pair the system resolves for the current appearance.
    init(light: UInt32, dark: UInt32) {
        func components(_ hex: UInt32) -> (CGFloat, CGFloat, CGFloat) {
            (CGFloat((hex >> 16) & 0xFF) / 255, CGFloat((hex >> 8) & 0xFF) / 255, CGFloat(hex & 0xFF) / 255)
        }
        let (lr, lg, lb) = components(light)
        let (dr, dg, db) = components(dark)
        #if os(iOS)
            self.init(
                uiColor: UIColor { traits in
                    traits.userInterfaceStyle == .dark
                        ? UIColor(red: dr, green: dg, blue: db, alpha: 1)
                        : UIColor(red: lr, green: lg, blue: lb, alpha: 1)
                })
        #else
            self.init(
                nsColor: NSColor(name: nil) { appearance in
                    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                        ? NSColor(srgbRed: dr, green: dg, blue: db, alpha: 1)
                        : NSColor(srgbRed: lr, green: lg, blue: lb, alpha: 1)
                })
        #endif
    }

    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
