import CubbyKit
import Foundation
import Nuke
import Observation
#if os(iOS)
    import UIKit
#endif

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
    /// Only a first-registration suggestion; Cubby's edited Device name is authoritative.
    private static var suggestedDeviceName: String {
        #if os(iOS)
            UIDevice.current.model
        #else
            ProcessInfo.processInfo.hostName
        #endif
    }
    static let productionBaseURL = URL(string: "https://cubby.nickysemenza.com")!
    static let localBaseURL = URL(string: "http://localhost:3000")!
    static let defaultBaseURL = productionBaseURL

    private(set) var phase: Phase = .restoring
    private(set) var credential: CubbyCredential?
    private(set) var client: CubbyClient
    private(set) var auth: AuthFlow
    private(set) var credentials: CredentialProvider
    /// This device's master "Automatic work on this device" switch, mirrored to its `Device` row.
    /// Loaded once at init; every change goes through `setParticipation(automaticWork:)`.
    private(set) var participation: DeviceParticipation
    let navigator = Navigator()
    let browseCounts = BrowseCountsModel()
    let spotlight = SpotlightIndexer()
    /// One on-device index of product covers, shared by Identify and by Add photo (which indexes
    /// a new photo the moment it lands, so it matches before the next rebuild).
    let featurePrints = FeaturePrintIndex()
    let photoMatches = PhotoMatchStore()
    /// Browsing the system library is independent from Cubby's persisted analysis index. Keep it
    /// available immediately so opening persistent state cannot block the Photos tab.
    let photoLibrary = PhotoLibraryStore()
    /// The single register of device-local and companion work in progress, read by the iOS bottom
    /// accessory, the macOS sidebar, and Activity's "This device" section (replaces the old
    /// `localExecutionLabel`).
    let backgroundActivity = BackgroundActivityCenter()
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
    // Not `@ObservationIgnored`: `LibraryMetadataSyncActivitySource`'s adapter closure below reads
    // this property fresh on every access, so its assignment in `preparePhotoSubsystem()` (the
    // first instance ever existing) and in `rebindClients()` (a host change) must invalidate any
    // reader that observed this property while it was still `nil` — otherwise the sync's
    // activities never appear until something unrelated re-triggers that reader.
    private var storedLibraryMetadataSync: LibraryMetadataSync?
    @ObservationIgnored private var photoSubsystemTask: Task<Void, Never>?

    var photoAnalysisStore: PhotoAnalysisStore? { storedPhotoAnalysisStore }
    var photoClassificationSweep: PhotoClassificationSweep? { storedPhotoClassificationSweep }
    var libraryMetadataSync: LibraryMetadataSync? { storedLibraryMetadataSync }

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
            let sweep = makePhotoClassificationSweep()
            storedPhotoClassificationSweep = sweep
            backgroundActivity.register(sweep)
            storedLibraryMetadataSync = makeLibraryMetadataSync(analysisStore: analysisStore)
            photoLibrary.install(analysisStore: analysisStore)
            photoSubsystemTask = nil
        }
        photoSubsystemTask = task
        await task.value
    }

    private func makePhotoClassificationSweep() -> PhotoClassificationSweep {
        let sweep = PhotoClassificationSweep(
            analysisStore: storedPhotoAnalysisStore!, library: photoLibrary,
            window: Self.persistedAnalysisWindow, paused: Self.persistedAnalysisPaused,
            isParticipating: participation.automaticWork)
        let matches = photoMatches
        sweep.onClassified = { id, snapshot in matches.markAnalysis([id: snapshot]) }
        Task { try? await storedPhotoAnalysisStore?.migrateLegacyHashCacheIfNeeded() }
        return sweep
    }

    /// Registered once here (not rebuilt in `rebindClients()`) — `LibraryMetadataSyncActivitySource`
    /// below reads `storedLibraryMetadataSync` fresh on every access, so replacing the instance on
    /// a host change (`rebindClients()`) never leaves a stale registration behind. And because
    /// `storedLibraryMetadataSync` itself is not `@ObservationIgnored`, this assignment (and the
    /// first one, in `preparePhotoSubsystem()`) also invalidates any reader of the adapter's
    /// `currentActivities` that observed the property while it was still `nil`.
    private func makeLibraryMetadataSync(analysisStore: PhotoAnalysisStore) -> LibraryMetadataSync {
        let sync = LibraryMetadataSync(
            analysisStore: analysisStore, library: photoLibrary, matches: photoMatches, client: client,
            host: host, installationID: AppInstallationID.current.uuidString.lowercased(),
            isParticipating: participation.automaticWork, isSignedIn: phase == .signedIn)
        // Unlike the sweep, there is no "Photos tab appeared" hook driving this — kick it once so
        // any strong matches computed before this instance existed are not missed.
        sync.reconcile()
        return sync
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
        self.participation = DeviceParticipation.load(from: .standard)
        self.client = CubbyClient(
            baseURL: url, credentials: credentials, identity: Self.identity, requestObserver: requestTrace)
        self.auth = AuthFlow(baseURL: url, credentials: credentials, identity: Self.identity)
        #if os(macOS)
            configureBrowserBridge()
        #endif
        configureCompanionImageWorker()
        configureBackgroundActivitySources()
        applyParticipationToGates()
    }

    /// This install's identity, sent as `User-Agent`/`X-Cubby-Device` on every REST request
    /// (`CubbyAuthMiddleware`).
    private static var identity: ClientIdentity {
        ClientIdentity.currentApp(product: "cubby-apple", installationID: AppInstallationID.current)
    }

    /// Registers this model's long-lived activity sources once. `photoLibrary`/`photoMatches`/
    /// `browserBridge` are `let` constants that outlive host switches and sign-out (they `reset()`
    /// in place), so registering them here — rather than in `rebindClients()` — never produces a
    /// stale or duplicate registration. The companion adapter closes over `self` weakly and reads
    /// `companionImageActivity` fresh on every access, so it too survives `configureCompanionImageWorker()`
    /// rebuilding the underlying worker.
    private func configureBackgroundActivitySources() {
        backgroundActivity.register(photoLibrary)
        backgroundActivity.register(photoMatches)
        backgroundActivity.register(
            CompanionActivitySource { [weak self] in
                self?.companionImageActivity ?? .init(phase: .stopped)
            })
        backgroundActivity.register(
            LibraryMetadataSyncActivitySource { [weak self] in
                self?.storedLibraryMetadataSync?.currentActivities ?? []
            })
        backgroundActivity.register(
            cancel: { [weak self] in self?.storedLibraryMetadataSync?.cancel() },
            for: "library-metadata-sync")
        #if os(macOS)
            backgroundActivity.register(browserBridge)
        #endif
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
            baseURL: baseURL, credentials: model.credentials, identity: Self.identity,
            session: PreviewURLProtocol.session(), requestObserver: model.requestTrace)
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
                if participation.automaticWork { await browserBridge.connectConfigured() }
            #endif
            await syncDeviceParticipation()
            storedLibraryMetadataSync?.setSignedIn(true)
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
            if participation.automaticWork { await browserBridge.connectConfigured() }
        #endif
        await syncDeviceParticipation()
        storedLibraryMetadataSync?.setSignedIn(true)
    }

    func signOut() async {
        storedLibraryMetadataSync?.setSignedIn(false)
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
    }

    /// Called by any screen that receives a `CubbyAPIError`: a 401 means the middleware already
    /// dropped the credential, so the UI should follow it out.
    func handle(_ error: any Error) {
        Diagnostics.report(error, context: "app.handle")
        if let apiError = error as? CubbyAPIError {
            lastError = apiError.detail?.message ?? "HTTP \(apiError.status)"
            if apiError.isUnauthorized {
                storedLibraryMetadataSync?.setSignedIn(false)
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

    /// The master switch: persists, answers the first-sign-in question if it hasn't been answered
    /// yet, fans out to every gate (companion socket, library matching, background analysis, the
    /// macOS browser bridge autoconnect), and mirrors the change onto this install's `Device` row.
    /// `photoAnalysisPaused` (Settings' "Pause analysis" toggle) is a separate, temporary pause
    /// within library processing — this never touches it.
    func setParticipation(automaticWork: Bool) {
        var next = participation
        next.automaticWork = automaticWork
        if next.answeredAt == nil { next.answeredAt = .now }
        participation = next
        participation.save(to: .standard)
        applyParticipationToGates()
        Task { await syncDeviceParticipation() }
    }

    /// Applies `participation.automaticWork` to every gate it controls. Called once at init/rebind
    /// (so a freshly loaded value takes effect immediately) and again from `setParticipation`.
    private func applyParticipationToGates() {
        let automaticWork = participation.automaticWork
        backgroundActivity.participationEnabled = automaticWork
        photoLibrary.setParticipating(automaticWork)
        photoMatches.allowsRepair = automaticWork
        storedPhotoClassificationSweep?.setParticipating(automaticWork)
        storedLibraryMetadataSync?.setParticipating(automaticWork)
        let worker = companionImageWorker
        Task { await worker?.setParticipating(automaticWork) }
    }

    /// Mirrors this install's participation onto its `Device` row through the generic generated
    /// client. Never blocks the UI: a failure is reported and otherwise ignored.
    private func syncDeviceParticipation() async {
        do {
            try await DeviceRegistration.sync(
                .init(
                    installationID: AppInstallationID.current,
                    name: Self.suggestedDeviceName,
                    platform: DevicePlatform.current,
                    appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
                        as? String,
                    osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
                    automaticWork: participation.automaticWork
                ),
                client: client
            )
        } catch {
            Diagnostics.report(error, context: "device.participation.sync")
        }
    }

    private func rebindClients() {
        storedLibraryMetadataSync?.cancel()
        photoMatches.reset()
        photoLibrary.reset()
        let credentials = CredentialProvider(host: host, store: store)
        self.credentials = credentials
        client = CubbyClient(
            baseURL: baseURL, credentials: credentials, identity: Self.identity,
            requestObserver: requestTrace)
        auth = AuthFlow(baseURL: baseURL, credentials: credentials, identity: Self.identity)
        #if os(macOS)
            configureBrowserBridge()
        #endif
        configureCompanionImageWorker()
        // A new host means a new `CubbyClient`/`host` pair — rebuild rather than reuse, same as
        // `configureCompanionImageWorker()` above. Only when the photo subsystem has already
        // opened (`storedPhotoAnalysisStore != nil`): before that, `preparePhotoSubsystem()` will
        // build the first instance against whatever host is current by then.
        if let analysisStore = storedPhotoAnalysisStore {
            storedLibraryMetadataSync = makeLibraryMetadataSync(analysisStore: analysisStore)
        }
        applyParticipationToGates()
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
                deviceName: Self.suggestedDeviceName,
                foreground: companionSceneActive,
                isParticipating: participation.automaticWork,
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
