import Foundation
import Observation

/// The serialized, location-anchored queue every scanning flow drains through.
///
/// Extracted from `ScanSession` so the audit's bin pass shares its two load-bearing invariants
/// instead of re-implementing them:
///
/// **Serialization.** The camera keeps firing while a lookup is in flight, and the same-code
/// debounce only compares the last raw value, so two encodings of one product would both observe
/// "not stocked here" if run concurrently. Reads drain one at a time in the order they were read.
///
/// **Anchoring.** Every read carries the location it was read at. `reset()` empties the queue but
/// cannot abort work in flight, so an outcome whose anchor is no longer the current one is
/// discarded outright, and its pending decrement with it (`reset()` already zeroed the count).
///
/// The drain owns no domain state: `work` turns a read into an `Outcome` (a scan result, a
/// classification failure, anything `Sendable`), and `onSettle` receives it on the main actor
/// only when the anchor still matches.
@MainActor
@Observable
public final class ScanDrain<Outcome: Sendable> {
    public typealias Work = @MainActor (ScanRead) async -> Outcome
    public typealias Settle = @MainActor (_ token: UUID, _ outcome: Outcome) -> Void

    public private(set) var pendingCount = 0

    /// The location reads are anchored to. Changing it empties the queue.
    public var anchor: LocationCode? {
        didSet { if anchor != oldValue { reset() } }
    }

    /// Called for every outcome that survives the anchor gate. Set after construction so the
    /// owner can capture itself weakly.
    public var onSettle: Settle = { _, _ in }

    private let work: Work
    private let debounceInterval: TimeInterval
    private var queue: [(read: ScanRead, token: UUID)] = []
    private var draining = false
    private var lastAccepted: (raw: String, at: Date)?

    public init(anchor: LocationCode? = nil, debounceInterval: TimeInterval = 1.5, work: @escaping Work) {
        self.anchor = anchor
        self.debounceInterval = debounceInterval
        self.work = work
    }

    /// Queues a raw scanner or keyboard value. Returns the token the outcome will settle under,
    /// or `nil` when there is no anchor or the value is a debounced repeat of the last one.
    @discardableResult
    public func submit(_ raw: String, at date: Date = .now) -> UUID? {
        guard let anchor else { return nil }
        if let last = lastAccepted, last.raw == raw, date.timeIntervalSince(last.at) < debounceInterval {
            return nil
        }
        lastAccepted = (raw, date)
        let token = UUID()
        pendingCount += 1
        queue.append((ScanRead(raw: raw, anchor: anchor, at: date), token))
        Task { await drain() }
        return token
    }

    /// Drops everything queued and forgets the debounce state. Work in flight finishes, but its
    /// outcome only settles if the anchor it was read at is still current.
    public func reset() {
        queue.removeAll()
        pendingCount = 0
        lastAccepted = nil
    }

    private func drain() async {
        if draining { return }
        draining = true
        defer { draining = false }
        while !queue.isEmpty {
            let (read, token) = queue.removeFirst()
            let outcome = await work(read)
            guard read.anchor == anchor else { continue }
            onSettle(token, outcome)
            pendingCount = max(0, pendingCount - 1)
        }
    }
}
