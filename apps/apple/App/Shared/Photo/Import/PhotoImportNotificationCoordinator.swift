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
    private(set) var registrationError: String?
    private var stopping = false
    private var backgroundRegistrationKey: String?
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
        guard !stopping else { return }
        let token = data.map { String(format: "%02x", $0) }.joined()
        if deviceToken != token {
            registeredRuns.removeAll()
            backgroundRegistrationKey = nil
        }
        deviceToken = token
        Task { await reconcile() }
    }

    private func observeWork() {
        withObservationTracking {
            _ = model?.phase
            _ = NotificationPreferences.shared.backgroundResultsEnabled
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
        guard !stopping, let model, model.phase == .signedIn, let deviceToken else { return }
        do {
            let enabled = NotificationPreferences.shared.backgroundResultsEnabled
            let key = "\(deviceToken):\(enabled)"
            if backgroundRegistrationKey != key {
                var input = DevicePushRegisterInput(
                    token: deviceToken, environment: .production,
                    appIdentity: AppleAppIdentity.current == .development ? .development : .production,
                    enabled: enabled)
                #if DEBUG
                    input.environment = .development
                #endif
                _ = try await model.client.registerDevicePush(input)
                backgroundRegistrationKey = key
                registrationError = nil
            }
        } catch {
            registrationError = error.userMessage
            Diagnostics.report(error, context: "notifications.register")
        }
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

    func resumeRegistration() async {
        stopping = false
        await refreshRegistration()
    }

    func refreshRegistration() async {
        guard !stopping, let model, model.phase == .signedIn else { return }
        backgroundRegistrationKey = nil
        let permission = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if permission == .authorized || permission == .provisional {
            await reconcile()
            registerDevice()
        } else {
            do { _ = try await model.client.endDevicePush() } catch {
                Diagnostics.report(error, context: "notifications.permission")
            }
        }
    }

    func stop(client: CubbyClient) async {
        stopping = true
        registrationError = nil
        #if os(iOS)
            UIApplication.shared.unregisterForRemoteNotifications()
        #elseif os(macOS)
            NSApplication.shared.unregisterForRemoteNotifications()
        #endif
        do { _ = try await client.endDevicePush() } catch {
            Diagnostics.report(error, context: "notifications.end")
        }
        backgroundRegistrationKey = nil
        deviceToken = nil
        NotificationPreferences.shared.backgroundResultsEnabled = false
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
        let info = response.notification.request.content.userInfo
        if let runID = info["runId"] as? String {
            await MainActor.run { AppModel.active?.navigator.open(.activity(run: runID)) }
        } else if info["backgroundResults"] as? Bool == true {
            let entity = info["entity"] as? String
            let id = info["entityId"] as? String
            await Self.openResult(entity: entity, id: id)
        }
    }

    @MainActor private static func openResult(entity: String?, id: String?) async {
        guard let model = AppModel.active, model.phase == .signedIn else { return }
        if let entity, let key = EntityKey(rawValue: entity), let id {
            do {
                if let row = try await model.client.row(EntityCatalog[key], id: id) {
                    model.navigator.open(.entity(key, id: row.id))
                    return
                }
            } catch { Diagnostics.report(error, context: "notifications.open") }
        }
        let url = model.webHandoff.url(.route(path: "/suggestions", query: ["status": "automatic"]))
        #if os(iOS)
            _ = await UIApplication.shared.open(url)
        #elseif os(macOS)
            NSWorkspace.shared.open(url)
        #endif
    }
}
