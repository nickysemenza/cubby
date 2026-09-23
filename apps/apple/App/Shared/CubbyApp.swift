import CoreSpotlight
import CubbyKit
import Nuke
import SwiftUI

@main
struct CubbyApp: App {
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
        // Home-screen Quick Actions (`UIApplicationShortcutItems`): the adaptor constructs
        // `AppDelegate` — and this app value's other stored properties, including `model` above —
        // before `UIApplicationMain` starts the scene lifecycle, so `AppModel.active` is already
        // set by the time `SceneDelegate.scene(_:willConnectTo:options:)` can run.
        @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

    init() {
        // Before anything else so a crash during model setup is still reported.
        Diagnostics.start(baseURL: AppModel.persistedBaseURL)
        let model = AppModel()
        // `CubbyApp` is instantiated exactly once per process by SwiftUI; `model` is a local
        // built inside `init()`, not an external init parameter, and there is no re-presentation
        // to go stale across.
        _model = State(initialValue: model)  // state-init-ok: single instance for process lifetime
        AppModel.active = model
        // Thumbnails go through Nuke (`Thumb.swift`); a shared on-disk cache under Caches keeps
        // covers warm across launches without growing the app's iCloud/backup footprint (Caches is
        // excluded from both). `ImageCaches.reset()` wipes both tiers on sign-out and base-URL
        // change, mirroring `SpotlightIndexer.wipe()`.
        ImagePipeline.shared = ImagePipeline(configuration: .withDataCache(name: "cubby-images"))
    }

    var body: some Scene {
        #if os(macOS)
            Window("Cubby", id: "main") {
                appContent
            }
            .defaultSize(width: 1200, height: 800)
            .commands {
                CubbyCommands(); SidebarCommands()
            }
        #else
            WindowGroup { appContent }
                .commands { CubbyCommands() }
        #endif
        #if os(macOS)
            Settings {
                SettingsView().environment(model).frame(width: 420)
            }
        #endif
    }

    private var appContent: some View {
        RootView()
            .environment(model)
            .tint(PorcelainTokens.cobalt)
            .task { await model.restoreSession() }
            .onAppear {
                #if os(macOS)
                    DockBadge.clear()
                #endif
                model.setCompanionSceneActive(scenePhase == .active)
                #if os(iOS)
                    DeviceWorkLiveActivityCoordinator.shared.start(
                        model: model, foreground: scenePhase == .active)
                #endif
            }
            .onChange(of: scenePhase) { _, phase in
                model.setCompanionSceneActive(phase == .active)
                #if os(iOS)
                    DeviceWorkLiveActivityCoordinator.shared.setForeground(phase == .active)
                    if phase == .background { PhotoBackgroundProcessing.scheduleIfNeeded(model: model) }
                #endif
            }
            .onOpenURL { url in
                if let link = CubbyLink(url: url) { model.navigator.open(link) }
            }
            .onContinueUserActivity(CSSearchableItemActionType) { activity in
                if let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
                    let link = SpotlightIndexer.link(from: id)
                {
                    model.navigator.open(link)
                }
            }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                if let url = activity.webpageURL, let link = CubbyLink(url: url) {
                    model.navigator.open(link)
                }
            }
    }
}
