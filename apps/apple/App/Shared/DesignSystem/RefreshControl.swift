import SwiftUI

/// `.refreshable` everywhere, plus a way to fire it without a finger. macOS has no pull-to-refresh
/// gesture, so there every visible control joins its window's `SceneRefresh`: View › Refresh (⌘R)
/// and the window's one toolbar Refresh reload list, detail and any other joined view together,
/// instead of one toolbar button per column whose ⌘R depended on keyboard focus.
private struct RefreshControl: ViewModifier {
    let action: @Sendable () async -> Void

    @State private var refreshing = false
    #if os(macOS)
        @Environment(\.sceneRefresh) private var sceneRefresh
        @State private var member = UUID()
        @State private var visible = false
    #endif

    func body(content: Content) -> some View {
        content
            .refreshable { await runIfNeeded() }
            #if os(macOS)
                .onAppear {
                    visible = true
                    sceneRefresh?.join(member)
                }
                .onDisappear {
                    visible = false
                    sceneRefresh?.leave(member)
                }
                // A view kept alive beneath a pushed screen stays out of the window's refresh.
                .onChange(of: sceneRefresh?.request) {
                    if visible { Task { await runIfNeeded() } }
                }
                // Windows without a split root (Connections) keep the focused menu command.
                .focusedValue(
                    \.nativeRefresh,
                    sceneRefresh == nil
                        ? NativeRefreshAction(
                            isEnabled: !refreshing, run: { Task { await runIfNeeded() } })
                        : nil
                )
            #endif
    }

    /// A trigger that lands while one is already in flight — ⌘R pressed twice, or mid
    /// pull-to-refresh — is dropped instead of starting a second, overlapping load.
    private func runIfNeeded() async {
        guard !refreshing else { return }
        refreshing = true
        #if os(macOS)
            let scene = sceneRefresh
            scene?.begin()
            defer { scene?.end() }
        #endif
        defer { refreshing = false }
        await action()
    }
}

extension View {
    /// Refresh gesture on iOS; on Mac, membership in the window's View › Refresh (⌘R).
    func refreshControl(_ action: @escaping @Sendable () async -> Void) -> some View {
        modifier(RefreshControl(action: action))
    }
}

/// One window's refresh. Each visible `.refreshControl` joins while on screen; `refresh()` asks
/// all of them to reload, and stays disabled while any reload is in flight.
@Observable
final class SceneRefresh {
    private(set) var request = 0
    private var members: Set<UUID> = []
    private var running = 0

    var isEnabled: Bool { !members.isEmpty && running == 0 }

    func refresh() {
        guard isEnabled else { return }
        request += 1
    }

    func join(_ member: UUID) { members.insert(member) }
    func leave(_ member: UUID) { members.remove(member) }
    func begin() { running += 1 }
    func end() { running = max(0, running - 1) }

    var action: NativeRefreshAction { NativeRefreshAction(isEnabled: isEnabled, run: refresh) }
}

extension EnvironmentValues {
    @Entry var sceneRefresh: SceneRefresh?
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
