import SwiftUI

/// App-level keyboard shortcuts: ⌘1…⌘6 select each `AppSection` (macOS menu bar and, since
/// `Commands` is honoured on iPadOS too, a hardware keyboard there), and ⌘F jumps to Search and
/// focuses its field.
///
/// `Commands` runs outside any window's view hierarchy, so it cannot read `@Environment(AppModel
/// .self)` — there is one menu bar (or one shortcuts table) shared by every window. `AppModel
/// .active`, a static weak reference `CubbyApp.init` sets once, is the seam every command goes
/// through instead (see that property's doc comment).
struct CubbyCommands: Commands {
    var body: some Commands {
        CommandGroup(after: .toolbar) {
            ForEach(Array(AppSection.allCases.enumerated()), id: \.element) { index, section in
                Button(section.title) {
                    AppModel.active?.navigator.section = section
                }
                .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
            }
            Divider()
            Button("Search") {
                guard let model = AppModel.active else { return }
                model.navigator.section = .search
                model.navigator.focusSearchRequest += 1
            }
            .keyboardShortcut("f", modifiers: .command)
        }
    }
}
