import Foundation

/// A minimal PHAsset shape so `PhotoMonthIndex` can be exercised with a fake in tests — PHAsset
/// cannot be constructed outside PhotoKit. `PHAsset`'s own conformance lives beside
/// `PhotoLibraryStore` (`PhotoLibraryStore.swift`), the only production caller.
protocol PhotoMonthAsset {
    var localIdentifier: String { get }
    var creationDate: Date? { get }
}

/// The month-grouped photo index `PhotoLibraryStore` keeps in memory for the app's lifetime.
/// Pulled out of `PhotoLibraryStore.refresh()` — which used to rebuild `assetsByID` and the whole
/// month grouping from every asset loaded so far on *every* 200-asset batch (quadratic in library
/// size) — so `append` is O(batch size) and `apply` (a PhotoKit change) is O(changed assets).
struct PhotoMonthIndex<Asset: PhotoMonthAsset> {
    private(set) var assetsByID: [String: Asset] = [:]
    private var grouped: [Date: [Asset]] = [:]
    private var calendar: Calendar

    init(
        calendar: Calendar = {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = .current
            return calendar
        }()
    ) {
        self.calendar = calendar
    }

    var count: Int { assetsByID.count }

    func asset(for localIdentifier: String) -> Asset? { assetsByID[localIdentifier] }

    /// O(batch size): adds a freshly-fetched batch without touching any asset already indexed.
    mutating func append(_ batch: some Sequence<Asset>) {
        for asset in batch { insert(asset) }
    }

    /// Applies a PhotoKit `PHFetchResultChangeDetails` delta. `changed` assets are removed and
    /// reinserted rather than updated in place — their `creationDate` may have moved them to a
    /// different month, and removing the stale copy first means a changed asset that becomes the
    /// last one in its old month correctly drops that month.
    mutating func apply(
        removed: some Sequence<Asset>, inserted: some Sequence<Asset>, changed: some Sequence<Asset>
    ) {
        for asset in removed { remove(id: asset.localIdentifier) }
        for asset in changed { remove(id: asset.localIdentifier) }
        for asset in changed { insert(asset) }
        for asset in inserted { insert(asset) }
    }

    /// Newest month first; assets within a month newest first (undated assets sort last). Sorted
    /// on read rather than kept sorted on every write — batches arrive from PhotoKit already in
    /// this order, so the common case (`append`) is a no-op sort, and `apply`'s deltas touch only
    /// a handful of assets, cheaper to resort here than to maintain an exact insertion point for.
    var months: [(id: Date, assets: [Asset])] {
        grouped.keys.sorted(by: >).map { key in
            (id: key, assets: grouped[key]!.sorted(by: newestFirst))
        }
    }

    private func newestFirst(_ lhs: Asset, _ rhs: Asset) -> Bool {
        switch (lhs.creationDate, rhs.creationDate) {
        case let (lhsDate?, rhsDate?): return lhsDate > rhsDate
        case (nil, nil): return false
        case (nil, _): return false
        case (_, nil): return true
        }
    }

    private mutating func insert(_ asset: Asset) {
        grouped[monthKey(for: asset), default: []].append(asset)
        assetsByID[asset.localIdentifier] = asset
    }

    private mutating func remove(id: String) {
        guard let existing = assetsByID.removeValue(forKey: id) else { return }
        let key = monthKey(for: existing)
        grouped[key]?.removeAll { $0.localIdentifier == id }
        if grouped[key]?.isEmpty == true { grouped.removeValue(forKey: key) }
    }

    private func monthKey(for asset: Asset) -> Date {
        asset.creationDate.flatMap { date in
            calendar.date(from: calendar.dateComponents([.year, .month], from: date))
        } ?? .distantPast
    }
}
