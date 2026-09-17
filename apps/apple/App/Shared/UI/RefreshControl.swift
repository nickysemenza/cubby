import SwiftUI

/// `.refreshable` everywhere, plus a way to fire it without a finger. macOS has no pull-to-refresh
/// gesture, so on that platform this also adds a toolbar Refresh button (⌘R) — the only way to
/// trigger `.refreshable`'s action there.
private struct RefreshControl: ViewModifier {
    let action: @Sendable () async -> Void

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
    /// Refresh gesture on iOS, toolbar action on Mac, and a focused menu command.
    func refreshControl(_ action: @escaping @Sendable () async -> Void) -> some View {
        modifier(RefreshControl(action: action))
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
