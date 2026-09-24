import CubbyKit
import Foundation
import Observation
import Photos

/// Backward path (PR 5): backfills `ImageSighting` rows for library assets this device already
/// knows are strong matches (`PhotoMatchStore.candidates`), without re-running any hashing — the
/// candidates already exist from the forward matching flow. Shaped like `PhotoClassificationSweep`:
/// a pure candidate/gating core plus a production convenience init that wires PhotoKit and the
/// network.
@MainActor
@Observable
final class LibraryMetadataSync {
    /// `library_sighting_sync.version` — bump to force every sighting to resend (a schema or
    /// builder change), the same role `PhotoClassificationSweep.classifyVersion` plays for
    /// classification.
    static let version = 1

    struct Candidate: Sendable, Hashable {
        let localIdentifier: String
        let imageID: ImageCode
        let hashDistance: Int
        /// `true` when this candidate only reached `.strong` confidence because its hash distance
        /// (3...6) also passed the aspect-ratio gate — see `PhotoMatchVerdict.evaluate`. `false`
        /// for a distance-0...2 match, which needed no gate.
        let aspectGate: Bool
    }

    private(set) var isRunning = false
    private(set) var sentCount = 0
    /// Every candidate this pass has finished with, success or failure — what `currentActivities`
    /// drives its progress bar from. `sentCount` alone stalls the bar on a library with a lot of
    /// already-classified-elsewhere or momentarily-unsendable candidates, since neither a skip nor
    /// a failure ever touched it.
    private(set) var processedCount = 0
    private(set) var totalCount = 0
    /// Set on the transition into running, cleared alongside `isRunning`. SwiftUI reads
    /// `currentActivities` on every body evaluation, so a literal `.now` there would make the
    /// Activity screen's relative timestamp perpetually say "now" — this is computed once per run
    /// instead.
    private(set) var startedAt: Date?

    @ObservationIgnored private let analysisStore: PhotoAnalysisStore
    @ObservationIgnored private let host: String
    @ObservationIgnored private let installationID: String
    @ObservationIgnored private let thermal: any PhotoThermalSource
    @ObservationIgnored private let power: any PhotoPowerSource
    @ObservationIgnored private let candidateProvider: @MainActor () -> [Candidate]
    @ObservationIgnored private let factsProvider: @MainActor (String) -> (any LibraryAssetFacts)?
    @ObservationIgnored private let cloudIdentifierProvider: @MainActor (String) async -> String?
    /// Resolved fresh at the start of every run: this device's own `Device` shortcode may not
    /// exist yet the first time a run starts (`DeviceRegistration.sync` races this on sign-in), so
    /// a run with no shortcode yet simply does nothing rather than failing every candidate.
    @ObservationIgnored private let deviceShortcodeProvider: @MainActor () async -> DeviceShortcode?
    @ObservationIgnored private let sendPage: @MainActor ([ImageSightingCreateInput]) async throws -> Void

    @ObservationIgnored private var isSignedIn: Bool
    @ObservationIgnored private var isSceneActive = true
    @ObservationIgnored private var isParticipating: Bool
    @ObservationIgnored private var runTask: Task<Void, Never>?
    @ObservationIgnored private var runGeneration = UUID()
    /// Set by `reconcile()` when it is called while a run is already in flight, instead of
    /// cancelling that run: `PhotoMatchStore.revision` bumps on every 32-asset scan batch and every
    /// visible-cell query batch, so treating each bump as "cancel and restart from candidate 0"
    /// turned a 20k-asset scan into ~600 full restarts — this is the POST-stream bug. `run(token:)`
    /// checks it after every pass and, if set, clears it and re-plans in place rather than
    /// restarting the task.
    @ObservationIgnored private var replanRequested = false
    /// Set by `cancel()` and left set until `setParticipating(true)` or `setSignedIn(true)` clears
    /// it. Without this, `cancel()` only tore down the in-flight `Task` — it changed no gate — so
    /// the very next thermal/power notification or scene-active toggle called `reconcile()` again
    /// and undid the cancellation within seconds of the user tapping Cancel on the Activity screen.
    @ObservationIgnored private var cancelledByUser = false
    // `nonisolated(unsafe)`: same justification as `PhotoClassificationSweep` — `deinit` is not
    // main-actor-isolated, and these tokens are only ever unregistered there.
    @ObservationIgnored nonisolated(unsafe) private var systemConditionObservers: [NSObjectProtocol] = []

    init(
        analysisStore: PhotoAnalysisStore,
        host: String,
        installationID: String,
        isParticipating: Bool = true,
        isSignedIn: Bool = false,
        thermal: any PhotoThermalSource = SystemThermalSource(),
        power: any PhotoPowerSource = SystemPowerSource(),
        candidateProvider: @escaping @MainActor () -> [Candidate],
        factsProvider: @escaping @MainActor (String) -> (any LibraryAssetFacts)?,
        cloudIdentifierProvider: @escaping @MainActor (String) async -> String? = { _ in nil },
        deviceShortcodeProvider: @escaping @MainActor () async -> DeviceShortcode?,
        sendPage: @escaping @MainActor ([ImageSightingCreateInput]) async throws -> Void
    ) {
        self.analysisStore = analysisStore
        self.host = host
        self.installationID = installationID
        self.isParticipating = isParticipating
        self.isSignedIn = isSignedIn
        self.thermal = thermal
        self.power = power
        self.candidateProvider = candidateProvider
        self.factsProvider = factsProvider
        self.cloudIdentifierProvider = cloudIdentifierProvider
        self.deviceShortcodeProvider = deviceShortcodeProvider
        self.sendPage = sendPage
        observeSystemConditions()
    }

    deinit {
        for observer in systemConditionObservers { NotificationCenter.default.removeObserver(observer) }
    }

    private func observeSystemConditions() {
        let thermalToken = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.reconcile() }
        }
        let powerToken = NotificationCenter.default.addObserver(
            forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.reconcile() }
        }
        systemConditionObservers = [thermalToken, powerToken]
    }

    /// `AppModel.restoreSession`/`finishSignIn`/`signOut` — a signed-out install has no session to
    /// write sightings with, and a run in flight is cancelled immediately.
    func setSignedIn(_ signedIn: Bool) {
        isSignedIn = signedIn
        if signedIn { cancelledByUser = false }
        reconcile()
    }

    /// The scene phase (foreground/background).
    func setSceneActive(_ active: Bool) {
        isSceneActive = active
        reconcile()
    }

    /// The master "Automatic work on this device" switch.
    func setParticipating(_ participating: Bool) {
        isParticipating = participating
        if participating { cancelledByUser = false }
        reconcile()
    }

    /// Cancels an in-flight run and keeps it cancelled — `AppModel`'s cancel handler for the
    /// Activity screen's "Cancel" action (`isCancellable: true`). Sticky until the user flips
    /// participation or signs back in (see `cancelledByUser`); a plain "cancel the task" here would
    /// let the next thermal/power notification silently restart the run underneath the user.
    func cancel() {
        cancelledByUser = true
        runTask?.cancel()
        runTask = nil
        isRunning = false
        startedAt = nil
    }

    static func shouldRun(
        isSceneActive: Bool, isSignedIn: Bool, isParticipating: Bool,
        thermalState: ProcessInfo.ThermalState, isLowPowerModeEnabled: Bool
    ) -> Bool {
        isSceneActive && isSignedIn && isParticipating && !isLowPowerModeEnabled
            && thermalState.rawValue < ProcessInfo.ThermalState.serious.rawValue
    }

    private var shouldRunNow: Bool {
        Self.shouldRun(
            isSceneActive: isSceneActive, isSignedIn: isSignedIn, isParticipating: isParticipating,
            thermalState: thermal.thermalState, isLowPowerModeEnabled: power.isLowPowerModeEnabled)
    }

    /// Re-plans against the current candidate source and system conditions. Called by every
    /// setter above, and by `PhotosRootView` whenever `PhotoMatchStore.revision` changes (a fresh
    /// batch of strong matches) — mirrors `PhotoClassificationSweep.reconcile()`'s role for
    /// `PhotoLibraryStore.monthsRevision`. A run already in flight is never cancelled here: it
    /// finishes its current pass and `run(token:)` re-plans once on `replanRequested`, so a burst
    /// of calls (a fast-scrolling scan bumping `revision` hundreds of times) collapses into at most
    /// one extra pass rather than one restart per bump.
    func reconcile() {
        guard shouldRunNow, !cancelledByUser else {
            runTask?.cancel()
            runTask = nil
            isRunning = false
            startedAt = nil
            return
        }
        guard runTask == nil else {
            replanRequested = true
            return
        }
        let token = UUID()
        runGeneration = token
        // Flip synchronously: a scheduled run is already "running" to the activity bar and to
        // anyone polling `isRunning` right after `reconcile()`; `run` clears it when it ends.
        isRunning = true
        startedAt = .now
        runTask = Task(priority: .utility) { [weak self] in await self?.run(token: token) }
    }

    /// Repeats `pass(token:)` until a pass completes with no replan requested during it — the
    /// "finish this pass, then re-plan once" behaviour `reconcile()` promises. `isRunning`/
    /// `runTask`/`startedAt` cover the whole repeat, not each pass, so the activity bar reads as
    /// one continuous run across a replan instead of flickering between runs.
    private func run(token: UUID) async {
        defer {
            if runGeneration == token {
                isRunning = false
                runTask = nil
                startedAt = nil
            }
        }
        repeat {
            replanRequested = false
            await pass(token: token)
        } while replanRequested && runGeneration == token && !Task.isCancelled
    }

    /// One planning-and-send pass: re-reads the candidate source fresh (so a candidate appended
    /// mid-run, e.g. after a replan, is included), pre-filters out anything already recorded for
    /// its current `modificationDate`, then sends the rest in bounded transactional pages. Counters reset at
    /// the top so neither a fresh run nor a replanned pass briefly shows the previous pass's totals.
    private func pass(token: UUID) async {
        sentCount = 0
        processedCount = 0
        totalCount = 0
        let candidates = candidateProvider()
        guard !candidates.isEmpty, !Task.isCancelled else { return }
        let alreadySent =
            (try? await analysisStore.librarySightingsSent(host: host, version: Self.version)) ?? []
        // `factsProvider` runs on this actor (PhotoKit lookups are main-actor-bound), so planning a
        // pass over thousands of candidates would otherwise block the UI for the whole filter step;
        // yielding periodically lets SwiftUI keep drawing while a big library plans.
        var pending: [Candidate] = []
        pending.reserveCapacity(candidates.count)
        for (offset, candidate) in candidates.enumerated() {
            guard !Task.isCancelled, runGeneration == token else { return }
            if let facts = factsProvider(candidate.localIdentifier) {
                let key = SentSightingKey(
                    localIdentifier: candidate.localIdentifier, imageId: candidate.imageID.rawValue,
                    modificationDate: facts.modificationDate)
                if alreadySent.contains(key) { continue }
            }
            pending.append(candidate)
            if offset % 200 == 199 { await Task.yield() }
        }
        totalCount = pending.count
        guard !pending.isEmpty, !Task.isCancelled else { return }
        guard let deviceShortcode = await deviceShortcodeProvider(), runGeneration == token,
            !Task.isCancelled
        else { return }
        let pageSize = 50
        for offset in stride(from: 0, to: pending.count, by: pageSize) {
            guard !Task.isCancelled, runGeneration == token else { return }
            let candidates = pending[offset..<min(offset + pageSize, pending.count)]
            var prepared:
                [(
                    candidate: Candidate, facts: any LibraryAssetFacts,
                    cloudIdentifier: String?, input: ImageSightingCreateInput
                )] = []
            for candidate in candidates {
                guard !Task.isCancelled, runGeneration == token else { return }
                guard let facts = factsProvider(candidate.localIdentifier) else {
                    processedCount += 1
                    continue
                }
                let cloudIdentifier = await cloudIdentifierProvider(candidate.localIdentifier)
                let metadata = LibrarySightingBuilder.metadata(
                    from: facts, cloudIdentifier: cloudIdentifier)
                let input = LibrarySightingBuilder.createInput(
                    imageId: candidate.imageID, deviceId: deviceShortcode, metadata: metadata,
                    installationID: installationID, hashDistance: candidate.hashDistance,
                    aspectGate: candidate.aspectGate)
                prepared.append((candidate, facts, cloudIdentifier, input))
            }
            guard !prepared.isEmpty else { continue }
            do {
                try await sendPage(prepared.map(\.input))
                guard !Task.isCancelled, runGeneration == token else { return }
                for row in prepared {
                    try? await analysisStore.markLibrarySightingSent(
                        host: host, localIdentifier: row.candidate.localIdentifier,
                        imageId: row.candidate.imageID.rawValue,
                        version: Self.version, modificationDate: row.facts.modificationDate,
                        cloudIdentifier: row.cloudIdentifier)
                }
                sentCount += prepared.count
            } catch {
                Diagnostics.report(error, context: "photos.librarySightingSync.sendPage")
            }
            processedCount += prepared.count
            await Task.yield()
        }
    }
}

extension LibraryMetadataSync: BackgroundActivitySource {
    var currentActivities: [BackgroundActivity] {
        guard isRunning else { return [] }
        // `totalCount == 0` is the planning phase: `pass(token:)` is still filtering already-sent
        // candidates out and does not yet know its denominator. That step walks the whole candidate
        // list on this actor, so on a large library it lasts long enough to matter — report
        // indeterminate rather than returning `[]`, or the activity blinks out of every surface at
        // the start of each pass.
        //
        // Otherwise: driven by `processedCount`, not `sentCount`, because a skip or a send failure
        // still finishes a candidate, and the bar must advance for those too or it reads "0 of N"
        // until every candidate happens to succeed.
        let progress =
            totalCount > 0 ? Double(min(processedCount, totalCount)) / Double(totalCount) : nil
        return [
            BackgroundActivity(
                id: "library-metadata-sync",
                kind: .metadataSync,
                title: "Recording library matches",
                phase: .running,
                progress: progress,
                detail: totalCount > 0 ? "\(processedCount) of \(totalCount)" : nil,
                startedAt: startedAt ?? .now,
                link: .localActivity("library-metadata-sync"),
                isUserInitiated: false,
                isCancellable: true)
        ]
    }
}

extension LibraryMetadataSync {
    /// The production wiring: candidates come from `PhotoMatchStore`'s strong matches, facts and
    /// the cloud-identifier lookup from PhotoKit through `PhotoLibraryStore`, and writes go
    /// through the bounded bulk operation. A failed page stays unmarked locally and can be
    /// replayed through the server's existing image/owner/asset-key upsert rule.
    convenience init(
        analysisStore: PhotoAnalysisStore, library: PhotoLibraryStore, matches: PhotoMatchStore,
        client: CubbyClient, host: String, installationID: String, isParticipating: Bool = true,
        isSignedIn: Bool = false
    ) {
        self.init(
            analysisStore: analysisStore, host: host, installationID: installationID,
            isParticipating: isParticipating, isSignedIn: isSignedIn,
            candidateProvider: { [weak matches] in
                guard let matches else { return [] }
                var seen = Set<String>()
                var candidates: [Candidate] = []
                for (localIdentifier, matched) in matches.candidates {
                    for candidate in matched where candidate.confidence == .strong {
                        let key = "\(localIdentifier):\(candidate.id.rawValue)"
                        guard seen.insert(key).inserted else { continue }
                        candidates.append(
                            Candidate(
                                localIdentifier: localIdentifier, imageID: candidate.id,
                                hashDistance: candidate.distance, aspectGate: candidate.distance > 2))
                    }
                }
                return candidates
            },
            factsProvider: { [weak library] localIdentifier in
                library?.asset(for: localIdentifier).map { PHAssetLibraryFacts(asset: $0) }
            },
            cloudIdentifierProvider: { localIdentifier in
                let mappings = PHPhotoLibrary.shared().cloudIdentifierMappings(
                    forLocalIdentifiers: [localIdentifier])
                guard case .success(let cloudID) = mappings[localIdentifier] else { return nil }
                return cloudID.stringValue
            },
            deviceShortcodeProvider: { [weak client] in
                guard let client else { return nil }
                let descriptor = EntityCatalog[.device]
                let filters = EntityFilterState(["installationId": .single(installationID)])
                let page = try? await client.list(descriptor, page: 1, pageSize: 1, filters: filters)
                return page?.items.first?.id
            },
            sendPage: { [weak client] inputs in
                guard let client else { throw LibraryMetadataSyncError.clientUnavailable }
                try await client.bulkImageSightings(inputs)
            })
    }
}

enum LibraryMetadataSyncError: LocalizedError {
    case clientUnavailable
    var errorDescription: String? { "The Cubby client is no longer available." }
}
