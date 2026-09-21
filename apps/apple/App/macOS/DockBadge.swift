import AppKit

/// Clears badges left behind by older app versions. Cubby keeps problem counts in Today.
enum DockBadge {
    static func clear() {
        NSApp.dockTile.badgeLabel = nil
    }
}
