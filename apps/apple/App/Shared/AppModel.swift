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
    /// Browsing the system library is independent from Cubby's persisted analysis index. Keep it
    /// available immediately so opening persistent state cannot block the Photos tab.
    let photoLibrary = PhotoLibraryStore()
    #if os(macOS)
        let browserBridge = BrowserBridgeSettingsModel()
        @ObservationIgnored private var browserBridgeController: MacBrowserBridgeController?
    #endif
    @ObservationIgnored private var companionImageWorker: CompanionImageWorker?
    @ObservationIgnored private var companionImageWorkerGeneration = UUID()
    private(set) var companionImageActivity = CompanionImageWorkerActivity(phase: .stopped)
    @ObservationIgnored private var companionSceneActive = false
    /// The SQLite cache opens away from the UI actor and attaches matching/classification once
    /// available. Local photo browsing never waits for it.
    @ObservationIgnored private var storedPhotoAnalysisStore: PhotoAnalysisStore?
    @ObservationIgnored private var storedPhotoClassificationSweep: PhotoClassificationSweep?
    @ObservationIgnored private var photoSubsystemTask: Task<Void, Never>?

    var photoAnalysisStore: PhotoAnalysisStore? { storedPhotoAnalysisStore }
    var photoClassificationSweep: PhotoClassificationSweep? { storedPhotoClassificationSweep }

    /// Opens the persisted SQLite index in the background after local browsing has started.
    func preparePhotoSubsystem() async {
        if storedPhotoAnalysisStore != nil { return }
        if let photoSubsystemTask {
            await photoSubsystemTask.value
            return
        }
        let task = Task { [weak self] in
            let analysisStore = await Task.detached(priority: .userInitiated) {
                Self.makeAnalysisStore()
            }.value
            guard let self else { return }
            storedPhotoAnalysisStore = analysisStore
            storedPhotoClassificationSweep = makePhotoClassificationSweep()
            photoLibrary.install(analysisStore: analysisStore)
            photoSubsystemTask = nil
        }
        photoSubsystemTask = task
        await task.value
    }

    private func makePhotoClassificationSweep() -> PhotoClassificationSweep {
        let sweep = PhotoClassificationSweep(
            analysisStore: storedPhotoAnalysisStore!, library: photoLibrary,
            window: Self.persistedAnalysisWindow, paused: Self.persistedAnalysisPaused)
        let matches = photoMatches
        sweep.onClassified = { id, snapshot in matches.markAnalysis([id: snapshot]) }
        Task { try? await storedPhotoAnalysisStore?.migrateLegacyHashCacheIfNeeded() }
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
        #if os(macOS)
            configureBrowserBridge()
        #endif
        configureCompanionImageWorker()
    }

    /// Opens the SQLite cache at `Application Support/Cubby/PhotoAnalysis.sqlite`, falling back
    /// to an in-memory cache rather than making Photos unavailable if the file cannot be opened.
    private nonisolated static func makeAnalysisStore() -> PhotoAnalysisStore {
        do {
            return try PhotoAnalysisStore.make()
        } catch {
            Diagnostics.report(error, context: "photos.analysisStore.container")
            // An in-memory SQLite queue has no file-system failure mode to hit.
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
        #if os(macOS)
            model.configureBrowserBridge()
        #endif
        model.configureCompanionImageWorker()
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
        if current != nil {
            warmBrowseCounts()
            await companionImageWorker?.start()
            #if os(macOS)
                await browserBridge.connectConfigured()
            #endif
        }
    }

    func signIn(email: String, password: String) async {
        lastError = nil
        let flow = auth
        do {
            let credential = try await flow.signIn(email: email, password: password)
            guard auth === flow else { return }
            await finishSignIn(with: credential)
        } catch let error as AuthError {
            lastError = error.message
            Diagnostics.report(error, context: "auth.signIn")
        } catch {
            lastError = String(describing: error)
            Diagnostics.report(error, context: "auth.signIn")
        }
    }

    func signInWithGoogle(
        authenticate: @escaping AuthFlow.WebAuthenticationHandler
    ) async {
        lastError = nil
        let flow = auth
        do {
            let credential = try await flow.signInWithGoogle(authenticate: authenticate)
            guard auth === flow else { return }
            await finishSignIn(with: credential)
        } catch AuthError.cancelled {
            // Closing the system browser is a normal user action; remain signed out without an
            // error banner or diagnostic event.
        } catch let error as AuthError {
            lastError = error.message
            Diagnostics.report(error, context: "auth.googleSignIn")
        } catch {
            lastError = String(describing: error)
            Diagnostics.report(error, context: "auth.googleSignIn")
        }
    }

    private func finishSignIn(with credential: CubbyCredential) async {
        self.credential = credential
        phase = .signedIn
        warmBrowseCounts()
        await companionImageWorker?.start()
        #if os(macOS)
            await browserBridge.connectConfigured()
        #endif
    }

    func signOut() async {
        do {
            try await companionImageWorker?.stopAndDiscardPendingResults()
        } catch {
            Diagnostics.report(error, context: "imageProcessing.outbox.signOut")
        }
        #if os(macOS)
            await browserBridge.disconnect()
        #endif
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
                Task {
                    try? await companionImageWorker?.stopAndDiscardPendingResults()
                }
                #if os(macOS)
                    Task { await browserBridge.disconnect() }
                #endif
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
        #if os(macOS)
            configureBrowserBridge()
        #endif
        configureCompanionImageWorker()
    }

    func setCompanionSceneActive(_ active: Bool) {
        companionSceneActive = active
        Task { await companionImageWorker?.setForeground(active) }
    }

    private func configureCompanionImageWorker() {
        let previous = companionImageWorker
        let generation = UUID()
        companionImageWorkerGeneration = generation
        companionImageActivity = .init(phase: .stopped)
        do {
            let outbox = try CompanionResultOutbox<ImageProcessingResult>.applicationSupport(
                namespace: host)
            companionImageWorker = CompanionImageWorker(
                baseURL: baseURL,
                credentials: credentials,
                deviceID: AppInstallationID.current,
                foreground: companionSceneActive,
                outbox: outbox,
                failureObserver: { error in
                    Diagnostics.report(error, context: "imageProcessing.socket")
                },
                activityObserver: { [weak self] activity in
                    Task { @MainActor [weak self] in
                        guard self?.companionImageWorkerGeneration == generation else { return }
                        self?.companionImageActivity = activity
                    }
                })
        } catch {
            companionImageWorker = nil
            Diagnostics.report(error, context: "imageProcessing.outbox")
        }
        if let previous { Task { await previous.stop() } }
    }

    var localExecutionLabel: String? {
        if companionImageActivity.phase == .processing {
            return companionImageActivity.kind == "subject_lift"
                ? "Creating image cutout" : "Describing image"
        }
        #if os(macOS)
            if browserBridge.isSyncing { return "Running purchase import" }
        #endif
        return nil
    }

    #if os(macOS)
        private func configureBrowserBridge() {
            let previous = browserBridgeController
            let controller = MacBrowserBridgeController(
                baseURL: baseURL, client: client, credentials: credentials, settings: browserBridge)
            browserBridgeController = controller
            browserBridge.install(controller: controller)
            if let previous { Task { await previous.retire() } }
        }
    #endif

    /// Starts the one cheap dashboard-count request without delaying authentication UI.
    private func warmBrowseCounts() {
        let client = client
        let host = host
        Task { await browseCounts.load(client: client, host: host) }
    }
}
