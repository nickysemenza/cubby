import CubbyAPI
import Foundation
import Observation

/// The state behind a walk-the-shelf recount: a pass over every stocked bin under a scope, one
/// bin at a time, each committed as one `reconcileSession` call.
///
/// Tenets, in order of how much they cost to get wrong:
/// - Nothing auto-decrements. A row you did not touch commits as `verify`; Done says so first.
/// - Skip writes nothing.
/// - The snapshot guard is the only concurrency control: every commit sends the server's opaque
///   location snapshot token back; a stale answer refetches the bin and keeps what you staged, and a second
///   consecutive stale stops retrying and asks you to reload.
/// - An expected product scanned in its bin is matched locally, with no request. Only an
///   unexpected code goes to the server, through the same `ScanDrain` the sweep uses.
@MainActor
@Observable
public final class RecountSession {
    public enum Phase: Sendable, Hashable {
        case choosingScope, loading, bin, complete, failed(String)
    }

    public enum StaleState: Sendable, Hashable {
        /// The bin changed underneath the commit; rows were refetched and staged decisions kept.
        case refetched
        /// Two commits in a row were stale; the walk stops until `reload()`.
        case needsReload
    }

    public struct RowState: Sendable, Hashable, Identifiable {
        public var id: InventoryEntryCode { row.id }
        public var row: RecountRow
        public var resolution: RecountResolution?
        public var isDuplicate: Bool
    }

    /// What the Live Activity (later) and the header show.
    public struct Progress: Sendable, Hashable {
        public let binIndex: Int
        public let binTotal: Int
        public let binName: String
        public let remainingInBin: Int
        public let verified: Int
        public let changed: Int
    }

    enum Event: Sendable {
        case scanned(ScanAtLocationOut)
        case failed(String)
    }

    public static let recentLimit = ScanSession.recentLimit

    public private(set) var phase: Phase = .choosingScope
    public private(set) var tree: LocationTree?
    public private(set) var scope: LocationTreeNode?
    public private(set) var bins: [LocationTreeNode] = []
    public private(set) var binIndex = 0
    public private(set) var rows: [RowState] = []
    public private(set) var strays: [ScanSession.QueuedStray] = []
    public private(set) var adoptions: [AdoptableBin] = []
    public private(set) var chips: [ScanSession.Chip] = []
    public private(set) var completed: Set<LocationCode> = []
    public private(set) var skipped: Set<LocationCode> = []
    public private(set) var summary = RecountSummary()
    public private(set) var stale: StaleState?
    public private(set) var busy = false
    public private(set) var lastError: String?
    public var onProgress: (@MainActor (Progress) -> Void)?

    public var pendingCount: Int { drain.pendingCount }
    public var currentBin: LocationTreeNode? {
        phase == .bin && bins.indices.contains(binIndex) ? bins[binIndex] : nil
    }
    public var unresolvedCount: Int { rows.filter { $0.resolution == nil }.count }
    public var progress: Progress {
        Progress(
            binIndex: bins.isEmpty ? 0 : binIndex + 1,
            binTotal: bins.count,
            binName: currentBin?.name ?? "",
            remainingInBin: unresolvedCount,
            verified: summary.verified,
            changed: summary.changed
        )
    }

    private let service: any RecountService
    private let drain: ScanDrain<Event>
    private var duplicates: Set<ProductCode> = []
    private var snapshotToken: String?
    private var consecutiveStale = 0
    private var unknownLocation: LocationCode?
    private var lastLocalMatch: (raw: String, at: Date)?

    // One refetch loop at a time. A request while a fetch is in flight sets `refetchWanted` and
    // the loop runs once more; staged decisions are snapshotted only after each fetch lands, so
    // a `.verify` set meanwhile is never overwritten by an older fetch's view of the rows.
    /// The running loop; `nil` between refetches (tests await it).
    private(set) var refetchTask: Task<Void, Never>?
    private var refetchWanted = false
    private var dropResolutionsOnRefetch = false
    /// Products the server just added to or confirmed in this bin, verified on the next apply.
    private var pendingVerify: Set<ProductCode> = []

    public init(service: any RecountService) {
        self.service = service
        drain = ScanDrain(debounceInterval: ScanSession.debounceInterval) { read in
            await Self.perform(read, service: service)
        }
        drain.onSettle = { [weak self] token, event in self?.settle(token, event) }
    }

    // MARK: Scope and pass

    public func loadTree() async {
        phase = .loading
        do {
            tree = try await service.locationTree()
            duplicates = (try? await service.duplicateProductIDs()) ?? []
            phase = .choosingScope
        } catch {
            phase = .failed(Self.message(for: error))
        }
    }

    public func start(scope id: LocationCode) async {
        guard let tree, let node = tree[id] else {
            phase = .failed("\(id.rawValue) is not in the location tree.")
            return
        }
        scope = node
        bins = tree.auditableBins(under: id)
        completed = []
        skipped = []
        summary = RecountSummary()
        binIndex = 0
        guard !bins.isEmpty else {
            phase = .complete
            return
        }
        phase = .bin
        await loadBin()
    }

    /// Walks only the bins that were skipped, in their original order.
    public func revisitSkipped() async {
        bins = bins.filter { skipped.contains($0.id) }
        skipped = []
        summary.binsSkipped = 0
        binIndex = 0
        guard !bins.isEmpty else {
            phase = .complete
            return
        }
        phase = .bin
        await loadBin()
    }

    public func restart() {
        phase = tree == nil ? .loading : .choosingScope
        scope = nil
        bins = []
        rows = []
        drain.anchor = nil
        clearBinState()
    }

    // MARK: Scanning

    /// Accepts a raw scanner or keyboard value at the current bin.
    public func submit(_ raw: String, at date: Date = .now) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let bin = currentBin, !trimmed.isEmpty else { return }

        if let label = CubbyLabel(trimmed), label.key == .location, let tree {
            switch BinPlan.plan(scanned: LocationCode(label.code), anchor: bin.id, in: tree) {
            case .confirm:
                push(Self.chip(label: tree[LocationCode(label.code)]?.name ?? label.code, status: .confirmed))
            case .adopt(let adoptable):
                if !adoptions.contains(where: { $0.id == adoptable.id }) { adoptions.append(adoptable) }
                push(Self.chip(label: adoptable.name, status: .added))
            case .refuse(_, let message):
                push(Self.chip(label: trimmed, status: .failed(message)))
            }
            return
        }

        if let index = rowIndex(matchingScanned: trimmed) {
            if let last = lastLocalMatch, last.raw == trimmed,
                date.timeIntervalSince(last.at) < ScanSession.debounceInterval
            {
                return
            }
            lastLocalMatch = (trimmed, date)
            if rows[index].resolution == nil { rows[index].resolution = .verify }
            push(Self.chip(label: rows[index].row.product.name, status: .confirmed))
            report()
            return
        }

        guard let token = drain.submit(trimmed, at: date) else { return }
        push(ScanSession.Chip(id: token, label: trimmed, status: .pending))
    }

    // MARK: Staging

    public func stage(_ resolution: RecountResolution, for id: InventoryEntryCode) {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        rows[index].resolution = resolution
        report()
    }

    public func clearResolution(for id: InventoryEntryCode) {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return }
        rows[index].resolution = nil
        report()
    }

    /// Stages a relocation to the global Unknown bin, creating it on first use.
    public func relocateToUnknown(_ id: InventoryEntryCode) async {
        do {
            if unknownLocation == nil { unknownLocation = try await service.ensureGlobalUnknown() }
            if let unknownLocation { stage(.relocate(unknownLocation, name: "Unknown"), for: id) }
        } catch {
            lastError = Self.message(for: error)
        }
    }

    public func dismissAdoption(_ id: LocationCode) {
        adoptions.removeAll { $0.id == id }
    }

    public func dismissStray(_ productID: ProductCode) {
        strays.removeAll { $0.productID == productID }
    }

    /// Moves every queued stray into the current bin, then refetches the bin: the moved rows
    /// are now expected here, and the snapshot has moved with them.
    public func resolveStrays() async throws -> ResolveScanStraysOut? {
        guard let bin = currentBin, !strays.isEmpty else { return nil }
        let moves = strays.flatMap { stray in
            stray.rows.map { StrayMove(entryId: $0.entryId, quantity: $0.ambiguousQuantity ? 1 : nil) }
        }
        let resolution = try await service.resolveStrays(to: bin.id, moves: moves)
        guard currentBin?.id == bin.id else { return resolution }
        strays.removeAll()
        await refetchRows(keepingResolutions: true)
        return resolution
    }

    // MARK: Committing

    /// Commits the bin: untouched rows verify, every staged decision applies, then queued bins
    /// are adopted. Advances on success; a stale snapshot refetches instead.
    public func commitBin() async {
        guard let bin = currentBin, !busy else { return }
        busy = true
        defer { busy = false }
        lastError = nil

        guard let snapshotToken else {
            lastError = "This bin needs a fresh inventory snapshot before it can be counted."
            return
        }
        let resolutions = rows.map { ($0.id, $0.resolution ?? RecountResolution.verify) }
        let body = ReconcileSessionPayload(
            locationId: bin.id,
            expectedInventoryEntryIds: rows.map(\.id),
            snapshotToken: snapshotToken,
            resolutions: resolutions.map { $0.1.resolution(for: $0.0) }
        )
        do {
            _ = try await service.reconcile(body)
        } catch let error as CubbyAPIError where error.isStaleInventory {
            consecutiveStale += 1
            if consecutiveStale >= 2 {
                stale = .needsReload
            } else {
                stale = .refetched
                await refetchRows(keepingResolutions: true)
            }
            return
        } catch {
            lastError = Self.message(for: error)
            return
        }

        consecutiveStale = 0
        stale = nil
        summary.tally(resolutions.map(\.1))
        if !adoptions.isEmpty {
            // Adoption is a second write after the reconcile; it is not atomic with it. A
            // failure here leaves the count committed and the bins where they were, and says so.
            do {
                summary.adopted += try await service.adopt(adoptions.map(\.id), into: bin.id)
            } catch {
                lastError = "Counted, but the bins were not adopted: \(Self.message(for: error))"
            }
        }
        completed.insert(bin.id)
        summary.binsDone += 1
        await advance()
    }

    public func skipBin() async {
        guard let bin = currentBin, !busy else { return }
        skipped.insert(bin.id)
        summary.binsSkipped += 1
        await advance()
    }

    /// After `.needsReload`: a fresh read of the bin, dropping staged decisions.
    public func reload() async {
        consecutiveStale = 0
        stale = nil
        await refetchRows(keepingResolutions: false)
    }

    // MARK: Internals

    private func loadBin() async {
        guard let bin = currentBin else { return }
        busy = true
        defer { busy = false }
        drain.anchor = bin.id
        clearBinState()
        await refetchRows(keepingResolutions: false)
    }

    private func refetchRows(keepingResolutions: Bool) async {
        await requestRefetch(keepingResolutions: keepingResolutions).value
    }

    /// Asks for a fresh read of the current bin, coalescing into the running loop if there is
    /// one. Returns the task that will finish every refetch requested so far.
    @discardableResult
    private func requestRefetch(keepingResolutions: Bool) -> Task<Void, Never> {
        if !keepingResolutions {
            dropResolutionsOnRefetch = true
            snapshotToken = nil
        }
        if let refetchTask {
            refetchWanted = true
            return refetchTask
        }
        let task = Task { await runRefetchLoop() }
        refetchTask = task
        return task
    }

    private func runRefetchLoop() async {
        defer { refetchTask = nil }
        repeat {
            refetchWanted = false
            let keep = !dropResolutionsOnRefetch
            dropResolutionsOnRefetch = false
            await fetchAndApplyRows(keepingResolutions: keep)
        } while refetchWanted
    }

    private func fetchAndApplyRows(keepingResolutions: Bool) async {
        guard let bin = currentBin else { return }
        if !keepingResolutions { pendingVerify = [] }
        do {
            let fresh = try await service.stockSnapshot(at: bin.id)
            guard currentBin?.id == bin.id else { return }
            // Snapshot after the await: anything staged while the fetch was in flight is kept.
            var staged: [InventoryEntryCode: RecountResolution] = [:]
            if keepingResolutions {
                for state in rows { staged[state.id] = state.resolution }
            }
            rows = fresh.rows.map { row in
                RowState(
                    row: row,
                    resolution: staged[row.id] ?? (pendingVerify.contains(row.product.id) ? .verify : nil),
                    isDuplicate: duplicates.contains(row.product.id))
            }
            snapshotToken = fresh.token
            pendingVerify.subtract(fresh.rows.map(\.product.id))
            report()
        } catch {
            lastError = Self.message(for: error)
        }
    }

    private func advance() async {
        drain.anchor = nil
        clearBinState()
        rows = []
        let next = bins.indices.first { index in
            index > binIndex && !completed.contains(bins[index].id) && !skipped.contains(bins[index].id)
        }
        guard let next else {
            phase = .complete
            report()
            return
        }
        binIndex = next
        await loadBin()
    }

    private func clearBinState() {
        chips = []
        strays = []
        adoptions = []
        stale = nil
        consecutiveStale = 0
        lastLocalMatch = nil
        lastError = nil
        pendingVerify = []
        snapshotToken = nil
    }

    func row(matchingScanned raw: String) -> RowState? {
        rowIndex(matchingScanned: raw).map { rows[$0] }
    }

    /// An expected row for a raw read, offline: a product label by id, a barcode or ISBN by the
    /// GTIN-14 it is stored as. Anything else is not in the bin as far as the device can tell.
    private func rowIndex(matchingScanned raw: String) -> Int? {
        if let label = CubbyLabel(raw) {
            guard label.key == .product else { return nil }
            return rows.firstIndex { $0.row.product.id.rawValue == label.code }
        }
        guard let gtin = ScanCodes.gtin14(raw) else { return nil }
        return rows.firstIndex { $0.row.product.barcodes.contains(gtin) }
    }

    private static func perform(_ read: ScanRead, service: any RecountService) async -> Event {
        do {
            return .scanned(try await service.scan(raw: read.raw, at: read.anchor))
        } catch {
            return .failed(message(for: error))
        }
    }

    private func settle(_ token: UUID, _ event: Event) {
        switch event {
        case .failed(let message):
            patch(token) { $0.status = .failed(message) }
            lastError = message
        case .scanned(let result):
            patch(token) {
                $0.label = result.product.name
                switch result.outcome {
                case .added: $0.status = .added
                case .confirmed: $0.status = .confirmed
                case .queued: $0.status = .queued
                }
            }
            switch result.outcome {
            case .queued:
                if !result.strays.isEmpty, !strays.contains(where: { $0.productID == result.product.id }) {
                    strays.append(
                        .init(
                            productID: result.product.id, productName: result.product.name,
                            rows: result.strays))
                }
            case .added, .confirmed:
                // The server wrote to this bin (a new row, or a verified stamp), so the expected
                // set and its snapshot moved. Refetch so the commit matches what is there now.
                if case .added = result.outcome { summary.added += 1 }
                pendingVerify.insert(result.product.id)
                requestRefetch(keepingResolutions: true)
            }
        }
    }

    private func push(_ chip: ScanSession.Chip) {
        chips = Array(([chip] + chips).prefix(Self.recentLimit))
    }

    private func patch(_ id: UUID, _ change: (inout ScanSession.Chip) -> Void) {
        guard let index = chips.firstIndex(where: { $0.id == id }) else { return }
        change(&chips[index])
    }

    private static func chip(label: String, status: ScanSession.ChipStatus) -> ScanSession.Chip {
        ScanSession.Chip(id: UUID(), label: label, status: status)
    }

    private func report() {
        onProgress?(progress)
    }

    private static func message(for error: any Error) -> String {
        if let error = error as? CubbyAPIError {
            return error.detail?.message ?? "HTTP \(error.status)"
        }
        return String(describing: error)
    }
}
