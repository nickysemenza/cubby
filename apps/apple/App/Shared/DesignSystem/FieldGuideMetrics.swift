// Generated from packages/design-tokens/tokens.json. Do not edit.
import SwiftUI

enum FieldGuideMetrics {
    static let radiusControl: CGFloat = 8
    static let radiusPanel: CGFloat = 12
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
        case "var(--positive)", "var(--brand-positive)": Color("Positive")
        case "var(--warning)", "var(--brand-warning)": Color("Warning")
        case "var(--destructive)", "var(--brand-destructive)": Color("Destructive")
        case "var(--slate)", "var(--brand-slate)": Color("Slate")
        case "var(--positive-surface)", "var(--brand-positive-surface)": Color("PositiveSurface")
        case "var(--warning-surface)", "var(--brand-warning-surface)": Color("WarningSurface")
        case "var(--destructive-surface)", "var(--brand-destructive-surface)": Color("DestructiveSurface")
        case "var(--info)", "var(--brand-info)": Color("Info")
        case "var(--info-surface)", "var(--brand-info-surface)": Color("InfoSurface")
        case "var(--neutral-status)", "var(--brand-neutral-status)": Color("NeutralStatus")
        case "var(--category-1)", "var(--brand-category-1)": Color("Category1")
        case "var(--category-2)", "var(--brand-category-2)": Color("Category2")
        case "var(--category-3)", "var(--brand-category-3)": Color("Category3")
        case "var(--category-4)", "var(--brand-category-4)": Color("Category4")
        case "var(--category-5)", "var(--brand-category-5)": Color("Category5")
        case "var(--category-6)", "var(--brand-category-6)": Color("Category6")
        case "var(--category-7)", "var(--brand-category-7)": Color("Category7")
        case "var(--category-8)", "var(--brand-category-8)": Color("Category8")
        default: nil
        }
    }
}
