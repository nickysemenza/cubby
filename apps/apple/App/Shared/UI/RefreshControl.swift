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
                .toolbar {
                    ToolbarItem(placement: .secondaryAction) {
                        Button("Refresh", systemImage: "arrow.clockwise") {
                            Task { await runIfNeeded() }
                        }
                        .keyboardShortcut("r", modifiers: .command)
                        .disabled(refreshing)
                    }
                }
            #endif
    }

    /// Same re-entrancy guard idea as `GardenJournalModel.refresh()`: a trigger that lands while
    /// one is already in flight — the button tapped twice, or tapped mid pull-to-refresh — is
    /// dropped instead of starting a second, overlapping load.
    private func runIfNeeded() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        await action()
    }
}

extension View {
    /// Applies `.refreshable { await action() }` on every platform and, on macOS, a matching
    /// toolbar Refresh button + ⌘R (see `RefreshControl`'s doc comment for why). `nonisolated` to
    /// mirror `View.refreshable(action:)` itself, which is declared the same way.
    ///
    /// A closure literal built inline at the call site (`.refreshControl { await model.load() }`)
    /// satisfies `@Sendable` for free. A closure stored first as a plain `let` property (as
    /// `TodayContent.onRefresh` was) does not — under this target's
    /// `SWIFT_DEFAULT_ACTOR_ISOLATION: MainActor`, an unannotated `() async -> Void` property
    /// infers a caller-isolated (`nonisolated(nonsending)`) type, which cannot cross into a
    /// `@Sendable` parameter. Declare such a property `@Sendable () async -> Void` instead, as
    /// `onRefresh` now is.
    nonisolated func refreshControl(_ action: @escaping @Sendable () async -> Void) -> some View {
        modifier(RefreshControl(action: action))
    }
}
