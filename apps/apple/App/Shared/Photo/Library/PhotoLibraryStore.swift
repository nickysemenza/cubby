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
    private(set) var months: [Month] = []
    /// Bumped every time `months` is replaced (a fresh load, an authorization change, or a
    /// PhotoKit library-change refresh). `PhotoClassificationSweep`'s candidate provider reads
    /// `months` but has no other way to know it changed — `PhotosRootView` reconciles the sweep
    /// on this so a sweep that saw zero candidates (tab opened before the library finished
    /// loading) actually starts once photos exist, and a finished sweep re-arms for new ones.
    private(set) var monthsRevision = 0
    private(set) var count = 0
    private(set) var checked: Set<String> = []
    private(set) var isScanning = false
    private(set) var isLoadingLibrary = false
    private(set) var scannedCount = 0
    private(set) var error: String?
    private(set) var selectionProgress: Double = 0
    var selectedIDs: [String] = []
    var scrollID: String?

    @ObservationIgnored private let analysisStore: PhotoAnalysisStore
    @ObservationIgnored private let thumbnails = NSCache<NSString, ImageBox>()
    @ObservationIgnored private var scanTask: Task<Void, Never>?
    @ObservationIgnored private var libraryChangeTask: Task<Void, Never>?
    @ObservationIgnored private var visibleWork: [String: Task<CGImage, any Error>] = [:]
    @ObservationIgnored private var assetsByID: [String: PHAsset] = [:]
    @ObservationIgnored private var clients: [UUID: (PhotoMatchStore, CubbyClient)] = [:]
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var observing = false
    var hasFullAccess: Bool { authorization == .authorized }

    var scanStatus: String {
        if isLoadingLibrary { return "Loading your photo library…" }
        if isScanning { return "Checking photo \(min(scannedCount + 1, count)) of \(count)…" }
        let unchecked = count - checked.count
        return unchecked > 0
            ? "\(checked.count) of \(count) library photos checked · \(unchecked) unchecked"
            : "\(count) library photos checked"
    }

    init(analysisStore: PhotoAnalysisStore) {
        self.analysisStore = analysisStore
        super.init()
        #if os(macOS)
            thumbnails.totalCostLimit = 64 * 1024 * 1024
        #else
            thumbnails.totalCostLimit = 24 * 1024 * 1024
        #endif
    }

    func activate(_ id: UUID, matches: PhotoMatchStore, client: CubbyClient) async {
        clients[id] = (matches, client)
        matches.acquire(id)
        await refresh(matches: matches, client: client)
    }

    func deactivate(_ id: UUID) {
        clients.removeValue(forKey: id)?.0.release(id)
        if clients.isEmpty {
            stopWork()
            if observing { PHPhotoLibrary.shared().unregisterChangeObserver(self); observing = false }
        }
    }

    func reset() {
        stopWork()
        for (id, pair) in clients { pair.0.release(id) }
        if observing { PHPhotoLibrary.shared().unregisterChangeObserver(self); observing = false }
        clients = [:]; checked = []
        selectedIDs = []; scrollID = nil; months = []; assetsByID = [:]
        monthsRevision += 1
        thumbnails.removeAllObjects()
        count = 0; isScanning = false
    }

    func requestAccess(matches: PhotoMatchStore, client: CubbyClient) async {
        authorization = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        await refresh(matches: matches, client: client)
    }

    func refresh(matches: PhotoMatchStore, client: CubbyClient) async {
        stopWork()
        let token = generation
        defer { if generation == token { isLoadingLibrary = false } }
        authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        // Do not make the local Photos grid wait for the remote Cubby index. A stalled or slow
        // index request otherwise leaves the authorized screen showing an empty grid and
        // "Cubby has not been checked" indefinitely, even though PhotoKit is ready to load.
        isLoadingLibrary = true
        async let matchRefresh: Void = matches.refresh(client: client)
        guard generation == token, !Task.isCancelled else { return }
        guard hasFullAccess else {
            months = []; monthsRevision += 1
            count = 0; checked = []; selectedIDs = []; assetsByID = [:]
            thumbnails.removeAllObjects()
            if observing { PHPhotoLibrary.shared().unregisterChangeObserver(self); observing = false }
            return
        }
        if !observing { PHPhotoLibrary.shared().register(self); observing = true }
        let result = await Task.detached(priority: .userInitiated) {
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            let fetched = PHAsset.fetchAssets(with: .image, options: options)
            var assets: [PHAsset] = []
            fetched.enumerateObjects { asset, _, _ in assets.append(asset) }
            return assets
        }.value
        guard generation == token else { return }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .current
        var grouped: [Date: [PHAsset]] = [:]
        for asset in result {
            let month =
                asset.creationDate.flatMap { date in
                    calendar.date(from: calendar.dateComponents([.year, .month], from: date))
                } ?? .distantPast
            grouped[month, default: []].append(asset)
            if let old = assetsByID[asset.localIdentifier], old.modificationDate != asset.modificationDate {
                thumbnails.removeObject(forKey: asset.localIdentifier as NSString)
                checked.remove(asset.localIdentifier)
            }
        }
        assetsByID = Dictionary(uniqueKeysWithValues: result.map { ($0.localIdentifier, $0) })
        do {
            try await analysisStore.pruneMissing(Set(assetsByID.keys))
        } catch {
            Diagnostics.report(error, context: "photos.analysisStore.prune")
        }
        guard generation == token, !Task.isCancelled else { return }
        checked.formIntersection(assetsByID.keys)
        selectedIDs.removeAll { assetsByID[$0] == nil }
        months = grouped.keys.sorted(by: >).map { Month(id: $0, assets: grouped[$0]!) }
        monthsRevision += 1
        count = result.count
        isLoadingLibrary = false
        await matchRefresh
        guard generation == token, !Task.isCancelled else { return }
        // One batch read for the whole library's dot status, rather than a fetch per cell; the
        // sweep republishes individual ids afterward as it classifies them.
        if let snapshots = try? await analysisStore.snapshots(for: Array(assetsByID.keys)) {
            matches.markAnalysis(snapshots)
        }
        let remaining = result.filter { !checked.contains($0.localIdentifier) }
        let completedCount = result.count - remaining.count
        scannedCount = completedCount
        scanTask = Task { [weak self] in
            guard let self else { return }
            guard !Task.isCancelled, generation == token else { return }
            isScanning = true
            defer { if generation == token { isScanning = false } }
            // Let visible cells enqueue their user-initiated requests before the utility scan.
            try? await Task.sleep(for: .milliseconds(150))
            // One batch read for the whole remaining set instead of one actor round trip per
            // asset — `query(_:preloaded:)` only falls back to a per-id store read when an asset
            // is missing from this snapshot (e.g. newly added mid-scan).
            let preloadedHashes =
                (try? await analysisStore.hashes(for: remaining.map(\.localIdentifier))) ?? [:]
            var pending: [String: HashQuery] = [:]
            for (offset, asset) in remaining.enumerated() {
                guard !Task.isCancelled, generation == token else { return }
                // Visible cells may finish work after this scan's snapshot was taken.
                if checked.contains(asset.localIdentifier) { continue }
                do {
                    pending[asset.localIdentifier] =
                        try await query(asset, preloaded: preloadedHashes[asset.localIdentifier]).query
                } catch is CancellationError {
                    return
                } catch { /* Cloud-only assets remain unknown until explicitly selected. */  }
                // Coalesce progress even when cloud-only assets cannot be fingerprinted.
                if offset.isMultiple(of: 32) || offset == remaining.count - 1 {
                    scannedCount = completedCount + offset + 1
                }
                if pending.count >= 32 {
                    // Mark checked before the match round trip so a cell's published state
                    // reads "known: no match" as soon as it publishes, instead of the stale
                    // "not checked" it would show if `checked` only updated afterward.
                    matches.markChecked(pending.keys)
                    await matches.registerBatch(pending)
                    guard generation == token else { return }
                    checked.formUnion(pending.keys)
                    pending = [:]
                }
                await Task.yield()
            }
            if !pending.isEmpty {
                matches.markChecked(pending.keys)
                await matches.registerBatch(pending)
                guard generation == token else { return }
                checked.formUnion(pending.keys)
            }
        }
    }

    /// The sweep looks up a `PHAsset` by the identifier its scheduler ordered, without owning a
    /// second copy of `assetsByID`.
    func asset(for localIdentifier: String) -> PHAsset? { assetsByID[localIdentifier] }

    /// `degraded` fires (possibly more than once) with a fast, low-resolution frame before the
    /// final image resolves, so a cell can show it immediately instead of a blank tile.
    func thumbnail(
        _ asset: PHAsset, matches: PhotoMatchStore, degraded: ((CGImage) -> Void)? = nil
    ) async throws -> CGImage {
        let token = generation
        let image = try await loadImage(asset, degraded: degraded)
        guard generation == token else { throw CancellationError() }
        thumbnails.setObject(
            ImageBox(image), forKey: asset.localIdentifier as NSString,
            cost: image.bytesPerRow * image.height)
        let hashed = try await query(asset)
        // A cell re-executes this `.task` every time it reappears (e.g. scrolled back into
        // view), but `query(_:)` only recomputes the hash the first time this asset's current
        // modification date is seen. Re-registering an already-known hash re-triggers a full
        // match recompute (and every cell's cell-state republish) for no new information, so
        // skip it once the hash itself is nothing new.
        if hashed.isNew {
            matches.markChecked([asset.localIdentifier])
            await matches.register(id: asset.localIdentifier, query: hashed.query)
        }
        guard generation == token else { throw CancellationError() }
        checked.insert(asset.localIdentifier)
        return image
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
            guard let asset = assetsByID[id] else { continue }
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
            libraryChangeTask?.cancel()
            // Leave the scan running while iCloud sends bursts of library changes.
            libraryChangeTask = Task { [weak self] in
                do { try await Task.sleep(for: .milliseconds(750)) } catch { return }
                guard let self, !Task.isCancelled, let (matches, client) = clients.values.first else {
                    return
                }
                libraryChangeTask = nil
                await refresh(matches: matches, client: client)
            }
        }
    }

    /// `isNew` is false when `hash` came from the store (this exact modification date was already
    /// fingerprinted, in this session or an earlier one) rather than being computed just now.
    /// `preloaded` — from a batch `PhotoAnalysisStore.hashes(for:)` read — skips the per-id store
    /// round trip entirely when it is present and still valid; the scan loop always supplies it,
    /// the single-cell `thumbnail(_:matches:degraded:)` path never does.
    private func query(
        _ asset: PHAsset, preloaded: PhotoHashRecord? = nil
    ) async throws -> (query: HashQuery, isNew: Bool) {
        let token = generation
        let id = asset.localIdentifier
        let hash: PerceptualHash64
        let isNew: Bool
        if let preloaded, preloaded.hashRevision == PerceptualHash64.algorithmRevision,
            preloaded.modificationDate == asset.modificationDate
        {
            hash = preloaded.perceptualHash
            isNew = false
        } else if preloaded == nil,
            let cached = try? await analysisStore.hash(for: id, modificationDate: asset.modificationDate)
        {
            hash = cached
            isNew = false
        } else {
            // Fingerprints use an independent final-quality, full-frame request. Grid cache
            // entries must never become canonical hashes if display sizing/cropping changes.
            let source = try await PhotoLibraryIO.shared.thumbnail(for: asset, network: false)
            hash = try await Task.detached(priority: .utility) { try PerceptualHash64.compute(source) }.value
            try? await analysisStore.upsertHash(
                localIdentifier: id, modificationDate: asset.modificationDate, perceptualHash: hash)
            isNew = true
        }
        guard !Task.isCancelled, generation == token else { throw CancellationError() }
        let ratio =
            Double(max(asset.pixelWidth, asset.pixelHeight))
            / Double(max(1, min(asset.pixelWidth, asset.pixelHeight)))
        return (
            HashQuery(
                perceptualHash: hash, aspectRatio: ratio,
                sourceFingerprint: SourceFingerprint(hash: hash, aspectRatio: ratio)),
            isNew
        )
    }

    private func stopWork() {
        libraryChangeTask?.cancel(); libraryChangeTask = nil
        generation = UUID()
        scanTask?.cancel(); scanTask = nil
        for task in visibleWork.values { task.cancel() }
        visibleWork = [:]
        isScanning = false
        isLoadingLibrary = false
        scannedCount = 0
    }
}

private final class ImageBox {
    let image: CGImage
    init(_ image: CGImage) { self.image = image }
}
