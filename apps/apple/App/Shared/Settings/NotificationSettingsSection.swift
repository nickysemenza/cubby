import CubbyKit
import SwiftUI
import UserNotifications

#if os(iOS)
    import ActivityKit
    import UIKit
#else
    import AppKit
#endif

struct NotificationSettingsSection: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var permission: UNAuthorizationStatus?
    @State private var requestingPermission = false
    @State private var permissionError: String?
    #if os(iOS)
        @State private var systemActivitiesEnabled: Bool?
    #endif

    var body: some View {
        let preferences = NotificationPreferences.shared
        Section {
            LabeledContent("Notifications", value: permissionLabel)
            Toggle(
                "Import notifications",
                isOn: Binding(
                    get: { preferences.importNotificationsEnabled || requestingPermission },
                    set: setImportNotifications)
            )
            .disabled(requestingPermission)
            .accessibilityIdentifier("settings.importNotifications")
            Toggle(
                "Background results",
                isOn: Binding(
                    get: { preferences.backgroundResultsEnabled },
                    set: setBackgroundResults)
            )
            .disabled(requestingPermission)
            .accessibilityIdentifier("settings.backgroundResults")
            if requestingPermission { LoadingIndicator(label: "Enabling notifications") }
            if let registrationError = PhotoImportNotificationCoordinator.shared.registrationError {
                Text(registrationError).foregroundStyle(FieldGuideTokens.destructive)
            }
            if let permissionError {
                Text(permissionError).foregroundStyle(FieldGuideTokens.destructive)
            }
            #if os(iOS)
                LabeledContent(
                    "Live Activities",
                    value: systemActivitiesEnabled.map { $0 ? "Allowed" : "Disabled in system settings" }
                        ?? "Checking…")
            #endif
            Button("Open System Settings", systemImage: "arrow.up.forward.app", action: openSystemSettings)
                .accessibilityIdentifier("settings.notificationSystemSettings")
        } header: {
            SettingsSectionHeader(sectionTitle)
        } footer: {
            Text(
                "Import notifications alert you when an import is ready or needs attention. This is the default for new imports; each import can override it."
            )
            Text(
                "Background results include purchase and task details and available images. Related additions arrive together on this device."
            )
            #if os(iOS)
                Text("Live Activities show ongoing progress and are controlled in system settings.")
            #endif
        }
        .task(id: scenePhase) { await refreshPermissions() }
    }

    private var sectionTitle: String {
        #if os(iOS)
            "Notifications & Live Activities"
        #else
            "Notifications"
        #endif
    }

    private var permissionLabel: String {
        switch permission {
        case .authorized: "Allowed"
        case .denied: "Disabled in system settings"
        case .notDetermined: "Not requested"
        case .provisional: "Quiet delivery"
        case .ephemeral: "Allowed temporarily"
        case nil: "Checking…"
        @unknown default: "Unknown"
        }
    }

    private func setImportNotifications(_ enabled: Bool) {
        guard enabled else {
            NotificationPreferences.shared.importNotificationsEnabled = false
            return
        }
        requestingPermission = true
        permissionError = nil
        Task {
            defer { requestingPermission = false }
            do {
                let allowed = try await PhotoImportNotificationCoordinator.shared.requestPermission()
                NotificationPreferences.shared.importNotificationsEnabled = allowed
                if !allowed { permissionError = "Notifications are disabled in system settings." }
            } catch {
                Diagnostics.report(error, context: "settings.notifications.permission")
                permissionError = error.userMessage
            }
            await refreshPermissions()
        }
    }

    private func setBackgroundResults(_ enabled: Bool) {
        requestingPermission = true
        permissionError = nil
        Task {
            defer { requestingPermission = false }
            do {
                let allowed: Bool
                if enabled {
                    allowed = try await PhotoImportNotificationCoordinator.shared.requestPermission()
                } else {
                    allowed = false
                }
                NotificationPreferences.shared.backgroundResultsEnabled = allowed
                if enabled && !allowed { permissionError = "Notifications are disabled in system settings." }
                await PhotoImportNotificationCoordinator.shared.refreshRegistration()
            } catch { permissionError = error.userMessage }
        }
    }

    private func refreshPermissions() async {
        permission = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        await PhotoImportNotificationCoordinator.shared.refreshRegistration()
        #if os(iOS)
            systemActivitiesEnabled = ActivityAuthorizationInfo().areActivitiesEnabled
        #endif
    }

    private func openSystemSettings() {
        #if os(iOS)
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        #else
            if let url = NSWorkspace.shared.urlForApplication(
                withBundleIdentifier: "com.apple.systempreferences")
            {
                NSWorkspace.shared.open(url)
            }
        #endif
    }
}

#Preview {
    Form { NotificationSettingsSection() }
}
