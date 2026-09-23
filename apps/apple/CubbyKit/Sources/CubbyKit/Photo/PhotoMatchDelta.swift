import Foundation

/// Brings a photo's previously computed match result up to date with a changed hash index without
/// re-matching it against every entry: only entries added or changed since the result was
/// computed are matched, and candidates for changed or removed entries are dropped first.
///
/// Idempotent — applying a change to a result already computed against the current index yields
/// the same result — so a result saved before or after the index snapshot was persisted, or a
/// change applied twice after a crash, converges on the full-match answer.
public struct PhotoMatchDelta: Sendable {
    /// Entries whose candidates must be recomputed: added, or whose `matchDigest` differs.
    public let changed: [ImageHashEntry]
    /// Every entry id whose old candidates are stale: `changed` plus entries no longer indexed.
    public let affectedIDs: Set<ImageCode>
    private let changedIndex: HashIndex

    public var isEmpty: Bool { affectedIDs.isEmpty }

    /// `previous` is the digest snapshot the stored results reflect (empty on a first run, which
    /// makes every current entry `changed`).
    public init(previous: [ImageCode: UInt64], current: [ImageHashEntry]) throws {
        let changed = current.filter { previous[$0.id] != $0.matchDigest }
        let currentIDs = Set(current.map(\.id))
        let removed = previous.keys.filter { !currentIDs.contains($0) }
        self.changed = changed
        affectedIDs = Set(changed.map(\.id)).union(removed)
        changedIndex = try HashIndex(entries: changed)
    }

    public func apply(to stored: [DedupCandidate], query: HashQuery) -> [DedupCandidate] {
        guard !isEmpty else { return stored }
        let kept = stored.filter { !affectedIDs.contains($0.id) }
        // `kept` and the fresh candidates never share an id: every changed id is in
        // `affectedIDs`, so concatenating needs no best-per-key merge, only the shared ranking.
        return HashIndex.ranked(kept + changedIndex.candidates(for: query))
    }
}
