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
    let browseCounts = BrowseCountsModel()
    /// Today's open-problem count, mirrored here so the iOS tab badge can show it without owning
    /// `TodayModel` (which `TodayView` creates per host). `TodayModel.fetchProblems` writes it.
    var problemsTotal: Int?
    let spotlight = SpotlightIndexer()
    /// One on-device index of product covers, shared by Identify and by Add photo (which indexes
    /// a new photo the moment it lands, so it matches before the next rebuild).
    let featurePrints = FeaturePrintIndex()
    let photoMatches = PhotoMatchStore()
    /// SwiftData model-container creation can block or fail while the app is still constructing
    /// its root state on a device. Keep the photo subsystem cold until Photos or its settings are
    /// opened so a bad persisted store cannot leave the whole app on a white launch screen.
    @ObservationIgnored lazy var photoAnalysisStore: PhotoAnalysisStore = Self.makeAnalysisStore()
    @ObservationIgnored lazy var photoLibrary: PhotoLibraryStore =
        PhotoLibraryStore(analysisStore: photoAnalysisStore)
    @ObservationIgnored lazy var photoClassificationSweep: PhotoClassificationSweep =
        makePhotoClassificationSweep()

    private func makePhotoClassificationSweep() -> PhotoClassificationSweep {
        let sweep = PhotoClassificationSweep(
            analysisStore: photoAnalysisStore, library: photoLibrary,
            window: Self.persistedAnalysisWindow, paused: Self.persistedAnalysisPaused)
        let matches = photoMatches
        sweep.onClassified = { id, snapshot in matches.markAnalysis([id: snapshot]) }
        Task { try? await photoAnalysisStore.migrateLegacyHashCacheIfNeeded() }
        return sweep
    }
    /// Developer overlays layer 6: installed on every `CubbyClient` this model builds, so the
    /// request-timing strip reflects requests made through any of them (the base client and, after
    /// a base-URL change, its replacement).
    let requestTrace = RequestTrace()
    var lastError: String?
    /// Bumped by every write the app makes to an entity; a list or detail showing one of
    /// `entityMutationKeys` refreshes on the next revision (`.task(id:)` on the views).
    private(set) var entityMutationRevision = 0
    private(set) var entityMutationKeys: Set<EntityKey> = []
    private(set) var relationshipMutationReplacement: RelationshipAcceptance?

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
        self.client = CubbyClient(baseURL: url, credentials: credentials, requestObserver: requestTrace)
        self.auth = AuthFlow(baseURL: url, credentials: credentials)
    }

    /// The persistent store at `Application Support/Cubby/PhotoAnalysis.store`, falling back to an
    /// in-memory container (photo hashing/classification just resets for this launch) rather than
    /// crashing the app if the on-disk store cannot be opened.
    private static func makeAnalysisStore() -> PhotoAnalysisStore {
        do {
            return try PhotoAnalysisStore.make()
        } catch {
            Diagnostics.report(error, context: "photos.analysisStore.container")
            // The in-memory configuration has no file-system failure mode to hit; if it still
            // throws, SwiftData itself is broken and there is nothing more graceful to fall back
            // to than surfacing that at launch.
            return try! PhotoAnalysisStore.make(inMemory: true)
        }
    }

    private static var persistedAnalysisWindow: PhotoAnalysisWindow {
        UserDefaults.standard.string(forKey: "photoAnalysisWindow").flatMap(
            PhotoAnalysisWindow.init(rawValue:))
            ?? .thisYear
    }

    private static var persistedAnalysisPaused: Bool {
        UserDefaults.standard.bool(forKey: "photoAnalysisPaused")
    }

    /// Preview state is fully established synchronously; constructing a canvas never starts work.
    static func preview(signedIn: Bool, baseURL: URL) -> AppModel {
        let store = InMemorySessionTokenStore()
        let credential = CubbyCredential.bearer("preview.token")
        if signedIn { try? store.save(credential, for: CubbyBaseURL.host(of: baseURL)) }
        let model = AppModel(store: store, baseURL: baseURL)
        model.client = CubbyClient(
            baseURL: baseURL, credentials: model.credentials, session: PreviewURLProtocol.session(),
            requestObserver: model.requestTrace)
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
        if current != nil { warmBrowseCounts() }
    }

    func signIn(email: String, password: String) async {
        lastError = nil
        do {
            credential = try await auth.signIn(email: email, password: password)
            phase = .signedIn
            warmBrowseCounts()
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
        problemsTotal = nil
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

    /// Any screen that created, updated, or deleted an entity calls this with every entity kind
    /// the write could have changed (a placement touches inventory, location, and product).
    func recordEntityMutation(keys: Set<EntityKey>) {
        entityMutationKeys = keys
        relationshipMutationReplacement = nil
        entityMutationRevision += 1
    }

    /// An accepted recommendation is an entity mutation on the kinds it links, plus a jump to the
    /// surviving row when accepting merged the subject away.
    func recordRelationshipMutation(_ acceptance: RelationshipAcceptance) {
        switch acceptance.recommendation {
        case .expenseProject:
            recordEntityMutation(keys: [.expense, .project])
        case .inventoryPlacement:
            recordEntityMutation(keys: [.inventory, .location, .product])
        }
        relationshipMutationReplacement = acceptance.replacedSubject ? acceptance : nil
        if acceptance.replacedSubject {
            navigator.replaceCurrentRecord(
                with: RecordSelection(
                    key: acceptance.destination.entity,
                    id: acceptance.destination.id
                ))
        }
    }

    private func rebindClients() {
        photoMatches.reset()
        photoLibrary.reset()
        let credentials = CredentialProvider(host: host, store: store)
        self.credentials = credentials
        client = CubbyClient(baseURL: baseURL, credentials: credentials, requestObserver: requestTrace)
        auth = AuthFlow(baseURL: baseURL, credentials: credentials)
    }

    /// Starts the one cheap dashboard-count request without delaying authentication UI.
    private func warmBrowseCounts() {
        let client = client
        let host = host
        Task { await browseCounts.load(client: client, host: host) }
    }
}
