import CubbyKit
import SwiftUI

#if os(macOS)
    import AppKit
#endif

/// App-level menu commands and keyboard shortcuts. On Mac: File › New (⌘N for the focused entity,
/// plus a per-entity submenu), Open on Web ⌥⌘O and Copy Link ⇧⌘C for the focused record or list;
/// View › Refresh ⌘R; Edit › Find ⌘F (the visible list's filter, else global Search) and Search
/// Everything ⌥⌘F; and a Go menu numbering the sidebar's sections. Settings… (⌘,) is the
/// `Settings` scene's own app-menu item, not a command here. On iOS: ⌘1…⌘N select the tabs,
/// ⌘F jumps to Search, and ⌘0 opens Dev, which is off the tab bar there.
///
/// `Commands` runs outside any window's view hierarchy, so it cannot read `@Environment(AppModel
/// .self)`. Record and list commands read the focused scene's published values (`sceneCommands`,
/// `listSearch`, `nativeRefresh`) and are disabled, not hidden, when nothing is focused; section
/// switching goes through `AppModel.active`, a static weak reference `CubbyApp.init` sets once.
struct CubbyCommands: Commands {
    #if os(macOS)
        @FocusedValue(\.sceneCommands) private var scene
        @FocusedValue(\.listSearch) private var listSearch
    #endif

    @FocusedValue(\.nativeRefresh) private var refresh

    var body: some Commands {
        #if os(macOS)
            CommandGroup(replacing: .newItem) { newRecordCommands }
            CommandGroup(after: .newItem) {
                Divider()
                Button("Open on Web") {
                    if let url = focusedURL { NSWorkspace.shared.open(url) }
                }
                .keyboardShortcut("o", modifiers: [.option, .command])
                .disabled(focusedURL == nil)
                Button("Copy Link") {
                    if let url = focusedURL { Clipboard.copy(url.absoluteString) }
                }
                .keyboardShortcut("c", modifiers: [.shift, .command])
                .disabled(focusedURL == nil)
            }
            CommandGroup(after: .toolbar) { refreshButton }
            CommandGroup(after: .textEditing) {
                Button(listSearch.map { "Find in \($0.plural)" } ?? "Find") {
                    if let listSearch { listSearch.focus() } else { openSearch() }
                }
                .keyboardShortcut("f", modifiers: .command)
                Button("Search Everything") { openSearch() }
                    .keyboardShortcut("f", modifiers: [.option, .command])
            }
            CommandMenu("Go") {
                ForEach(Array(AppSection.tabs.enumerated()), id: \.element) { index, section in
                    Button(section.title) {
                        AppModel.active?.navigator.section = section
                    }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
                Divider()
                devButton
            }
        #else
            CommandGroup(after: .toolbar) {
                ForEach(Array(PhoneTab.primary.enumerated()), id: \.element) { index, tab in
                    Button(tab.title) {
                        AppModel.active?.navigator.phoneTab = tab
                    }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
                Divider()
                refreshButton
                Button("Search") { openSearch() }
                    .keyboardShortcut("f", modifiers: .command)
                devButton
            }
        #endif
    }

    private var refreshButton: some View {
        Button("Refresh") { refresh?.run() }
            .keyboardShortcut("r", modifiers: .command)
            .disabled(refresh?.isEnabled != true)
    }

    private var devButton: some View {
        Button("Dev") {
            AppModel.active?.navigator.openDev()
        }
        .keyboardShortcut("0", modifiers: .command)
    }

    private func openSearch() {
        guard let model = AppModel.active else { return }
        model.navigator.section = .search
        model.navigator.focusSearchRequest += 1
    }

    #if os(macOS)
        private var focusedURL: URL? {
            guard let target = scene?.target, let model = AppModel.active else { return nil }
            return model.webHandoff.url(target.webTarget)
        }

        /// ⌘N creates the focused record's or list's entity; the submenu reaches every creatable one.
        @ViewBuilder private var newRecordCommands: some View {
            let focused = scene?.target?.key
            let creatable = focused.flatMap { $0.nativeActions.contains(.create) ? EntityCatalog[$0] : nil }
            Button(creatable.map { "New \($0.singular)" } ?? "New Record") {
                if let creatable { scene?.create(creatable.key) }
            }
            .keyboardShortcut("n", modifiers: .command)
            .disabled(creatable == nil)
            Menu("New Record") {
                ForEach(NewRecordMenu.groups, id: \.domain) { group in
                    Section(group.domain.title) {
                        ForEach(group.descriptors, id: \.key) { descriptor in
                            Button(descriptor.singular) { scene?.create(descriptor.key) }
                        }
                    }
                }
            }
            .disabled(scene == nil)
        }
    #endif
}
