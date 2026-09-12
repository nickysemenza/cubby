import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// A scan service whose behaviour each test scripts. Records the maximum number of in-flight
/// scans so serialization is observable, and can hold a scan open until released.
final class StubScanService: ScanService, Sendable {
    typealias Responder = @Sendable (ScanCode, LocationCode) async throws -> ScanResult

    private let state = Mutex<(active: Int, maxActive: Int, calls: [(ScanCode, LocationCode)])>((0, 0, []))
    let responder: Mutex<Responder>

    init(_ responder: @escaping Responder) {
        self.responder = Mutex(responder)
    }

    var maxActive: Int { state.withLock { $0.maxActive } }
    var calls: [(ScanCode, LocationCode)] { state.withLock { $0.calls } }

    func scan(_ code: ScanCode, at location: LocationCode) async throws -> ScanResult {
        state.withLock {
            $0.active += 1
            $0.maxActive = max($0.maxActive, $0.active)
            $0.calls.append((code, location))
        }
        defer { state.withLock { $0.active -= 1 } }
        let responder = responder.withLock { $0 }
        return try await responder(code, location)
    }

    func resolveStrays(to target: LocationCode, moves: [StrayMove]) async throws -> StrayResolution {
        StrayResolution(moved: moves.count, skipped: [])
    }

    static func result(
        _ outcome: ScanOutcome, id: String = "PRD-2345", name: String = "Sample", strays: [Stray] = []
    ) -> ScanResult {
        ScanResult(
            outcome: outcome,
            product: ScannedProduct(
                id: ProductCode(id), name: name, created: false, manufacturer: nil, hasPrice: true),
            strays: strays
        )
    }
}

private func stray(_ entry: String, ambiguous: Bool = false) -> Stray {
    Stray(
        entryId: InventoryEntryCode(entry), locationId: LocationCode("LOC-9999"), locationName: "Elsewhere",
        ambiguousQuantity: ambiguous)
}

/// Waits until the session has nothing pending, or fails after a bounded time.
@MainActor
private func settle(_ session: ScanSession, timeout: Duration = .seconds(2)) async throws {
    let deadline = ContinuousClock.now + timeout
    while session.pendingCount > 0 {
        try #require(ContinuousClock.now < deadline, "session never settled")
        try await Task.sleep(for: .milliseconds(5))
    }
}

@Suite("ScanSession")
@MainActor
struct ScanSessionTests {
    let shelf = LocationCode("LOC-2345")

    @Test func scansDrainOneAtATime() async throws {
        let service = StubScanService { _, _ in
            try await Task.sleep(for: .milliseconds(20))
            return StubScanService.result(.added)
        }
        let session = ScanSession(service: service, location: shelf)
        session.submit("012345678905")
        session.submit("4006381333931")
        session.submit("12345678")
        try await settle(session)
        #expect(service.maxActive == 1)
        #expect(service.calls.count == 3)
        #expect(session.tally.added == 3)
    }

    @Test func staleAnchorResultsAreDiscarded() async throws {
        let service = StubScanService { _, _ in
            try await Task.sleep(for: .milliseconds(50))
            return StubScanService.result(.queued, strays: [stray("INV-2345")])
        }
        let session = ScanSession(service: service, location: shelf)
        session.submit("012345678905")
        // Wait until the lookup is genuinely in flight, then walk to the next shelf before it
        // returns. Changing location earlier would empty the queue, which is a different path.
        let deadline = ContinuousClock.now + .seconds(2)
        while service.calls.isEmpty {
            try #require(ContinuousClock.now < deadline, "scan never started")
            try await Task.sleep(for: .milliseconds(2))
        }
        session.location = LocationCode("LOC-3456")
        try await Task.sleep(for: .milliseconds(120))
        #expect(session.strays.isEmpty)
        #expect(session.chips.isEmpty)
        #expect(session.pendingCount == 0)
        #expect(service.calls.first?.1 == shelf)
    }

    @Test func chipsAreNewestFirstAndCapped() async throws {
        let service = StubScanService { _, _ in StubScanService.result(.confirmed) }
        let session = ScanSession(service: service, location: shelf)
        for i in 0..<7 {
            session.submit("0000000000\(String(format: "%02d", i))", at: .now + Double(i) * 10)
        }
        try await settle(session)
        #expect(session.chips.count == ScanSession.recentLimit)
        #expect(session.tally.confirmed == 7)
        #expect(session.tally.added == 0)
    }

    @Test func straysAreDedupedByProduct() async throws {
        let service = StubScanService { _, _ in
            StubScanService.result(.queued, strays: [stray("INV-2345"), stray("INV-3456", ambiguous: true)])
        }
        let session = ScanSession(service: service, location: shelf)
        session.submit("012345678905", at: .now)
        session.submit("012345678905", at: .now + 5)
        try await settle(session)
        #expect(session.strays.count == 1)
        #expect(session.chips.allSatisfy { $0.status == .queued })

        let resolution = try await session.resolveStrays()
        #expect(resolution?.moved == 2)
        #expect(session.strays.isEmpty)
    }

    @Test func failuresMarkTheChipAndKeepTheSessionAlive() async throws {
        let service = StubScanService { _, _ in
            throw CubbyAPIError(status: 500, operationID: "inventory.scanAtLocation", detail: nil)
        }
        let session = ScanSession(service: service, location: shelf)
        session.submit("012345678905")
        try await settle(session)
        #expect(session.chips.first?.status == .failed("HTTP 500"))
        #expect(session.lastError == "HTTP 500")

        session.submit("hello")
        try await settle(session)
        #expect(session.chips.first?.status == .failed(ScanCodeError.unrecognized.message))
        #expect(service.calls.count == 1)
    }

    @Test func repeatReadsWithinTheDebounceWindowAreIgnored() async throws {
        let service = StubScanService { _, _ in StubScanService.result(.added) }
        let session = ScanSession(service: service, location: shelf)
        let t0 = Date()
        #expect(session.submit("012345678905", at: t0))
        #expect(!session.submit("012345678905", at: t0 + 0.5))
        #expect(session.submit("012345678905", at: t0 + 3))
        try await settle(session)
        #expect(service.calls.count == 2)
    }

    @Test func noLocationMeansNoScan() {
        let service = StubScanService { _, _ in StubScanService.result(.added) }
        let session = ScanSession(service: service)
        #expect(!session.submit("012345678905"))
        #expect(session.chips.isEmpty)
    }
}
