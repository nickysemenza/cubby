import CoreGraphics
import CubbyKit
import Foundation
import Observation

/// Screen state for Identify: builds (or reuses) an on-device `FeaturePrintIndex` of the
/// household's product covers, then ranks a photo against it. Created per client, so a base URL
/// change gets a fresh one — mirrors `CaptureModel`.
///
/// `phase` doubles as the status for both the index build and the most recent ranking attempt:
/// there is only one thing on this screen that can fail, and the failure message is always shown
/// alongside it, so a second error field would just be two places to check instead of one.
@Observable
final class IdentifyModel {
    enum Phase: Equatable {
        case idle
        case indexing(done: Int, total: Int)
        case ready(count: Int)
        case failed(String)
    }

    /// How many product covers to index, most recently created first — matches the `cubby
    /// identify` CLI's default order so the on-device and CLI indexes agree when both are built
    /// from the same household.
    let maxProducts = 300

    private(set) var phase: Phase = .idle
    private(set) var candidates: [IdentificationCandidate] = []
    var probe: CGImage?

    var isIndexing: Bool {
        switch phase {
        case .idle, .indexing: true
        case .ready, .failed: false
        }
    }

    var canIdentify: Bool {
        if case .ready = phase { return true }
        return false
    }

    private let index: FeaturePrintIndex
    private let client: CubbyClient

    init(client: CubbyClient, index: FeaturePrintIndex = FeaturePrintIndex()) {
        self.client = client
        self.index = index
    }

    /// Loads the disk cache if one exists; otherwise builds the index from scratch. Safe to call
    /// repeatedly (e.g. from `.task(id:)` re-running) since a populated cache short-circuits.
    func prepare() async {
        guard phase == .idle else { return }
        phase = .indexing(done: 0, total: 0)
        let cached = (try? await index.loadCache()) ?? 0
        if cached > 0 {
            phase = .ready(count: cached)
            if let probe { await identify(probe) }
        } else {
            await buildIndex()
        }
    }

    /// Discards the cache and rebuilds from the current product list.
    func rebuild() async {
        guard !isIndexing else { return }
        phase = .indexing(done: 0, total: 0)
        candidates = []
        await index.clear()
        await buildIndex()
    }

    /// Ranks `image` against the index and stores both the probe and the result, so the view can
    /// show what was searched alongside what matched.
    func identify(_ image: CGImage) async {
        probe = image
        candidates = []
        guard canIdentify else { return }
        do {
            let ranked = try await index.rank(image, limit: 5)
            guard canIdentify, probe === image else { return }
            candidates = ranked
        } catch {
            guard canIdentify, probe === image else { return }
            candidates = []
            phase = .failed(error.userMessage)
            Diagnostics.report(error, context: "identify.rank")
        }
    }

    /// Mirrors `IdentifyCommand`'s CLI build: list rows carry no image URLs (the projection omits
    /// them), so page through the ids of products that have one, then fetch each detail for its
    /// cover with bounded concurrency.
    private func buildIndex() async {
        phase = .indexing(done: 0, total: 0)
        candidates = []
        do {
            let client = self.client
            let targetIDs = try await ListPage.collectAll(limit: maxProducts, pageSize: 100) { page, size in
                try await client.productIDsWithImages(page: page, pageSize: size)
            }

            let products = await withTaskGroup(of: ProductDetail?.self, returning: [ProductDetail].self) {
                group in
                var iterator = targetIDs.makeIterator()
                func enqueue() {
                    guard let id = iterator.next() else { return }
                    group.addTask {
                        try? await client.product(id)
                    }
                }
                for _ in 0..<6 { enqueue() }
                var collected: [ProductDetail] = []
                for await result in group {
                    if let result { collected.append(result) }
                    enqueue()
                }
                return collected
            }

            // Await the MainActor update so queued progress cannot overwrite the final ready state.
            await index.build(from: products, concurrency: 6) { done, total in
                await MainActor.run {
                    self.phase = .indexing(done: done, total: total)
                }
            }
            try await index.saveCache()
            let count = await index.count
            phase = .ready(count: count)
            if let probe { await identify(probe) }
        } catch {
            phase = .failed(error.userMessage)
            Diagnostics.report(error, context: "identify.buildIndex")
        }
    }
}
