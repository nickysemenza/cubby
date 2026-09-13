import CoreSpotlight
import CubbyKit
import SwiftUI

@main
struct CubbyApp: App {
    @State private var model: AppModel
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
        _model = State(initialValue: model)
        AppModel.active = model
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(PorcelainTokens.cobalt)
                // Porcelain Transit is a light-only palette (DESIGN.md). Pin the scheme so the
                // system chrome never goes dark over a porcelain canvas; dark tokens come later.
                .preferredColorScheme(.light)
                .task { await model.restoreSession() }
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
        #if os(macOS)
            Settings {
                SettingsView()
                    .environment(model)
                    .frame(width: 420)
            }
        #endif
    }
}
