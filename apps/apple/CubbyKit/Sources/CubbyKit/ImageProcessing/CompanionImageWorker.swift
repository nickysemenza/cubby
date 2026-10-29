import Foundation

/// The companion worker's live state, for Activity's "This device" section, Settings, the iOS
/// bar, and `cubby companion`'s log. Every phase is explicit, so a quiet device always says why.
public struct CompanionImageWorkerActivity: Sendable, Equatable {
    public enum Phase: Sendable, Equatable {
        /// Not started, or signed out.
        case stopped
        /// The master "Automatic work on this device" switch is off.
        case automaticWorkOff
        /// iOS outside the foreground: the subscription closes; system background windows still run.
        case backgrounded
        /// macOS system sleep: claims were released and pulling stops until wake.
        case asleep
        /// No live subscription; reconnecting with backoff (`lastError` says why when known).
        case connecting
        /// Subscribed, nothing claimable right now.
        case idle
        /// Subscribed and asking `imageProcessing.pull` for work.
        case pulling
        /// Running `processingCount` commands; `jobID`/`kind`/`startedAt` describe the oldest.
        case processing
        /// The server's version gate refused this build (426 CLIENT_UPDATE_REQUIRED). Pulling has
        /// stopped until the app is updated and relaunched.
        case updateRequired
    }

    public let phase: Phase
    public let queueProgress: CompanionImageQueueProgress?
    public let jobID: String?
    public let kind: String?
    public let startedAt: Date?
    /// The server paused this device's participation from the web (`Device.remotePaused`), for
    /// this connection. Settings shows "Paused from the web" when this is true.
    public let remotePaused: Bool
    /// Commands executing now.
    public let processingCount: Int
    /// All recorded results waiting for delivery, including a send in progress. They stay on disk
    /// until the server responds.
    public let undeliveredResults: Int
    /// The latest delivery failure among `undeliveredResults`, verbatim.
    public let deliveryError: String?
    /// The latest connection, pull, or lease failure, verbatim; cleared by a successful drain.
    public let lastError: String?
    /// Failed subscription attempts in a row; 0 once a subscription opens.
    public let connectionAttempt: Int
    /// When the next subscription attempt starts, while one is waiting out its backoff.
    public let nextConnectAt: Date?
    /// When the current or last subscription opened.
    public let connectedAt: Date?

    public init(
        phase: Phase, queueProgress: CompanionImageQueueProgress? = nil, jobID: String? = nil,
        kind: String? = nil, startedAt: Date? = nil,
        remotePaused: Bool = false, processingCount: Int = 0, undeliveredResults: Int = 0,
        deliveryError: String? = nil, lastError: String? = nil, connectionAttempt: Int = 0,
        nextConnectAt: Date? = nil, connectedAt: Date? = nil
    ) {
        self.phase = phase
        self.queueProgress = queueProgress
        self.jobID = jobID
        self.kind = kind
        self.startedAt = startedAt
        self.remotePaused = remotePaused
        self.processingCount = processingCount
        self.undeliveredResults = undeliveredResults
        self.deliveryError = deliveryError
        self.lastError = lastError
        self.connectionAttempt = connectionAttempt
        self.nextConnectAt = nextConnectAt
        self.connectedAt = connectedAt
    }
}

/// One executed command's outcome, for a caller that logs each job (`cubby companion`). Reported
/// after execution, before the result is recorded in the outbox and sent.
public struct CompanionImageJobReport: Sendable, Equatable {
    public enum Status: String, Sendable, Equatable {
        case completed
        /// AVIF input prepared as JPEG for the server's cloud description.
        case normalized
        case unsupported
        case skipped
        case failed
    }

    public let jobID: String
    public let kind: String
    public let status: Status
    /// The skipped or failed reason, verbatim from the result.
    public let reason: String?
    public let retryable: Bool?
    public let duration: Duration

    init(_ result: ImageProcessingResult, kind: String, duration: Duration) {
        jobID = result.jobId
        self.kind = kind
        self.duration = duration
        let outcome = result.outcome
        switch outcome {
        case .failed(let failure):
            (status, reason, retryable) = (.failed, failure.reason, failure.retryable)
        case .skipped(let skipped):
            (status, reason, retryable) = (.skipped, skipped.reason.rawValue, nil)
        case .normalized:
            (status, reason, retryable) = (.normalized, nil, nil)
        case .completed:
            (status, reason, retryable) = (.completed, nil, nil)
        case .unrecognized(let raw):
            (status, reason, retryable) = (.unsupported, String(reflecting: raw), nil)
        }
    }
}

/// Whether a pulled command should be executed — `false` when the web has paused this device
/// (`PullCompanionImageProcessingOutput.remotePaused`), same as participation-off. A tiny pure
/// decision, kept apart from the actor so it is directly unit-testable.
enum CompanionWorkAcceptance {
    static func acceptsCommand(remotePaused: Bool) -> Bool { !remotePaused }
}

/// The server refused to renew a running command's lease; the command was stopped unrecorded.
struct CompanionLeaseRefused: Error, LocalizedError, Sendable {
    let jobID: String
    let reason: String

    var errorDescription: String? { "Image job \(jobID) lease refused: \(reason)" }
}

/// A pulled command this build cannot execute. It was released (when it carried a claim) and the
/// drain backs off before pulling again.
struct CompanionUnsupportedCommand: Error, LocalizedError, Sendable {
    let detail: String

    var errorDescription: String? { "Unsupported image-processing command: \(detail)" }
}

/// The foreground companion. It subscribes to the `imageProcessing.work` doorbell and, when the
/// subscription opens and on every ring, drains claimable work through `imageProcessing.pull`,
/// executing up to `maximumConcurrentCommands` (`CompanionImageConcurrency`) at once, renewing each command's lease every
/// `heartbeatInterval`, and finishing each with `imageProcessing.complete`. A ring carries no
/// state; a missed one costs latency only, because every reconnect drains again.
///
/// Claims are handed back (`imageProcessing.release`) whenever this device stops working on them
/// before recording a result: stop, sign-out, iOS backgrounding, participation off, macOS sleep,
/// and a command this build cannot execute. A 426 CLIENT_UPDATE_REQUIRED from any image operation
/// stops pulling for the life of this worker.
public actor CompanionImageWorker {
    public typealias FailureObserver = @Sendable (any Error) -> Void
    public typealias ActivityObserver = @Sendable (CompanionImageWorkerActivity) -> Void
    public typealias JobObserver = @Sendable (CompanionImageJobReport) -> Void

    private struct RunningCommand {
        let jobID: String
        let kind: String
        let startedAt: Date
    }

    private let baseURL: URL
    private let credentials: CredentialProvider
    private let session: URLSession
    private let transport: any CompanionImageBackgroundTransport
    private let execute: @Sendable (ImageProcessingCommand) async throws -> ImageProcessingResult
    private let outbox: CompanionResultOutbox<ImageProcessingResult>
    /// Durably records a finished command's result; tests hold this boundary open.
    private let recordResult: @Sendable (ImageProcessingResult, String) async throws -> Void
    /// Waits between lease renewals; tests replace the clock with a gate.
    private let heartbeatPause: @Sendable () async throws -> Void
    private let failureObserver: FailureObserver?
    private let activityObserver: ActivityObserver?
    private let jobObserver: JobObserver?
    private let deviceID: UUID
    private let deviceName: String
    private var foreground: Bool
    /// The master "Automatic work on this device" switch. `false` keeps `start()`/`stop()` working
    /// normally but never subscribes (`platformAllowsConnection`); flipping it off mid-session
    /// closes the subscription via `reconcileConnection()`, and flipping it back on reconnects.
    private var isParticipating: Bool
    /// macOS system sleep. Like participation off, it closes the subscription and releases
    /// claims; waking reconnects, and the new subscription pulls immediately.
    private var systemAsleep = false
    /// Latched by the first 426 from an image operation. Only a new build (a relaunch) clears it.
    private var updateRequired = false
    /// From the latest pull: the server paused this device from the web. Reset on every new
    /// subscription.
    private var remotePaused = false
    private var shouldRun = false
    private var connectionGeneration = 0
    private var connectionTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    /// The subscription that has opened; `drainState()` is connected only while it is `socket`.
    private var openedSocket: URLSessionWebSocketTask?
    private var backgroundTask: Task<CompanionBackgroundOutcome, Never>?
    private let backgroundRunner: CompanionImageBackgroundRunner
    /// Commands run concurrently up to this bound, one pool shared by every kind; each command's
    /// own lease deadline still applies. Changing it takes effect on the next pull.
    private var maximumConcurrentCommands: Int
    private var commandTasks: [String: Task<Void, Never>] = [:]
    /// Accepted commands whose result is not yet recorded: exactly the claims a stop releases.
    /// A command leaves it when it commits to recording, or when its lease is refused.
    private var inFlight: [String: CompanionImageCommandClaim] = [:]
    private var releaseTasks: [UUID: Task<Void, Never>] = [:]
    private enum Acceptance { case open, paused, stopped }
    private var acceptance = Acceptance.open
    private var deferredCommands: [ImageProcessingCommand] = []
    private var running: [String: RunningCommand] = [:]
    private var queueProgress: CompanionImageQueueProgress?
    private var sessionCompletedBaseline = 0
    private var backlogRefresh: Task<Void, Never>?
    private var backgroundProcessingCount = 0
    private var isPulling = false
    private var lastError: String?
    /// Subscription diagnostics for Activity; see `CompanionImageWorkerActivity`.
    private var connectionAttempt = 0
    private var nextConnectAt: Date?
    private var connectedAt: Date?
    /// The subscription step in progress, named in a failure.
    private var connectionStep = "sign-in"
    /// Shared with the charging window, so a result set aside by either path backs off in both.
    private let delivery: CompanionResultDelivery
    private var deliverySnapshot = CompanionResultDelivery.Snapshot()
    private var deliveryRetry: Task<Void, Never>?
    /// One serial sender, independent of the compute slots and pull loop.
    private var deliveryTask: Task<Void, Never>?
    private var deliveryRequested = false
    /// Recorded results retain their attempt while the serial sender waits or backs off.
    private var deliveryHeartbeats: [String: Task<Void, Never>] = [:]
    /// A heartbeat transfers before recording begins; absence from the outbox is not yet an ack.
    private var recordingResults: Set<String> = []
    private var refusedDeliveryLeases: Set<String> = []
    private var lastReportedActivity: CompanionImageWorkerActivity?
    private var isDraining = false
    private var drainRequested = false
    private var drainTask: Task<Void, Never>?
    private var drainFailures = 0
    private var drainRetry: Task<Void, Never>?

    public init(
        baseURL: URL,
        credentials: CredentialProvider,
        deviceID: UUID,
        deviceName: String,
        foreground: Bool,
        isParticipating: Bool = true,
        maximumConcurrentCommands: Int = CompanionImageConcurrency.automatic,
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        identity: ClientIdentity = .unknown,
        session: URLSession = .cubbyShared,
        requestObserver: (any RequestObserver)? = nil,
        executor: CompanionImageCommandExecutor = CompanionImageCommandExecutor(),
        failureObserver: FailureObserver? = nil,
        activityObserver: ActivityObserver? = nil,
        jobObserver: JobObserver? = nil
    ) {
        // The app's request observer latches a 426 into its update banner, the same as every
        // other client the app builds.
        self.init(
            baseURL: baseURL, credentials: credentials, deviceID: deviceID, deviceName: deviceName,
            foreground: foreground, isParticipating: isParticipating,
            maximumConcurrentCommands: maximumConcurrentCommands, outbox: outbox,
            session: session,
            transport: CubbyClient(
                baseURL: baseURL, credentials: credentials, identity: identity, session: session,
                requestObserver: requestObserver),
            failureObserver: failureObserver, activityObserver: activityObserver,
            jobObserver: jobObserver, execute: { command in try await executor.execute(command) })
    }

    init(
        baseURL: URL,
        credentials: CredentialProvider,
        deviceID: UUID,
        deviceName: String,
        foreground: Bool,
        isParticipating: Bool = true,
        maximumConcurrentCommands: Int = CompanionImageConcurrency.automatic,
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        session: URLSession = .cubbyShared,
        transport: any CompanionImageBackgroundTransport,
        failureObserver: FailureObserver? = nil,
        activityObserver: ActivityObserver? = nil,
        jobObserver: JobObserver? = nil,
        execute: @escaping @Sendable (ImageProcessingCommand) async throws -> ImageProcessingResult,
        recordResult: (@Sendable (ImageProcessingResult, String) async throws -> Void)? = nil,
        heartbeatPause: (@Sendable () async throws -> Void)? = nil
    ) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.deviceID = deviceID
        self.deviceName = deviceName
        self.foreground = foreground
        self.isParticipating = isParticipating
        self.maximumConcurrentCommands = CompanionImageConcurrency.slots(for: maximumConcurrentCommands)
        self.outbox = outbox
        self.recordResult = recordResult ?? { try await outbox.record($0, for: $1) }
        let heartbeatPause =
            heartbeatPause ?? {
                try await Task.sleep(for: CompanionImageProcessingProtocol.heartbeatInterval)
            }
        self.heartbeatPause = heartbeatPause
        self.session = session
        self.transport = transport
        self.execute = execute
        self.failureObserver = failureObserver
        self.activityObserver = activityObserver
        self.jobObserver = jobObserver
        let delivery = CompanionResultDelivery(outbox: outbox, failureObserver: failureObserver)
        self.delivery = delivery
        self.backgroundRunner = CompanionImageBackgroundRunner(
            outbox: outbox, delivery: delivery, execute: execute, failureObserver: failureObserver,
            heartbeatPause: heartbeatPause)
    }

    deinit {
        backgroundTask?.cancel()
        backlogRefresh?.cancel()
        connectionTask?.cancel()
        deliveryRetry?.cancel()
        deliveryTask?.cancel()
        for heartbeat in deliveryHeartbeats.values { heartbeat.cancel() }
        socket?.cancel(with: .goingAway, reason: nil)
    }

    private var backgroundWindowActive = false

    private var wireDeviceID: String { deviceID.uuidString.lowercased() }

    public func start() {
        shouldRun = true
        reconcileConnection()
        reportActivity()
    }

    /// Stops pulling and executing, and hands every unrecorded claim back best-effort. Recorded
    /// results stay in the outbox for the next session.
    public func stop() {
        backgroundTask?.cancel()
        shouldRun = false
        connectionGeneration += 1
        connectionTask?.cancel()
        connectionTask = nil
        drainRetry?.cancel()
        drainRetry = nil
        deliveryRetry?.cancel()
        deliveryRetry = nil
        deliveryRequested = false
        deliveryTask?.cancel()
        cancelDeliveryHeartbeats()
        cancelCommands()
        releaseDeferredCommands()
        closeSocket(.goingAway)
        reportActivity()
    }

    /// `stop()`, then waits (bounded per claim) for its releases, so a quitting app hands its
    /// claims back before the process ends.
    public func stopAndReleaseClaims() async {
        await stopAndReleaseClaims(drainSettle: { try? await Task.sleep(for: CompanionClaimRelease.timeout) })
    }

    /// `drainSettle` bounds the wait for a drain in flight; tests replace the clock with a gate.
    func stopAndReleaseClaims(drainSettle: @escaping @Sendable () async -> Void) async {
        let drain = drainTask
        stop()
        // As at sign-out: a pull in flight at stop() registers its claim's release only when it
        // answers (see drainOnce), so settle it before awaiting releases. A pull that outlasts
        // the bound is cancelled; its claim, if any, expires with its lease.
        if let drain {
            let settled = await withTaskGroup(of: Bool.self) { group in
                group.addTask {
                    await drain.waitUnlessCancelled()
                    return true
                }
                group.addTask {
                    await drainSettle()
                    return false
                }
                let first = await group.next() ?? true
                group.cancelAll()
                return first
            }
            if !settled { drain.cancel() }
        }
        await releasesIdle()
    }

    /// Signing out ends the authenticated principal that owns every pending attempt. Do not let
    /// another account subsequently signed in on the same host replay those results.
    public func stopAndDiscardPendingResults() async throws {
        let background = backgroundTask
        let connection = connectionTask
        let drain = drainTask
        let commands = Array(commandTasks.values)
        let sender = deliveryTask
        let renewals = Array(deliveryHeartbeats.values)
        stop()
        _ = await background?.value
        await connection?.value
        // A pull in flight at stop() releases its claim rather than starting it (see drainOnce).
        await drain?.value
        for command in commands { await command.value }
        await sender?.value
        for renewal in renewals { await renewal.value }
        // Releases use the outgoing credential; finish them before it is removed.
        await releasesIdle()
        try await outbox.removeAll()
    }

    /// Resizes the shared slot pool. A smaller pool lets running commands finish and pulls again
    /// only below the new bound; a larger one pulls into the new slots at once.
    public func setMaximumConcurrentCommands(_ slots: Int) {
        let slots = CompanionImageConcurrency.slots(for: slots)
        guard slots != maximumConcurrentCommands else { return }
        let grew = slots > maximumConcurrentCommands
        maximumConcurrentCommands = slots
        if grew { requestDrain() }
    }

    public func setForeground(_ foreground: Bool) {
        self.foreground = foreground
        reconcileConnection()
        reportActivity()
    }

    /// macOS system sleep and wake. Sleep releases claims and stops pulling; wake reconnects and
    /// the new subscription pulls immediately.
    public func setSystemAsleep(_ asleep: Bool) {
        guard systemAsleep != asleep else { return }
        systemAsleep = asleep
        reconcileConnection()
        reportActivity()
    }

    /// The master "Automatic work on this device" switch. `start()` is still what arms
    /// `shouldRun` — this only gates whether `reconcileConnection()` may subscribe, so a later
    /// flip back on reconnects without a fresh `start()`.
    public func setParticipating(_ participating: Bool) {
        isParticipating = participating
        if !participating { backgroundTask?.cancel() }
        reconcileConnection()
        reportActivity()
    }

    /// The system background task owns this HTTP window; it does not reopen an iOS subscription.
    public func runInBackground(client: CubbyClient) async -> Bool {
        await runInBackground(transport: client, hello: hello(foreground: false))
    }

    func runInBackground(
        transport: any CompanionImageBackgroundTransport, hello: ImageProcessingHello
    ) async -> Bool {
        guard shouldRun, isParticipating, !updateRequired, backgroundTask == nil else { return false }
        // One executor owns the shared slots. Settle any resident pull before the HTTP window.
        backgroundWindowActive = true
        let residentDrain = drainTask
        let residentCommands = Array(commandTasks.values)
        let residentDelivery = deliveryTask
        let residentRenewals = Array(deliveryHeartbeats.values)
        reconcileConnection()
        let task = Task {
            await residentDrain?.waitUnlessCancelled()
            for command in residentCommands { await command.waitUnlessCancelled() }
            await residentDelivery?.waitUnlessCancelled()
            for renewal in residentRenewals { await renewal.waitUnlessCancelled() }
            await releasesIdle()
            guard shouldRun, isParticipating, !Task.isCancelled else {
                return CompanionBackgroundOutcome.resumable
            }
            return await backgroundRunner.run(
                transport: transport, hello: hello, maximumJobs: Int.max,
                maximumConcurrentCommands: { await self.maximumConcurrentCommands },
                activity: { processed, running in
                    await self.reportBackgroundProgress(processed: processed, running: running)
                })
        }
        backgroundTask = task
        let outcome = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        backgroundTask = nil
        backgroundWindowActive = false
        backgroundProcessingCount = 0
        reconcileConnection()
        deliverySnapshot = await delivery.snapshot
        switch outcome {
        case .updateRequired(let error):
            // Latches like a foreground 426: no later window starts, results stay recorded.
            enterUpdateRequired(error)
            return false
        case .resumable:
            reportActivity()
            return true
        case .settled:
            reportActivity()
            return false
        }
    }

    public func endBackgroundRun() {
        backgroundTask?.cancel()
    }

    private func hello(foreground: Bool) -> ImageProcessingHello {
        .companion(
            deviceID: deviceID, deviceName: deviceName, foreground: foreground,
            imageDescriptionAvailable: FoundationModelsImageDescriber().availability() == .available,
            automaticWork: isParticipating)
    }

    private var platformAllowsConnection: Bool {
        guard isParticipating, !updateRequired, !systemAsleep, !backgroundWindowActive else { return false }
        #if os(macOS)
            // A Mac keeps working while another app is frontmost; it reports `foreground` as is.
            return true
        #else
            return foreground
        #endif
    }

    private func reconcileConnection() {
        guard shouldRun, platformAllowsConnection else {
            connectionGeneration += 1
            connectionTask?.cancel()
            connectionTask = nil
            deliveryTask?.cancel()
            cancelDeliveryHeartbeats()
            deliveryRetry?.cancel()
            deliveryRetry = nil
            cancelCommands()
            closeSocket(.goingAway)
            return
        }
        guard connectionTask == nil else { return }
        connectionGeneration += 1
        let generation = connectionGeneration
        connectionTask = Task { [weak self] in
            await self?.runConnectionLoop(generation: generation)
        }
    }

    private func closeSocket(_ code: URLSessionWebSocketTask.CloseCode) {
        socket?.cancel(with: code, reason: nil)
        socket = nil
        openedSocket = nil
    }

    private func runConnectionLoop(generation: Int) async {
        var attempt = 0
        while !Task.isCancelled, generation == connectionGeneration, shouldRun,
            platformAllowsConnection
        {
            do {
                try await runOneConnection(generation: generation)
                attempt = 0
            } catch is CancellationError {
                break
            } catch {
                guard generation == connectionGeneration else { break }
                attempt += 1
                closeSocket(.abnormalClosure)
                let failure = CompanionConnectionFailure(
                    step: connectionStep, attempt: attempt, underlying: error)
                lastError = failure.errorDescription
                // Expected reconnect failures still reach diagnostics, rate-limited: the first of
                // a streak and every tenth, so a device that can never subscribe is visible.
                if !AuthenticatedSocketSupport.isExpectedReconnectFailure(error)
                    || attempt == 1 || attempt % 10 == 0
                {
                    failureObserver?(failure)
                }
                let delay = AuthenticatedSocketSupport.reconnectDelay(attempt: attempt)
                connectionAttempt = attempt
                nextConnectAt = Date.now.addingTimeInterval(
                    Double(delay.components.seconds)
                        + Double(delay.components.attoseconds) / 1e18)
                reportActivity()
                do {
                    try await Task.sleep(for: delay)
                } catch {
                    break
                }
                nextConnectAt = nil
                reportActivity()
            }
        }
        if generation == connectionGeneration {
            closeSocket(.goingAway)
            connectionTask = nil
        }
    }

    private func runOneConnection(generation: Int) async throws {
        connectionStep = "sign-in"
        let token = try await credentials.bearerToken()
        connectionStep = "open"
        let endpoint = try AuthenticatedSocketSupport.socketURL(
            baseURL: baseURL, path: CompanionImageProcessingProtocol.doorbellPath,
            queryItems: [CompanionImageProcessingProtocol.doorbellTopic])
        let request = try AuthenticatedSocketSupport.request(
            url: endpoint,
            bearerToken: token,
            userAgent:
                "cubby-apple-image-worker/\(CompanionImageProcessingProtocol.version) (\(wireDeviceID))"
        )
        let socket = session.webSocketTask(with: request)
        guard generation == connectionGeneration else { throw CancellationError() }
        self.socket = socket
        socket.resume()
        // Per-subscription: a stale pause must not survive a reconnect whose first pull reports
        // otherwise.
        remotePaused = false
        // The server greets every new subscriber with a ring, so the first frame confirms the
        // subscription opened. A protocol ping did not: its pong never arrived from the hibernating
        // doorbell, and the worker waited on it forever without an error. The deadline cancels a
        // socket that opens but never greets, so the attempt fails, is reported and backs off.
        connectionStep = "greeting"
        try await awaitFirstFrame(
            within: CompanionImageProcessingProtocol.openDeadline,
            receive: { _ = try await socket.receive() },
            cancel: { socket.cancel(with: .goingAway, reason: nil) })
        connectionStep = "receive"
        openedSocket = socket
        connectionAttempt = 0
        nextConnectAt = nil
        connectedAt = .now
        lastError = nil
        reportActivity()
        // Work already waiting is claimable now; a (re)connect pulls at once rather than waiting
        // for the first ring or a pending drain backoff.
        drainRetry?.cancel()
        drainRetry = nil
        requestDrain()
        while !Task.isCancelled, generation == connectionGeneration, self.socket === socket {
            // Any frame is a ring; its content is a refetch hint this worker does not need.
            _ = try await socket.receive()
            requestDrain()
        }
    }

    /// Coalesces rings: one drain runs at a time, and a ring during it runs one more pass. Only a
    /// live subscription drains; backgrounded iOS work belongs to the bounded background runner.
    /// While a failed drain's backoff is pending a ring only marks the drain requested.
    func requestDrain() {
        guard shouldRun, platformAllowsConnection, connectionTask != nil else { return }
        requestDelivery()
        drainRequested = true
        guard !isDraining, drainRetry == nil else { return }
        isDraining = true
        drainTask = Task { await self.drainWhileRequested() }
    }

    private func drainWhileRequested() async {
        defer {
            isDraining = false
            reportActivity()
        }
        while drainRequested, shouldRun, platformAllowsConnection {
            drainRequested = false
            do {
                try await drainOnce(generation: connectionGeneration)
                drainFailures = 0
            } catch {
                handle(error)
                if !updateRequired { scheduleDrainRetry() }
                // The retry owns the next pass; a ring meanwhile must not skip the backoff.
                return
            }
        }
    }

    /// A failed drain may leave claimable work that no later ring will announce, and an
    /// unsupported command must not be pulled again in a hot loop; retry with the socket's
    /// backoff while the subscription lives.
    private func scheduleDrainRetry() {
        drainFailures += 1
        drainRetry?.cancel()
        let delay = AuthenticatedSocketSupport.reconnectDelay(attempt: drainFailures)
        drainRetry = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            await self?.retryDrain()
        }
    }

    private func retryDrain() {
        drainRetry = nil
        requestDrain()
    }

    /// Pulls until no work is claimable or every compute slot is busy. Durable delivery runs
    /// separately, so a slow HTTP response cannot hold the next command behind it.
    private func drainOnce(generation: Int) async throws {
        func isCurrent() -> Bool {
            shouldRun && platformAllowsConnection && generation == connectionGeneration
        }
        while isCurrent(), acceptance == .open,
            commandTasks.count < maximumConcurrentCommands
        {
            isPulling = true
            reportActivity()
            let pulled: PullCompanionImageProcessingOutput
            do {
                defer { isPulling = false }
                pulled = try await transport.pull(
                    hello: hello(foreground: foreground),
                    leaseSeconds: CompanionImageProcessingProtocol.residentLeaseSeconds,
                    maxCommands: maximumConcurrentCommands - commandTasks.count)
            }
            reportActivity()
            // The subscription ended during the pull (background, participation off, sleep,
            // stop): hand the claim back instead of running it outside the window that asked.
            if !isCurrent() {
                for command in pulled.commands { releaseBestEffort(command) }
                return
            }
            if pulled.remotePaused != remotePaused {
                remotePaused = pulled.remotePaused
                reportActivity()
            }
            guard !pulled.commands.isEmpty else {
                lastError = nil
                reportActivity()
                return
            }
            guard CompanionWorkAcceptance.acceptsCommand(remotePaused: pulled.remotePaused) else {
                for command in pulled.commands { releaseBestEffort(command) }
                return
            }
            var unsupported: String?
            for command in pulled.commands {
                // A setting change during the pull may shrink the pool. Return the excess.
                guard commandTasks.count < maximumConcurrentCommands else {
                    releaseBestEffort(command)
                    continue
                }
                if case .unsupported(let detail) = startCommand(command) { unsupported = detail }
            }
            // Start/release the entire batch before backing off an unsupported variant.
            if let unsupported { throw CompanionUnsupportedCommand(detail: unsupported) }
        }
    }

    // MARK: Outbox delivery

    private func requestDelivery() {
        guard shouldRun, platformAllowsConnection, !updateRequired else { return }
        deliveryRequested = true
        guard deliveryTask == nil else { return }
        deliveryTask = Task {
            defer {
                deliveryTask = nil
                if deliveryRequested { requestDelivery() }
            }
            while deliveryRequested, shouldRun, platformAllowsConnection, !Task.isCancelled {
                deliveryRequested = false
                do {
                    try await deliverOutbox()
                } catch {
                    handle(error)
                    // An unreadable outbox must remain visible and retry without a hot loop.
                    scheduleDeliveryRetry(after: .now + .seconds(2))
                    return
                }
            }
        }
    }

    /// Sends a bounded batch through the one resident sender; failures retain their per-result
    /// backoff, and remaining due entries schedule another pass without gating pulls.
    private func deliverOutbox() async throws {
        guard shouldRun, !updateRequired else { return }
        try await refreshDeliveryHeartbeats()
        applyDelivery(
            try await delivery.deliverDue(transport: transport, deviceID: wireDeviceID),
            snapshot: await delivery.snapshot)
        try await refreshDeliveryHeartbeats()
    }

    private func refreshDeliveryHeartbeats() async throws {
        let pending = try await outbox.pending()
        let keys = Set(pending.map(\.key))
        for key in Array(deliveryHeartbeats.keys)
        where !keys.contains(key) && !recordingResults.contains(key) {
            deliveryHeartbeats.removeValue(forKey: key)?.cancel()
        }
        refusedDeliveryLeases.formIntersection(keys)
        guard shouldRun, platformAllowsConnection, !Task.isCancelled else { return }
        for entry in pending
        where deliveryHeartbeats[entry.key] == nil && !refusedDeliveryLeases.contains(entry.key) {
            let claim = CompanionImageCommandClaim(
                jobID: entry.result.jobId, attemptID: entry.result.attemptId)
            deliveryHeartbeats[entry.key] = startHeartbeat(
                key: entry.key, claim: claim, lease: CompanionCommandLease(deadline: .distantFuture))
        }
    }

    private func cancelDeliveryHeartbeats() {
        for heartbeat in deliveryHeartbeats.values { heartbeat.cancel() }
        deliveryHeartbeats.removeAll()
        refusedDeliveryLeases.removeAll()
    }

    private func applyDelivery(
        _ outcome: CompanionResultDelivery.Outcome, snapshot: CompanionResultDelivery.Snapshot
    ) {
        deliverySnapshot = snapshot
        queueProgress?.completedCount = max(0, snapshot.completedCount - sessionCompletedBaseline)
        // Kept on disk: the updated build delivers it.
        if case .updateRequired(let error) = outcome { enterUpdateRequired(error) }
        scheduleDeliveryRetry()
        reportActivity()
    }

    private func scheduleDeliveryRetry() {
        scheduleDeliveryRetry(after: deliverySnapshot.nextAttemptAt)
    }

    private func scheduleDeliveryRetry(after next: ContinuousClock.Instant?) {
        deliveryRetry?.cancel()
        deliveryRetry = nil
        guard shouldRun, platformAllowsConnection, !updateRequired, let next else { return }
        deliveryRetry = Task { [weak self] in
            do { try await Task.sleep(until: next) } catch { return }
            await self?.requestDelivery()
        }
    }

    // MARK: Commands

    enum CommandStart: Equatable {
        case started
        /// Held for a paused acceptance, dropped for a stopped one, or already running.
        case notStarted
        /// This build cannot execute it; its claim (when it had one) was released.
        case unsupported(String)
    }

    /// Tracks the command in `commandTasks` from acceptance until its result is durably recorded,
    /// which is what `drainState()` counts as outstanding.
    @discardableResult
    func startCommand(_ command: ImageProcessingCommand) -> CommandStart {
        let metadata: CompanionImageCommandMetadata
        do { metadata = try CompanionImageCommandMetadata(command) } catch {
            // Hand it back now rather than holding it for its whole lease; the caller reports
            // it and backs off before pulling again.
            releaseBestEffort(command)
            return .unsupported(String(describing: error))
        }
        guard acceptance == .open else {
            // Held, not started: a paused check resumes it; a stopped worker hands it back.
            if acceptance == .paused {
                deferredCommands.append(command)
            } else {
                releaseBestEffort(command)
            }
            return .notStarted
        }
        let key = CompanionImageProcessingProtocol.attemptKey(
            jobID: metadata.jobID, attemptID: metadata.attemptID)
        guard commandTasks[key] == nil else { return .notStarted }
        let claim = CompanionImageCommandClaim(jobID: metadata.jobID, attemptID: metadata.attemptID)
        inFlight[key] = claim
        beginQueueSession()
        commandTasks[key] = Task { [weak self] in
            await self?.run(command, metadata: metadata, claim: claim, key: key)
        }
        return .started
    }

    /// Stops starting newly pulled commands for the rest of this worker's life (a standalone
    /// companion's shutdown); accepted ones keep running, recording, and delivering.
    public func stopAccepting() {
        acceptance = .stopped
        releaseDeferredCommands()
    }

    /// The only safe "settled → stop" check. It closes acceptance first, so no command can start
    /// while it awaits the outbox, then answers whether nothing is outstanding or undelivered.
    /// `true` leaves acceptance closed for the caller to `stop()`; `false` reopens it (unless
    /// `stopAccepting()` was called) and starts any command that arrived meanwhile.
    public func pauseAcceptingIfSettled() async throws -> Bool {
        if acceptance == .open { acceptance = .paused }
        // Acceptance is closed, so `commandTasks` can only shrink across this suspension; a
        // command still in it was counted, and one that finished recorded its result first.
        var settled = commandTasks.isEmpty
        if settled {
            do {
                settled = try await outbox.pending().isEmpty && commandTasks.isEmpty
            } catch {
                reopenIfPaused()
                throw error
            }
        }
        if !settled { reopenIfPaused() }
        return settled
    }

    /// Whether a connection loop is running, the only path that subscribes.
    var isConnecting: Bool { connectionTask != nil }

    /// Whether a 426 stopped this worker.
    var isUpdateRequired: Bool { updateRequired }

    /// Whether a failed drain's backoff is pending.
    var isBackingOff: Bool { drainRetry != nil }

    /// Returns once the current drain pass, if any, has ended.
    func drainIdle() async {
        await drainTask?.value
    }

    /// Returns once every accepted command has recorded its result or stopped.
    func commandsIdle() async {
        while !Task.isCancelled, let command = commandTasks.values.first {
            await command.waitUnlessCancelled()
        }
        await deliveryTask?.waitUnlessCancelled()
    }

    /// Captures a recorded result heartbeat for deterministic lifecycle checks.
    func deliveryHeartbeat(for key: String) -> Task<Void, Never>? {
        deliveryHeartbeats[key]
    }

    /// Returns once every best-effort release has answered or timed out.
    func releasesIdle() async {
        while !Task.isCancelled, let release = releaseTasks.values.first {
            await release.waitUnlessCancelled()
        }
    }

    private func reopenIfPaused() {
        guard acceptance == .paused else { return }
        acceptance = .open
        let deferred = deferredCommands
        deferredCommands.removeAll()
        for command in deferred { startCommand(command) }
        requestDrain()
    }

    /// Advisory counts for logging and the `--once` quiet window. It can over-count a finishing
    /// command but is not atomic with acceptance; stop on `pauseAcceptingIfSettled()`, not this.
    public func drainState() async throws -> CompanionDrainState {
        let connected = socket != nil && socket === openedSocket
        let outstanding = commandTasks.count
        let pending = try await outbox.pending().count
        return .init(connected: connected, outstandingCommands: outstanding, pendingResults: pending)
    }

    private func run(
        _ command: ImageProcessingCommand, metadata: CompanionImageCommandMetadata,
        claim: CompanionImageCommandClaim, key: String
    ) async {
        defer {
            commandTasks[key] = nil
            inFlight[key] = nil
            requestDrain()
            reportActivity()
        }
        guard !Task.isCancelled else { return }
        defer {
            running[key] = nil
            reportActivity()
        }
        running[key] = RunningCommand(jobID: metadata.jobID, kind: metadata.kind, startedAt: .now)
        reportActivity()
        let lease = CompanionCommandLease(deadline: metadata.deadline)
        let heartbeat = startHeartbeat(key: key, claim: claim, lease: lease)
        defer { if deliveryHeartbeats[key] == nil { heartbeat.cancel() } }
        do {
            let started = ContinuousClock.now
            let execute = self.execute
            let result = try await CompanionCommandLease.$current.withValue(lease) {
                try await execute(command)
            }
            running[key] = nil
            reportActivity()
            // Stopped (its claim was released) or its lease was refused: the result is moot.
            guard !Task.isCancelled, inFlight.removeValue(forKey: key) != nil else { return }
            deliveryHeartbeats[key] = heartbeat
            recordingResults.insert(key)
            defer { recordingResults.remove(key) }
            jobObserver?(.init(result, kind: metadata.kind, duration: started.duration(to: .now)))
            try await recordResult(result, key)
            recordingResults.remove(key)
            deliverySnapshot = await delivery.refreshSnapshot()
            reportActivity()
            requestDelivery()
        } catch {
            // Execution threw before a result existed; hand the claim back unless it is gone.
            let wasRecording = deliveryHeartbeats.removeValue(forKey: key)
            wasRecording?.cancel()
            if inFlight.removeValue(forKey: key) != nil || wasRecording != nil {
                releaseBestEffort(claim)
            }
            handle(error)
        }
    }

    /// Renews through execution and recorded delivery. A refusal stops execution; a recorded
    /// result stays durable and the server still decides whether its late completion is adoptable.
    private func startHeartbeat(
        key: String, claim: CompanionImageCommandClaim, lease: CompanionCommandLease
    ) -> Task<Void, Never> {
        let pause = heartbeatPause
        return Task { [weak self] in
            while !Task.isCancelled {
                do { try await pause() } catch { return }
                guard let self, await self.renew(key: key, claim: claim, lease: lease) else {
                    return
                }
            }
        }
    }

    /// `false` ends the heartbeat.
    private func renew(
        key: String, claim: CompanionImageCommandClaim, lease: CompanionCommandLease
    ) async -> Bool {
        guard (inFlight[key] != nil || deliveryHeartbeats[key] != nil), !Task.isCancelled else {
            return false
        }
        do {
            if inFlight[key] == nil, !recordingResults.contains(key),
                try await outbox.result(for: key) == nil
            {
                deliveryHeartbeats.removeValue(forKey: key)?.cancel()
                return false
            }
            switch try await transport.renew(deviceID: wireDeviceID, claim: claim) {
            case .renewed(let leaseExpiresAt):
                lease.extend(to: leaseExpiresAt)
                return true
            case .refused(let reason):
                // A completion may have acknowledged this result while renewal was in flight.
                if inFlight[key] == nil, !recordingResults.contains(key),
                    try await outbox.result(for: key) == nil
                {
                    deliveryHeartbeats.removeValue(forKey: key)?.cancel()
                    return false
                }
                // The server retired or reassigned this attempt; a result would be discarded and
                // the work may already be running elsewhere. Stop without releasing.
                if inFlight.removeValue(forKey: key) != nil {
                    commandTasks[key]?.cancel()
                } else if deliveryHeartbeats.removeValue(forKey: key) != nil {
                    refusedDeliveryLeases.insert(key)
                } else {
                    return false
                }
                let refusal = CompanionLeaseRefused(jobID: claim.jobID, reason: reason)
                lastError = Self.describe(refusal)
                failureObserver?(refusal)
                reportActivity()
                return false
            }
        } catch is CancellationError {
            return false
        } catch {
            handle(error)
            return !updateRequired
        }
    }

    /// Cancels every running command and hands back the claims of those not yet recorded.
    private func cancelCommands() {
        for task in commandTasks.values { task.cancel() }
        let claims = Array(inFlight.values)
        inFlight.removeAll()
        running = [:]
        for claim in claims { releaseBestEffort(claim) }
    }

    private func releaseDeferredCommands() {
        let deferred = deferredCommands
        deferredCommands.removeAll()
        for command in deferred { releaseBestEffort(command) }
    }

    private func releaseBestEffort(_ command: ImageProcessingCommand) {
        guard let claim = CompanionImageCommandClaim(command) else { return }
        releaseBestEffort(claim)
    }

    /// Starts an uncancelled release bounded by `CompanionClaimRelease.timeout`. Skipped once a
    /// 426 latched: every write fails the same way and the lease expires on its own.
    private func releaseBestEffort(_ claim: CompanionImageCommandClaim) {
        guard !updateRequired else { return }
        let id = UUID()
        let transport = transport
        let deviceID = wireDeviceID
        let failureObserver = failureObserver
        releaseTasks[id] = Task { [weak self] in
            let refusal = await CompanionClaimRelease.bestEffort(
                transport: transport, deviceID: deviceID, claim: claim,
                failureObserver: failureObserver)
            await self?.releaseFinished(id, refusal: refusal)
        }
    }

    private func releaseFinished(_ id: UUID, refusal: (any Error)?) {
        releaseTasks[id] = nil
        if let refusal { enterUpdateRequired(refusal) }
    }

    // MARK: Errors and activity

    private static func describe(_ error: any Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }

    private func handle(_ error: any Error) {
        if CompanionResultDelivery.isClientUpdateRequired(error) {
            enterUpdateRequired(error)
            return
        }
        guard !(error is CancellationError) else { return }
        lastError = Self.describe(error)
        failureObserver?(error)
        reportActivity()
    }

    /// Stops pulling for good: the server will refuse every image write from this build. Recorded
    /// results stay in the outbox for the updated build to deliver.
    private func enterUpdateRequired(_ error: any Error) {
        guard !updateRequired else { return }
        updateRequired = true
        lastError = Self.describe(error)
        failureObserver?(error)
        backgroundTask?.cancel()
        drainRetry?.cancel()
        drainRetry = nil
        deliveryRetry?.cancel()
        deliveryRetry = nil
        deliveryRequested = false
        deliveryTask?.cancel()
        reconcileConnection()
        reportActivity()
    }

    private func currentActivity() -> CompanionImageWorkerActivity {
        let phase: CompanionImageWorkerActivity.Phase
        if !shouldRun {
            phase = .stopped
        } else if updateRequired {
            phase = .updateRequired
        } else if !isParticipating {
            phase = .automaticWorkOff
        } else if queueProgress != nil {
            phase = .processing
        } else if systemAsleep {
            phase = .asleep
        } else if !platformAllowsConnection {
            phase = .backgrounded
        } else if socket == nil || socket !== openedSocket {
            phase = .connecting
        } else if isPulling {
            phase = .pulling
        } else {
            phase = .idle
        }
        let oldest = phase == .processing ? running.values.min { $0.startedAt < $1.startedAt } : nil
        return .init(
            phase: phase, queueProgress: phase == .processing ? queueProgress : nil, jobID: oldest?.jobID,
            kind: oldest?.kind, startedAt: oldest?.startedAt,
            remotePaused: remotePaused,
            processingCount: phase == .processing ? running.count + backgroundProcessingCount : 0,
            undeliveredResults: deliverySnapshot.undelivered,
            deliveryError: deliverySnapshot.latestError,
            lastError: phase == .stopped ? nil : lastError,
            connectionAttempt: phase == .connecting ? connectionAttempt : 0,
            nextConnectAt: phase == .connecting ? nextConnectAt : nil,
            connectedAt: phase == .connecting ? nil : connectedAt)
    }

    private func beginQueueSession() {
        guard queueProgress == nil else { return }
        sessionCompletedBaseline = deliverySnapshot.completedCount
        queueProgress = .init(startedAt: .now)
        let sessionID = queueProgress?.id
        backlogRefresh = Task { [weak self, transport] in
            while !Task.isCancelled {
                do {
                    guard let backlog = try await transport.deviceBacklog() else { return }
                    await self?.refreshBacklog(backlog, sessionID: sessionID)
                } catch is CancellationError { return } catch { await self?.failureObserver?(error) }
                do { try await Task.sleep(for: .seconds(45)) } catch { return }
            }
        }
    }

    private func refreshBacklog(_ backlog: DeviceBacklogBanner, sessionID: String?) {
        guard queueProgress?.id == sessionID else { return }
        queueProgress?.refresh(
            backlog: backlog,
            outstanding: commandTasks.count + backgroundProcessingCount + deliverySnapshot.undelivered)
        reportActivity()
    }

    private func reportBackgroundProgress(processed: Int, running: Int) {
        if running > 0 { beginQueueSession() }
        deliverySnapshot.completedCount = processed
        queueProgress?.completedCount = max(0, processed - sessionCompletedBaseline)
        backgroundProcessingCount = running
        reportActivity()
    }

    /// Reports only changes, so observers see each transition once.
    private func reportActivity() {
        // Slot refills and durable result recording belong to the same session. Only a settled
        // drain or a lifecycle stop ends it; a transient zero-running count does not reset it.
        if !shouldRun || updateRequired || !isParticipating || systemAsleep
            || (!platformAllowsConnection && !backgroundWindowActive)
            || (commandTasks.isEmpty && !isDraining && deliveryTask == nil
                && deliverySnapshot.undelivered == 0 && !backgroundWindowActive)
        {
            queueProgress = nil
            backlogRefresh?.cancel()
            backlogRefresh = nil
        }
        let activity = currentActivity()
        guard activity != lastReportedActivity else { return }
        lastReportedActivity = activity
        activityObserver?(activity)
    }
}

/// The one best-effort `imageProcessing.release`, shared by the resident worker and the iOS
/// charging window. It runs in an uncancelled task so a stopping caller still sends it, and the
/// request is cancelled after `timeout` when the remaining window cannot fit it.
enum CompanionClaimRelease {
    static let timeout = Duration.seconds(3)

    /// Returns the 426 CLIENT_UPDATE_REQUIRED that refused the release, for the caller to latch;
    /// any other failure goes to `failureObserver` and the lease expires on its own.
    @discardableResult
    static func bestEffort(
        transport: any CompanionImageBackgroundTransport, deviceID: String,
        claim: CompanionImageCommandClaim, failureObserver: CompanionImageWorker.FailureObserver?
    ) async -> (any Error)? {
        let cleanup = Task { () -> (any Error)? in
            await withTaskGroup(of: (any Error)?.self) { group in
                group.addTask {
                    do {
                        try await transport.release(deviceID: deviceID, claim: claim)
                    } catch {
                        if CompanionResultDelivery.isClientUpdateRequired(error) { return error }
                        failureObserver?(error)
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(for: timeout)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }
        }
        return await cleanup.value
    }
}

/// Waits for `receive` to deliver the subscription's first frame, or fails after `limit`. On a
/// timeout `cancel` closes the socket, which ends the pending receive, so the wait cannot hang.
func awaitFirstFrame(
    within limit: Duration,
    receive: @escaping @Sendable () async throws -> Void,
    cancel: @escaping @Sendable () -> Void
) async throws {
    try await withThrowingTaskGroup(of: Bool.self) { group in
        group.addTask {
            try await receive()
            return true
        }
        group.addTask {
            try await Task.sleep(for: limit)
            return false
        }
        defer { group.cancelAll() }
        let greeted = try await group.next() ?? false
        if !greeted {
            cancel()
            throw CompanionOpenTimeout(limit: limit)
        }
    }
}

/// The subscription opened but no greeting arrived within the deadline.
struct CompanionOpenTimeout: LocalizedError {
    let limit: Duration
    var errorDescription: String? {
        "No greeting from the image-work doorbell within \(limit.components.seconds) s"
    }
}

/// One failed subscription attempt: which step failed and why, for Activity and diagnostics.
struct CompanionConnectionFailure: LocalizedError, CustomNSError {
    let step: String
    let attempt: Int
    let underlying: any Error

    var errorDescription: String? {
        let nsError = underlying as NSError
        let reason = (underlying as? LocalizedError)?.errorDescription ?? String(describing: underlying)
        return "\(step) failed (\(nsError.domain) \(nsError.code)): \(reason)"
    }

    static var errorDomain: String { "CompanionConnection" }
    var errorCode: Int { (underlying as NSError).code }
    var errorUserInfo: [String: Any] {
        [
            NSLocalizedDescriptionKey: errorDescription ?? "",
            NSUnderlyingErrorKey: underlying as NSError,
            "step": step,
            "attempt": attempt,
        ]
    }
}
