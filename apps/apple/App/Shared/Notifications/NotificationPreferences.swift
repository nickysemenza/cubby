import Foundation
import Observation

@MainActor
@Observable
final class NotificationPreferences {
    static let shared = NotificationPreferences()
    private let defaults: UserDefaults

    var importNotificationsEnabled: Bool {
        didSet { defaults.set(importNotificationsEnabled, forKey: "importNotificationsEnabled") }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        importNotificationsEnabled = defaults.bool(forKey: "importNotificationsEnabled")
    }
}
