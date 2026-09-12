import CubbyKit
import Foundation
import Observation

/// The products-without-a-photo backlog, one at a time. Rows come from the generic product list
/// with `imagePresenceFilter: "none"`; skipping is local and never written.
@Observable
final class NeedsPhotoModel {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var queue: [EntityRow] = []
    private(set) var total: Int?
    private(set) var skipped = 0
    private(set) var added = 0

    private let client: CubbyClient
    private let locationID: LocationCode?
    private let pageSize = 50

    init(client: CubbyClient, locationID: LocationCode?) {
        self.client = client
        self.locationID = locationID
    }

    var current: EntityRow? { queue.first }
    var remaining: Int { queue.count }

    func load() async {
        phase = .loading
        do {
            let page = try await client.productsMissingImages(page: 1, pageSize: pageSize, at: locationID)
            queue = page.items
            total = page.meta.totalCount
            phase = .ready
        } catch let error as CubbyAPIError {
            phase = .failed(error.detail?.message ?? "HTTP \(error.status)")
        } catch {
            phase = .failed(String(describing: error))
        }
    }

    func skip() {
        guard !queue.isEmpty else { return }
        queue.removeFirst()
        skipped += 1
    }

    /// Called when a photo landed on the current product: it no longer belongs in the queue.
    func photoAdded() {
        guard !queue.isEmpty else { return }
        queue.removeFirst()
        added += 1
        if let total { self.total = max(0, total - 1) }
    }
}
