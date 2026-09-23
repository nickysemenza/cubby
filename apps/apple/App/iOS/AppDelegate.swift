import CubbyKit
import UIKit

/// Routes iOS home-screen Quick Actions (`UIApplicationShortcutItems` in `project.yml`) into
/// `CubbyLink` navigation, for both a cold launch (`connectionOptions.shortcutItem`) and a
/// shortcut invoked while the app is already running (`performActionFor`).
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        PhotoBackgroundProcessing.register()
        return true
    }

    /// A link that arrived before `AppModel.active` existed. In practice this should never be
    /// read: `CubbyApp.init` sets `AppModel.active` while building the `App` value, and a
    /// `@UIApplicationDelegateAdaptor`'s delegate — and the scene lifecycle that follows it — are
    /// only reachable once that value exists (SwiftUI constructs the `App` before calling
    /// `UIApplicationMain`), so `willConnectTo` below always finds `AppModel.active` set. This is
    /// the fallback for if that invariant is ever wrong: `RootView` applies it on first
    /// appearance instead of dropping the link on the floor.
    @MainActor static var stashedLaunchLink: CubbyLink?

    @MainActor
    static func takeStashedLaunchLink() -> CubbyLink? {
        defer { stashedLaunchLink = nil }
        return stashedLaunchLink
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(
            name: "Default Configuration", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

/// Handles a Quick Action shortcut item both at cold launch (`willConnectTo`) and while the app
/// is already running (`performActionFor`), mapping `shortcutItem.type` (the `cubby://…` string
/// configured in `project.yml`) through `CubbyLink` and into the shared `Navigator`.
final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(
        _ scene: UIScene, willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let shortcutItem = connectionOptions.shortcutItem else { return }
        open(shortcutItem)
    }

    func windowScene(
        _ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(open(shortcutItem))
    }

    @discardableResult
    private func open(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
        guard let url = URL(string: shortcutItem.type), let link = CubbyLink(url: url) else { return false }
        if let model = AppModel.active {
            model.navigator.open(link)
        } else {
            AppDelegate.stashedLaunchLink = link
        }
        return true
    }
}
