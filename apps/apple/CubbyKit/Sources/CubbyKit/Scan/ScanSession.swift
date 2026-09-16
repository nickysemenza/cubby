import CubbyAPI
import Foundation
import Observation

/// The server calls a sweep needs. `CubbyClient` conforms; tests stub it.
public protocol ScanService: Sendable {
    /// The raw scanner or keyboard value, resolved by the server (`{kind: "scan"}`).
    func scan(raw: String, at location: LocationCode) async throws -> ScanAtLocationOut
    func resolveStrays(to target: LocationCode, moves: [StrayMove]) async throws -> ResolveScanStraysOut
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

/// The state behind a location sweep: chips, tally, and the strays it turns up, over a
/// `ScanDrain` that provides the serialization and location anchoring `useLocationSweep.ts`
/// relies on. A stray queued against one shelf must never commit against the next.
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

    /// The last outcome for one code plus how many times it landed.
    public struct Seen: Sendable, Hashable {
        public var label: String
        public var status: ChipStatus
        public var count: Int
    }

    /// One product that turned up elsewhere during the sweep. Keyed by product: scanning two
    /// copies of the same book must not queue the same decision twice.
    public struct QueuedStray: Sendable, Hashable, Identifiable {
        public var id: ProductCode { productID }
        public let productID: ProductCode
        public let productName: String
        public let rows: [ScanStrayOut]
    }

    public struct Tally: Sendable, Hashable {
        public var added = 0
        /// Seen where it was expected. Counted apart from `added` because nothing was written.
        public var confirmed = 0
    }

    /// What one read turned into, before the anchor gate.
    enum Event: Sendable {
        case scanned(ScanAtLocationOut)
        case failed(String)
    }

    public private(set) var chips: [Chip] = []
    /// Everything this sweep has learned per code, keyed by `key(forScanned:)`, so the camera
    /// overlay can label a barcode it has already seen without another request.
    public private(set) var scanned: [String: Seen] = [:]
    private var rawByToken: [UUID: String] = [:]
    public private(set) var strays: [QueuedStray] = []
    public private(set) var tally = Tally()
    public private(set) var lastError: String?
    public var pendingCount: Int { drain.pendingCount }

    public var location: LocationCode? {
        didSet {
            if location != oldValue {
                drain.anchor = location
                reset()
            }
        }
    }

    private let service: any ScanService
    private let drain: ScanDrain<Event>

    public init(service: any ScanService, location: LocationCode? = nil) {
        self.service = service
        self.location = location
        drain = ScanDrain(anchor: location, debounceInterval: Self.debounceInterval) { read in
            await Self.perform(read, service: service)
        }
        drain.onSettle = { [weak self] token, event in self?.settle(token, event) }
    }

    /// Accepts a raw scanner or keyboard value. Returns `false` when it was a debounced repeat.
    @discardableResult
    public func submit(_ raw: String, at date: Date = .now) -> Bool {
        guard let token = drain.submit(raw, at: date) else { return false }
        let chip = Chip(id: token, label: raw, status: .pending)
        chips = Array(([chip] + chips).prefix(Self.recentLimit))
        rawByToken[token] = raw
        scanned[ScanCodes.key(forScanned: raw), default: Seen(label: raw, status: .pending, count: 0)]
            .status = .pending
        return true
    }

    public func reset() {
        drain.reset()
        chips.removeAll()
        scanned.removeAll()
        rawByToken.removeAll()
        strays.removeAll()
        tally = Tally()
        lastError = nil
    }

    public func dismissStray(_ productID: ProductCode) {
        strays.removeAll { $0.productID == productID }
    }

    /// Commits every queued stray into the current location. Rows flagged `ambiguousQuantity`
    /// move one unit; the rest move whole.
    public func resolveStrays() async throws -> ResolveScanStraysOut? {
        guard let location, !strays.isEmpty else { return nil }
        let moves = strays.flatMap { stray in
            stray.rows.map { StrayMove(entryId: $0.entryId, quantity: $0.ambiguousQuantity ? 1 : nil) }
        }
        let resolution = try await service.resolveStrays(to: location, moves: moves)
        if self.location == location { strays.removeAll() }
        return resolution
    }

    /// Scans one read. Static so the drain's work closure captures the service, not the session.
    private static func perform(_ read: ScanRead, service: any ScanService) async -> Event {
        do {
            return .scanned(try await service.scan(raw: read.raw, at: read.anchor))
        } catch let error as CubbyAPIError {
            return .failed(error.detail?.message ?? "HTTP \(error.status)")
        } catch {
            return .failed(String(describing: error))
        }
    }

    private func settle(_ chipID: UUID, _ event: Event) {
        switch event {
        case .scanned(let result): apply(result, to: chipID)
        case .failed(let message): fail(chipID, message)
        }
    }

    private func fail(_ chipID: UUID, _ message: String) {
        patch(chipID) { $0.status = .failed(message) }
        note(chipID) { $0.status = .failed(message) }
        lastError = message
    }

    private func apply(_ result: ScanAtLocationOut, to chipID: UUID) {
        patch(chipID) {
            $0.label = result.product.name
            switch result.outcome {
            case .added: $0.status = .added
            case .confirmed: $0.status = .confirmed
            case .queued: $0.status = .queued
            }
        }
        note(chipID) {
            $0.label = result.product.name
            $0.count += 1
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
            strays.append(
                QueuedStray(
                    productID: result.product.id, productName: result.product.name, rows: result.strays))
        }
    }

    private func note(_ chipID: UUID, _ change: (inout Seen) -> Void) {
        guard let raw = rawByToken.removeValue(forKey: chipID) else { return }
        change(
            &scanned[ScanCodes.key(forScanned: raw), default: Seen(label: raw, status: .pending, count: 0)])
    }

    private func patch(_ chipID: UUID, _ change: (inout Chip) -> Void) {
        guard let index = chips.firstIndex(where: { $0.id == chipID }) else { return }
        change(&chips[index])
    }
}
