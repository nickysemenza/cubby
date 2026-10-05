import Foundation
import Testing

@testable import CubbyKit

/// `cubby companion --once` exits on this policy. Ways it could go wrong: exiting before the
/// socket ever connected, exiting while a command is queued, executing, or being recorded,
/// exiting before the server acknowledged a result, never exiting when the server is unreachable,
/// letting a reconnect or a job's activity hide a running command or a disconnection, keeping a
/// stale quiet clock across a reconnect, and reporting success when a job failed.
@Suite("CompanionDrainPolicy")
struct CompanionDrainPolicyTests {
    private let start = ContinuousClock.now
    private func at(_ seconds: Double) -> ContinuousClock.Instant { start + .seconds(seconds) }
    private func policy() -> CompanionDrainPolicy {
        CompanionDrainPolicy(idleWindow: .seconds(10), connectTimeout: .seconds(30), startedAt: start)
    }
    private func state(connected: Bool, outstanding: Int = 0, pending: Int = 0) -> CompanionDrainState {
        .init(connected: connected, outstandingCommands: outstanding, pendingResults: pending)
    }

    @Test func neverConnectingIsUnreachableOnlyAfterTheConnectTimeout() {
        var policy = policy()
        policy.observe(state(connected: false), at: at(0))
        #expect(policy.decision(at: at(29)) == .keepRunning)
        #expect(policy.decision(at: at(30)) == .unreachable)
    }

    @Test func aConnectedQuietWorkerDrainsAfterExactlyTheIdleWindow() {
        var policy = policy()
        policy.observe(state(connected: true), at: at(2))
        #expect(policy.decision(at: at(11.9)) == .keepRunning)
        #expect(policy.decision(at: at(12)) == .drained)
    }

    @Test func anOutstandingCommandHoldsTheExitAndTheWindowRestartsWhenItFinishes() {
        var policy = policy()
        policy.observe(state(connected: true), at: at(0))
        policy.observe(state(connected: true, outstanding: 1), at: at(1))
        #expect(policy.decision(at: at(60)) == .keepRunning)
        policy.observeJobFinished(.completed, at: at(60))
        policy.observe(state(connected: true), at: at(60))
        #expect(policy.decision(at: at(69)) == .keepRunning)
        #expect(policy.decision(at: at(70)) == .drained)
    }

    /// Regression: the worker keeps command tasks across a reconnect and reports idle on the new
    /// connection, so a reconnect must not read as "no job running".
    @Test func aCommandThatOutlivesAReconnectStillHoldsTheExit() {
        var policy = policy()
        policy.observe(state(connected: true, outstanding: 1), at: at(0))
        policy.observe(state(connected: false, outstanding: 1), at: at(5))
        policy.observe(state(connected: true, outstanding: 1), at: at(8))
        #expect(policy.decision(at: at(60)) == .keepRunning)
        policy.observe(state(connected: true, outstanding: 0, pending: 1), at: at(60))
        #expect(policy.decision(at: at(80)) == .keepRunning)
        policy.observe(state(connected: true), at: at(81))
        #expect(policy.decision(at: at(90)) == .keepRunning)
        #expect(policy.decision(at: at(91)) == .drained)
    }

    /// Regression: job activity while the socket is down must not clear the connect timeout.
    @Test func aCommandRunningWhileDisconnectedDoesNotResetTheConnectTimeout() {
        var policy = policy()
        policy.observe(state(connected: true), at: at(0))
        policy.observe(state(connected: false, outstanding: 1), at: at(10))
        policy.observe(state(connected: false, outstanding: 1), at: at(25))
        policy.observeJobFinished(.completed, at: at(30))
        policy.observe(state(connected: false, pending: 1), at: at(30))
        #expect(policy.decision(at: at(39)) == .keepRunning)
        #expect(policy.decision(at: at(40)) == .unreachable)
    }

    @Test func anUnacknowledgedResultHoldsTheExitUntilTheServerAcknowledgesIt() {
        var policy = policy()
        policy.observe(state(connected: true), at: at(0))
        policy.observe(state(connected: true, pending: 1), at: at(1))
        #expect(policy.decision(at: at(30)) == .keepRunning)
        policy.observe(state(connected: true), at: at(30))
        #expect(policy.decision(at: at(39)) == .keepRunning)
        #expect(policy.decision(at: at(40)) == .drained)
    }

    @Test func aRepeatedQuietSnapshotDoesNotRestartTheWindow() {
        var policy = policy()
        policy.observe(state(connected: true), at: at(0))
        policy.observe(state(connected: true), at: at(1))
        policy.observe(state(connected: true), at: at(5))
        #expect(policy.decision(at: at(10)) == .drained)
    }

    @Test func aDroppedConnectionRestartsTheWindowAndTimesOutIfItNeverReturns() {
        var policy = policy()
        policy.observe(state(connected: true), at: at(0))
        policy.observe(state(connected: false), at: at(8))
        #expect(policy.decision(at: at(12)) == .keepRunning)
        policy.observe(state(connected: true), at: at(15))
        #expect(policy.decision(at: at(24)) == .keepRunning)
        #expect(policy.decision(at: at(25)) == .drained)

        policy.observe(state(connected: false), at: at(26))
        #expect(policy.decision(at: at(55)) == .keepRunning)
        #expect(policy.decision(at: at(56)) == .unreachable)
    }

    @Test func onlyAFailedJobMakesTheRunUnsuccessful() {
        var policy = policy()
        policy.observeJobFinished(.completed, at: at(1))
        policy.observeJobFinished(.skipped, at: at(2))
        policy.observeJobFinished(.normalized, at: at(3))
        #expect(policy.failedJobs == 0)
        policy.observeJobFinished(.failed, at: at(4))
        #expect(policy.failedJobs == 1)
    }
}
