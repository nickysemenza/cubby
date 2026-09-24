import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("AppInstallationID")
struct AppInstallationIDTests {
    private final class MemoryStore: InstallationIDStore {
        var value: UUID?

        func load() throws -> UUID? { value }
        func save(_ id: UUID) throws { value = id }
    }

    private func defaults() -> UserDefaults {
        let name = "AppInstallationIDTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test func reinstallReusesTheRegisteredID() {
        let store = MemoryStore()
        let before = defaults()
        let registeredID = UUID()
        before.set(registeredID.uuidString.lowercased(), forKey: "cubby.installation.deviceID")

        #expect(AppInstallationID.current(in: before, store: store) == registeredID)
        #expect(store.value == registeredID)

        let after = defaults()
        #expect(AppInstallationID.current(in: after, store: store) == registeredID)
        #expect(
            after.string(forKey: "cubby.installation.deviceID")
                == registeredID.uuidString.lowercased())
    }

    @Test func existingDefaultsWinOverAnOlderKeychainValue() {
        let store = MemoryStore()
        store.value = UUID()
        let currentID = UUID()
        let defaults = defaults()
        defaults.set(currentID.uuidString.lowercased(), forKey: "cubby.installation.deviceID")

        #expect(AppInstallationID.current(in: defaults, store: store) == currentID)
        #expect(store.value == currentID)
    }
}
