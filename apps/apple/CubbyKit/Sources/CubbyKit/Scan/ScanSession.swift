import Foundation
import Observation

/// The server calls a sweep needs. `CubbyClient` conforms; tests stub it.
public protocol ScanService: Sendable {
    func scan(_ code: ScanCode, at location: LocationCode) async throws -> ScanResult
    func resolveStrays(to target: LocationCode, moves: [StrayMove]) async throws -> StrayResolution
}

extension CubbyClient: ScanService {}

/// A scan plus the location it was read at. This is the value that crosses from the camera
/// delegate into the session; it is deliberately the only thing that does.
public struct ScanRead: Sendable, Hashable, Identifiable {
    public let id: UUID
    public let raw: String
    public let anchor: LocationCode
    public let at: Date

    public init(id: UUID = UUID(), raw: String, anchor: LocationCode, at: Date = .now) {
        self.id = id
        self.raw = raw
        self.anchor = anchor
        self.at = at
    }
}

/// The state behind a location sweep: a serialized scan queue and the strays it turns up.
///
/// Mirrors `useLocationSweep.ts` and keeps its two load-bearing properties:
///
/// **Serialization.** The camera keeps firing while a lookup is in flight, and the same-code
/// debounce only compares the last raw value, so two encodings of one product would both observe
/// "not stocked here" if run concurrently. Scans drain one at a time in the order they were read.
///
/// **Location anchoring.** Every read carries the location it was read at. `reset()` empties the
/// queue but cannot abort a lookup in flight, so a late result whose anchor is no longer the
/// current location is discarded outright. A stray queued against one shelf must never commit
/// against the next.
@MainActor
@Observable
public final class ScanSession {
    /// How many recently-scanned chips the viewfinder shows (newest first).
    public static let recentLimit = 5
    /// A repeat of the last accepted raw value inside this window is a re-read, not a new scan.
    public static let debounceInterval: TimeInterval = 1.5

    public enum ChipStatus: Sendable, Hashable {
        case pending, added, confirmed, queued, failed(String)
    }

    public struct Chip: Sendable, Hashable, Identifiable {
        public let id: UUID
        public var label: String
        public var status: ChipStatus
    }

    /// One product that turned up elsewhere during the sweep. Keyed by product: scanning two
    /// copies of the same book must not queue the same decision twice.
    public struct QueuedStray: Sendable, Hashable, Identifiable {
        public var id: ProductCode { productID }
        public let productID: ProductCode
        public let productName: String
        public let rows: [Stray]
    }

    public struct Tally: Sendable, Hashable {
        public var added = 0
        /// Seen where it was expected. Counted apart from `added` because nothing was written.
        public var confirmed = 0
    }

    public private(set) var chips: [Chip] = []
    public private(set) var strays: [QueuedStray] = []
    public private(set) var tally = Tally()
    public private(set) var pendingCount = 0
    public private(set) var lastError: String?

    public var location: LocationCode? {
        didSet { if location != oldValue { reset() } }
    }

    private let service: any ScanService
    private var queue: [(read: ScanRead, chip: UUID)] = []
    private var draining = false
    private var lastAccepted: (raw: String, at: Date)?

    public init(service: any ScanService, location: LocationCode? = nil) {
        self.service = service
        self.location = location
    }

    /// Accepts a raw scanner or keyboard value. Returns `false` when it was a debounced repeat.
    @discardableResult
    public func submit(_ raw: String, at date: Date = .now) -> Bool {
        guard let location else { return false }
        if let last = lastAccepted, last.raw == raw, date.timeIntervalSince(last.at) < Self.debounceInterval {
            return false
        }
        lastAccepted = (raw, date)
        let chip = Chip(id: UUID(), label: raw, status: .pending)
        chips = Array(([chip] + chips).prefix(Self.recentLimit))
        pendingCount += 1
        queue.append((ScanRead(raw: raw, anchor: location, at: date), chip.id))
        Task { await drain() }
        return true
    }

    public func reset() {
        queue.removeAll()
        chips.removeAll()
        strays.removeAll()
        tally = Tally()
        pendingCount = 0
        lastAccepted = nil
        lastError = nil
    }

    public func dismissStray(_ productID: ProductCode) {
        strays.removeAll { $0.productID == productID }
    }

    /// Commits every queued stray into the current location. Rows flagged `ambiguousQuantity`
    /// move one unit; the rest move whole.
    public func resolveStrays() async throws -> StrayResolution? {
        guard let location, !strays.isEmpty else { return nil }
        let moves = strays.flatMap { stray in
            stray.rows.map { StrayMove(entryId: $0.entryId, quantity: $0.ambiguousQuantity ? 1 : nil) }
        }
        let resolution = try await service.resolveStrays(to: location, moves: moves)
        if self.location == location { strays.removeAll() }
        return resolution
    }

    private func drain() async {
        if draining { return }
        draining = true
        defer { draining = false }
        while !queue.isEmpty {
            let (read, chipID) = queue.removeFirst()
            let code: ScanCode
            switch ScanCode.classify(read.raw) {
            case .success(let classified): code = classified
            case .failure(let error):
                settle(read) { self.fail(chipID, error.message) }
                continue
            }
            do {
                let result = try await service.scan(code, at: read.anchor)
                settle(read) { self.apply(result, to: chipID) }
            } catch let error as CubbyAPIError {
                settle(read) { self.fail(chipID, error.detail?.message ?? "HTTP \(error.status)") }
            } catch {
                settle(read) { self.fail(chipID, String(describing: error)) }
            }
        }
    }

    /// The anchor gate: a result for a location we have since walked away from is dropped, and
    /// its pending decrement with it, because `reset()` already zeroed the count.
    private func settle(_ read: ScanRead, _ apply: () -> Void) {
        guard read.anchor == location else { return }
        apply()
        pendingCount = max(0, pendingCount - 1)
    }

    private func fail(_ chipID: UUID, _ message: String) {
        patch(chipID) { $0.status = .failed(message) }
        lastError = message
    }

    private func apply(_ result: ScanResult, to chipID: UUID) {
        patch(chipID) {
            $0.label = result.product.name
            switch result.outcome {
            case .added: $0.status = .added
            case .confirmed: $0.status = .confirmed
            case .queued: $0.status = .queued
            }
        }
        switch result.outcome {
        case .added: tally.added += 1
        case .confirmed: tally.confirmed += 1
        case .queued: break
        }
        if !result.strays.isEmpty, !strays.contains(where: { $0.productID == result.product.id }) {
            strays.append(QueuedStray(productID: result.product.id, productName: result.product.name, rows: result.strays))
        }
    }

    private func patch(_ chipID: UUID, _ change: (inout Chip) -> Void) {
        guard let index = chips.firstIndex(where: { $0.id == chipID }) else { return }
        change(&chips[index])
    }
}
