import AppIntents
import CubbyKit
import Foundation

/// How an intent reaches the running app. Intents run in-process, so the client and navigator
/// are the app's own; `AppModel.active` is set once in `CubbyApp.init`.
nonisolated enum IntentContext {
    enum Failure: LocalizedError {
        case signedOut
        case notFound(String)

        var errorDescription: String? {
            switch self {
            case .signedOut: "Sign in to Cubby first."
            case .notFound(let what): "Cubby has no \(what)."
            }
        }
    }

    static func client() async throws -> CubbyClient {
        guard let client = await MainActor.run(body: { AppModel.active?.client }) else {
            throw Failure.signedOut
        }
        return client
    }

    @MainActor
    static func open(_ link: CubbyLink) {
        AppModel.active?.navigator.open(link)
    }

    /// Opens the Search tab with `query` prefilled — an intent's fallback when a code or a name
    /// doesn't resolve to exactly one entity. `SearchView` consumes this the same way `CaptureView`
    /// consumes a pending location: set-then-taken, so a relaunch does not repeat it.
    @MainActor
    static func openSearch(prefilling query: String) {
        guard let navigator = AppModel.active?.navigator else { return }
        navigator.pendingSearchQuery = query
        navigator.open(.search)
    }

    /// Fetches one entity by shortcode through the generic resource route.
    static func entity(id: String, client: CubbyClient) async throws -> CubbyEntity {
        guard let descriptor = EntityCatalog.descriptor(forShortcode: id), descriptor.isIntentExposed else {
            throw Failure.notFound("item called \(id)")
        }
        guard let row = try await client.row(descriptor, id: id) else {
            throw Failure.notFound("item called \(id)")
        }
        return CubbyEntity(row: row, kind: descriptor.key)
    }
}

/// The last few entities an intent touched, so Shortcuts can offer them before the user types.
nonisolated enum RecentEntities {
    private static let key = "cubby.intents.recent"
    static let limit = 10

    static func ids() -> [String] {
        UserDefaults.standard.stringArray(forKey: key) ?? []
    }

    static func record(_ id: String) {
        var ids = ids().filter { $0 != id }
        ids.insert(id, at: 0)
        UserDefaults.standard.set(Array(ids.prefix(limit)), forKey: key)
    }
}
