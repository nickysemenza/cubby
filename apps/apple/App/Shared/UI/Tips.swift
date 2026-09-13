import SwiftUI
import TipKit

/// "Pull down to refresh." Anchored to the count row atop any `EntityListView`.
struct PullToRefreshTip: Tip {
    var title: Text { Text("Pull to refresh") }
    var message: Text? { Text("Pull down on a list to fetch the latest from the server.") }
    var image: Image? { Image(systemName: "arrow.clockwise") }
}

/// "Scan a label to jump straight to it." Anchored to Search's scan button.
struct ScanLabelTip: Tip {
    var title: Text { Text("Scan a label") }
    var message: Text? { Text("Scan a barcode or ISBN to jump straight to it.") }
    var image: Image? { Image(systemName: "barcode.viewfinder") }
}

/// "Long-press the app icon for Scan, Audit, Search." iOS only — Today, over the shortcut tiles
/// (see `TodayView`, which shows it only under `#if os(iOS)`; the Home Screen quick actions it
/// describes are themselves iOS-only, in `App/iOS/AppDelegate.swift`).
struct QuickActionsTip: Tip {
    var title: Text { Text("Quick actions") }
    var message: Text? { Text("Long-press the app icon for Scan, Audit, and Search.") }
    var image: Image? { Image(systemName: "square.stack.3d.up") }
}
