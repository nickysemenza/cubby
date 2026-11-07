import CubbyKit
import SwiftUI

#if os(macOS)
    import AppKit
#endif

/// App-level menu commands and keyboard shortcuts. On Mac: File › New (⌘N for the focused entity,
/// plus a per-entity submenu), Open on Web ⌥⌘O and Copy Link ⇧⌘C for the focused record or list;
/// View › Refresh ⌘R; Edit › Find ⌘F (the visible list's filter, else global Search) and Search
/// Everything ⌥⌘F; Edit › Edit Record ⌘E and Delete Record… ⌘⌫ (confirmed) for the open record;
/// an Actions menu of that record's placed verbs, unavailable ones dimmed with the server's
/// reason; and a Go menu numbering the sidebar's sections. Settings… (⌘,) is the
/// `Settings` scene's own app-menu item, not a command here. On iOS: ⌘1…⌘N select the tabs,
/// ⌘F jumps to Search, and ⌘0 opens Dev, which is off the tab bar there.
///
/// `Commands` runs outside any window's view hierarchy, so it cannot read `@Environment(AppModel
/// .self)`. Record and list commands read the focused scene's published values (`sceneCommands`,
/// `recordCommands`, `listSearch`, `nativeRefresh`) and are disabled, not hidden, when nothing is focused; section
/// switching goes through `AppModel.active`, a static weak reference `CubbyApp.init` sets once.
struct CubbyCommands: Commands {
    #if os(macOS)
        @FocusedValue(\.sceneCommands) private var scene
        @FocusedValue(\.recordCommands) private var record
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
            CommandGroup(after: .pasteboard) { recordEditCommands }
            CommandGroup(after: .toolbar) { refreshButton }
            CommandGroup(after: .textEditing) {
                Button(listSearch.map { "Find in \($0.plural)" } ?? "Find") {
                    if let listSearch { listSearch.focus() } else { openSearch() }
                }
                .keyboardShortcut("f", modifiers: .command)
                Button("Search Everything") { openSearch() }
                    .keyboardShortcut("f", modifiers: [.option, .command])
            }
            CommandMenu("Actions") { recordActionCommands }
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

        /// Edit opens the record's editor; Delete asks the record's one confirmation first.
        @ViewBuilder private var recordEditCommands: some View {
            Divider()
            Button("Edit Record") { record?.edit?() }
                .keyboardShortcut("e", modifiers: .command)
                .disabled(record?.edit == nil)
            Button("Delete Record…") {
                // Menu key equivalents run before the text system, so ⌘⌫ inside a field must
                // keep deleting to the line start instead of asking to delete the record.
                if NSApp.keyWindow?.firstResponder is NSText {
                    NSApp.sendAction(#selector(NSResponder.deleteToBeginningOfLine(_:)), to: nil, from: nil)
                    return
                }
                if let record, let delete = record.delete { record.perform(delete) }
            }
            .keyboardShortcut(.delete, modifiers: .command)
            .disabled(record?.delete?.enabled != true)
        }

        @ViewBuilder private var recordActionCommands: some View {
            if let record, !record.actions.isEmpty {
                ForEach(record.actions) { action in
                    Button {
                        record.perform(action)
                    } label: {
                        Text(action.label)
                        if !action.enabled, let reason = action.reason { Text(reason) }
                    }
                    .disabled(!action.enabled)
                }
            } else {
                Text(record == nil ? "No record open" : "No actions for this record")
            }
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
