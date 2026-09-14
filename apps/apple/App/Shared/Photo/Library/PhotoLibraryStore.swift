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
    private(set) var count = 0
    private(set) var checked: Set<String> = []
    private(set) var isScanning = false
    private(set) var error: String?
    private(set) var selectionProgress: Double = 0
    var selectedIDs: [String] = []
    var scrollID: String?

    @ObservationIgnored private let cache = LibraryHashCache()
    @ObservationIgnored private let thumbnails = NSCache<NSString, ImageBox>()
    @ObservationIgnored private var scanTask: Task<Void, Never>?
    @ObservationIgnored private var visibleWork: [String: Task<CGImage, any Error>] = [:]
    @ObservationIgnored private var assetsByID: [String: PHAsset] = [:]
    @ObservationIgnored private var clients: [UUID: (PhotoMatchStore, CubbyClient)] = [:]
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var observing = false
    var hasFullAccess: Bool { authorization == .authorized }

    override init() {
        super.init()
        thumbnails.totalCostLimit = 24 * 1024 * 1024
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
            Task { await flush() }
        }
    }

    func reset() {
        stopWork()
        for (id, pair) in clients { pair.0.release(id) }
        if observing { PHPhotoLibrary.shared().unregisterChangeObserver(self); observing = false }
        clients = [:]; checked = []
        selectedIDs = []; scrollID = nil; months = []; assetsByID = [:]
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
        authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        await matches.refresh(client: client)
        guard generation == token, !Task.isCancelled else { return }
        guard hasFullAccess else {
            months = []; count = 0; checked = []; selectedIDs = []; assetsByID = [:]
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
            try await cache.prune(to: Set(assetsByID.keys))
        } catch {
            Diagnostics.report(error, context: "photos.cache.prune")
        }
        guard generation == token, !Task.isCancelled else { return }
        checked.formIntersection(assetsByID.keys)
        selectedIDs.removeAll { assetsByID[$0] == nil }
        months = grouped.keys.sorted(by: >).map { Month(id: $0, assets: grouped[$0]!) }
        count = result.count
        scanTask = Task { [weak self] in
            guard let self else { return }
            guard !Task.isCancelled, generation == token else { return }
            isScanning = true
            defer { if generation == token { isScanning = false } }
            // Let visible cells enqueue their user-initiated requests before the utility scan.
            try? await Task.sleep(for: .milliseconds(150))
            var pending: [String: HashQuery] = [:]
            for asset in result {
                guard !Task.isCancelled, generation == token else { return }
                do { pending[asset.localIdentifier] = try await query(asset) } catch is CancellationError {
                    return
                } catch { /* Cloud-only assets remain unknown until explicitly selected. */  }
                if pending.count >= 32 {
                    await matches.registerBatch(pending)
                    guard generation == token else { return }
                    checked.formUnion(pending.keys)
                    pending = [:]
                }
                await Task.yield()
            }
            if !pending.isEmpty {
                await matches.registerBatch(pending)
                guard generation == token else { return }
                checked.formUnion(pending.keys)
            }
            await flush()
        }
    }

    func thumbnail(_ asset: PHAsset, matches: PhotoMatchStore) async throws -> CGImage {
        let token = generation
        let image = try await loadImage(asset)
        guard generation == token else { throw CancellationError() }
        thumbnails.setObject(
            ImageBox(image), forKey: asset.localIdentifier as NSString,
            cost: image.bytesPerRow * image.height)
        let query = try await query(asset, image: image)
        await matches.register(id: asset.localIdentifier, query: query)
        guard generation == token else { throw CancellationError() }
        checked.insert(asset.localIdentifier)
        return image
    }

    private func loadImage(_ asset: PHAsset) async throws -> CGImage {
        let id = asset.localIdentifier
        if let box = thumbnails.object(forKey: id as NSString) { return box.image }
        if let task = visibleWork[id] { return try await task.value }
        let token = generation
        let task = Task { try await PhotoLibraryIO.shared.thumbnail(for: asset) }
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
            guard let self, let (matches, client) = clients.values.first else { return }
            await refresh(matches: matches, client: client)
        }
    }

    private func query(_ asset: PHAsset, image: CGImage? = nil) async throws -> HashQuery {
        let token = generation
        let id = asset.localIdentifier
        let hash: PerceptualHash64
        if let cached = await cache.hash(forLocalIdentifier: id, modificationDate: asset.modificationDate) {
            hash = cached
        } else {
            let source: CGImage
            if let image { source = image } else { source = try await loadImage(asset) }
            hash = try await Task.detached(priority: .utility) { try PerceptualHash64.compute(source) }.value
            try await cache.store(hash, forLocalIdentifier: id, modificationDate: asset.modificationDate)
        }
        guard !Task.isCancelled, generation == token else { throw CancellationError() }
        let ratio =
            Double(max(asset.pixelWidth, asset.pixelHeight))
            / Double(max(1, min(asset.pixelWidth, asset.pixelHeight)))
        return HashQuery(
            perceptualHash: hash, aspectRatio: ratio,
            sourceFingerprint: SourceFingerprint(hash: hash, aspectRatio: ratio))
    }

    private func stopWork() {
        generation = UUID()
        scanTask?.cancel(); scanTask = nil
        for task in visibleWork.values { task.cancel() }
        visibleWork = [:]
        isScanning = false
    }

    private func flush() async {
        do { try await cache.flush() } catch { Diagnostics.report(error, context: "photos.cache.flush") }
    }
}

private final class ImageBox {
    let image: CGImage
    init(_ image: CGImage) { self.image = image }
}
