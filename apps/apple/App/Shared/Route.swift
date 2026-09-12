import CubbyKit

/// The typed navigation spine shared by the iOS tab stacks and the macOS split view.
enum Route: Hashable {
    case entityList(EntityKey)
    case entityDetail(EntityKey, id: String)
}

/// Top-level sections. Tabs on iOS, sidebar rows on macOS.
enum AppSection: String, CaseIterable, Identifiable {
    case today, capture, browse, identify, dev

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: "Today"
        case .capture: "Capture"
        case .browse: "Browse"
        case .identify: "Identify"
        case .dev: "Dev"
        }
    }

    var symbol: String {
        switch self {
        case .today: "sun.horizon"
        case .capture: "barcode.viewfinder"
        case .browse: "square.grid.2x2"
        case .identify: "camera.metering.center.weighted"
        case .dev: "wrench.and.screwdriver"
        }
    }
}
