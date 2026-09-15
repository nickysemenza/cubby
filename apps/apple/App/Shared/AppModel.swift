import CubbyKit
import Foundation
import Nuke
import Observation

/// Root app state: which server, whether we are signed in, and the clients bound to both.
///
/// Changing `baseURL` rebuilds the clients and re-reads the credential for that host, so a dev
/// token for `localhost:3000` and a prod token coexist and switching never sends one to the other.
@Observable
final class AppModel {
    enum Phase: Equatable {
        case restoring
        case signedOut
        case signedIn
    }

    private static let baseURLKey = "cubby.baseURL"
    static let productionBaseURL = URL(string: "https://cubby.nickysemenza.com")!
    static let localBaseURL = URL(string: "http://localhost:3000")!
    static let defaultBaseURL = productionBaseURL

    private(set) var phase: Phase = .restoring
    private(set) var credential: CubbyCredential?
    private(set) var client: CubbyClient
    private(set) var auth: AuthFlow
    private(set) var credentials: CredentialProvider
    let navigator = Navigator()
    let spotlight = SpotlightIndexer()
    /// One on-device index of product covers, shared by Identify and by Add photo (which indexes
    /// a new photo the moment it lands, so it matches before the next rebuild).
    let featurePrints = FeaturePrintIndex()
    let photoMatches = PhotoMatchStore()
    let photoLibrary = PhotoLibraryStore()
    var lastError: String?

    /// The app's model, for App Intents (which run in-process). Set once in `CubbyApp.init`.
    static weak var active: AppModel?

    var baseURL: URL {
        didSet {
            guard baseURL != oldValue else { return }
            UserDefaults.standard.set(baseURL.absoluteString, forKey: Self.baseURLKey)
            Diagnostics.setBaseURL(baseURL)
            rebindClients()
            ImageCaches.reset()
            Task {
                await spotlight.wipe()
                await restoreSession()
            }
        }
    }

    private let store: any SessionTokenStore

    /// The last-applied base URL, or the default. Readable before an `AppModel` exists so
    /// `Diagnostics.start` can run first in `CubbyApp.init`.
    static var persistedBaseURL: URL {
        UserDefaults.standard.string(forKey: baseURLKey).flatMap(URL.init(string:)) ?? defaultBaseURL
    }

    init(store: any SessionTokenStore = KeychainSessionTokenStore(), baseURL: URL? = nil) {
        self.store = store
        let url = baseURL ?? Self.persistedBaseURL
        self.baseURL = url
        let credentials = CredentialProvider(host: CubbyBaseURL.host(of: url), store: store)
        self.credentials = credentials
        self.client = CubbyClient(baseURL: url, credentials: credentials)
        self.auth = AuthFlow(baseURL: url, credentials: credentials)
    }

    /// Preview state is fully established synchronously; constructing a canvas never starts work.
    static func preview(signedIn: Bool, baseURL: URL) -> AppModel {
        let store = InMemorySessionTokenStore()
        let credential = CubbyCredential.bearer("preview.token")
        if signedIn { try? store.save(credential, for: CubbyBaseURL.host(of: baseURL)) }
        let model = AppModel(store: store, baseURL: baseURL)
        model.client = CubbyClient(
            baseURL: baseURL, credentials: model.credentials, session: PreviewURLProtocol.session())
        model.credential = signedIn ? credential : nil
        model.phase = signedIn ? .signedIn : .signedOut
        return model
    }

    var host: String { CubbyBaseURL.host(of: baseURL) }

    /// Re-reads the Keychain for the current host. Called at launch and after a base URL change.
    func restoreSession() async {
        let provider = credentials
        let current = await provider.current()
        guard credentials === provider, !Task.isCancelled else { return }
        credential = current
        phase = current == nil ? .signedOut : .signedIn
    }

    func signIn(email: String, password: String) async {
        lastError = nil
        do {
            credential = try await auth.signIn(email: email, password: password)
            phase = .signedIn
        } catch let error as AuthError {
            lastError = error.message
            Diagnostics.report(error, context: "auth.signIn")
        } catch {
            lastError = String(describing: error)
            Diagnostics.report(error, context: "auth.signIn")
        }
    }

    func signOut() async {
        do {
            try await auth.signOut()
        } catch {
            // The credential is cleared locally regardless; a failed server call is not a
            // reason to stay signed in on the device.
            lastError = String(describing: error)
            Diagnostics.report(error, context: "auth.signOut")
        }
        photoMatches.reset()
        photoLibrary.reset()
        credential = nil
        phase = .signedOut
        await spotlight.wipe()
        ImageCaches.reset()
        #if os(macOS)
            DockBadge.clear()
        #endif
    }

    /// Called by any screen that receives a `CubbyAPIError`: a 401 means the middleware already
    /// dropped the credential, so the UI should follow it out.
    func handle(_ error: any Error) {
        Diagnostics.report(error, context: "app.handle")
        if let apiError = error as? CubbyAPIError {
            lastError = apiError.detail?.message ?? "HTTP \(apiError.status)"
            if apiError.isUnauthorized {
                photoMatches.reset()
                photoLibrary.reset()
                credential = nil
                phase = .signedOut
            }
        } else {
            lastError = String(describing: error)
        }
    }

    private func rebindClients() {
        photoMatches.reset()
        photoLibrary.reset()
        let credentials = CredentialProvider(host: host, store: store)
        self.credentials = credentials
        client = CubbyClient(baseURL: baseURL, credentials: credentials)
        auth = AuthFlow(baseURL: baseURL, credentials: credentials)
    }
}
