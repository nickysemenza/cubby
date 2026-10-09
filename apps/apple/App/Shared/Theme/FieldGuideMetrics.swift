// Generated from packages/design-tokens/tokens.json. Do not edit.
import SwiftUI

enum FieldGuideMetrics {
    static let radiusControl: CGFloat = 8
    static let radiusPanel: CGFloat = 16
    static let radiusChip: CGFloat = 7
    static let space1: CGFloat = 4
    static let space2: CGFloat = 8
    static let space3: CGFloat = 12
    static let space4: CGFloat = 12
    static let space5: CGFloat = 16
    static let space6: CGFloat = 16

    static func optionColor(_ token: String?) -> Color? {
        switch token {
        case "var(--interaction)", "var(--brand-interaction)": Color("AccentColor")
        case "var(--signal)", "var(--brand-signal)": Color("Signal")
        case "var(--canvas)", "var(--brand-canvas)": Color("Canvas")
        case "var(--surface)", "var(--brand-surface)": Color("Surface")
        case "var(--inset)", "var(--brand-inset)": Color("Inset")
        case "var(--hairline)", "var(--brand-hairline)": Color("Hairline")
        case "var(--domain-cook)", "var(--brand-domain-cook)": Color("Cook")
        case "var(--domain-pantry)", "var(--brand-domain-pantry)": Color("Pantry")
        case "var(--domain-plan)", "var(--brand-domain-plan)": Color("Plan")
        case "var(--domain-house)", "var(--brand-domain-house)": Color("House")
        case "var(--domain-finance)", "var(--brand-domain-finance)": Color("Finance")
        case "var(--positive)", "var(--brand-positive)": Color("Positive")
        case "var(--warning)", "var(--brand-warning)": Color("Warning")
        case "var(--destructive)", "var(--brand-destructive)": Color("Destructive")
        case "var(--slate)", "var(--brand-slate)": Color("Slate")
        default: nil
        }
    }
}
