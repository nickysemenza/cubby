import CoreGraphics
import CubbyKit
import Foundation
import Observation
import Photos

@Observable
final class PhotoLibraryStore: NSObject, PHPhotoLibraryChangeObserver {
    struct Month: Identifiable {
        let id: Date
        let assets: [PHAsset]
    }
    private(set) var authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    /// The master "Automatic work on this device" switch, set by `AppModel`. `false` keeps the
    /// grid enumerating the local library but skips the remote matches refresh and the background
    /// hash-scan; per-cell hashing (`thumbnail(_:matches:degraded:)`) returns the image only.
    private(set) var isParticipating = true
    private(set) var months: [Month] = []
    /// Bumped every time `months` is replaced (a fresh load, an authorization change, or a
    /// PhotoKit library-change refresh). `PhotoClassificationSweep`'s candidate provider reads
    /// `months` but has no other way to know it changed — `PhotosRootView` reconciles the sweep
    /// on this so a sweep that saw zero candidates (tab opened before the library finished
    /// loading) actually starts once photos exist, and a finished sweep re-arms for new ones.
    private(set) var monthsRevision = 0
    /// Photos indexed so far — updates every batch during a load (cheap: an `Int` assignment),
    /// unlike `months`/`monthsRevision`, which publish on a throttle (see `refresh`).
    private(set) var count = 0
    /// The fetch result's total count, known from the first batch. `nil` before that, and while
    /// there is no PhotoKit fetch in flight to ask (e.g. before the first `refresh`).
    private(set) var totalAssetCount: Int?
    private(set) var checked: Set<String> = []
    private(set) var deferredCloudIDs: Set<String> = []
    private(set) var isScanning = false
    private(set) var isLoadingLibrary = false
    private(set) var loadingStartedAt: Date?
    private(set) var loadingStep = "Idle"
    private(set) var completedLoadingSteps: [String] = []
    private(set) var scannedCount = 0
    private(set) var error: String?
    private(set) var selectionProgress: Double = 0
    var selectedIDs: [String] = []
    var scrollID: String?

    @ObservationIgnored private var analysisStore: PhotoAnalysisStore?
    @ObservationIgnored private let thumbnails = NSCache<NSString, ImageBox>()
    @ObservationIgnored private var scanTask: Task<Void, Never>?
    @ObservationIgnored private var currentScanID: UUID?
    @ObservationIgnored private var libraryChangeTask: Task<Void, Never>?
    @ObservationIgnored private var visibleWork: [String: Task<CGImage, any Error>] = [:]
    @ObservationIgnored private var index = PhotoMonthIndex<PHAsset>()
    /// The PhotoKit fetch result from the last full or incremental load — kept so a library-change
    /// notification can ask PhotoKit for a diff (`changeDetails(for:)`) instead of falling back to
    /// a full `refresh()`. Only ever written on the main actor (inside `refresh`/
    /// `applyLibraryChange`); `photoLibraryDidChange` is a `nonisolated` delegate callback but only
    /// reads it after hopping back to the main actor, so no concurrent access ever occurs.
    @ObservationIgnored private var fetchResult: PHFetchResult<PHAsset>?
    @ObservationIgnored private var clients: [UUID: (PhotoMatchStore, CubbyClient)] = [:]
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var analysisBadgeMonths: Set<Date> = []
    @ObservationIgnored private var loadingAnalysisBadgeMonths: Set<Date> = []
    @ObservationIgnored private var observing = false
    /// The server host saved match results are keyed by (`AppModel.host`), set by `AppModel` on
    /// install and on every host change. `nil` keeps matching in memory only.
    @ObservationIgnored var matchHost: String?
    /// Set by an explicit refresh so the next reconcile ignores saved match results once.
    @ObservationIgnored private var forceRematch = false
    /// PhotoKit changes not yet applied — a debounce window's burst, or everything delivered while
    /// no Photos tab was active. Applied in order: each `changeDetails(for:)` is relative to the
    /// fetch result the previous change produced, so none may be dropped.
    @ObservationIgnored private var pendingLibraryChanges: [PHChange] = []
    var hasFullAccess: Bool { authorization == .authorized }

    var scanStatus: String {
        if !isParticipating { return "Automatic matching is off" }
        if isLoadingLibrary { return "Loading your photo library…" }
        if isScanning { return "Checking photo \(min(scannedCount + 1, count)) of \(count)…" }
        let unchecked = count - checked.count
        return unchecked > 0
            ? "\(checked.count) of \(count) library photos checked · \(unchecked) unchecked"
            : "\(count) library photos checked"
    }

    /// The master "Automatic work on this device" switch. Turning it off cancels the in-flight
    /// background hash-scan immediately (library enumeration itself is untouched); turning it back
    /// on takes effect on the next `refresh(...)`.
    func setParticipating(_ participating: Bool) {
        guard isParticipating != participating else { return }
        isParticipating = participating
        guard !participating else { return }
        scanTask?.cancel()
        scanTask = nil
        isScanning = false
        scannedCount = 0
    }

    /// The full step/elapsed/batch/analysis picture the Photos header used to print as six lines
    /// of monospaced text. `PhotoLibraryHeader`'s one-line load-step caption replaces that on
    /// screen, but a frozen support case still needs every one of these fields — this is what the
    /// "Copy diagnostics" payload (`PhotosRootView`'s `CopyDiagnosticsButton`) carries instead.
    struct LoadDiagnostics: Encodable {
        let step: String
        let elapsedSeconds: Double
        let completedSteps: [String]
        let photosPublished: Int
        let totalPhotos: Int?
        let analysisIndexAttached: Bool
    }

    var loadDiagnostics: LoadDiagnostics {
        LoadDiagnostics(
            step: loadingStep,
            elapsedSeconds: loadingStartedAt.map { Date.now.timeIntervalSince($0) } ?? 0,
            completedSteps: completedLoadingSteps,
            photosPublished: count,
            totalPhotos: totalAssetCount,
            analysisIndexAttached: analysisStore != nil)
    }

    /// Photos this device has enumerated but not yet checked against Cubby — the "Not in Cubby"
    /// filter's footnote count (`PhotoLibraryHeader`). Never negative: `checked` only ever grows to
    /// intersect the index's current keys (see `refresh`), but a defensive `max` keeps this safe
    /// even if that invariant is ever violated mid-refresh.
    var uncheckedCount: Int { max(0, count - checked.count) }

    /// Only locally accessible, unchecked photos justify another iOS processing request.
    var hasPendingMatching: Bool {
        isParticipating && hasFullAccess && count > checked.count + deferredCloudIDs.count
    }

    init(analysisStore: PhotoAnalysisStore? = nil) {
        self.analysisStore = analysisStore
        super.init()
        #if os(macOS)
            thumbnails.totalCostLimit = 64 * 1024 * 1024
        #else
            thumbnails.totalCostLimit = 24 * 1024 * 1024
        #endif
    }

    /// Attaches Cubby's persisted matching/classification index only after it is usable. Local
    /// PhotoKit browsing does not depend on this store and stays available without it.
    func install(analysisStore: PhotoAnalysisStore) {
        guard self.analysisStore == nil else { return }
        self.analysisStore = analysisStore
        guard let (matches, client) = clients.values.first else { return }
        // A load already in flight reads `self.analysisStore` again once PhotoKit enumeration
        // finishes (`reconcileAnalysis`, called from the tail of `refresh`), so it picks this
        // store up on its own — restarting here via a full `refresh()` would cancel that
        // in-flight enumeration (`stopWork()`) and start over from zero for no reason.
        guard !isLoadingLibrary else { return }
        let token = generation
        Task { [weak self] in
            await self?.reconcileAnalysis(token: token, matches: matches, client: client, matchRefresh: nil)
        }
    }

    func activate(_ id: UUID, matches: PhotoMatchStore, client: CubbyClient) async {
        guard !Task.isCancelled else { return }
        let wasEmpty = clients.isEmpty
        clients[id] = (matches, client)
        matches.acquire(id)
        guard wasEmpty else {
            if !isScanning && !isLoadingLibrary {
                if fetchResult == nil {
                    await refresh(matches: matches, client: client)
                } else if hasPendingMatching {
                    await resume(matches: matches, client: client)
                }
            }
            return
        }
        if canResume {
            await resume(matches: matches, client: client)
        } else {
            await refresh(matches: matches, client: client)
        }
    }

    /// Leaving the Photos tab stops background work but keeps the loaded library and stays
    /// registered for PhotoKit changes (queued in `pendingLibraryChanges`), so returning resumes
    /// instead of re-reading ~90k assets from PhotoKit.
    func deactivate(_ id: UUID) {
        clients.removeValue(forKey: id)?.0.release(id)
        if clients.isEmpty { stopWork() }
    }

    func waitForMatching() async {
        await scanTask?.value
    }

    func interruptMatching() {
        scanTask?.cancel()
        scanTask = nil
        isScanning = false
    }

    /// A completed load for the same Photos access, kept current by the change observer while
    /// the tab was away.
    private var canResume: Bool {
        fetchResult != nil && observing && hasFullAccess
            && PHPhotoLibrary.authorizationStatus(for: .readWrite) == authorization
    }

    private func resume(matches: PhotoMatchStore, client: CubbyClient) async {
        if !pendingLibraryChanges.isEmpty {
            // Applies the deltas (or falls back to a full refresh) and re-arms the scan.
            await applyLibraryChanges(matches: matches, client: client)
            return
        }
        let token = generation
        // Cheap now that known results only take the index delta (`PhotoMatchStore.refresh`).
        if isParticipating { await matches.refresh(client: client) }
        guard generation == token, !Task.isCancelled, isParticipating, analysisStore != nil else { return }
        let remaining = months.flatMap(\.assets).filter {
            !checked.contains($0.localIdentifier) && !deferredCloudIDs.contains($0.localIdentifier)
        }
        startScan(remaining: remaining, matches: matches, token: token)
    }

    func reset() {
        stopWork()
        pendingLibraryChanges = []
        for (id, pair) in clients { pair.0.release(id) }
        if observing { PHPhotoLibrary.shared().unregisterChangeObserver(self); observing = false }
        clients = [:]; checked = []; deferredCloudIDs = []
        selectedIDs = []; scrollID = nil; months = []; index = PhotoMonthIndex()
        fetchResult = nil
        monthsRevision += 1
        thumbnails.removeAllObjects()
        count = 0; totalAssetCount = nil; isScanning = false
        loadingStartedAt = nil; loadingStep = "Idle"
        completedLoadingSteps = []
    }

    func requestAccess(matches: PhotoMatchStore, client: CubbyClient) async {
        authorization = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        await refresh(matches: matches, client: client)
    }

    /// `forceRematch` (the header's refresh control) re-checks every photo against the whole index
    /// instead of trusting saved results for this one load.
    func refresh(matches: PhotoMatchStore, client: CubbyClient, forceRematch: Bool = false) async {
        if forceRematch { self.forceRematch = true }
        stopWork()
        // The fresh fetch below already reflects every change queued before it.
        pendingLibraryChanges = []
        let token = generation
        defer { if generation == token { isLoadingLibrary = false } }
        authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        // Do not make the local Photos grid wait for the remote Cubby index. A stalled or slow
        // index request otherwise leaves the authorized screen showing an empty grid and
        // "Cubby has not been checked" indefinitely, even though PhotoKit is ready to load.
        isLoadingLibrary = true
        totalAssetCount = nil
        loadingStartedAt = .now
        loadingStep = "Opening photo library"
        completedLoadingSteps = ["Refresh started", "Photos access checked"]
        let isParticipating = isParticipating
        // A `Task` (not `async let`) so the same handle can be threaded through to
        // `reconcileAnalysis`, which awaits it at the point it actually needs the result — the
        // remote index refresh keeps running concurrently with the local PhotoKit read below
        // exactly as it did as an `async let`.
        let matchRefresh = Task { [weak matches] in
            guard isParticipating else { return }
            guard let matches else { return }
            await matches.refresh(client: client)
        }
        guard generation == token, !Task.isCancelled else { return }
        guard hasFullAccess else {
            index = PhotoMonthIndex()
            months = []; monthsRevision += 1
            count = 0; totalAssetCount = nil; checked = []; deferredCloudIDs = []; selectedIDs = []
            fetchResult = nil
            thumbnails.removeAllObjects()
            if observing { PHPhotoLibrary.shared().unregisterChangeObserver(self); observing = false }
            return
        }
        if !observing { PHPhotoLibrary.shared().register(self); observing = true }
        completedLoadingSteps.append("Library observer active")
        loadingStep = "Reading local photos"
        // Kept only to detect a modificationDate change below (the loop can't consult `index`
        // for that — it is reset to empty for this load's fresh append-only build-up).
        let oldIndex = index
        index = PhotoMonthIndex()
        var clock = ContinuousClock.now
        var publishedFirstBatch = false
        for await batch in Self.assetBatches() {
            guard generation == token, !Task.isCancelled else { return }
            if let result = batch.fetchResult { fetchResult = result }
            if let total = batch.totalCount { totalAssetCount = total }
            for asset in batch.assets {
                if let old = oldIndex.asset(for: asset.localIdentifier),
                    old.modificationDate != asset.modificationDate
                {
                    thumbnails.removeObject(forKey: asset.localIdentifier as NSString)
                    checked.remove(asset.localIdentifier)
                    deferredCloudIDs.remove(asset.localIdentifier)
                }
            }
            index.append(batch.assets)
            // `count` is cheap (an `Int`) and updates every batch so the "x of y photos" caption
            // stays live; `months`/`monthsRevision` — which drive ~450 SwiftUI grid re-diffs at
            // 200/batch on a 90k-photo library — publish at most every ~0.5s instead.
            count = index.count
            let now = ContinuousClock.now
            if !publishedFirstBatch || now - clock >= .milliseconds(500) {
                publishMonths()
                clock = now
                publishedFirstBatch = true
            }
            await Task.yield()
        }
        guard generation == token, !Task.isCancelled else { return }
        publishMonths()
        completedLoadingSteps.append("PhotoKit enumeration complete")
        guard isParticipating, analysisStore != nil else {
            selectedIDs.removeAll { index.asset(for: $0) == nil }
            loadingStep =
                isParticipating
                ? "Local photos ready; Cubby analysis unavailable"
                : "Local photos ready; automatic matching is off"
            return
        }
        await reconcileAnalysis(token: token, matches: matches, client: client, matchRefresh: matchRefresh)
    }

    private func publishMonths() {
        months = index.months.map { Month(id: $0.id, assets: $0.assets) }
        monthsRevision += 1
    }

    /// The tail of a load: prune stale analysis rows, wait for the remote match refresh, mark
    /// existing analysis, and (re)arm the hash scan. Shared by `refresh()` (a fresh PhotoKit
    /// enumeration) and `install(analysisStore:)` (the store attaching after PhotoKit has already
    /// finished enumerating — no PhotoKit read to redo). `matchRefresh` is the `Task` `refresh()`
    /// already started concurrently with its local read; `install` has none in flight, so this
    /// starts its own here instead.
    private func reconcileAnalysis(
        token: UUID, matches: PhotoMatchStore, client: CubbyClient, matchRefresh: Task<Void, Never>?
    ) async {
        guard let analysisStore else { return }
        loadingStep = "Reconciling on-device analysis"
        do {
            try await analysisStore.pruneMissing(Set(index.assetsByID.keys))
        } catch {
            Diagnostics.report(error, context: "photos.analysisStore.prune")
        }
        guard generation == token, !Task.isCancelled else { return }
        checked.formIntersection(index.assetsByID.keys)
        selectedIDs.removeAll { index.asset(for: $0) == nil }
        publishMonths()
        count = index.count
        isLoadingLibrary = false
        loadingStep = "Checking Cubby matches"
        let isParticipating = isParticipating
        let refreshTask =
            matchRefresh
            ?? Task { [weak matches] in
                guard isParticipating else { return }
                guard let matches else { return }
                await matches.refresh(client: client)
            }
        await refreshTask.value
        guard generation == token, !Task.isCancelled else { return }
        // Badges are loaded by visible month below; a whole-library snapshot read makes a warm
        // launch proportional to the entire photo library even when only one month is on screen.
        let unchecked = months.flatMap(\.assets).filter { !checked.contains($0.localIdentifier) }
        let retryDeferredCloud = forceRematch
        let remaining = await seedSavedMatches(
            unchecked, matches: matches, analysisStore: analysisStore, token: token)
        guard generation == token, !Task.isCancelled else { return }
        let deferred =
            (try? await analysisStore.deferredCloudHashes(for: remaining.map(\.localIdentifier))) ?? [:]
        if retryDeferredCloud {
            try? await analysisStore.clearDeferredCloudHashes(Array(deferred.keys))
            deferredCloudIDs = []
        } else {
            deferredCloudIDs = Set(
                remaining.compactMap { asset in
                    guard let saved = deferred[asset.localIdentifier], saved == asset.modificationDate else {
                        return nil
                    }
                    return asset.localIdentifier
                })
        }
        startScan(
            remaining: remaining.filter { !deferredCloudIDs.contains($0.localIdentifier) },
            matches: matches, token: token)
    }

    /// Load badges for visible months and one neighbor on each side. A month is fetched once per
    /// library generation; the classification sweep publishes new badge results as it works.
    func loadAnalysisBadges(visible: [Date], matches: PhotoMatchStore) async {
        guard let analysisStore else { return }
        let token = generation
        var wanted: Set<Date> = []
        for id in visible {
            guard let position = months.firstIndex(where: { $0.id == id }) else { continue }
            for neighbor in max(0, position - 1)...min(months.count - 1, position + 1) {
                wanted.insert(months[neighbor].id)
            }
        }
        let missing = wanted.subtracting(analysisBadgeMonths).subtracting(loadingAnalysisBadgeMonths)
        guard !missing.isEmpty else { return }
        loadingAnalysisBadgeMonths.formUnion(missing)
        defer { if generation == token { loadingAnalysisBadgeMonths.subtract(missing) } }
        let ids = months.filter { missing.contains($0.id) }
            .flatMap { $0.assets.map(\.localIdentifier) }
        guard
            let snapshots = try? await analysisStore.snapshots(
                for: ids, includeFullAnalysis: false), generation == token, !Task.isCancelled
        else { return }
        matches.markAnalysis(snapshots)
        analysisBadgeMonths.formUnion(missing)
    }

    /// Installs saved match results for every unedited photo, brought up to date with only the
    /// index entries that changed since they were saved (`PhotoMatchDelta`), and returns the
    /// photos that still need a full match: new, edited, or never matched. Re-matching the whole
    /// library against the whole index every launch was most of a warm launch's work.
    private func seedSavedMatches(
        _ unchecked: [PHAsset], matches: PhotoMatchStore, analysisStore: PhotoAnalysisStore, token: UUID
    ) async -> [PHAsset] {
        let force = forceRematch
        forceRematch = false
        guard let host = matchHost, matches.hasIndex, !force, !unchecked.isEmpty else { return unchecked }
        let (entries, indexRevision) = matches.indexSnapshot
        do {
            let state = try await analysisStore.matchState(host: host)
            let hashes = try await analysisStore.hashes(for: unchecked.map(\.localIdentifier))
            let delta = try PhotoMatchDelta(previous: state.indexDigests, current: entries)
            var queries: [String: HashQuery] = [:]
            var stored: [String: [DedupCandidate]] = [:]
            var cold: [PHAsset] = []
            for asset in unchecked {
                let id = asset.localIdentifier
                if let saved = state.matches[id], saved.modificationDate == asset.modificationDate,
                    saved.hashRevision == PerceptualHash64.algorithmRevision,
                    let record = hashes[id], Self.isCurrent(record, for: asset)
                {
                    queries[id] = Self.hashQuery(for: asset, hash: record.perceptualHash)
                    stored[id] = saved.candidates
                } else {
                    cold.append(asset)
                }
            }
            let updated =
                delta.isEmpty ? stored : try await PhotoMatchStore.apply(delta, to: stored, queries: queries)
            // The index moved while applying (a repair batch): leave everything to the full scan.
            guard generation == token, !Task.isCancelled, matches.isCurrentIndex(indexRevision) else {
                return unchecked
            }
            if !delta.isEmpty {
                // Only rows the delta changed, with the snapshot they now reflect, atomically. On a
                // first run this writes just the snapshot, before the scan saves any rows.
                let changedRows = updated.compactMap { id, candidates -> StoredPhotoMatch? in
                    guard candidates != stored[id], let asset = index.asset(for: id) else { return nil }
                    return Self.storedMatch(for: asset, candidates: candidates)
                }
                try await analysisStore.applyMatchDelta(
                    host: host, matches: changedRows,
                    indexDigests: Dictionary(uniqueKeysWithValues: entries.map { ($0.id, $0.matchDigest) }))
                guard generation == token, !Task.isCancelled else { return unchecked }
            }
            matches.seedServerMatches(
                updated.reduce(into: [:]) { seeded, element in
                    if let query = queries[element.key] { seeded[element.key] = (query, element.value) }
                })
            checked.formUnion(updated.keys)
            return cold
        } catch {
            Diagnostics.report(error, context: "photos.savedMatches.load")
            return unchecked
        }
    }

    private static func storedMatch(for asset: PHAsset, candidates: [DedupCandidate]) -> StoredPhotoMatch {
        StoredPhotoMatch(
            localIdentifier: asset.localIdentifier, modificationDate: asset.modificationDate,
            hashRevision: PerceptualHash64.algorithmRevision, candidates: candidates)
    }

    /// Persists results the scan just published so the next launch can seed them.
    private func saveMatches(_ published: [String: [DedupCandidate]]) async {
        guard let host = matchHost, let analysisStore, !published.isEmpty else { return }
        let rows = published.compactMap { id, candidates in
            index.asset(for: id).map { Self.storedMatch(for: $0, candidates: candidates) }
        }
        do {
            try await analysisStore.saveMatches(host: host, rows)
        } catch {
            Diagnostics.report(error, context: "photos.savedMatches.save")
        }
    }

    /// The background hash scan, factored out of `reconcileAnalysis` so `applyLibraryChange`
    /// can re-arm it for just-changed/newly-inserted assets after a delta apply, without redoing
    /// the whole reconciliation. `remaining` must already exclude `checked` ids.
    private func startScan(remaining: [PHAsset], matches: PhotoMatchStore, token: UUID) {
        let completedCount = count - remaining.count
        scannedCount = completedCount
        // A delta re-arm (`applyLibraryChange`) keeps the same `generation`, so the previous scan
        // must be cancelled here, and `isScanning` is owned by `scanID` rather than `token` —
        // otherwise the superseded scan's `defer` clears it while the new scan is still running.
        scanTask?.cancel()
        guard !remaining.isEmpty else {
            scanTask = nil
            isScanning = false
            return
        }
        let scanID = UUID()
        currentScanID = scanID
        scanTask = Task { [weak self] in
            guard let self else { return }
            guard !Task.isCancelled, generation == token else { return }
            guard let analysisStore else { return }
            isScanning = true
            defer { if currentScanID == scanID { isScanning = false } }
            // Let visible cells enqueue their user-initiated requests before the utility scan.
            try? await Task.sleep(for: .milliseconds(150))
            // One batch read for the whole remaining set instead of one actor round trip per
            // asset — `query(_:preloaded:)` only falls back to a per-id store read when an asset
            // is missing from this snapshot (e.g. newly added mid-scan).
            let preloadedHashes =
                (try? await analysisStore.hashes(for: remaining.map(\.localIdentifier))) ?? [:]
            // Warm path: photos with a still-valid cached fingerprint need no image work, so they
            // register in large chunks. Each `registerBatch` bumps `matches.revision`, which
            // invalidates the grid's filter caches — at 32 per batch that was ~2,800 bumps on a
            // 90k-photo library and most of this stage's time on every launch.
            var uncached: [PHAsset] = []
            var warm: [String: HashQuery] = [:]
            var warmDone = 0
            @MainActor func flushWarm() async -> Bool {
                guard !warm.isEmpty else { return true }
                matches.markChecked(warm.keys)
                await saveMatches(await matches.registerBatch(warm))
                guard generation == token, !Task.isCancelled else { return false }
                checked.formUnion(warm.keys)
                warmDone += warm.count
                scannedCount = completedCount + warmDone
                warm = [:]
                await Task.yield()
                return true
            }
            for asset in remaining where !checked.contains(asset.localIdentifier) {
                if let record = preloadedHashes[asset.localIdentifier], Self.isCurrent(record, for: asset) {
                    warm[asset.localIdentifier] = Self.hashQuery(for: asset, hash: record.perceptualHash)
                    if warm.count >= 2_000, !(await flushWarm()) { return }
                } else {
                    uncached.append(asset)
                }
            }
            guard await flushWarm() else { return }
            let uncachedBase = completedCount + warmDone
            var pending: [String: HashQuery] = [:]
            for (offset, asset) in uncached.enumerated() {
                guard !Task.isCancelled, generation == token else { return }
                // Visible cells may finish work after this scan's snapshot was taken.
                if checked.contains(asset.localIdentifier) { continue }
                matches.markChecking(for: asset.localIdentifier)
                do {
                    pending[asset.localIdentifier] =
                        try await query(asset, preloaded: preloadedHashes[asset.localIdentifier])
                } catch is CancellationError {
                    matches.markCheckCancelled(for: asset.localIdentifier)
                    return
                } catch {
                    guard generation == token else { return }
                    matches.markUnavailable(for: asset.localIdentifier, message: error.localizedDescription)
                    if PhotoLibraryFailure.isCloudUnavailable(error) {
                        deferredCloudIDs.insert(asset.localIdentifier)
                        try? await analysisStore.deferCloudHash(
                            localIdentifier: asset.localIdentifier, modificationDate: asset.modificationDate)
                    } else {
                        Diagnostics.report(error, context: "photos.match.prepare")
                    }
                }
                // Coalesce progress even when cloud-only assets cannot be fingerprinted.
                if offset.isMultiple(of: 32) || offset == uncached.count - 1 {
                    scannedCount = uncachedBase + offset + 1
                }
                if pending.count >= 32 {
                    // Mark checked before the match round trip so a cell's published state
                    // reads "known: no match" as soon as it publishes, instead of the stale
                    // "not checked" it would show if `checked` only updated afterward.
                    matches.markChecked(pending.keys)
                    await saveMatches(await matches.registerBatch(pending))
                    guard generation == token else { return }
                    checked.formUnion(pending.keys)
                    pending = [:]
                }
                await Task.yield()
            }
            if !pending.isEmpty {
                matches.markChecked(pending.keys)
                await saveMatches(await matches.registerBatch(pending))
                guard generation == token else { return }
                checked.formUnion(pending.keys)
            }
        }
    }

    /// The sweep looks up a `PHAsset` by the identifier its scheduler ordered, without owning a
    /// second copy of the index.
    func asset(for localIdentifier: String) -> PHAsset? { index.asset(for: localIdentifier) }

    /// `degraded` fires (possibly more than once) with a fast, low-resolution frame before the
    /// final image resolves, so a cell can show it immediately instead of a blank tile.
    func thumbnail(
        _ asset: PHAsset, matches: PhotoMatchStore, degraded: ((CGImage) -> Void)? = nil
    ) async throws -> CGImage {
        let token = generation
        let id = asset.localIdentifier
        guard isParticipating else {
            let image = try await loadImage(asset, degraded: degraded)
            if generation == token {
                thumbnails.setObject(
                    ImageBox(image), forKey: id as NSString, cost: image.bytesPerRow * image.height)
            }
            return image
        }
        if !matches.hasKnownResult(for: id) { matches.markChecking(for: id) }
        do {
            let image = try await loadImage(asset, degraded: degraded)
            guard generation == token else { throw CancellationError() }
            thumbnails.setObject(
                ImageBox(image), forKey: id as NSString, cost: image.bytesPerRow * image.height)
            guard analysisStore != nil else {
                matches.markUnavailable(for: id, message: "Local hash cache is unavailable")
                return image
            }
            let hashed = try await query(asset)
            guard generation == token else { throw CancellationError() }
            // A persistent cached hash is not evidence that this in-memory index has checked it.
            // register deduplicates identical queries; neither this nor inspection repairs hashes.
            matches.markChecked([id])
            await matches.register(id: id, query: hashed)
            guard generation == token else { throw CancellationError() }
            checked.insert(id)
            return image
        } catch is CancellationError {
            if generation == token { matches.markCheckCancelled(for: id) }
            throw CancellationError()
        } catch {
            if generation == token {
                matches.markUnavailable(for: id, message: error.localizedDescription)
                if !PhotoLibraryFailure.isCloudUnavailable(error) {
                    Diagnostics.report(error, context: "photos.match.prepare")
                }
            }
            throw error
        }
    }

    private func loadImage(_ asset: PHAsset, degraded: ((CGImage) -> Void)?) async throws -> CGImage {
        let id = asset.localIdentifier
        if let box = thumbnails.object(forKey: id as NSString) { return box.image }
        if let task = visibleWork[id] { return try await task.value }
        let token = generation
        let task = Task {
            let stream = await PhotoLibraryIO.shared.thumbnails(for: asset)
            var last: CGImage?
            for try await frame in stream {
                last = frame
                degraded?(frame)
            }
            guard let last else { throw PhotoLibraryFailure.cloudUnavailable }
            return last
        }
        visibleWork[id] = task
        defer { if generation == token { visibleWork[id] = nil } }
        return try await task.value
    }

    func selection(_ ids: [String]) async throws -> [PhotoSelectionItem] {
        var items: [PhotoSelectionItem] = []
        selectionProgress = 0
        for (offset, id) in ids.enumerated() {
            try Task.checkCancellation()
            guard let asset = index.asset(for: id) else { continue }
            // Explicit selection may retrieve iCloud data; the grid and scan never do.
            let image = try await PhotoLibraryIO.shared.thumbnail(for: asset, network: true) {
                [weak self] fraction in
                Task { @MainActor in
                    self?.selectionProgress = (Double(offset) + fraction) / Double(max(1, ids.count))
                }
            }
            selectionProgress = Double(offset + 1) / Double(max(1, ids.count))
            items.append(PhotoSelectionItem(asset: asset, preview: image))
        }
        return items
    }

    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            pendingLibraryChanges.append(changeInstance)
            libraryChangeTask?.cancel()
            // Leave the scan running while iCloud sends bursts of library changes; with no
            // active Photos tab the queue simply waits for `resume`.
            libraryChangeTask = Task { [weak self] in
                do { try await Task.sleep(for: .milliseconds(750)) } catch { return }
                guard let self, !Task.isCancelled, let (matches, client) = clients.values.first else {
                    return
                }
                libraryChangeTask = nil
                await self.applyLibraryChanges(matches: matches, client: client)
            }
        }
    }

    /// Applies queued PhotoKit changes as deltas into `index` instead of a full `refresh()`, so an
    /// iCloud sync burst on a 90k-photo library does not repeatedly reload everything. A change
    /// that does not touch the image fetch (an album edit) is a no-op; one PhotoKit cannot diff,
    /// or a queue too long to be worth replaying, falls back to a full `refresh()`.
    private func applyLibraryChanges(matches: PhotoMatchStore, client: CubbyClient) async {
        let changes = pendingLibraryChanges
        pendingLibraryChanges = []
        // Mid-load, `index` is still being filled from the load's own snapshot: a delta applied
        // now would be overwritten (removed assets re-appended by later batches), so restart.
        guard !isLoadingLibrary, var current = fetchResult, changes.count <= 200 else {
            await refresh(matches: matches, client: client)
            return
        }
        let token = generation
        var applied = false
        var invalidatedIDs: [String] = []
        for change in changes {
            guard let details = change.changeDetails(for: current) else { continue }
            guard details.hasIncrementalChanges else {
                await refresh(matches: matches, client: client)
                return
            }
            for asset in details.changedObjects + details.removedObjects {
                thumbnails.removeObject(forKey: asset.localIdentifier as NSString)
                checked.remove(asset.localIdentifier)
                deferredCloudIDs.remove(asset.localIdentifier)
                invalidatedIDs.append(asset.localIdentifier)
            }
            let removedIDs = Set(details.removedObjects.map(\.localIdentifier))
            selectedIDs.removeAll { removedIDs.contains($0) }
            index.apply(
                removed: details.removedObjects, inserted: details.insertedObjects,
                changed: details.changedObjects)
            current = details.fetchResultAfterChanges
            applied = true
        }
        fetchResult = current
        guard applied else { return }
        try? await analysisStore?.clearDeferredCloudHashes(invalidatedIDs)
        guard generation == token, !Task.isCancelled else { return }
        count = index.count
        totalAssetCount = index.count
        publishMonths()
        guard isParticipating, let analysisStore else { return }
        do {
            try await analysisStore.pruneMissing(Set(index.assetsByID.keys))
        } catch {
            Diagnostics.report(error, context: "photos.analysisStore.prune")
        }
        guard generation == token, !Task.isCancelled else { return }
        // Re-arm the scan for whatever is still unchecked (the newly inserted/changed assets,
        // plus anything a prior scan hadn't reached yet) rather than only the delta itself — a
        // changed asset's `checked` entry was already cleared above.
        let remaining = months.flatMap(\.assets).filter {
            !checked.contains($0.localIdentifier) && !deferredCloudIDs.contains($0.localIdentifier)
        }
        startScan(remaining: remaining, matches: matches, token: token)
    }

    /// `preloaded` — from a batch `PhotoAnalysisStore.hashes(for:)` read — skips the per-id store
    /// round trip entirely when it is present and still valid; the scan loop always supplies it,
    /// the single-cell `thumbnail(_:matches:degraded:)` path never does.
    private func query(
        _ asset: PHAsset, preloaded: PhotoHashRecord? = nil
    ) async throws -> HashQuery {
        let token = generation
        let id = asset.localIdentifier
        guard let analysisStore else { throw CancellationError() }
        let hash: PerceptualHash64
        if let preloaded, Self.isCurrent(preloaded, for: asset) {
            hash = preloaded.perceptualHash
        } else if preloaded == nil,
            let cached = try? await analysisStore.hash(for: id, modificationDate: asset.modificationDate)
        {
            hash = cached
        } else {
            // Fingerprints use an independent final-quality, full-frame request. Grid cache
            // entries must never become canonical hashes if display sizing/cropping changes.
            let source = try await PhotoLibraryIO.shared.thumbnail(for: asset, network: false)
            hash = try await Task.detached(priority: .utility) { try PerceptualHash64.compute(source) }.value
            try? await analysisStore.upsertHash(
                localIdentifier: id, modificationDate: asset.modificationDate, perceptualHash: hash)
        }
        guard !Task.isCancelled, generation == token else { throw CancellationError() }
        deferredCloudIDs.remove(id)
        return Self.hashQuery(for: asset, hash: hash)
    }

    private static func isCurrent(_ record: PhotoHashRecord, for asset: PHAsset) -> Bool {
        record.hashRevision == PerceptualHash64.algorithmRevision
            && record.modificationDate == asset.modificationDate
    }

    private static func hashQuery(for asset: PHAsset, hash: PerceptualHash64) -> HashQuery {
        let ratio =
            Double(max(asset.pixelWidth, asset.pixelHeight))
            / Double(max(1, min(asset.pixelWidth, asset.pixelHeight)))
        return HashQuery(
            perceptualHash: hash, aspectRatio: ratio,
            sourceFingerprint: SourceFingerprint(hash: hash, aspectRatio: ratio))
    }

    private func stopWork() {
        libraryChangeTask?.cancel(); libraryChangeTask = nil
        generation = UUID()
        analysisBadgeMonths = []
        loadingAnalysisBadgeMonths = []
        scanTask?.cancel(); scanTask = nil
        for task in visibleWork.values { task.cancel() }
        visibleWork = [:]
        isScanning = false
        isLoadingLibrary = false
        scannedCount = 0
    }

    /// PhotoKit's fetch result is enumerated off the UI actor. The stream publishes 200 assets at
    /// a time so the main actor can render between batches instead of receiving one giant array.
    /// `fetchResult` rides along on the first batch only — it is what `photoLibraryDidChange`
    /// later diffs against instead of forcing a full reload.
    private struct AssetBatch: @unchecked Sendable {
        // `@unchecked Sendable`: `PHFetchResult`/`PHAsset` are not themselves annotated
        // `Sendable` in this SDK, but Apple documents both as safe to use from any thread — this
        // batch is produced once on a detached task and handed to a single `AsyncStream`
        // consumer, never mutated or read concurrently.
        let assets: [PHAsset]
        let totalCount: Int?
        let fetchResult: PHFetchResult<PHAsset>?
    }

    private static func assetBatches() -> AsyncStream<AssetBatch> {
        AsyncStream { continuation in
            let producer = Task.detached(priority: .userInitiated) {
                let options = PHFetchOptions()
                options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
                let fetched = PHAsset.fetchAssets(with: .image, options: options)
                let totalCount = fetched.count
                var batch: [PHAsset] = []
                var isFirstBatch = true
                fetched.enumerateObjects { asset, _, stop in
                    guard !Task.isCancelled else { stop.pointee = true; return }
                    batch.append(asset)
                    if batch.count == 200 {
                        continuation.yield(
                            AssetBatch(
                                assets: batch, totalCount: isFirstBatch ? totalCount : nil,
                                fetchResult: isFirstBatch ? fetched : nil))
                        isFirstBatch = false
                        batch.removeAll(keepingCapacity: true)
                    }
                }
                if !batch.isEmpty, !Task.isCancelled {
                    continuation.yield(
                        AssetBatch(
                            assets: batch, totalCount: isFirstBatch ? totalCount : nil,
                            fetchResult: isFirstBatch ? fetched : nil))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in producer.cancel() }
        }
    }
}

extension PHAsset: PhotoMonthAsset {}

private final class ImageBox {
    let image: CGImage
    init(_ image: CGImage) { self.image = image }
}
