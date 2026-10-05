import Foundation
import Testing

@testable import CubbyKit

@Suite("CompanionImageWorker")
struct CompanionImageWorkerTests {
    @Test func helloUsesTheSuppliedCreationHint() {
        let message = ImageProcessingClientMessage.companionHello(
            deviceID: UUID(), deviceName: "Kitchen phone", foreground: true,
            imageDescriptionAvailable: false, automaticWork: true)
        guard case .hello(let hello) = message else {
            Issue.record("Expected a companion hello")
            return
        }
        #expect(hello.deviceName == "Kitchen phone")
    }

    private func outbox() throws -> CompanionResultOutbox<ImageProcessingResult> {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return CompanionResultOutbox<ImageProcessingResult>(
            fileURL: directory.appendingPathComponent("outbox.json"))
    }

    private func credentials(bearer: String?) throws -> CredentialProvider {
        let store = InMemorySessionTokenStore()
        if let bearer { try store.save(.bearer(bearer), for: "localhost:3000") }
        return CredentialProvider(host: "localhost:3000", store: store)
    }

    // MARK: - Participation off never opens a socket

    /// `platformAllowsConnection` folds `isParticipating` in, so `reconcileConnection()` returns
    /// before `runConnectionLoop` ever calls `runOneConnection` — the only place a failure (auth or
    /// network) could surface. Contrast with `participatingWorkerAttemptsAConnectionAndSurfacesTheFailure`
    /// below, which proves this suite's failure-observation signal actually fires when a connection
    /// is attempted, so a passing "no failures" here is not vacuous.
    @Test func participationOffNeverAttemptsAConnection() async throws {
        let failures = FailureBox()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: "tok"),
            deviceID: UUID(),
            deviceName: "Test phone",
            foreground: true,
            isParticipating: false,
            outbox: try outbox(),
            failureObserver: { error in Task { await failures.record(error) } })
        await worker.start()
        try await Task.sleep(for: .milliseconds(200))
        await worker.stop()
        #expect(await failures.count == 0)
    }

    /// No credential is saved, so `runOneConnection` throws `URLError.userAuthenticationRequired`
    /// before any network I/O — deterministic, and not on `AuthenticatedSocketSupport`'s expected
    /// reconnect-failure allowlist, so it reaches `failureObserver`.
    @Test func participatingWorkerAttemptsAConnectionAndSurfacesTheFailure() async throws {
        let failures = FailureBox()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: nil),
            deviceID: UUID(),
            deviceName: "Test phone",
            foreground: true,
            isParticipating: true,
            outbox: try outbox(),
            failureObserver: { error in Task { await failures.record(error) } })
        await worker.start()
        for _ in 0..<100 {
            if await failures.count > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        await worker.stop()
        #expect(await failures.count > 0)
    }

    // MARK: - helloAck remotePaused → no work accepted

    @Test func remotePausedRejectsWorkAndUnpausedAcceptsIt() {
        #expect(!CompanionWorkAcceptance.acceptsCommand(remotePaused: true))
        #expect(CompanionWorkAcceptance.acceptsCommand(remotePaused: false))
    }

    @Test func activityCarriesRemotePausedForSettingsToShow() {
        let paused = CompanionImageWorkerActivity(phase: .idle, remotePaused: true)
        #expect(paused.remotePaused)
        let notPaused = CompanionImageWorkerActivity(phase: .idle)
        #expect(!notPaused.remotePaused)
    }

    // MARK: - Drain state

    /// Regression: the worker reports idle before it records the result, so `cubby companion`
    /// stopped on a stale "nothing pending" while a finished result was still unrecorded. Every
    /// drain-state read must count a finished command as outstanding, pending, or both until the server
    /// acknowledges it.
    @Test func drainStateCountsACommandUntilItsResultIsDurablyRecorded() async throws {
        let gate = ExecutionGate()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true, isParticipating: false,
            outbox: try outbox(), execute: { await gate.run($0) })
        await worker.startCommand(try describeCommand(), socket: nil)
        while !(await gate.started) { try await Task.sleep(for: .milliseconds(2)) }
        #expect(
            try await worker.drainState()
                == .init(connected: false, outstandingCommands: 1, pendingResults: 0))

        await gate.release()
        for _ in 0..<500 {
            let state = try await worker.drainState()
            #expect(state.outstandingCommands + state.pendingResults >= 1)
            if state.outstandingCommands == 0 { break }
            await Task.yield()
        }
        #expect(
            try await worker.drainState()
                == .init(connected: false, outstandingCommands: 0, pendingResults: 1))
    }

    /// Regression: `drainState()` read the command count before awaiting the outbox, so a command
    /// accepted during that await ran uncounted and shutdown cancelled it. A settled answer must
    /// also close acceptance, so nothing can start between "settled" and the caller's `stop()`.
    @Test func aSettledAnswerMeansNoCommandRunsUntilAcceptanceResumes() async throws {
        for _ in 0..<100 {
            let executions = ExecutionCounter()
            let worker = CompanionImageWorker(
                baseURL: URL(string: "http://localhost:3000")!,
                credentials: try credentials(bearer: "tok"),
                deviceID: UUID(), deviceName: "Test phone", foreground: true, isParticipating: false,
                outbox: try outbox(), execute: { await executions.run($0) })
            let command = try describeCommand()
            async let settled = worker.pauseAcceptingIfSettled()
            async let started: Void = worker.startCommand(command, socket: nil)
            let wasSettled = try await settled
            await started
            for _ in 0..<20 { await Task.yield() }
            if wasSettled {
                #expect(await executions.count == 0)
                #expect(try await worker.drainState().outstandingCommands == 0)
            }
        }
    }

    @Test func anUnsettledAnswerKeepsAcceptingAndRunsDeferredCommands() async throws {
        let gate = ExecutionGate()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true, isParticipating: false,
            outbox: try outbox(), execute: { await gate.run($0) })
        await worker.startCommand(try describeCommand(), socket: nil)
        while !(await gate.started) { try await Task.sleep(for: .milliseconds(2)) }
        #expect(try await worker.pauseAcceptingIfSettled() == false)
        await gate.release()
        while try await worker.drainState().outstandingCommands > 0 {
            try await Task.sleep(for: .milliseconds(2))
        }
        // A pending (unacknowledged) result still means not settled.
        #expect(try await worker.pauseAcceptingIfSettled() == false)
    }

    @Test func stoppingAcceptanceDefersNewCommandsForGood() async throws {
        let executions = ExecutionCounter()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true, isParticipating: false,
            outbox: try outbox(), execute: { await executions.run($0) })
        await worker.stopAccepting()
        await worker.startCommand(try describeCommand(), socket: nil)
        #expect(try await worker.pauseAcceptingIfSettled())
        for _ in 0..<20 { await Task.yield() }
        #expect(await executions.count == 0)
    }

    private func describeCommand() throws -> ImageProcessingCommand {
        let value = """
            {"kind":"describe_image","jobId":"00000000-0000-4000-8000-000000000001","attemptId":"00000000-0000-4000-8000-000000000002","deadline":"2099-01-01T00:00:00Z","source":{"url":"https://example.test/panel.jpg","sha256":"\(String(repeating: "a", count: 64))","contentType":"image/jpeg"},"promptRevision":1,"resultSchemaRevision":1}
            """
        return try JSONDecoder.companionImageProcessing.decode(
            ImageProcessingCommand.self, from: Data(value.utf8))
    }
}

private actor ExecutionCounter {
    private(set) var count = 0

    func run(_ command: ImageProcessingCommand) -> ImageProcessingResult {
        count += 1
        return .init(
            jobId: command.companionJobID, attemptId: command.companionAttemptID, completedAt: .now,
            outcome: .init(
                value3: .init(
                    kind: .describeImage, status: .failed, retryable: true, reason: "Synthetic failure")))
    }
}

private actor ExecutionGate {
    private(set) var started = false
    private var waiter: CheckedContinuation<Void, Never>?

    func run(_ command: ImageProcessingCommand) async -> ImageProcessingResult {
        started = true
        await withCheckedContinuation { waiter = $0 }
        return .init(
            jobId: command.companionJobID, attemptId: command.companionAttemptID, completedAt: .now,
            outcome: .init(
                value3: .init(
                    kind: .describeImage, status: .failed, retryable: true, reason: "Synthetic failure")))
    }

    func release() {
        waiter?.resume()
        waiter = nil
    }
}

private actor FailureBox {
    private(set) var count = 0
    func record(_ error: any Error) { count += 1 }
}
