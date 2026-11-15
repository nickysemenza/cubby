import Foundation
import Observation

@MainActor
@Observable
final class NotificationPreferences {
    static let shared = NotificationPreferences()
    private let defaults: UserDefaults

    var backgroundResultsEnabled: Bool {
        didSet { defaults.set(backgroundResultsEnabled, forKey: "backgroundResultsEnabled") }
    }

    var importNotificationsEnabled: Bool {
        didSet { defaults.set(importNotificationsEnabled, forKey: "importNotificationsEnabled") }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        backgroundResultsEnabled = defaults.bool(forKey: "backgroundResultsEnabled")
        importNotificationsEnabled = defaults.bool(forKey: "importNotificationsEnabled")
    }
}
