import Foundation
import Testing

@testable import CubbyKit

/// `cubby companion --once` exits on this policy. Ways it could go wrong: exiting before the
/// socket ever connected, exiting while a job is still running, exiting before the server
/// acknowledged a result (it would replay on the next run, but the run reports "done" early),
/// never exiting when the server is unreachable, keeping a stale quiet clock across a reconnect,
/// and reporting success when a job failed.
@Suite("CompanionDrainPolicy")
struct CompanionDrainPolicyTests {
    private let start = ContinuousClock.now
    private func at(_ seconds: Double) -> ContinuousClock.Instant { start + .seconds(seconds) }
    private func policy() -> CompanionDrainPolicy {
        CompanionDrainPolicy(idleWindow: .seconds(10), connectTimeout: .seconds(30), startedAt: start)
    }

    @Test func neverConnectingIsUnreachableOnlyAfterTheConnectTimeout() {
        var policy = policy()
        policy.observe(.init(phase: .connecting), at: at(0))
        #expect(policy.decision(at: at(29)) == .keepRunning)
        #expect(policy.decision(at: at(30)) == .unreachable)
    }

    @Test func aConnectedQuietWorkerDrainsAfterExactlyTheIdleWindow() {
        var policy = policy()
        policy.observe(.init(phase: .idle), at: at(2))
        #expect(policy.decision(at: at(11.9)) == .keepRunning)
        #expect(policy.decision(at: at(12)) == .drained)
    }

    @Test func aRunningJobHoldsTheExitAndTheWindowRestartsWhenItFinishes() {
        var policy = policy()
        policy.observe(.init(phase: .idle), at: at(0))
        policy.observe(.init(phase: .processing, jobID: "job-1", kind: "describe_image"), at: at(1))
        #expect(policy.decision(at: at(60)) == .keepRunning)
        policy.observeJobFinished(.completed, at: at(60))
        policy.observe(.init(phase: .idle), at: at(60))
        #expect(policy.decision(at: at(69)) == .keepRunning)
        #expect(policy.decision(at: at(70)) == .drained)
    }

    @Test func anUnacknowledgedResultHoldsTheExitUntilTheServerAcknowledgesIt() {
        var policy = policy()
        policy.observe(.init(phase: .idle), at: at(0))
        policy.observePendingResults(1, at: at(1))
        #expect(policy.decision(at: at(30)) == .keepRunning)
        policy.observePendingResults(0, at: at(30))
        #expect(policy.decision(at: at(39)) == .keepRunning)
        #expect(policy.decision(at: at(40)) == .drained)
    }

    @Test func aRepeatedIdleReportDoesNotRestartTheWindow() {
        var policy = policy()
        policy.observe(.init(phase: .idle), at: at(0))
        // The worker reports idle once after hello and again on helloAck.
        policy.observe(.init(phase: .idle), at: at(1))
        policy.observePendingResults(0, at: at(5))
        #expect(policy.decision(at: at(10)) == .drained)
    }

    @Test func aDroppedConnectionRestartsTheWindowAndTimesOutIfItNeverReturns() {
        var policy = policy()
        policy.observe(.init(phase: .idle), at: at(0))
        policy.observe(.init(phase: .connecting), at: at(8))
        #expect(policy.decision(at: at(12)) == .keepRunning)
        policy.observe(.init(phase: .idle), at: at(15))
        #expect(policy.decision(at: at(24)) == .keepRunning)
        #expect(policy.decision(at: at(25)) == .drained)

        policy.observe(.init(phase: .connecting), at: at(26))
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
