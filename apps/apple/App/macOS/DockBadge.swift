import AppKit

/// Mirrors Today's open-problem count onto the Dock icon so it's visible without opening the app.
/// `TodayModel.fetchProblems()` calls `update(total:)` after each successful load;
/// `AppModel.signOut()` calls `clear()`. `SettingsView`'s "Show problem count in Dock" toggle
/// (`@AppStorage("showProblemsInDock")`, default on) gates it — read directly here rather than
/// threaded through as a parameter, since both call sites are cross-platform code that knows
/// nothing about the Dock.
enum DockBadge {
    static let showInDockDefaultsKey = "showProblemsInDock"

    static func update(total: Int) {
        guard enabled else {
            NSApp.dockTile.badgeLabel = nil
            return
        }
        NSApp.dockTile.badgeLabel = total > 0 ? "\(total)" : nil
    }

    static func clear() {
        NSApp.dockTile.badgeLabel = nil
    }

    private static var enabled: Bool {
        // No key yet (first launch, before Settings has ever written one) reads as on, matching
        // the `@AppStorage` default in `SettingsView`.
        UserDefaults.standard.object(forKey: showInDockDefaultsKey) as? Bool ?? true
    }
}
