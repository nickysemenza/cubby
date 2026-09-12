import SwiftUI

/// Porcelain Transit: the web app's palette (apps/web/DESIGN.md), colors and metrics only.
/// Chrome stays stock SwiftUI so the iOS 26 SDK's own materials apply.
enum PorcelainTokens {
    static let canvas = Color(hex: 0xF7F9FC)
    static let surface = Color(hex: 0xFFFFFF)
    static let inset = Color(hex: 0xF1F4F8)
    static let graphite = Color(hex: 0x171A21)
    static let graphiteSecondary = Color(hex: 0x667085)
    static let hairline = Color(hex: 0xD9DEE7)
    static let cobalt = Color(hex: 0x2563EB)
    static let positive = Color(hex: 0x16845B)
    static let warning = Color(hex: 0xB66A00)
    static let destructive = Color(hex: 0xC93636)

    static let radiusSmall: CGFloat = 6
    static let radiusMedium: CGFloat = 10
    static let spacing: CGFloat = 8
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
