import CubbyKit
import Foundation
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
    var lastError: String?

    /// The app's model, for App Intents (which run in-process). Set once in `CubbyApp.init`.
    static weak var active: AppModel?

    var baseURL: URL {
        didSet {
            guard baseURL != oldValue else { return }
            UserDefaults.standard.set(baseURL.absoluteString, forKey: Self.baseURLKey)
            rebindClients()
            Task {
                await spotlight.wipe()
                await restoreSession()
            }
        }
    }

    private let store: any SessionTokenStore

    init(store: any SessionTokenStore = KeychainSessionTokenStore(), baseURL: URL? = nil) {
        self.store = store
        let url =
            baseURL
            ?? UserDefaults.standard.string(forKey: Self.baseURLKey).flatMap(URL.init(string:))
            ?? Self.defaultBaseURL
        self.baseURL = url
        let credentials = CredentialProvider(host: CubbyBaseURL.host(of: url), store: store)
        self.credentials = credentials
        self.client = CubbyClient(baseURL: url, credentials: credentials)
        self.auth = AuthFlow(baseURL: url, credentials: credentials)
    }

    var host: String { CubbyBaseURL.host(of: baseURL) }

    /// Re-reads the Keychain for the current host. Called at launch and after a base URL change.
    func restoreSession() async {
        let current = await credentials.current()
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
        } catch {
            lastError = String(describing: error)
        }
    }

    func signOut() async {
        do {
            try await auth.signOut()
        } catch {
            // The credential is cleared locally regardless; a failed server call is not a
            // reason to stay signed in on the device.
            lastError = String(describing: error)
        }
        credential = nil
        phase = .signedOut
        await spotlight.wipe()
    }

    /// Called by any screen that receives a `CubbyAPIError`: a 401 means the middleware already
    /// dropped the credential, so the UI should follow it out.
    func handle(_ error: any Error) {
        if let apiError = error as? CubbyAPIError {
            lastError = apiError.detail?.message ?? "HTTP \(apiError.status)"
            if apiError.isUnauthorized {
                credential = nil
                phase = .signedOut
            }
        } else {
            lastError = String(describing: error)
        }
    }

    private func rebindClients() {
        let credentials = CredentialProvider(host: host, store: store)
        self.credentials = credentials
        client = CubbyClient(baseURL: baseURL, credentials: credentials)
        auth = AuthFlow(baseURL: baseURL, credentials: credentials)
    }
}
