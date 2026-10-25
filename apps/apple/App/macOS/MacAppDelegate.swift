import AppKit

final class MacAppDelegate: NSObject, NSApplicationDelegate {
    private var workspaceObservers: [any NSObjectProtocol] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        // System sleep releases the companion's claims and stops pulling; wake resumes with an
        // immediate pull. Screen lock alone is not sleep: an awake, locked Mac keeps working.
        let center = NSWorkspace.shared.notificationCenter
        workspaceObservers = [
            center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) {
                _ in
                MainActor.assumeIsolated { AppModel.active?.setCompanionSystemAsleep(true) }
            },
            center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) {
                _ in
                MainActor.assumeIsolated { AppModel.active?.setCompanionSystemAsleep(false) }
            },
        ]
    }

    /// Quitting (an app update included) waits briefly so the companion hands its claims back
    /// instead of leaving them to lease expiry.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model = AppModel.active else { return .terminateNow }
        Task {
            await model.releaseCompanionClaimsForTermination()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

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
