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
    private(set) var totalCount = 0

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
    @ObservationIgnored private let send: @MainActor (ImageSightingCreateInput) async throws -> Void

    @ObservationIgnored private var isSignedIn: Bool
    @ObservationIgnored private var isSceneActive = true
    @ObservationIgnored private var isParticipating: Bool
    @ObservationIgnored private var runTask: Task<Void, Never>?
    @ObservationIgnored private var runGeneration = UUID()
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
        send: @escaping @MainActor (ImageSightingCreateInput) async throws -> Void
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
        self.send = send
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
        reconcile()
    }

    /// Cancels an in-flight run without changing any gate — `AppModel`'s cancel handler for the
    /// Activity screen's "Cancel" action (`isCancellable: true`).
    func cancel() {
        runTask?.cancel()
        runTask = nil
        isRunning = false
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
    /// `PhotoLibraryStore.monthsRevision`.
    func reconcile(force: Bool = false) {
        guard shouldRunNow else {
            runTask?.cancel()
            runTask = nil
            isRunning = false
            return
        }
        guard runTask == nil || force else { return }
        runTask?.cancel()
        let token = UUID()
        runGeneration = token
        // Flip synchronously: a scheduled run is already "running" to the activity bar and to
        // anyone polling `isRunning` right after `reconcile()`; `run` clears it when it ends.
        isRunning = true
        runTask = Task(priority: .utility) { [weak self] in await self?.run(token: token) }
    }

    private func run(token: UUID) async {
        let candidates = candidateProvider()
        totalCount = candidates.count
        sentCount = 0
        defer {
            if runGeneration == token {
                isRunning = false
                runTask = nil
            }
        }
        guard !candidates.isEmpty, !Task.isCancelled else { return }
        guard let deviceShortcode = await deviceShortcodeProvider(), runGeneration == token,
            !Task.isCancelled
        else { return }
        var iterator = candidates.makeIterator()
        await withTaskGroup(of: Bool.self) { group in
            var pendingCount = 0
            func enqueue() {
                guard !Task.isCancelled, pendingCount < 4, let candidate = iterator.next() else { return }
                pendingCount += 1
                group.addTask { [weak self] in
                    await self?.sendSighting(for: candidate, deviceShortcode: deviceShortcode) ?? false
                }
            }
            for _ in 0..<4 { enqueue() }
            while pendingCount > 0 {
                guard let sent = await group.next() else { break }
                pendingCount -= 1
                if sent { sentCount += 1 }
                guard !Task.isCancelled, runGeneration == token else { break }
                enqueue()
            }
        }
    }

    /// One candidate's full pipeline: skip if already sent for its current `modificationDate`,
    /// else resolve its cloud identifier, build the sighting, write it, and mark it sent. A
    /// send failure is reported and simply leaves the row unmarked so the next pass retries it.
    private func sendSighting(for candidate: Candidate, deviceShortcode: DeviceShortcode) async -> Bool {
        guard let facts = factsProvider(candidate.localIdentifier) else { return false }
        let alreadySent =
            (try? await analysisStore.librarySightingSent(
                host: host, localIdentifier: candidate.localIdentifier,
                imageId: candidate.imageID.rawValue, version: Self.version,
                modificationDate: facts.modificationDate)) ?? false
        guard !alreadySent else { return false }
        let cloudIdentifier = await cloudIdentifierProvider(candidate.localIdentifier)
        let metadata = LibrarySightingBuilder.metadata(from: facts, cloudIdentifier: cloudIdentifier)
        let input = LibrarySightingBuilder.createInput(
            imageId: candidate.imageID, deviceId: deviceShortcode, metadata: metadata,
            installationID: installationID, hashDistance: candidate.hashDistance,
            aspectGate: candidate.aspectGate)
        do {
            try await self.send(input)
        } catch {
            Diagnostics.report(error, context: "photos.librarySightingSync.send")
            return false
        }
        try? await analysisStore.markLibrarySightingSent(
            host: host, localIdentifier: candidate.localIdentifier, imageId: candidate.imageID.rawValue,
            version: Self.version, modificationDate: facts.modificationDate,
            cloudIdentifier: cloudIdentifier)
        return true
    }
}

extension LibraryMetadataSync: BackgroundActivitySource {
    var currentActivities: [BackgroundActivity] {
        guard isRunning, totalCount > 0 else { return [] }
        let progress = Double(min(sentCount, totalCount)) / Double(totalCount)
        return [
            BackgroundActivity(
                id: "library-metadata-sync",
                kind: .metadataSync,
                title: "Recording library matches",
                phase: .running,
                progress: progress,
                detail: "\(sentCount) of \(totalCount)",
                startedAt: .now,
                link: .localActivity("library-metadata-sync"),
                isUserInitiated: false,
                isCancellable: true)
        ]
    }
}

extension LibraryMetadataSync {
    /// The production wiring: candidates come from `PhotoMatchStore`'s strong matches, facts and
    /// the cloud-identifier lookup from PhotoKit through `PhotoLibraryStore`, and writes go
    /// through the generic generated client — `resources.imageSighting.create`'s server adapter
    /// upserts, so a repeated send (a resend after a `modificationDate` change this device also
    /// missed marking) is safe.
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
            send: { [weak client] input in
                guard let client else { return }
                guard case .object(let body) = try JSONValue(encoding: input) else {
                    throw LibraryMetadataSyncError.encodingFailed
                }
                _ = try await client.create(EntityCatalog[.imageSighting], body: body)
            })
    }
}

enum LibraryMetadataSyncError: LocalizedError {
    case encodingFailed
    var errorDescription: String? { "Could not encode this sighting for Cubby." }
}
