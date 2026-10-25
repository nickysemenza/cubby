import Foundation
import Synchronization
import Testing

@testable import CubbyKit

// A completed result survives a failed HTTP send; cancellation releases the assigned capability
// instead of writing a failed result that can consume the next background window's work.
@Suite("Companion image background window", .timeLimit(.minutes(1)))
struct CompanionImageBackgroundTests {
    private func command(
        job: String = "00000000-0000-4000-8000-000000000001",
        attempt: String = "00000000-0000-4000-8000-000000000002"
    ) throws -> ImageProcessingCommand {
        let value = """
            {"kind":"describe_image","jobId":"\(job)","attemptId":"\(attempt)","deadline":"2099-01-01T00:00:00Z","source":{"url":"https://example.test/panel.jpg","sha256":"\(String(repeating: "a", count: 64))","contentType":"image/jpeg"},"promptRevision":1,"resultSchemaRevision":1}
            """
        return try JSONDecoder.companionImageProcessing.decode(
            ImageProcessingCommand.self, from: Data(value.utf8))
    }
    private func hello() -> ImageProcessingHello {
        .companion(
            deviceID: UUID(), deviceName: "Synthetic phone", foreground: false,
            imageDescriptionAvailable: true, automaticWork: true)
    }
    private func outboxFile() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "companion-background-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("outbox.json")
    }
    @Test func replayAcknowledgesWithoutRepeatingExecution() async throws {
        let command = try command()
        let transport = BackgroundTransportFixture(commands: [command], failFirstCompletion: true)
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let executions = BackgroundExecutionFixture()
        let runner = CompanionImageBackgroundRunner(
            outbox: outbox,
            execute: { command in
                try await executions.complete(command)
            })
        await runner.run(transport: transport, hello: hello(), maximumJobs: 1)
        #expect(try await outbox.pending().count == 1)
        let restored = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        let replayRunner = CompanionImageBackgroundRunner(
            outbox: restored,
            execute: { command in
                try await executions.complete(command)
            })
        await replayRunner.run(transport: transport, hello: hello(), maximumJobs: 1)
        #expect(try await restored.pending().isEmpty)
        #expect(await executions.count == 1)
        #expect(await transport.completionCount == 2)
    }
    /// Regression: a charging-window claim asked for up to 90 s and was never renewed, so a slow
    /// command outlived its lease. It now claims the resident 60 s lease and heartbeats, and the
    /// executor's deadline moves with each accepted renewal.
    @Test func aBackgroundClaimUsesTheResidentLeaseAndRenews() async throws {
        let renewedUntil = Date(timeIntervalSince1970: 4_070_908_860)
        let transport = BackgroundTransportFixture(
            commands: [try command()], renewal: .renewed(leaseExpiresAt: renewedUntil))
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let heartbeat = Gate()
        let execution = Gate()
        let observed = LeaseDeadlineFixture()
        let runner = CompanionImageBackgroundRunner(
            outbox: outbox,
            execute: { command in
                try await execution.pass()
                await observed.record(CompanionCommandLease.current?.deadline)
                return try await BackgroundExecutionFixture().complete(command)
            },
            heartbeatPause: { try await heartbeat.pass() })
        let task = Task { await runner.run(transport: transport, hello: hello(), maximumJobs: 1) }
        await execution.arrivals(1)
        await heartbeat.arrivals(1)
        heartbeat.release()
        // The second pause starts only after the first renewal was applied.
        await heartbeat.arrivals(2)
        execution.release()
        _ = await task.value
        #expect(await transport.leaseSeconds == [CompanionImageProcessingProtocol.residentLeaseSeconds])
        #expect(await transport.renewCount == 1)
        #expect(await observed.deadline == renewedUntil)
        #expect(await transport.completionCount == 1)
    }

    /// A refused renewal stops the command: nothing is recorded, delivered, or released.
    @Test func aRefusedBackgroundRenewalStopsTheCommandUnrecorded() async throws {
        let transport = BackgroundTransportFixture(
            commands: [try command()], renewal: .refused(reason: "lease_lost"))
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let heartbeat = Gate()
        let execution = Gate()
        let runner = CompanionImageBackgroundRunner(
            outbox: outbox,
            execute: { command in
                try await execution.pass()
                return try await BackgroundExecutionFixture().complete(command)
            },
            heartbeatPause: { try await heartbeat.pass() })
        let task = Task { await runner.run(transport: transport, hello: hello(), maximumJobs: 1) }
        await execution.arrivals(1)
        await heartbeat.arrivals(1)
        heartbeat.release()
        _ = await task.value
        #expect(await transport.renewCount == 1)
        #expect(await transport.releaseCount == 0)
        #expect(await transport.completionCount == 0)
        #expect(try await outbox.pending().isEmpty)
    }

    /// Regression: one result the server kept rejecting threw out of every charging window before
    /// its pull, and each later window retried it first. It is set aside under the worker's
    /// backoff (kept on disk) while deliveries and pulls go on.
    @Test func aRejectedResultIsSetAsideWhileTheWindowKeepsPulling() async throws {
        let stuckJob = "00000000-0000-4000-8000-0000000000aa"
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let stuck = try await BackgroundExecutionFixture().complete(try command(job: stuckJob))
        try await outbox.record(stuck, for: "\(stuckJob):stuck")
        let second = "00000000-0000-4000-8000-000000000003"
        let transport = BackgroundTransportFixture(
            commands: [try command(), try command(attempt: second)], rejectedJobs: [stuckJob])
        let runner = CompanionImageBackgroundRunner(
            outbox: outbox, execute: { try await BackgroundExecutionFixture().complete($0) })
        await runner.run(transport: transport, hello: hello(), maximumJobs: 1)
        #expect(await transport.pullCount == 1)
        #expect(await transport.deliveredAttempts == ["00000000-0000-4000-8000-000000000002"])
        #expect(try await outbox.pending().map(\.key) == ["\(stuckJob):stuck"])
        // The next window does not retry it during its backoff, and still pulls and delivers.
        await runner.run(transport: transport, hello: hello(), maximumJobs: 1)
        #expect(await transport.rejectedCount == 1)
        #expect(
            await transport.deliveredAttempts == ["00000000-0000-4000-8000-000000000002", second])
        #expect(try await outbox.pending().map(\.key) == ["\(stuckJob):stuck"])
    }

    /// Regression: a 426 on a background renewal was logged and ignored, so the command kept
    /// running, the window reported resumable, and every later window tried again. It stops the
    /// command, latches the worker's update-required state, and no later window starts.
    @Test func aBackgroundUpdateRefusalStopsExecutionAndLatchesTheWorker() async throws {
        let refusal = CubbyAPIError(
            status: CubbyAPIError.clientUpdateRequiredStatus, operationID: "imageProcessing.renew",
            detail: nil)
        let transport = BackgroundTransportFixture(commands: [try command()], renewError: refusal)
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let heartbeat = Gate()
        let execution = Gate()
        let phases = PhaseFixture()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://127.0.0.1:9")!,
            credentials: CredentialProvider(host: "example.test", store: InMemorySessionTokenStore()),
            deviceID: UUID(), deviceName: "Synthetic phone", foreground: false, outbox: outbox,
            transport: transport, activityObserver: { phases.record($0.phase) },
            execute: { command in
                try await execution.pass()
                return try await BackgroundExecutionFixture().complete(command)
            },
            heartbeatPause: { try await heartbeat.pass() })
        await worker.start()
        let hello = hello()
        let run = Task { await worker.runInBackground(transport: transport, hello: hello) }
        await execution.arrivals(1)
        await heartbeat.arrivals(1)
        heartbeat.release()
        #expect(await run.value == false)
        #expect(await worker.isUpdateRequired)
        #expect(phases.latest == .updateRequired)
        #expect(await transport.releaseCount == 0)
        #expect(await transport.completionCount == 0)
        // No later window pulls.
        #expect(await worker.runInBackground(transport: transport, hello: hello) == false)
        #expect(await transport.pullCount == 1)
        await worker.stop()
    }

    @Test func cancellationReleasesAndKeepsTheOutboxEmpty() async throws {
        let command = try command()
        let transport = BackgroundTransportFixture(commands: [command])
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let execution = Gate()
        let runner = CompanionImageBackgroundRunner(
            outbox: outbox,
            execute: { command in
                // Cancellation is the fixture's stop signal.
                try? await execution.pass()
                return try await BackgroundExecutionFixture().complete(command)
            })
        let task = Task { await runner.run(transport: transport, hello: hello(), maximumJobs: 1) }
        await execution.arrivals(1)
        task.cancel()
        await task.value
        #expect(await transport.releaseCount == 1)
        #expect(try await outbox.pending().isEmpty)
    }

    @Test func signOutWaitsForCancelledBackgroundCleanupBeforeDiscardingResults() async throws {
        let command = try command()
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let result = try await BackgroundExecutionFixture().complete(command)
        try await outbox.record(result, for: "synthetic-pending")
        let credentials = CredentialProvider(host: "example.test", store: InMemorySessionTokenStore())
        let worker = CompanionImageWorker(
            baseURL: URL(string: "https://example.test")!, credentials: credentials,
            deviceID: UUID(), deviceName: "Synthetic phone", foreground: false, outbox: outbox)
        let transport = SignOutCleanupFixture()
        let completed = SignOutCompletionFixture()
        await worker.start()
        let hello = hello()
        let run = Task { await worker.runInBackground(transport: transport, hello: hello) }
        await transport.started.arrivals(1)
        let signOut = Task {
            try await worker.stopAndDiscardPendingResults()
            await completed.markFinished()
        }
        await transport.cancelled.arrivals(1)
        #expect(!(await completed.finished))
        #expect(try await outbox.pending().count == 1)
        await transport.finishCleanup()
        try await signOut.value
        _ = await run.value
        #expect(await completed.finished)
        #expect(try await outbox.pending().isEmpty)
    }

    @Test func cancellationDuringCompletionReleasesAndRetainsDurableResult() async throws {
        let command = try command()
        let transport = BackgroundTransportFixture(commands: [command], waitDuringCompletion: true)
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let runner = CompanionImageBackgroundRunner(
            outbox: outbox, execute: { command in try await BackgroundExecutionFixture().complete(command) })
        let task = Task { await runner.run(transport: transport, hello: hello(), maximumJobs: 1) }
        await transport.completion.arrivals(1)
        #expect(await transport.completionCount == 1)
        task.cancel()
        _ = await task.value
        #expect(await transport.releaseCount == 1)
        #expect(try await outbox.pending().count == 1)
    }
}

private actor SignOutCompletionFixture {
    private(set) var finished = false
    func markFinished() { finished = true }
}

private actor SignOutCleanupFixture: CompanionImageBackgroundTransport {
    let started = Gate()
    let cancelled = Gate()
    private var cleanup: CheckedContinuation<Void, Never>?
    func pull(hello: ImageProcessingHello, leaseSeconds: Int) async throws
        -> PullCompanionImageProcessingOutput
    {
        .init(command: nil, remotePaused: false)
    }
    func complete(deviceID: String, result: ImageProcessingResult) async throws {
        do { try await started.pass() } catch {
            cancelled.signal()
            await withCheckedContinuation { cleanup = $0 }
            throw CancellationError()
        }
    }
    func release(deviceID: String, claim: CompanionImageCommandClaim) async throws {}
    func renew(deviceID: String, claim: CompanionImageCommandClaim) async throws -> CompanionLeaseRenewal {
        .renewed(leaseExpiresAt: .distantFuture)
    }
    func finishCleanup() { cleanup?.resume(); cleanup = nil }
}

private actor BackgroundTransportFixture: CompanionImageBackgroundTransport {
    enum Failure: Error { case network }
    var commands: [ImageProcessingCommand]
    var failFirstCompletion: Bool
    var waitDuringCompletion: Bool
    let renewal: CompanionLeaseRenewal
    /// Fails every renewal with this error instead of answering `renewal`.
    let renewError: (any Error)?
    /// Results for these jobs are always refused.
    let rejectedJobs: Set<String>
    private(set) var completionCount = 0
    private(set) var rejectedCount = 0
    private(set) var deliveredAttempts: [String] = []
    private(set) var pullCount = 0
    private(set) var releaseCount = 0
    private(set) var renewCount = 0
    private(set) var leaseSeconds: [Int] = []
    /// Holds a completion while `waitDuringCompletion`; it ends only by cancellation.
    let completion = Gate()
    init(
        commands: [ImageProcessingCommand], failFirstCompletion: Bool = false,
        waitDuringCompletion: Bool = false,
        renewal: CompanionLeaseRenewal = .renewed(leaseExpiresAt: .distantFuture),
        renewError: (any Error)? = nil, rejectedJobs: Set<String> = []
    ) {
        self.commands = commands
        self.failFirstCompletion = failFirstCompletion
        self.waitDuringCompletion = waitDuringCompletion
        self.renewal = renewal
        self.renewError = renewError
        self.rejectedJobs = rejectedJobs
    }
    func pull(hello: ImageProcessingHello, leaseSeconds: Int) async throws
        -> PullCompanionImageProcessingOutput
    {
        self.leaseSeconds.append(leaseSeconds)
        pullCount += 1
        return .init(command: commands.isEmpty ? nil : commands.removeFirst(), remotePaused: false)
    }
    func complete(deviceID: String, result: ImageProcessingResult) async throws {
        if rejectedJobs.contains(result.jobId) {
            rejectedCount += 1
            throw Failure.network
        }
        completionCount += 1
        if waitDuringCompletion { try await completion.pass() }
        if failFirstCompletion { failFirstCompletion = false; throw Failure.network }
        deliveredAttempts.append(result.attemptId)
    }
    func release(deviceID: String, claim: CompanionImageCommandClaim) async throws { releaseCount += 1 }
    func renew(deviceID: String, claim: CompanionImageCommandClaim) async throws -> CompanionLeaseRenewal {
        renewCount += 1
        if let renewError { throw renewError }
        return renewal
    }
}

/// The latest worker phase reported.
private final class PhaseFixture: Sendable {
    private let phase = Mutex<CompanionImageWorkerActivity.Phase?>(nil)
    var latest: CompanionImageWorkerActivity.Phase? { phase.withLock { $0 } }
    func record(_ next: CompanionImageWorkerActivity.Phase) { phase.withLock { $0 = next } }
}

private actor LeaseDeadlineFixture {
    private(set) var deadline: Date?
    func record(_ deadline: Date?) { self.deadline = deadline }
}

private actor BackgroundExecutionFixture {
    private(set) var count = 0
    func complete(_ command: ImageProcessingCommand) throws -> ImageProcessingResult {
        count += 1
        return .init(
            jobId: try CompanionImageCommandMetadata(command).jobID,
            attemptId: try CompanionImageCommandMetadata(command).attemptID,
            completedAt: .now,
            outcome: .failed(
                .init(
                    kind: .describeImage,
                    status: .failed, retryable: true, reason: "Synthetic failure")))
    }
}
