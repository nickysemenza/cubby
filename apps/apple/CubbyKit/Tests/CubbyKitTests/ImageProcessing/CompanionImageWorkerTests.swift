import Foundation
import Testing

@testable import CubbyKit

@Suite("CompanionImageWorker", .timeLimit(.minutes(1)))
struct CompanionImageWorkerTests {
    @Test func helloUsesTheSuppliedCreationHint() {
        let hello = ImageProcessingHello.companion(
            deviceID: UUID(), deviceName: "Kitchen phone", foreground: true,
            imageDescriptionAvailable: false, automaticWork: true)
        #expect(hello.deviceName == "Kitchen phone")
    }

    /// A ring (or a new subscription) drains: pull until nothing is claimable, execute, record,
    /// then deliver through `imageProcessing.complete` and clear the outbox.
    @Test func aDrainPullsUntilEmptyAndDeliversEveryResult() async throws {
        let store = try outbox()
        let transport = QueuedCompanionTransport(commands: [
            try describeCommand(), try describeCommand(attempt: "00000000-0000-4000-8000-000000000003"),
        ])
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            outbox: store, transport: transport, execute: { try Self.failedResult($0) })
        await worker.start()
        await worker.requestDrain()
        await transport.completions.arrivals(2)
        await worker.commandsIdle()
        #expect(await transport.pulls >= 3)
        #expect(try await store.pending().isEmpty)
        await worker.stop()
    }

    /// Regression: a pull in flight when the subscription ended (iOS backgrounding, or here
    /// participation turning off) still started its job outside the window that asked for it.
    @Test func aCommandPulledAfterTheSubscriptionEndsIsReleased() async throws {
        let pullGate = Gate()
        let transport = QueuedCompanionTransport(commands: [try describeCommand()], pullGate: pullGate)
        let executions = ExecutionCounter()
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            outbox: try outbox(), transport: transport, execute: { try await executions.run($0) })
        await worker.start()
        await worker.requestDrain()
        await pullGate.arrivals()
        await worker.setParticipating(false)
        pullGate.open()
        await transport.releases.arrivals()
        await worker.commandsIdle()
        #expect(await executions.count == 0)
        await worker.stop()
    }

    /// Regression: a drain whose delivery failed went idle, and with no more work no ring arrived,
    /// so the recorded result stayed pending and `companion --once` never settled.
    @Test func aFailedDeliveryIsRetriedWithoutAnotherRing() async throws {
        let transport = QueuedCompanionTransport(commands: [try describeCommand()], failingCompletions: 2)
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            outbox: try outbox(), transport: transport, execute: { try Self.failedResult($0) })
        await worker.start()
        await worker.requestDrain()
        // Reaching the third `complete` is the assertion; the acknowledgement follows it.
        await transport.completions.arrivals()
        await worker.stop()
    }

    /// Refuses connections, so the subscription loop stays alive retrying while a test drives
    /// drains directly.
    private static let unreachable = URL(string: "http://127.0.0.1:9")!

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
    /// before starting the connection loop, the only path to `runOneConnection` and a socket.
    @Test func participationOffNeverAttemptsAConnection() async throws {
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: "tok"),
            deviceID: UUID(),
            deviceName: "Test phone",
            foreground: true,
            isParticipating: false,
            outbox: try outbox())
        await worker.start()
        #expect(await !worker.isConnecting)
        await worker.stop()
    }

    /// No credential is saved, so `runOneConnection` throws `URLError.userAuthenticationRequired`
    /// before any network I/O — deterministic, and not on `AuthenticatedSocketSupport`'s expected
    /// reconnect-failure allowlist, so it reaches `failureObserver`.
    @Test func participatingWorkerAttemptsAConnectionAndSurfacesTheFailure() async throws {
        let failures = Gate()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: nil),
            deviceID: UUID(),
            deviceName: "Test phone",
            foreground: true,
            isParticipating: true,
            outbox: try outbox(),
            failureObserver: { _ in failures.signal() })
        await worker.start()
        #expect(await worker.isConnecting)
        await failures.arrivals(1)
        await worker.stop()
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
        let execution = Gate()
        let recording = Gate()
        let store = try outbox()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true, isParticipating: false,
            outbox: store, transport: QueuedCompanionTransport(commands: [], delivers: false),
            execute: { command in
                try? await execution.pass()
                return try Self.failedResult(command)
            },
            recordResult: { result, key in
                await recording.hold()
                try await store.record(result, for: key)
            })
        await worker.startCommand(try describeCommand())
        await execution.arrivals(1)
        #expect(
            try await worker.drainState()
                == .init(connected: false, outstandingCommands: 1, pendingResults: 0))

        // Executed but not yet persisted: still counted, or shutdown would see nothing to wait for.
        execution.release()
        await recording.arrivals(1)
        #expect(
            try await worker.drainState()
                == .init(connected: false, outstandingCommands: 1, pendingResults: 0))

        recording.open()
        await worker.commandsIdle()
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
                outbox: try outbox(), transport: QueuedCompanionTransport(commands: [], delivers: false),
                execute: { try await executions.run($0) })
            let command = try describeCommand()
            async let settled = worker.pauseAcceptingIfSettled()
            async let started: Void = worker.startCommand(command)
            let wasSettled = try await settled
            await started
            await worker.commandsIdle()
            if wasSettled {
                #expect(await executions.count == 0)
                #expect(try await worker.drainState().outstandingCommands == 0)
            }
        }
    }

    @Test func anUnsettledAnswerKeepsAcceptingAndRunsDeferredCommands() async throws {
        let gate = Gate()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true, isParticipating: false,
            outbox: try outbox(), transport: QueuedCompanionTransport(commands: [], delivers: false),
            execute: { command in
                try? await gate.pass()
                return try Self.failedResult(command)
            })
        await worker.startCommand(try describeCommand())
        await gate.arrivals(1)
        #expect(try await worker.pauseAcceptingIfSettled() == false)
        gate.release()
        await worker.commandsIdle()
        // A pending (unacknowledged) result still means not settled.
        #expect(try await worker.pauseAcceptingIfSettled() == false)
    }

    @Test func stoppingAcceptanceDefersNewCommandsForGood() async throws {
        let executions = ExecutionCounter()
        let worker = CompanionImageWorker(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true, isParticipating: false,
            outbox: try outbox(), transport: QueuedCompanionTransport(commands: [], delivers: false),
            execute: { try await executions.run($0) })
        await worker.stopAccepting()
        await worker.startCommand(try describeCommand())
        #expect(try await worker.pauseAcceptingIfSettled())
        await worker.commandsIdle()
        #expect(await executions.count == 0)
    }

    fileprivate static func failedResult(_ command: ImageProcessingCommand) throws -> ImageProcessingResult {
        .init(
            jobId: try CompanionImageCommandMetadata(command).jobID,
            attemptId: try CompanionImageCommandMetadata(command).attemptID, completedAt: .now,
            outcome: .failed(
                .init(
                    kind: .describeImage, status: .failed, retryable: true, reason: "Synthetic failure")))
    }

    private func describeCommand(
        attempt: String = "00000000-0000-4000-8000-000000000002"
    ) throws -> ImageProcessingCommand {
        let value = """
            {"kind":"describe_image","jobId":"00000000-0000-4000-8000-000000000001","attemptId":"\(attempt)","deadline":"2099-01-01T00:00:00Z","source":{"url":"https://example.test/panel.jpg","sha256":"\(String(repeating: "a", count: 64))","contentType":"image/jpeg"},"promptRevision":1,"resultSchemaRevision":1}
            """
        return try JSONDecoder.companionImageProcessing.decode(
            ImageProcessingCommand.self, from: Data(value.utf8))
    }
}

private actor ExecutionCounter {
    private(set) var count = 0

    func run(_ command: ImageProcessingCommand) throws -> ImageProcessingResult {
        count += 1
        return try CompanionImageWorkerTests.failedResult(command)
    }
}

/// Serves queued commands to `pull`, then none. `delivers: false` fails every `complete` (and
/// `failingCompletions` the first few), so a result stays in the outbox as it would after a
/// dropped connection.
private actor QueuedCompanionTransport: CompanionImageBackgroundTransport {
    private var commands: [ImageProcessingCommand]
    private let delivers: Bool
    private var failingCompletions: Int
    private let pullGate: Gate?
    private(set) var pulls = 0
    nonisolated let completions = Gate()
    nonisolated let releases = Gate()

    init(
        commands: [ImageProcessingCommand], delivers: Bool = true, failingCompletions: Int = 0,
        pullGate: Gate? = nil
    ) {
        self.commands = commands
        self.delivers = delivers
        self.failingCompletions = failingCompletions
        self.pullGate = pullGate
    }

    func pull(hello: ImageProcessingHello, leaseSeconds: Int) async throws
        -> PullCompanionImageProcessingOutput
    {
        pulls += 1
        let next = commands.isEmpty ? nil : commands.removeFirst()
        try await pullGate?.pass()
        return .init(command: next, remotePaused: false)
    }

    func complete(deviceID: String, result: ImageProcessingResult) async throws {
        guard delivers else { throw URLError(.networkConnectionLost) }
        if failingCompletions > 0 {
            failingCompletions -= 1
            throw URLError(.networkConnectionLost)
        }
        completions.signal()
    }

    func release(deviceID: String, command: ImageProcessingCommand) async throws {
        releases.signal()
    }
}
