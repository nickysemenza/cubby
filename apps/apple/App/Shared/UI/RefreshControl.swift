import SwiftUI

/// `.refreshable` everywhere, plus a way to fire it without a finger. macOS has no pull-to-refresh
/// gesture, so on that platform this also adds a toolbar Refresh button (⌘R) — the only way to
/// trigger `.refreshable`'s action there.
private struct RefreshControl: ViewModifier {
    let action: @Sendable () async -> Void
    /// Set on the macOS toolbar button only — iOS never shows a Refresh button, since pull-to-
    /// refresh is `.refreshable`'s own gesture there, so an identifier meant for that button would
    /// otherwise have nowhere to land on iOS.
    let identifier: String?

    @State private var refreshing = false

    func body(content: Content) -> some View {
        content
            .refreshable { await runIfNeeded() }
            #if os(macOS)
                .focusedValue(
                    \.nativeRefresh,
                    NativeRefreshAction(
                        isEnabled: !refreshing, run: { Task { await runIfNeeded() } }
                    )
                )
                .toolbar {
                    ToolbarItem(placement: .secondaryAction) {
                        Button("Refresh", systemImage: "arrow.clockwise") {
                            Task { await runIfNeeded() }
                        }
                        .disabled(refreshing)
                        .accessibilityIdentifier(ifPresent: identifier)
                    }
                }
            #endif
    }

    /// A trigger that lands while one is already in flight — the button tapped twice, or tapped
    /// mid pull-to-refresh — is dropped instead of starting a second, overlapping load.
    private func runIfNeeded() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        await action()
    }
}

extension View {
    /// Refresh gesture on iOS, toolbar action on Mac, and a focused menu command. `identifier` names
    /// the macOS toolbar button for a UI test to find; leave it `nil` where nothing needs to.
    func refreshControl(
        identifier: String? = nil, _ action: @escaping @Sendable () async -> Void
    ) -> some View {
        modifier(RefreshControl(action: action, identifier: identifier))
    }

    /// `.accessibilityIdentifier(identifier ?? "")` would set an empty identifier when `identifier`
    /// is `nil`, which is not the same as leaving it unset — this leaves the view untouched instead.
    @ViewBuilder fileprivate func accessibilityIdentifier(ifPresent identifier: String?) -> some View {
        if let identifier {
            accessibilityIdentifier(identifier)
        } else {
            self
        }
    }
}

struct NativeRefreshAction {
    let isEnabled: Bool
    let run: @MainActor () -> Void
}

private struct NativeRefreshKey: FocusedValueKey {
    typealias Value = NativeRefreshAction
}

extension FocusedValues {
    var nativeRefresh: NativeRefreshAction? {
        get { self[NativeRefreshKey.self] }
        set { self[NativeRefreshKey.self] = newValue }
    }
}
