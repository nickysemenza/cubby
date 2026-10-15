import CubbyKit
import Foundation
import Observation
import UserNotifications

#if os(iOS)
    import UIKit
#elseif os(macOS)
    import AppKit
#endif

/// Alerts use the standard device token, independently of ActivityKit authorization. The
/// server stores an explicit per-run opt-in and delivers only readiness or attention changes.
@MainActor
@Observable
final class PhotoImportNotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PhotoImportNotificationCoordinator()
    private weak var model: AppModel?
    private var deviceToken: String?
    private var registeredRuns: [String: String] = [:]
    private var registeringRuns: Set<String> = []

    func start(model: AppModel) {
        self.model = model
        UNUserNotificationCenter.current().delegate = self
        observeWork()
        Task {
            if await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
                == .authorized
            {
                registerDevice()
            }
        }
    }

    func requestPermission() async throws -> Bool {
        let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [
            .alert, .sound,
        ])
        if allowed { registerDevice() }
        return allowed
    }

    private func registerDevice() {
        #if os(iOS)
            UIApplication.shared.registerForRemoteNotifications()
        #elseif os(macOS)
            NSApplication.shared.registerForRemoteNotifications(matching: [.alert, .sound])
        #endif
    }

    func receivedDeviceToken(_ data: Data) {
        deviceToken = data.map { String(format: "%02x", $0) }.joined()
        registeredRuns.removeAll()
        Task { await reconcile() }
    }

    private func observeWork() {
        withObservationTracking {
            _ = model?.phase
            for flow in model?.photoImportFlows ?? [] {
                _ = flow.session.runID
                _ = flow.notifyWhenReady
            }
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.observeWork()
                await self?.reconcile()
            }
        }
    }

    private func reconcile() async {
        guard let model, model.phase == .signedIn, let deviceToken else { return }
        for flow in model.latestPhotoImportFlows {
            guard flow.notifyWhenReady, let runID = flow.session.runID,
                registeredRuns[runID] != flow.liveActivityBatchID, !registeringRuns.contains(runID)
            else { continue }
            registeringRuns.insert(runID)
            do {
                var input = PhotoRunNotificationRegisterInput(
                    runId: runID, deviceToken: deviceToken, apnsEnvironment: .production,
                    appIdentity: AppleAppIdentity.current == .development ? .development : .production)
                #if DEBUG
                    input.apnsEnvironment = .development
                #endif
                _ = try await model.client.registerPhotoRunNotification(input)
                registeredRuns[runID] = flow.liveActivityBatchID
            } catch { Diagnostics.report(error, context: "photos.import.notification.register") }
            registeringRuns.remove(runID)
        }
    }

    func stop(client: CubbyClient) async {
        for runID in registeredRuns.keys {
            do { _ = try await client.endPhotoRunNotification(.init(runId: runID)) } catch {
                Diagnostics.report(error, context: "photos.import.notification.end")
            }
        }
        registeredRuns.removeAll()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        guard let runID = response.notification.request.content.userInfo["runId"] as? String else { return }
        await MainActor.run { AppModel.active?.navigator.open(.activity(run: runID)) }
    }
}
