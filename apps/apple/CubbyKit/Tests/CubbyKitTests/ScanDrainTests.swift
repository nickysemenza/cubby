import Foundation
import Synchronization
import Testing

@testable import CubbyKit

@Suite("ScanDrain")
@MainActor
struct ScanDrainTests {
    let shelf = LocationCode("LOC-2345")

    @Test func worksRunOneAtATimeInOrder() async throws {
        let active = Mutex((now: 0, peak: 0))
        let started = Mutex<[String]>([])
        let gate = Gate()
        let drain = ScanDrain<String>(anchor: shelf) { read in
            active.withLock {
                $0.now += 1; $0.peak = max($0.peak, $0.now)
            }
            started.withLock { $0.append(read.raw) }
            try? await gate.pass()
            active.withLock { $0.now -= 1 }
            return read.raw
        }
        var settled: [String] = []
        drain.onSettle = { _, raw in settled.append(raw) }
        drain.submit("a", at: .now)
        drain.submit("b", at: .now + 5)
        drain.submit("c", at: .now + 10)
        #expect(drain.pendingCount == 3)
        await gate.arrivals(1)
        #expect(started.withLock { $0 } == ["a"])
        gate.release()
        await gate.arrivals(2)
        #expect(started.withLock { $0 } == ["a", "b"])
        gate.release()
        await gate.arrivals(3)
        #expect(started.withLock { $0 } == ["a", "b", "c"])
        gate.release()
        await drain.idle()
        #expect(drain.pendingCount == 0)
        #expect(active.withLock { $0.peak } == 1)
        #expect(settled == ["a", "b", "c"])
    }

    @Test func tokensIdentifyOutcomes() async throws {
        let drain = ScanDrain<String>(anchor: shelf) { $0.raw.uppercased() }
        var outcomes: [UUID: String] = [:]
        drain.onSettle = { token, value in outcomes[token] = value }
        let token = try #require(drain.submit("abc"))
        await drain.idle()
        #expect(outcomes[token] == "ABC")
    }

    @Test func anchorChangeDropsQueuedAndInFlightOutcomes() async throws {
        let gate = Gate()
        let drain = ScanDrain<String>(anchor: shelf) { read in
            try? await gate.pass()
            return read.raw
        }
        var settled: [String] = []
        drain.onSettle = { _, raw in settled.append(raw) }
        drain.submit("in-flight", at: .now)
        drain.submit("queued", at: .now + 5)
        await gate.arrivals(1)
        drain.anchor = LocationCode("LOC-3456")
        #expect(drain.pendingCount == 0)
        gate.open()
        await drain.idle()
        #expect(settled.isEmpty)
        #expect(drain.pendingCount == 0)
        #expect(gate.arrived == 1)
    }

    @Test func debounceIgnoresARepeatInsideTheWindow() async throws {
        let drain = ScanDrain<String>(anchor: shelf, debounceInterval: 1.5) { $0.raw }
        let t0 = Date()
        #expect(drain.submit("x", at: t0) != nil)
        #expect(drain.submit("x", at: t0 + 0.5) == nil)
        #expect(drain.submit("y", at: t0 + 0.6) != nil)
        #expect(drain.submit("x", at: t0 + 3) != nil)
        await drain.idle()
    }

    @Test func noAnchorMeansNothingQueues() {
        let drain = ScanDrain<String> { $0.raw }
        #expect(drain.submit("x") == nil)
        #expect(drain.pendingCount == 0)
    }
}
