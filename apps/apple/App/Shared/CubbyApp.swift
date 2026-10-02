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
        #if DEBUG
            let e2eURL = Self.e2eServerURL
            let serverURL = e2eURL ?? Self.devServerURL
            #if os(macOS)
                if Self.isMacImportFixture, let bundleID = Bundle.main.bundleIdentifier {
                    // Stable signing retains OS permissions; fixture preferences still start fresh.
                    UserDefaults.standard.removePersistentDomain(forName: bundleID)
                }
            #endif
            if e2eURL != nil {
                // A fixture install stays a plain viewer without presenting the
                // first-install companion-work decision over the E2E flow.
                DeviceParticipation(automaticWork: false, answeredAt: .now).save(to: .standard)
            }
        #else
            let serverURL: URL? = nil
        #endif
        // Before anything else so a crash during model setup is still reported.
        Diagnostics.start(baseURL: serverURL ?? AppModel.persistedBaseURL)
        #if DEBUG
            let model =
                serverURL.map {
                    #if os(macOS)
                        if Self.isMacImportFixture {
                            return AppModel(store: InMemorySessionTokenStore(), baseURL: $0)
                        }
                    #endif
                    return AppModel(
                        store: FileSessionTokenStore(
                            fileURL: URL.applicationSupportDirectory.appending(
                                path: e2eURL == nil
                                    ? "Cubby/dev-credentials.json" : "Cubby/e2e-credentials.json")),
                        baseURL: $0)
                } ?? AppModel()
        #else
            let model = AppModel()
        #endif
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

    @ViewBuilder private var appContent: some View {
        #if DEBUG && os(iOS)
            if ProcessInfo.processInfo.arguments.contains("--cubby-preview-photo-run") {
                NavigationStack {
                    RunReviewView(
                        runID: RunReviewPreviewFixture.runID,
                        previewModel: RunReviewPreviewFixture.model())
                }
                .environment(model)
                .tint(FieldGuideTokens.interaction)
            } else {
                normalAppContent
            }
        #else
            normalAppContent
        #endif
    }

    private var normalAppContent: some View {
        RootView()
            .environment(model)
            .tint(FieldGuideTokens.interaction)
            .task {
                await model.restoreSession()
                #if DEBUG
                    if Self.e2eServerURL != nil {
                        // This uses the normal AuthFlow and credential store against the
                        // disposable loopback workerd server selected at launch.
                        await model.signIn(email: "sim@cubby.localhost", password: "cubby-sim-local-only")
                    } else if Self.devServerURL != nil {
                        await model.signInForDevelopment()
                    }
                #endif
            }
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
                    if phase == .background {
                        PhotoBackgroundProcessing.scheduleIfNeeded(model: model)
                        LibrarySyncBackgroundProcessing.scheduleIfNeeded(model: model)
                    }
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

    #if DEBUG
        private static var e2eServerURL: URL? {
            serverURL(argument: "--cubby-e2e-server")
        }

        #if os(macOS)
            static var isMacImportFixture: Bool {
                Bundle.main.bundleIdentifier == "com.nickysemenza.cubby.e2e"
                    && e2eServerURL != nil
            }
        #endif

        private static var devServerURL: URL? {
            let key = "cubby.devServerURL"
            if let url = serverURL(argument: "--cubby-dev-server") {
                AppModel.persistBaseURL(url)
                UserDefaults.standard.set(url.absoluteString, forKey: key)
                return url
            }
            // Settings remains authoritative when the user switches servers.
            guard let saved = UserDefaults.standard.string(forKey: key),
                let url = localServerURL(saved), url == AppModel.persistedBaseURL
            else { return nil }
            return url
        }

        private static func serverURL(argument: String) -> URL? {
            let arguments = ProcessInfo.processInfo.arguments
            guard let index = arguments.firstIndex(of: argument),
                arguments.indices.contains(index + 1)
            else { return nil }
            return localServerURL(arguments[index + 1])
        }

        private static func localServerURL(_ value: String) -> URL? {
            guard let url = URL(string: value),
                url.scheme == "http",
                ["localhost", "127.0.0.1"].contains(url.host ?? ""),
                url.port != nil,
                url.user == nil, url.password == nil,
                url.path.isEmpty || url.path == "/",
                url.query == nil,
                url.fragment == nil
            else { return nil }
            return url
        }
    #endif
}
