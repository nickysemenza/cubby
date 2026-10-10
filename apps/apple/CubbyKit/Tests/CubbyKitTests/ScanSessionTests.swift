import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// A scan service whose behaviour each test scripts. Records the maximum number of in-flight
/// scans so serialization is observable, and can hold a scan open until released.
final class StubScanService: ScanService, Sendable {
    typealias Responder = @Sendable (String, LocationCode) async throws -> ScanAtLocationOut

    private let state = Mutex<(active: Int, maxActive: Int, calls: [(String, LocationCode)])>((0, 0, []))
    let responder: Mutex<Responder>

    init(_ responder: @escaping Responder) {
        self.responder = Mutex(responder)
    }

    var maxActive: Int { state.withLock { $0.maxActive } }
    var calls: [(String, LocationCode)] { state.withLock { $0.calls } }

    func scan(raw: String, at location: LocationCode) async throws -> ScanAtLocationOut {
        state.withLock {
            $0.active += 1
            $0.maxActive = max($0.maxActive, $0.active)
            $0.calls.append((raw, location))
        }
        defer { state.withLock { $0.active -= 1 } }
        let responder = responder.withLock { $0 }
        return try await responder(raw, location)
    }

    func resolveStrays(to target: LocationCode, moves: [StrayMove]) async throws -> ResolveScanStraysOut {
        ResolveScanStraysOut(moved: moves.count, skipped: [], sideEffects: .init())
    }

    static func result(
        _ outcome: ScanAtLocationOut.OutcomePayload, id: String = "PRD-2345", name: String = "Sample",
        strays: [ScanStrayOut] = []
    ) -> ScanAtLocationOut {
        ScanAtLocationOut(
            outcome: outcome,
            product: .init(
                id: ProductCode(id), name: name, created: false, manufacturer: nil, hasPrice: true),
            strays: strays,
            sideEffects: .init()
        )
    }
}

private func stray(_ entry: String, ambiguous: Bool = false) -> ScanStrayOut {
    ScanStrayOut(
        entryId: InventoryEntryCode(entry), location: .init(id: LocationCode("LOC-9999"), name: "Elsewhere"),
        amount: Amount(value: 1, unit: "each"), ambiguousQuantity: ambiguous)
}

@Suite("ScanSession", .timeLimit(.minutes(1)))
@MainActor
struct ScanSessionTests {
    let shelf = LocationCode("LOC-2345")

    @Test func shelfAnnotationsFollowWhatEachCodeResolvedTo() async throws {
        let service = StubScanService { raw, _ in
            raw == "4006381333931"
                ? StubScanService.result(.queued, id: "PRD-3456", name: "Elsewhere Thing")
                : StubScanService.result(.added, name: "Bulbs")
        }
        let session = ScanSession(service: service, location: shelf)
        #expect(session.annotation(forScanned: "012345678905") == nil)
        session.submit("012345678905")
        #expect(session.annotation(forScanned: "012345678905")?.tone == .pending)
        await session.idle()
        session.submit("012345678905", at: .now + 10)
        session.submit("4006381333931")
        await session.idle()

        // A UPC-A read and its zero-padded spelling are the same entry.
        #expect(
            session.annotation(forScanned: "012345678905")
                == ShelfAnnotation(title: "Bulbs", detail: "Added ×2", tone: .verified))
        #expect(session.annotation(forScanned: "4006381333931")?.tone == .unexpected)
        #expect(session.annotation(forScanned: "LOC-2345") == nil)

        session.reset()
        #expect(session.annotation(forScanned: "012345678905") == nil)
    }

    @Test func staleAnchorResultsAreDiscarded() async throws {
        let lookup = Gate()
        let service = StubScanService { _, _ in
            try await lookup.pass()
            return StubScanService.result(.queued, strays: [stray("INV-2345")])
        }
        let session = ScanSession(service: service, location: shelf)
        session.submit("012345678905")
        // Walk to the next shelf while the lookup is in flight. Changing location before it starts
        // would empty the queue, which is a different path.
        await lookup.arrivals(1)
        session.location = LocationCode("LOC-3456")
        lookup.open()
        await session.idle()
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
        await session.idle()
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
        await session.idle()
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
        await session.idle()
        #expect(session.chips.first?.status == .failed("HTTP 500"))
        #expect(session.lastError == "HTTP 500")

        // The server classifies every read; an unreadable one is its validation error.
        service.responder.withLock { responder in
            responder = { _, _ in
                throw CubbyAPIError(
                    status: 400, operationID: "inventory.scanAtLocation",
                    detail: .init(
                        code: "VALIDATION",
                        message: "Use a Cubby shortcode, UPC/EAN/GTIN barcode, or valid ISBN.",
                        reason: nil, requestId: nil))
            }
        }
        session.submit("hello")
        await session.idle()
        #expect(
            session.chips.first?.status
                == .failed("Use a Cubby shortcode, UPC/EAN/GTIN barcode, or valid ISBN."))
        #expect(service.calls.count == 2)
    }

    @Test func repeatReadsWithinTheDebounceWindowAreIgnored() async throws {
        let service = StubScanService { _, _ in StubScanService.result(.added) }
        let session = ScanSession(service: service, location: shelf)
        let t0 = Date()
        #expect(session.submit("012345678905", at: t0))
        #expect(!session.submit("012345678905", at: t0 + 0.5))
        #expect(session.submit("012345678905", at: t0 + 3))
        await session.idle()
        #expect(service.calls.count == 2)
    }

    @Test func noLocationMeansNoScan() {
        let service = StubScanService { _, _ in StubScanService.result(.added) }
        let session = ScanSession(service: service)
        #expect(!session.submit("012345678905"))
        #expect(session.chips.isEmpty)
    }
}
