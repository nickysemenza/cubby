import SwiftUI

/// App-level keyboard shortcuts: ⌘1…⌘N select the visible destinations, ⌘F jumps to Search and
/// focuses its field, and ⌘0 opens Dev — off the tab bar on iOS (see `AppSection.tabs`), so it
/// needs its own shortcut rather than a slot in the numbered loop.
///
/// `Commands` runs outside any window's view hierarchy, so it cannot read `@Environment(AppModel
/// .self)` — there is one menu bar (or one shortcuts table) shared by every window. `AppModel
/// .active`, a static weak reference `CubbyApp.init` sets once, is the seam every command goes
/// through instead (see that property's doc comment).
struct CubbyCommands: Commands {
    @FocusedValue(\.nativeRefresh) private var refresh

    var body: some Commands {
        CommandGroup(after: .toolbar) {
            #if os(iOS)
                ForEach(Array(PhoneTab.allCases.enumerated()), id: \.element) { index, tab in
                    Button(tab.title) {
                        AppModel.active?.navigator.phoneTab = tab
                    }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
            #else
                ForEach(Array(AppSection.tabs.enumerated()), id: \.element) { index, section in
                    Button(section.title) {
                        AppModel.active?.navigator.section = section
                    }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
            #endif
            Divider()
            Button("Refresh") { refresh?.run() }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(refresh?.isEnabled != true)
            Button("Search") {
                guard let model = AppModel.active else { return }
                model.navigator.section = .search
                model.navigator.focusSearchRequest += 1
            }
            .keyboardShortcut("f", modifiers: .command)
            Button("Dev") {
                AppModel.active?.navigator.openDev()
            }
            .keyboardShortcut("0", modifiers: .command)
        }
    }
}
