import Foundation
import Testing

@testable import Cubby

@Suite("Notification preferences")
@MainActor
struct NotificationPreferencesTests {
    @Test func defaultImportPreferenceSurvivesRelaunch() throws {
        let suite = "synthetic-notification-preferences-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let preferences = NotificationPreferences(defaults: defaults)
        preferences.importNotificationsEnabled = true
        let reopened = NotificationPreferences(defaults: defaults)
        #expect(reopened.importNotificationsEnabled)

        reopened.importNotificationsEnabled = false
        let restored = NotificationPreferences(defaults: defaults)
        #expect(!restored.importNotificationsEnabled)
    }

    @Test(arguments: [false, true])
    func recoveredImportKeepsSavedOverride(saved: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("import.selection")
        let archive = PhotoImportSelectionCheckpoint(
            entries: [], runID: nil, createRun: nil, notificationsRequested: saved)
        try JSONEncoder().encode(archive).write(to: url, options: .atomic)
        let suite = "synthetic-notification-recovery-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NotificationPreferences(defaults: defaults)
        preferences.importNotificationsEnabled = !saved
        let flow = PhotoImportRunFlow(
            client: PreviewFixtures.signedInModel().client, notificationPreferences: preferences)
        #expect(flow.notifyWhenReady == !saved)

        try await flow.recoverSelection(from: url)

        #expect(flow.notifyWhenReady == saved)
        #expect(flow.step == .preparationNeedsAttention)
    }
}
