import Foundation
import Synchronization
import Testing

@testable import CubbyKit

@MainActor
private func settle<T: Sendable>(_ drain: ScanDrain<T>, timeout: Duration = .seconds(2)) async throws {
    let deadline = ContinuousClock.now + timeout
    while drain.pendingCount > 0 {
        try #require(ContinuousClock.now < deadline, "drain never settled")
        try await Task.sleep(for: .milliseconds(5))
    }
}

// Cases schedule a MainActor-owned drain through child Tasks. Run this suite serially so a
// neighboring case cannot starve a drain past its condition-based timeout on a loaded CI runner.
@Suite("ScanDrain", .serialized)
@MainActor
struct ScanDrainTests {
    let shelf = LocationCode("LOC-2345")

    @Test func worksRunOneAtATimeInOrder() async throws {
        let active = Mutex((now: 0, peak: 0))
        let drain = ScanDrain<String>(anchor: shelf) { read in
            active.withLock {
                $0.now += 1; $0.peak = max($0.peak, $0.now)
            }
            try? await Task.sleep(for: .milliseconds(10))
            active.withLock { $0.now -= 1 }
            return read.raw
        }
        var settled: [String] = []
        drain.onSettle = { _, raw in settled.append(raw) }
        drain.submit("a", at: .now)
        drain.submit("b", at: .now + 5)
        drain.submit("c", at: .now + 10)
        #expect(drain.pendingCount == 3)
        try await settle(drain)
        #expect(active.withLock { $0.peak } == 1)
        #expect(settled == ["a", "b", "c"])
    }

    @Test func tokensIdentifyOutcomes() async throws {
        let drain = ScanDrain<String>(anchor: shelf) { $0.raw.uppercased() }
        var outcomes: [UUID: String] = [:]
        drain.onSettle = { token, value in outcomes[token] = value }
        let token = try #require(drain.submit("abc"))
        try await settle(drain)
        #expect(outcomes[token] == "ABC")
    }

    @Test func anchorChangeDropsQueuedAndInFlightOutcomes() async throws {
        let started = Mutex(false)
        let drain = ScanDrain<String>(anchor: shelf) { read in
            started.withLock { $0 = true }
            try? await Task.sleep(for: .milliseconds(50))
            return read.raw
        }
        var settled: [String] = []
        drain.onSettle = { _, raw in settled.append(raw) }
        drain.submit("in-flight", at: .now)
        drain.submit("queued", at: .now + 5)
        let deadline = ContinuousClock.now + .seconds(2)
        while !started.withLock({ $0 }) {
            try #require(ContinuousClock.now < deadline, "work never started")
            try await Task.sleep(for: .milliseconds(2))
        }
        drain.anchor = LocationCode("LOC-3456")
        #expect(drain.pendingCount == 0)
        try await Task.sleep(for: .milliseconds(120))
        #expect(settled.isEmpty)
        #expect(drain.pendingCount == 0)
    }

    @Test func debounceIgnoresARepeatInsideTheWindow() async throws {
        let drain = ScanDrain<String>(anchor: shelf, debounceInterval: 1.5) { $0.raw }
        let t0 = Date()
        #expect(drain.submit("x", at: t0) != nil)
        #expect(drain.submit("x", at: t0 + 0.5) == nil)
        #expect(drain.submit("y", at: t0 + 0.6) != nil)
        #expect(drain.submit("x", at: t0 + 3) != nil)
        try await settle(drain)
    }

    @Test func noAnchorMeansNothingQueues() {
        let drain = ScanDrain<String> { $0.raw }
        #expect(drain.submit("x") == nil)
        #expect(drain.pendingCount == 0)
    }
}
