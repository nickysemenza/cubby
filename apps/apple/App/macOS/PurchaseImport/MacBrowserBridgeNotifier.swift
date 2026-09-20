import CubbyKit
import Foundation
import UserNotifications

/// Persists notification edges before asking UserNotifications to present them. The broker may
/// replay a terminal run event until its acknowledgement arrives, so this local ledger—not the
/// delivery callback—is the exactly-once boundary for a person's notification.
@MainActor
final class MacBrowserBridgeNotifier {
    private enum Key {
        static let completedRuns = "purchaseImport.browserBridge.notifiedRuns"
        static let offlineSince = "purchaseImport.browserBridge.offlineSince"
    }

    private let defaults: UserDefaults
    private let center: UNUserNotificationCenter

    init(
        defaults: UserDefaults = .standard, center: UNUserNotificationCenter = .current()
    ) {
        self.defaults = defaults
        self.center = center
    }

    func noteOffline(accountID: String, at date: Date = .now) {
        var values = offlineValues
        if values[accountID] == nil {
            values[accountID] = date.timeIntervalSince1970
            defaults.set(values, forKey: Key.offlineSince)
        }
    }

    func notifyDelayedOfflineIfNeeded(accountID: String, now: Date = .now) async {
        guard let timestamp = offlineValues[accountID] else { return }
        guard now.timeIntervalSince1970 - timestamp >= 24 * 60 * 60 else { return }
        guard await canPresentNotifications() else { return }
        await post(
            identifier: "purchase-import-offline-\(accountID)-\(Int(timestamp))",
            title: "Purchase imports resumed",
            body: "Cubby's browser bridge was offline for more than a day and has reconnected.")
        var values = offlineValues
        values.removeValue(forKey: accountID)
        defaults.set(values, forKey: Key.offlineSince)
    }

    func notifyRunCompleted(_ completion: BrowserBridgeRunCompletion) async {
        var notified = notifiedRunIDs
        guard notified.insert(completion.runID).inserted else { return }
        // Persist first: a process crash after enqueueing still must not create a duplicate local
        // completion notification when the server replays its durable control message.
        defaults.set(Array(notified).sorted(), forKey: Key.completedRuns)
        guard await canPresentNotifications() else { return }
        let changes = completion.imported + completion.updated
        let summary = changes == 1 ? "1 order changed" : "\(changes) orders changed"
        let findingSuffix =
            completion.findingCount == 0 ? "" : " \(completion.findingCount) item(s) need review."
        await post(
            identifier: "purchase-import-run-\(completion.runID)", title: "Purchase import complete",
            body: "\(summary); \(completion.skipped) skipped.\(findingSuffix)")
    }

    private var notifiedRunIDs: Set<String> {
        Set(defaults.stringArray(forKey: Key.completedRuns) ?? [])
    }

    private var offlineValues: [String: TimeInterval] {
        defaults.dictionary(forKey: Key.offlineSince) as? [String: TimeInterval] ?? [:]
    }

    private func canPresentNotifications() async -> Bool {
        let settings = await center.notificationSettings()
        return switch settings.authorizationStatus {
        case .authorized, .provisional:
            true
        case .notDetermined:
            (try? await center.requestAuthorization(options: [.alert, .sound])) == true
        case .denied, .ephemeral:
            false
        @unknown default:
            false
        }
    }

    private func post(identifier: String, title: String, body: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        try? await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }
}
