import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// A recount service whose every answer the test scripts. Records calls so "no request was
/// made" is observable, and can fail the next reconcile as stale.
final class StubRecountService: RecountService, Sendable {
    enum Call: Equatable, Sendable {
        case tree, unknown, rows(LocationCode), duplicates, reconcile(LocationCode, snapshot: String?), adopt(
            [LocationCode], LocationCode), scan(String, LocationCode), resolve(LocationCode)
    }

    struct State: Sendable {
        var tree: LocationTree
        var rows: [LocationCode: [RecountRow]] = [:]
        var duplicates: Set<ProductCode> = []
        var staleReconciles = 0
        var scanResult: ScanAtLocationOut = StubScanService.result(
            .queued, id: "PRD-9999", name: "Unexpected")
        /// Per-code answers; a code not listed falls back to `scanResult`.
        var scanResults: [String: ScanAtLocationOut] = [:]
        /// How long `stockRows` takes, so a test can overlap a refetch with later scans.
        var rowsDelay: Duration = .zero
        var calls: [Call] = []
        var lastReconcile: ReconcileSessionPayload?
    }

    let state: Mutex<State>

    init(tree: LocationTree, rows: [LocationCode: [RecountRow]]) {
        state = Mutex(State(tree: tree, rows: rows))
    }

    var calls: [Call] { state.withLock { $0.calls } }
    func record(_ call: Call) { state.withLock { $0.calls.append(call) } }

    func locationTree() async throws -> LocationTree {
        record(.tree)
        return state.withLock { $0.tree }
    }

    func ensureGlobalUnknown() async throws -> LocationCode {
        record(.unknown)
        return LocationCode("LOC-9ABC")
    }

    func stockSnapshot(at location: LocationCode) async throws -> RecountSnapshot {
        record(.rows(location))
        let delay = state.withLock { $0.rowsDelay }
        if delay > .zero { try await Task.sleep(for: delay) }
        return RecountSnapshot(
            rows: state.withLock { $0.rows[location] ?? [] },
            token: "snapshot-\(location.rawValue)")
    }

    func duplicateProductIDs() async throws -> Set<ProductCode> {
        record(.duplicates)
        return state.withLock { $0.duplicates }
    }

    func reconcile(_ body: ReconcileSessionPayload) async throws -> [RecountRow] {
        record(.reconcile(body.locationId, snapshot: body.snapshotToken))
        let stale: Bool = state.withLock { state in
            state.lastReconcile = body
            guard state.staleReconciles > 0 else { return false }
            state.staleReconciles -= 1
            return true
        }
        if stale {
            throw CubbyAPIError(
                status: 409, operationID: "inventory.reconcileSession",
                detail: .init(code: "CONFLICT", message: "stale", reason: "INVENTORY_STALE", requestId: nil)
            )
        }
        return []
    }

    func adopt(_ bins: [LocationCode], into parent: LocationCode) async throws -> Int {
        record(.adopt(bins, parent))
        return bins.count
    }

    func scan(raw: String, at location: LocationCode) async throws -> ScanAtLocationOut {
        record(.scan(raw, location))
        return state.withLock { $0.scanResults[raw] ?? $0.scanResult }
    }

    func resolveStrays(to target: LocationCode, moves: [StrayMove]) async throws -> ResolveScanStraysOut {
        record(.resolve(target))
        return ResolveScanStraysOut(
            moved: moves.count, skipped: [], sideEffects: .init(backgroundBatches: []))
    }
}

extension CubbyAPIError.ErrorDetail {
    init(code: String, message: String, reason: String?, requestId: String?) {
        let json = """
            {"code":"\(code)","message":"\(message)","reason":\(reason.map { "\"\($0)\"" } ?? "null"),"requestId":\(requestId.map { "\"\($0)\"" } ?? "null")}
            """
        self = try! JSONDecoder().decode(Self.self, from: Data(json.utf8))
    }
}

@MainActor
private func settle(_ session: RecountSession, timeout: Duration = .seconds(2)) async throws {
    let deadline = ContinuousClock.now + timeout
    // A settled scan requests its refetch synchronously, so once nothing is pending only the
    // refetch loop can still be running.
    while session.pendingCount > 0 || session.busy || session.refetchTask != nil {
        try #require(ContinuousClock.now < deadline, "session never settled")
        try await Task.sleep(for: .milliseconds(5))
    }
}

@Suite("RecountSession")
@MainActor
struct RecountSessionTests {
    let garage = LocationCode("LOC-3456")
    let bin1 = LocationCode("LOC-5678")
    let bin2 = LocationCode("LOC-6789")
    let shelf = LocationCode("LOC-4567")

    static func row(
        _ id: String, product: String, name: String, gtin: String? = nil, updated: String,
        at location: LocationCode = LocationCode("LOC-5678")
    ) -> RecountRow {
        RecountRow(
            id: InventoryEntryCode(id), amount: Amount(value: 1, unit: "each"),
            updatedAt: try! LenientISO8601DateTranscoder().decode(updated),
            product: .init(id: ProductCode(product), name: name, primaryGtin: gtin),
            locationID: location, locationName: "Bin"
        )
    }

    /// A pass over Shelf A: Bin 1 (two rows) then Bin 2 (one row).
    func makeSession(staleReconciles: Int = 0) async throws -> (RecountSession, StubRecountService) {
        let tree = try LocationTreeTests.tree()
        let service = StubRecountService(
            tree: tree,
            rows: [
                bin1: [
                    Self.row(
                        "INV-2345", product: "PRD-2345", name: "Sample Product", gtin: "00012345678905",
                        updated: "2026-03-02T10:00:00.000Z"),
                    Self.row(
                        "INV-3456", product: "PRD-3456", name: "Other Product",
                        updated: "2026-03-03T10:00:00.000Z"),
                ],
                bin2: [
                    Self.row(
                        "INV-4567", product: "PRD-4567", name: "Deep Product",
                        updated: "2026-03-04T10:00:00.000Z", at: bin2)
                ],
            ]
        )
        service.state.withLock {
            $0.staleReconciles = staleReconciles; $0.duplicates = [ProductCode("PRD-3456")]
        }
        let session = RecountSession(service: service)
        await session.loadTree()
        await session.start(scope: shelf)
        return (session, service)
    }

    @Test func startsOnTheFirstStockedBinWithItsRows() async throws {
        let (session, service) = try await makeSession()
        #expect(session.phase == .bin)
        #expect(session.bins.map(\.name) == ["Bin 1", "Bin 2"])
        #expect(session.currentBin?.id == bin1)
        #expect(session.rows.map(\.id.rawValue) == ["INV-2345", "INV-3456"])
        #expect(session.rows[1].isDuplicate)
        #expect(session.unresolvedCount == 2)
        #expect(service.calls == [.tree, .duplicates, .rows(bin1)])
    }

    @Test func expectedProductVerifiesLocallyWithNoRequest() async throws {
        let (session, service) = try await makeSession()
        session.submit("012345678905")  // 12-digit UPC of the 14-digit primaryGtin
        try await settle(session)
        #expect(session.rows[0].resolution == .verify)
        #expect(session.chips.first?.status == .confirmed)
        #expect(session.chips.first?.label == "Sample Product")
        #expect(!service.calls.contains { if case .scan = $0 { true } else { false } })

        session.submit("PRD-3456")
        try await settle(session)
        #expect(session.rows[1].resolution == .verify)
        #expect(session.unresolvedCount == 0)
        #expect(!service.calls.contains { if case .scan = $0 { true } else { false } })
    }

    @Test func shelfAnnotationsComeFromTheRowsWithNoRequest() async throws {
        let (session, service) = try await makeSession()
        #expect(
            session.annotation(forScanned: "012345678905")
                == ShelfAnnotation(title: "Sample Product", detail: "1 each expected", tone: .expected))
        #expect(
            session.annotation(forScanned: "4006381333931")
                == ShelfAnnotation(title: "Not in this bin", tone: .unexpected))
        #expect(session.annotation(forScanned: "LOC-5678")?.tone == .verified)
        #expect(session.annotation(forScanned: "LOC-6789")?.tone == .unexpected)
        #expect(session.annotation(forScanned: "not a code") == nil)

        session.submit("PRD-2345")
        try await settle(session)
        #expect(session.annotation(forScanned: "PRD-2345")?.detail == "1 each ✓")
        session.stage(.adjust(Amount(value: 3, unit: "each")), for: InventoryEntryCode("INV-2345"))
        #expect(
            session.annotation(forScanned: "PRD-2345")
                == ShelfAnnotation(title: "Sample Product", detail: "→ 3 each", tone: .verified))
        #expect(!service.calls.contains { if case .scan = $0 { true } else { false } })
    }

    @Test func aStagedAdjustmentSurvivesARescan() async throws {
        let (session, _) = try await makeSession()
        session.stage(.adjust(Amount(value: 2, unit: "each")), for: InventoryEntryCode("INV-2345"))
        session.submit("012345678905")
        try await settle(session)
        #expect(session.rows[0].resolution == .adjust(Amount(value: 2, unit: "each")))
    }

    @Test func unexpectedCodeScansOnceAndQueuesAStray() async throws {
        let (session, service) = try await makeSession()
        service.state.withLock {
            $0.scanResult = StubScanService.result(
                .queued, id: "PRD-9999", name: "Unexpected",
                strays: [
                    ScanStrayOut(
                        entryId: InventoryEntryCode("INV-9999"),
                        location: .init(id: LocationCode("LOC-89AB"), name: "Bin 9"),
                        amount: Amount(value: 1, unit: "each"), ambiguousQuantity: false)
                ])
        }
        session.submit("4006381333931")
        try await settle(session)
        #expect(service.calls.filter { if case .scan = $0 { true } else { false } }.count == 1)
        #expect(session.chips.first?.status == .queued)
        #expect(session.strays.count == 1)
        // A queued scan wrote nothing, so the bin was not refetched.
        #expect(service.calls.filter { $0 == .rows(bin1) }.count == 1)
    }

    @Test func anAddedScanRefetchesTheBinAndVerifiesTheNewRow() async throws {
        let (session, service) = try await makeSession()
        service.state.withLock { state in
            state.scanResult = StubScanService.result(.added, id: "PRD-9999", name: "Unexpected")
            state.rows[bin1]?.append(
                Self.row(
                    "INV-9999", product: "PRD-9999", name: "Unexpected", updated: "2026-03-05T10:00:00.000Z"))
        }
        session.submit("4006381333931")
        try await settle(session)
        #expect(session.rows.count == 3)
        #expect(session.rows[2].resolution == .verify)
        #expect(session.summary.added == 1)
        #expect(service.calls.filter { $0 == .rows(bin1) }.count == 2)
    }

    /// Two added scans while the first refetch is still in flight: the second must not race the
    /// first and drop its `.verify`. The follow-up refetch is coalesced, so the bin is read once
    /// on load, once for the in-flight refetch, and once more after it.
    @Test func backToBackAddedScansCoalesceTheRefetchAndVerifyBothRows() async throws {
        let (session, service) = try await makeSession()
        service.state.withLock { state in
            state.rowsDelay = .milliseconds(50)
            state.scanResults = [
                "4006381333931": StubScanService.result(.added, id: "PRD-9999", name: "Unexpected"),
                "5901234123457": StubScanService.result(.added, id: "PRD-8888", name: "Another"),
            ]
            state.rows[bin1]?.append(contentsOf: [
                Self.row(
                    "INV-9999", product: "PRD-9999", name: "Unexpected", updated: "2026-03-05T10:00:00.000Z"),
                Self.row(
                    "INV-8888", product: "PRD-8888", name: "Another", updated: "2026-03-05T11:00:00.000Z"),
            ])
        }
        session.submit("4006381333931")
        session.submit("5901234123457")
        try await settle(session)
        #expect(session.rows.map(\.id.rawValue) == ["INV-2345", "INV-3456", "INV-9999", "INV-8888"])
        #expect(session.rows[2].resolution == .verify)
        #expect(session.rows[3].resolution == .verify)
        #expect(session.unresolvedCount == 2)
        #expect(session.summary.added == 2)
        #expect(service.calls.filter { $0 == .rows(bin1) }.count == 3)
    }

    @Test func locationLabelsPlanBinsAndNeverScan() async throws {
        let (session, service) = try await makeSession()
        session.submit("LOC-6789")  // grandchild of Shelf A, child of Bin 1: confirm
        #expect(session.chips.first?.status == .confirmed)
        session.submit("LOC-89AB")  // Bin 9 in the Kitchen: adopt
        #expect(session.adoptions.map(\.name) == ["Bin 9"])
        session.submit("LOC-89AB")
        #expect(session.adoptions.count == 1)
        session.submit("LOC-3456")  // Garage contains Bin 1: refuse
        #expect(session.chips.first?.status == .failed("Garage contains Bin 1 — it can't move inside it."))
        #expect(!service.calls.contains { if case .scan = $0 { true } else { false } })
        #expect(session.pendingCount == 0)
    }

    @Test func doneFillsVerifyUsesTheOpaqueSnapshotAdoptsThenAdvances() async throws {
        let (session, service) = try await makeSession()
        session.stage(.remove, for: InventoryEntryCode("INV-3456"))
        session.submit("LOC-89AB")
        await session.commitBin()
        let body = try #require(service.state.withLock { $0.lastReconcile })
        #expect(body.snapshotUpdatedAt == nil)
        #expect(body.snapshotToken == "snapshot-LOC-5678")
        #expect(body.expectedInventoryEntryIds.map(\.rawValue) == ["INV-2345", "INV-3456"])
        #expect(
            body.resolutions.map { resolution -> String in
                switch resolution {
                case .verify: "verify"
                case .adjust: "adjust"
                case .remove: "remove"
                case .relocate: "relocate"
                }
            } == ["verify", "remove"]
        )
        #expect(service.calls.contains(.adopt([LocationCode("LOC-89AB")], bin1)))
        // Adoption happens after the reconcile, never before.
        let reconcileIndex = try #require(
            service.calls.firstIndex { if case .reconcile = $0 { true } else { false } })
        let adoptIndex = try #require(
            service.calls.firstIndex { if case .adopt = $0 { true } else { false } })
        #expect(adoptIndex > reconcileIndex)
        #expect(session.summary.verified == 1)
        #expect(session.summary.removed == 1)
        #expect(session.summary.adopted == 1)
        #expect(session.currentBin?.id == bin2)
        #expect(session.adoptions.isEmpty)
        #expect(session.rows.map(\.id.rawValue) == ["INV-4567"])

        await session.commitBin()
        #expect(session.phase == .complete)
        #expect(session.summary.binsDone == 2)
        #expect(session.completed == [bin1, bin2])
    }

    @Test func emptyBinStillSendsSnapshotToken() async throws {
        let tree = try LocationTreeTests.tree()
        let service = StubRecountService(tree: tree, rows: [:])
        let session = RecountSession(service: service)
        await session.loadTree()
        await session.start(scope: bin2)
        await session.commitBin()
        let body = try #require(service.state.withLock { $0.lastReconcile })
        #expect(body.snapshotUpdatedAt == nil)
        #expect(body.snapshotToken == "snapshot-LOC-6789")
        #expect(body.expectedInventoryEntryIds.isEmpty)
        #expect(session.phase == .complete)
    }

    @Test func staleRefetchesKeepsStagedDecisionsAndDoesNotAdvance() async throws {
        let (session, service) = try await makeSession(staleReconciles: 1)
        session.stage(.remove, for: InventoryEntryCode("INV-3456"))
        _ = service.state.withLock { $0.rows[bin1]?.removeFirst() }  // the bin changed underneath
        await session.commitBin()
        #expect(session.stale == .refetched)
        #expect(session.currentBin?.id == bin1)
        #expect(session.rows.map(\.id.rawValue) == ["INV-3456"])
        #expect(session.rows[0].resolution == .remove)
        #expect(session.summary.binsDone == 0)
        #expect(session.summary.removed == 0)

        await session.commitBin()
        #expect(session.stale == nil)
        #expect(session.currentBin?.id == bin2)
    }

    @Test func twoConsecutiveStalesStopUntilReload() async throws {
        let (session, service) = try await makeSession(staleReconciles: 2)
        await session.commitBin()
        #expect(session.stale == .refetched)
        await session.commitBin()
        #expect(session.stale == .needsReload)
        #expect(session.currentBin?.id == bin1)
        let reconciles = service.calls.filter { if case .reconcile = $0 { true } else { false } }.count
        #expect(reconciles == 2)

        session.stage(.remove, for: InventoryEntryCode("INV-3456"))
        await session.reload()
        #expect(session.stale == nil)
        // Reload is a fresh read: staged decisions are dropped.
        #expect(session.rows.allSatisfy { $0.resolution == nil })
        await session.commitBin()
        #expect(session.currentBin?.id == bin2)
    }

    @Test func skipWritesNothingAndCanBeRevisited() async throws {
        let (session, service) = try await makeSession()
        await session.skipBin()
        #expect(session.currentBin?.id == bin2)
        #expect(session.skipped == [bin1])
        #expect(!service.calls.contains { if case .reconcile = $0 { true } else { false } })
        await session.commitBin()
        #expect(session.phase == .complete)
        #expect(session.summary.binsSkipped == 1)

        await session.revisitSkipped()
        #expect(session.phase == .bin)
        #expect(session.bins.map(\.id) == [bin1])
        #expect(session.currentBin?.id == bin1)
        #expect(session.skipped.isEmpty)
    }

    @Test func relocateToUnknownEnsuresItOnce() async throws {
        let (session, service) = try await makeSession()
        await session.relocateToUnknown(InventoryEntryCode("INV-2345"))
        await session.relocateToUnknown(InventoryEntryCode("INV-3456"))
        #expect(session.rows[0].resolution == .relocate(LocationCode("LOC-9ABC"), name: "Unknown"))
        #expect(service.calls.filter { $0 == .unknown }.count == 1)
    }

    @Test func resolvingStraysRefetchesTheBin() async throws {
        let (session, service) = try await makeSession()
        service.state.withLock {
            $0.scanResult = StubScanService.result(
                .queued, id: "PRD-9999", name: "Unexpected",
                strays: [
                    ScanStrayOut(
                        entryId: InventoryEntryCode("INV-9999"),
                        location: .init(id: LocationCode("LOC-89AB"), name: "Bin 9"),
                        amount: Amount(value: 1, unit: "each"), ambiguousQuantity: true)
                ])
        }
        session.submit("4006381333931")
        try await settle(session)
        service.state.withLock { state in
            state.rows[bin1]?.append(
                Self.row(
                    "INV-9999", product: "PRD-9999", name: "Unexpected", updated: "2026-03-06T10:00:00.000Z"))
        }
        let resolution = try await session.resolveStrays()
        #expect(resolution?.moved == 1)
        #expect(session.strays.isEmpty)
        #expect(session.rows.count == 3)
        #expect(service.calls.contains(.resolve(bin1)))
    }

    @Test func staleAnchorScanIsDroppedAfterAdvancing() async throws {
        let (session, service) = try await makeSession()
        service.state.withLock {
            $0.scanResult = StubScanService.result(
                .queued, id: "PRD-9999", name: "Late",
                strays: [
                    ScanStrayOut(
                        entryId: InventoryEntryCode("INV-9999"),
                        location: .init(id: LocationCode("LOC-89AB"), name: "Bin 9"),
                        amount: Amount(value: 1, unit: "each"), ambiguousQuantity: false)
                ])
        }
        session.submit("4006381333931")
        // Skip before the scan settles: its stray must not land in Bin 2.
        await session.skipBin()
        try await settle(session)
        #expect(session.currentBin?.id == bin2)
        #expect(session.strays.isEmpty)
        #expect(session.chips.isEmpty)
    }
}
