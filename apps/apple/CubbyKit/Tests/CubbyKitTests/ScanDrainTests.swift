import Foundation
import Synchronization
import Testing

@testable import CubbyKit

@MainActor
private func waitUntil(
    timeout: Duration = .seconds(30),
    _ condition: @MainActor () -> Bool
) async throws {
    let deadline = ContinuousClock.now + timeout
    while !condition() {
        try #require(ContinuousClock.now < deadline, "condition never became true")
        try await Task.sleep(for: .milliseconds(5))
    }
}

@MainActor
private func settle<T: Sendable>(_ drain: ScanDrain<T>) async throws {
    try await waitUntil { drain.pendingCount == 0 }
}

@MainActor
private final class ScanWorkGate {
    private(set) var started: [String] = []
    private var releases: [CheckedContinuation<Void, Never>] = []

    func pause(_ raw: String) async {
        started.append(raw)
        await withCheckedContinuation { releases.append($0) }
    }

    func releaseFirst() {
        releases.removeFirst().resume()
    }
}

@Suite("ScanDrain", .serialized)
@MainActor
struct ScanDrainTests {
    let shelf = LocationCode("LOC-2345")

    @Test(.timeLimit(.minutes(1))) func worksRunOneAtATimeInOrder() async throws {
        let active = Mutex((now: 0, peak: 0))
        let gate = ScanWorkGate()
        let drain = ScanDrain<String>(anchor: shelf) { read in
            active.withLock {
                $0.now += 1; $0.peak = max($0.peak, $0.now)
            }
            await gate.pause(read.raw)
            active.withLock { $0.now -= 1 }
            return read.raw
        }
        var settled: [String] = []
        drain.onSettle = { _, raw in settled.append(raw) }
        drain.submit("a", at: .now)
        drain.submit("b", at: .now + 5)
        drain.submit("c", at: .now + 10)
        #expect(drain.pendingCount == 3)
        try await waitUntil { gate.started.count >= 1 }
        #expect(gate.started == ["a"])
        gate.releaseFirst()
        try await waitUntil { gate.started.count >= 2 }
        #expect(gate.started == ["a", "b"])
        gate.releaseFirst()
        try await waitUntil { gate.started.count >= 3 }
        #expect(gate.started == ["a", "b", "c"])
        gate.releaseFirst()
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
