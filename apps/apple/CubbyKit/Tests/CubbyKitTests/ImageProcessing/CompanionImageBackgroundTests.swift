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
    /// Both BGTask expiration handlers cancel this same window. Every accepted claim is released
    /// before the task returns, including commands cancelled while waiting for execution.
    @Test func expirationReleasesEveryClaimInTheBackgroundBatch() async throws {
        let commands = [
            try command(),
            try command(
                job: "00000000-0000-4000-8000-000000000003", attempt: "00000000-0000-4000-8000-000000000004"),
        ]
        let transport = BackgroundTransportFixture(commands: commands)
        let fileURL = try outboxFile()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        let execution = Gate()
        let runner = CompanionImageBackgroundRunner(
            outbox: outbox,
            execute: { command in
                try await execution.pass()
                return try await BackgroundExecutionFixture().complete(command)
            })
        let task = Task {
            await runner.run(
                transport: transport, hello: hello(), maximumJobs: Int.max,
                maximumConcurrentCommands: { 2 })
        }
        await execution.arrivals(2)
        task.cancel()
        _ = await task.value
        #expect(await transport.releaseCount == 2)
        #expect(await transport.completionCount == 0)
        #expect(try await outbox.pending().isEmpty)
    }

    /// A response already in flight can return its whole batch after expiration cancels the task.
    @Test func cancellationWhileABatchPullReturnsReleasesEveryClaim() async throws {
        let commands = [
            try command(),
            try command(
                job: "00000000-0000-4000-8000-000000000003", attempt: "00000000-0000-4000-8000-000000000004"),
        ]
        let pull = Gate()
        let transport = BackgroundTransportFixture(commands: commands, pullGate: pull)
        let fileURL = try outboxFile()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        let executions = BackgroundExecutionFixture()
        let runner = CompanionImageBackgroundRunner(
            outbox: outbox,
            execute: {
                try await executions.complete($0)
            })
        let task = Task {
            await runner.run(transport: transport, hello: hello(), maximumConcurrentCommands: { 2 })
        }
        await pull.arrivals()
        task.cancel()
        pull.open()
        _ = await task.value
        #expect(await transport.releaseCount == 2)
        #expect(await executions.count == 0)
        #expect(try await outbox.pending().isEmpty)
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

    /// Regression: replay took the outbox in key order, eight per window, so eight results the
    /// server kept rejecting ahead of a valid ninth took every window (windows are spaced beyond
    /// the backoff, so the same eight were always due). Least recently attempted goes first, and
    /// that order survives the process ending between windows.
    @Test func rejectedResultsNeverStarveALaterOne() async throws {
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        var rejected: Set<String> = []
        for index in 0..<8 {
            let job = "00000000-0000-4000-8000-00000000010\(index)"
            rejected.insert(job)
            try await outbox.record(
                try await BackgroundExecutionFixture().complete(try command(job: job)),
                for: "a-rejected-\(index)")
        }
        let valid = "00000000-0000-4000-8000-0000000002ff"
        try await outbox.record(
            try await BackgroundExecutionFixture().complete(try command(job: valid)),
            for: "z-valid")
        let transport = BackgroundTransportFixture(commands: [], rejectedJobs: rejected)
        for _ in 0..<3 {
            // Each window is a cold launch: a fresh outbox and delivery over the same file.
            let relaunched = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
            let runner = CompanionImageBackgroundRunner(
                outbox: relaunched,
                delivery: CompanionResultDelivery(outbox: relaunched, failureObserver: nil),
                execute: { try await BackgroundExecutionFixture().complete($0) })
            await runner.run(transport: transport, hello: hello(), maximumJobs: 1)
        }
        let reopened = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        #expect(try await reopened.pending().map(\.key).contains("z-valid") == false)
        #expect(await transport.deliveredAttempts == ["00000000-0000-4000-8000-000000000002"])
    }

    /// Regression: a 426 answering a claim release (a version bump between the pull and the
    /// release of a command this build cannot run) only reached the failure observer, so the
    /// worker never latched and later windows kept starting.
    @Test func aReleaseRefusedForUpdateLatchesTheWorker() async throws {
        let unsupported = try JSONDecoder.companionImageProcessing.decode(
            ImageProcessingCommand.self,
            from: Data(
                #"{"kind":"future_kind","jobId":"00000000-0000-4000-8000-0000000000bb","attemptId":"00000000-0000-4000-8000-0000000000bc","deadline":"2099-01-01T00:00:00Z"}"#
                    .utf8))
        let transport = BackgroundTransportFixture(
            commands: [unsupported], releaseError: Self.updateRefusal("imageProcessing.release"))
        let (worker, phases) = try makeWorker(transport: transport)
        await worker.start()
        let hello = hello()
        #expect(await worker.runInBackground(transport: transport, hello: hello) == false)
        #expect(await worker.isUpdateRequired)
        #expect(phases.latest == .updateRequired)
        #expect(await worker.runInBackground(transport: transport, hello: hello) == false)
        #expect(await transport.pullCount == 1)
        await worker.stop()
    }

    /// Regression: when the window ended while a delivery answered 426, the runner checked
    /// cancellation first, released the claim and reported resumable, so the worker never latched.
    @Test func anUpdateRefusalDuringWindowExpiryStillLatches() async throws {
        let transport = BackgroundTransportFixture(
            commands: [try command()],
            completionError: Self.updateRefusal("imageProcessing.complete"))
        let (worker, _) = try makeWorker(transport: transport)
        await worker.start()
        let hello = hello()
        let run = Task { await worker.runInBackground(transport: transport, hello: hello) }
        await transport.completionHold.arrivals(1)
        await worker.endBackgroundRun()
        transport.completionHold.release()
        #expect(await run.value == false)
        #expect(await worker.isUpdateRequired)
        #expect(await transport.releaseCount == 0)
        #expect(try await worker.drainState().pendingResults == 1)
        await worker.stop()
    }

    private static func updateRefusal(_ operation: String) -> CubbyAPIError {
        CubbyAPIError(
            status: CubbyAPIError.clientUpdateRequiredStatus, operationID: operation, detail: nil)
    }

    private func makeWorker(
        transport: BackgroundTransportFixture
    ) throws -> (CompanionImageWorker, PhaseFixture) {
        let fileURL = try outboxFile()
        let phases = PhaseFixture()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://127.0.0.1:9")!,
            credentials: CredentialProvider(host: "example.test", store: InMemorySessionTokenStore()),
            deviceID: UUID(), deviceName: "Synthetic phone", foreground: false,
            outbox: CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL),
            transport: transport, activityObserver: { phases.record($0.phase) },
            execute: { try await BackgroundExecutionFixture().complete($0) })
        return (worker, phases)
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
    func pull(hello: ImageProcessingHello, leaseSeconds: Int, maxCommands: Int) async throws
        -> PullCompanionImageProcessingOutput
    {
        .init(command: nil, commands: [], remotePaused: false)
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
    /// Fails every release with this error.
    let releaseError: (any Error)?
    /// Holds each completion on `completionHold` (ignoring cancellation), then throws this.
    let completionError: (any Error)?
    let pullGate: Gate?
    nonisolated let completionHold = Gate()
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
        renewError: (any Error)? = nil, rejectedJobs: Set<String> = [],
        releaseError: (any Error)? = nil, completionError: (any Error)? = nil, pullGate: Gate? = nil
    ) {
        self.pullGate = pullGate
        self.releaseError = releaseError
        self.completionError = completionError
        self.commands = commands
        self.failFirstCompletion = failFirstCompletion
        self.waitDuringCompletion = waitDuringCompletion
        self.renewal = renewal
        self.renewError = renewError
        self.rejectedJobs = rejectedJobs
    }
    func pull(hello: ImageProcessingHello, leaseSeconds: Int, maxCommands: Int) async throws
        -> PullCompanionImageProcessingOutput
    {
        self.leaseSeconds.append(leaseSeconds)
        pullCount += 1
        let batch = Array(commands.prefix(maxCommands))
        commands.removeFirst(batch.count)
        await pullGate?.hold()
        return .init(command: batch.first, commands: batch, remotePaused: false)
    }
    func complete(deviceID: String, result: ImageProcessingResult) async throws {
        if let completionError {
            await completionHold.hold()
            throw completionError
        }
        if rejectedJobs.contains(result.jobId) {
            rejectedCount += 1
            throw Failure.network
        }
        completionCount += 1
        if waitDuringCompletion { try await completion.pass() }
        if failFirstCompletion { failFirstCompletion = false; throw Failure.network }
        deliveredAttempts.append(result.attemptId)
    }
    func release(deviceID: String, claim: CompanionImageCommandClaim) async throws {
        releaseCount += 1
        if let releaseError { throw releaseError }
    }
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
