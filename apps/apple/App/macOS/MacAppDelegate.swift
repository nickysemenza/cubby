import AppKit

final class MacAppDelegate: NSObject, NSApplicationDelegate {
    func application(
        _ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PhotoImportNotificationCoordinator.shared.receivedDeviceToken(deviceToken)
    }

    func application(
        _ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
        Diagnostics.report(error, context: "photos.import.notification.deviceToken")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
