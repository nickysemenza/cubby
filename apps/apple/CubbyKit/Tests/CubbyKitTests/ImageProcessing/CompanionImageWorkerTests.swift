import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class RenewalStub: URLProtocol, @unchecked Sendable {
    static let handler = Mutex<StubNetworking.Handler?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubNetworking.startLoading(
            request, client: client, target: self, handler: Self.handler.withLock { $0 })
    }
    override func stopLoading() {}
    static func session() -> URLSession { StubNetworking.session(protocolClass: self) }
}

@Suite("CompanionImageWorker", .timeLimit(.minutes(1)))
struct CompanionImageWorkerTests {
    /// Field finding: a device that could never subscribe showed only "Disconnected —
    /// reconnecting", and an expected reconnect failure never reached diagnostics, so the reason
    /// was invisible on the device and in Sentry. A failed attempt now reports which step failed,
    /// the attempt number and the next try, and the first failure of a streak is reported.
    @Test func aFailedSubscriptionReportsItsStepAttemptAndNextTry() async throws {
        let activity = ActivityRecorder()
        let reported = Gate()
        let failed = Gate()
        let failures = Mutex<[String]>([])
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            outbox: try outbox(), transport: QueuedCompanionTransport(commands: []),
            failureObserver: { error in
                failures.withLock { $0.append((error as? LocalizedError)?.errorDescription ?? "") }
                reported.signal()
            },
            activityObserver: {
                activity.record($0)
                if $0.connectionAttempt > 0 { failed.signal() }
            },
            execute: { try Self.failedResult($0) })
        await worker.start()
        await reported.arrivals()
        await failed.arrivals()
        let latest = try #require(activity.activity)
        #expect(latest.phase == .connecting)
        #expect(latest.connectionAttempt == 1)
        #expect(latest.nextConnectAt != nil)
        #expect(latest.lastError?.contains(" failed (") == true)
        #expect(failures.withLock { $0.first?.contains(" failed (") } == true)
        await worker.stop()
    }

    /// Field finding: the opening protocol ping's pong never arrived from the hibernating
    /// doorbell, and the worker waited on it forever on "Opening the image-work connection…".
    /// The first frame (the server's greeting ring) now confirms the open, within a deadline
    /// that closes a socket which never greets.
    @Test func aSubscriptionThatNeverGreetsFailsAtTheDeadlineAndClosesTheSocket() async throws {
        // Like URLSession's receive, the pending frame ignores task cancellation: only closing the
        // socket ends it, so the wait returns only if the deadline closes the socket.
        let socket = Gate()
        let closed = Mutex(false)
        await #expect(throws: CompanionOpenTimeout.self) {
            try await awaitFirstFrame(
                within: .milliseconds(50),
                receive: { await socket.hold() },
                cancel: {
                    closed.withLock { $0 = true }
                    socket.open()
                })
        }
        #expect(closed.withLock { $0 })
    }

    @Test func aGreetingConfirmsTheSubscription() async throws {
        try await awaitFirstFrame(within: .seconds(5), receive: {}, cancel: {})
    }

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

    /// One slot pool: with every slot busy the worker does not pull, and widening the pool (the
    /// Settings stepper) pulls into the new slot at once, without a restart.
    @Test func pullsOnlyIntoAFreeSlotAndAWiderPoolPullsAtOnce() async throws {
        let execution = Gate()
        let transport = QueuedCompanionTransport(commands: [
            try describeCommand(), try describeCommand(attempt: "00000000-0000-4000-8000-000000000003"),
        ])
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            maximumConcurrentCommands: 1, outbox: try outbox(), transport: transport,
            execute: { command in
                try? await execution.pass()
                return try Self.failedResult(command)
            })
        await worker.start()
        await worker.requestDrain()
        await execution.arrivals(1)
        await worker.drainIdle()
        #expect(await transport.pulls == 1)

        await worker.setMaximumConcurrentCommands(2)
        await execution.arrivals(2)
        execution.open()
        await worker.commandsIdle()
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

    /// Regression: quitting during a pull awaited only releases already registered, so it
    /// finished before the pull's answer registered its claim's release and the claim stayed
    /// held until its lease expired.
    @Test func quittingDuringAPullReleasesItsClaimBeforeReturning() async throws {
        let pullGate = Gate()
        let stopped = Gate()
        let transport = QueuedCompanionTransport(commands: [try describeCommand()], pullGate: pullGate)
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            outbox: try outbox(), transport: transport,
            activityObserver: { if $0.phase == .stopped { stopped.signal() } },
            execute: { try Self.failedResult($0) })
        await worker.start()
        await worker.requestDrain()
        await pullGate.arrivals()
        let quitting = Task { await worker.stopAndReleaseClaims() }
        await stopped.arrivals()
        pullGate.open()
        await quitting.value
        #expect(await transport.released.map(\.jobID) == ["00000000-0000-4000-8000-000000000001"])
    }

    /// Regression: a drain whose delivery failed went idle, and with no more work no ring arrived,
    /// so the recorded result stayed pending and `companion --once` never settled.
    @Test func aFailedDeliveryIsRetriedWithoutAnotherRing() async throws {
        let transport = QueuedCompanionTransport(commands: [try describeCommand()], failingCompletions: 1)
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            outbox: try outbox(), transport: transport, execute: { try Self.failedResult($0) })
        await worker.start()
        await worker.requestDrain()
        // Reaching the second `complete` is the assertion; the acknowledgement follows it.
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
            async let started = worker.startCommand(command)
            let wasSettled = try await settled
            _ = await started
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

    // MARK: - Leases, release, outbox, and the version gate

    /// Regression: `stop()` cancelled a running command and dropped it, so its lease stayed held
    /// until expiry and every stop cost the job an attempt.
    @Test func stoppingReleasesARunningCommandWithoutDeliveringIt() async throws {
        let execution = Gate()
        let store = try outbox()
        let transport = QueuedCompanionTransport(commands: [try describeCommand()])
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            outbox: store, transport: transport,
            execute: { command in
                try await execution.pass()
                return try Self.failedResult(command)
            })
        await worker.start()
        await worker.requestDrain()
        await execution.arrivals()
        await worker.stop()
        await transport.releases.arrivals()
        await worker.commandsIdle()
        await worker.releasesIdle()
        #expect(await transport.released.map(\.attemptID) == ["00000000-0000-4000-8000-000000000002"])
        #expect(await transport.delivered.isEmpty)
        #expect(try await store.pending().isEmpty)
    }

    /// Regression: one result whose delivery kept failing threw out of every drain before its
    /// pull, so the device stopped taking work. It is set aside (kept on disk) and pulling goes on.
    @Test func anUndeliverableResultIsSetAsideAndPullingContinues() async throws {
        let store = try outbox()
        let stuckJob = "00000000-0000-4000-8000-0000000000aa"
        let stuck = try Self.failedResult(try describeCommand(job: stuckJob))
        try await store.record(stuck, for: "\(stuckJob):stuck")
        let activity = ActivityRecorder()
        let transport = QueuedCompanionTransport(
            commands: [try describeCommand()], undeliverableJobs: [stuckJob])
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            outbox: store, transport: transport,
            activityObserver: { activity.record($0) },
            execute: { try Self.failedResult($0) })
        await worker.start()
        await worker.requestDrain()
        await transport.completions.arrivals()
        await worker.commandsIdle()
        #expect(await transport.delivered == ["00000000-0000-4000-8000-000000000001"])
        #expect(try await store.pending().map(\.key) == ["\(stuckJob):stuck"])
        #expect(activity.activity?.undeliveredResults == 1)
        #expect(activity.activity?.deliveryError != nil)
        await worker.stop()
    }

    /// Regression: the worker's own client had no request observer and treated a 426 like any
    /// other failure, retrying pulls the server would always refuse and never telling anyone.
    @Test func clientUpdateRequiredStopsPullingAndReportsIt() async throws {
        let activity = ActivityRecorder()
        let transport = QueuedCompanionTransport(
            commands: [],
            pullError: CubbyAPIError(
                status: CubbyAPIError.clientUpdateRequiredStatus, operationID: "imageProcessing.pull",
                detail: nil))
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            outbox: try outbox(), transport: transport,
            activityObserver: { activity.record($0) },
            execute: { try Self.failedResult($0) })
        await worker.start()
        await worker.requestDrain()
        await worker.drainIdle()
        #expect(await worker.isUpdateRequired)
        #expect(await !worker.isConnecting)
        #expect(activity.activity?.phase == .updateRequired)
        // No further pull: neither a retry nor a new drain request runs.
        await worker.requestDrain()
        await worker.drainIdle()
        #expect(await transport.pulls == 1)
        await worker.stop()
    }

    /// A refused renewal means the server retired or reassigned the attempt: stop the command,
    /// record nothing, deliver nothing, and do not release a lease that is no longer ours.
    @Test func aRefusedRenewalStopsTheCommandUnrecorded() async throws {
        let heartbeat = Gate()
        let execution = Gate()
        let store = try outbox()
        let transport = QueuedCompanionTransport(
            commands: [try describeCommand()], renewal: .refused(reason: "lease_lost"))
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            outbox: store, transport: transport,
            execute: { command in
                try await execution.pass()
                return try Self.failedResult(command)
            },
            heartbeatPause: { try await heartbeat.pass() })
        await worker.start()
        await worker.requestDrain()
        await execution.arrivals()
        await heartbeat.arrivals()
        heartbeat.release()
        await transport.renewals.arrivals()
        await worker.commandsIdle()
        await worker.releasesIdle()
        #expect(await transport.released.isEmpty)
        #expect(await transport.delivered.isEmpty)
        #expect(try await store.pending().isEmpty)
        await worker.stop()
    }

    /// An accepted renewal moves the deadline the executor enforces.
    @Test func anAcceptedRenewalExtendsTheLease() {
        let lease = CompanionCommandLease(deadline: Date(timeIntervalSince1970: 100))
        lease.extend(to: Date(timeIntervalSince1970: 160))
        #expect(lease.deadline == Date(timeIntervalSince1970: 160))
        // A stale answer never shortens it.
        lease.extend(to: Date(timeIntervalSince1970: 120))
        #expect(lease.deadline == Date(timeIntervalSince1970: 160))
    }

    /// The client renews through the generated `imageProcessing.renew` method and maps both
    /// answers; an answer with neither shape is unsupported, never a silent renewal.
    @Test func renewalGoesThroughTheGeneratedOperation() async throws {
        let answers = Mutex([
            #"{"ok":true,"data":{"ok":true,"leaseExpiresAt":"2099-01-01T00:01:00.000Z"}}"#,
            #"{"ok":true,"data":{"ok":false,"reason":"job_obsolete"}}"#,
            #"{"ok":true,"data":{"ok":"maybe"}}"#,
        ])
        let seen = Mutex<[URLRequest]>([])
        RenewalStub.handler.withLock {
            $0 = { request in
                seen.withLock { $0.append(request) }
                return (200, Data(answers.withLock { $0.removeFirst() }.utf8))
            }
        }
        defer { RenewalStub.handler.withLock { $0 = nil } }
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let client = CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: CredentialProvider(host: "localhost:3000", store: store),
            session: RenewalStub.session())
        let claim = CompanionImageCommandClaim(jobID: "job-1", attemptID: "attempt-1")

        #expect(
            try await client.renew(deviceID: "device-1", claim: claim)
                == .renewed(leaseExpiresAt: Date(timeIntervalSince1970: 4_070_908_860)))
        #expect(
            try await client.renew(deviceID: "device-1", claim: claim)
                == .refused(reason: "job_obsolete"))
        await #expect(throws: UnsupportedNativeResponse.self) {
            _ = try await client.renew(deviceID: "device-1", claim: claim)
        }
        let first = try #require(seen.withLock { $0.first })
        #expect(first.url?.path == "/api/operations/imageProcessing.renew")
        #expect(
            StubNetworking.operationFields(of: first)
                == ["jobId": "job-1", "attemptId": "attempt-1", "deviceId": "device-1"])
    }

    /// Regression: a command this build could not parse was dropped without a release, holding
    /// its lease, and the drain pulled again at once.
    @Test func anUnsupportedCommandIsReleasedAndTheDrainBacksOff() async throws {
        let unsupported = try JSONDecoder.companionImageProcessing.decode(
            ImageProcessingCommand.self,
            from: Data(
                #"{"kind":"future_kind","jobId":"00000000-0000-4000-8000-0000000000bb","attemptId":"00000000-0000-4000-8000-0000000000bc","deadline":"2099-01-01T00:00:00Z"}"#
                    .utf8))
        let transport = QueuedCompanionTransport(commands: [unsupported, try describeCommand()])
        let worker = CompanionImageWorker(
            baseURL: Self.unreachable, credentials: try credentials(bearer: "tok"),
            deviceID: UUID(), deviceName: "Test phone", foreground: true,
            outbox: try outbox(), transport: transport, execute: { try Self.failedResult($0) })
        await worker.start()
        await worker.requestDrain()
        await transport.releases.arrivals()
        await worker.drainIdle()
        #expect(await worker.isBackingOff)
        // A ring during the backoff does not pull again.
        await worker.requestDrain()
        await worker.drainIdle()
        #expect(await transport.pulls == 1)
        #expect(await transport.released.map(\.jobID) == ["00000000-0000-4000-8000-0000000000bb"])
        await worker.stop()
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
        job: String = "00000000-0000-4000-8000-000000000001",
        attempt: String = "00000000-0000-4000-8000-000000000002"
    ) throws -> ImageProcessingCommand {
        let value = """
            {"kind":"describe_image","jobId":"\(job)","attemptId":"\(attempt)","deadline":"2099-01-01T00:00:00Z","source":{"url":"https://example.test/panel.jpg","sha256":"\(String(repeating: "a", count: 64))","contentType":"image/jpeg"},"promptRevision":1,"resultSchemaRevision":1}
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
/// `failingCompletions` the first few, `undeliverableJobs` always), so a result stays in the
/// outbox as it would after a dropped connection. `pullError` fails every pull; `renewal`
/// answers every `imageProcessing.renew`.
private actor QueuedCompanionTransport: CompanionImageBackgroundTransport {
    private var commands: [ImageProcessingCommand]
    private let delivers: Bool
    private var failingCompletions: Int
    private let undeliverableJobs: Set<String>
    private let pullGate: Gate?
    private let pullError: (any Error)?
    private let renewal: CompanionLeaseRenewal
    private(set) var pulls = 0
    private(set) var released: [CompanionImageCommandClaim] = []
    private(set) var delivered: [String] = []
    nonisolated let completions = Gate()
    nonisolated let releases = Gate()
    nonisolated let renewals = Gate()

    init(
        commands: [ImageProcessingCommand], delivers: Bool = true, failingCompletions: Int = 0,
        undeliverableJobs: Set<String> = [], pullGate: Gate? = nil, pullError: (any Error)? = nil,
        renewal: CompanionLeaseRenewal = .renewed(leaseExpiresAt: .distantFuture)
    ) {
        self.commands = commands
        self.delivers = delivers
        self.failingCompletions = failingCompletions
        self.undeliverableJobs = undeliverableJobs
        self.pullGate = pullGate
        self.pullError = pullError
        self.renewal = renewal
    }

    func pull(hello: ImageProcessingHello, leaseSeconds: Int) async throws
        -> PullCompanionImageProcessingOutput
    {
        pulls += 1
        if let pullError { throw pullError }
        let next = commands.isEmpty ? nil : commands.removeFirst()
        try await pullGate?.pass()
        return .init(command: next, remotePaused: false)
    }

    func complete(deviceID: String, result: ImageProcessingResult) async throws {
        guard delivers, !undeliverableJobs.contains(result.jobId) else {
            throw URLError(.networkConnectionLost)
        }
        if failingCompletions > 0 {
            failingCompletions -= 1
            throw URLError(.networkConnectionLost)
        }
        delivered.append(result.jobId)
        completions.signal()
    }

    func release(deviceID: String, claim: CompanionImageCommandClaim) async throws {
        released.append(claim)
        releases.signal()
    }

    func renew(deviceID: String, claim: CompanionImageCommandClaim) async throws
        -> CompanionLeaseRenewal
    {
        renewals.signal()
        return renewal
    }
}

/// The latest activity a worker reported.
private final class ActivityRecorder: Sendable {
    private let latest = Mutex<CompanionImageWorkerActivity?>(nil)

    var activity: CompanionImageWorkerActivity? { latest.withLock { $0 } }

    func record(_ activity: CompanionImageWorkerActivity) {
        latest.withLock { $0 = activity }
    }
}
