import Foundation

public struct CompanionImageWorkerActivity: Sendable, Equatable {
    public enum Phase: Sendable, Equatable {
        case stopped
        case connecting
        case idle
        case processing
    }

    public let phase: Phase
    public let jobID: String?
    public let kind: String?
    public let startedAt: Date?
    /// The server paused this device's participation from the web (`Device.remotePaused`), for
    /// this connection. Settings shows "Paused from the web" when this is true.
    public let remotePaused: Bool

    public init(
        phase: Phase, jobID: String? = nil, kind: String? = nil, startedAt: Date? = nil,
        remotePaused: Bool = false
    ) {
        self.phase = phase
        self.jobID = jobID
        self.kind = kind
        self.startedAt = startedAt
        self.remotePaused = remotePaused
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

/// The foreground companion. It subscribes to the `imageProcessing.work` doorbell and, when the
/// subscription opens and on every ring, drains claimable work through `imageProcessing.pull`,
/// executing up to `maximumConcurrentCommands` at once and finishing each with
/// `imageProcessing.complete`. A ring carries no state; a missed one costs latency only, because
/// every reconnect drains again.
public actor CompanionImageWorker {
    public typealias FailureObserver = @Sendable (any Error) -> Void
    public typealias ActivityObserver = @Sendable (CompanionImageWorkerActivity) -> Void
    public typealias JobObserver = @Sendable (CompanionImageJobReport) -> Void

    private let baseURL: URL
    private let credentials: CredentialProvider
    private let session: URLSession
    private let transport: any CompanionImageBackgroundTransport
    private let execute: @Sendable (ImageProcessingCommand) async throws -> ImageProcessingResult
    private let outbox: CompanionResultOutbox<ImageProcessingResult>
    /// Durably records a finished command's result; tests hold this boundary open.
    private let recordResult: @Sendable (ImageProcessingResult, String) async throws -> Void
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
    /// From the latest pull: the server paused this device from the web. Reset on every new
    /// subscription.
    private var remotePaused = false
    private var shouldRun = false
    private var connectionGeneration = 0
    private var connectionTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    /// The subscription that has opened; `drainState()` is connected only while it is `socket`.
    private var openedSocket: URLSessionWebSocketTask?
    private var backgroundTask: Task<Bool, Never>?
    private let backgroundRunner: CompanionImageBackgroundRunner
    /// Commands run concurrently up to this bound; each command's own deadline still applies.
    static let maximumConcurrentCommands = 4
    private var commandTasks: [String: Task<Void, Never>] = [:]
    private enum Acceptance { case open, paused, stopped }
    private var acceptance = Acceptance.open
    private var deferredCommands: [ImageProcessingCommand] = []
    private var running: [String: CompanionImageWorkerActivity] = [:]
    private var isDraining = false
    private var drainRequested = false

    public init(
        baseURL: URL,
        credentials: CredentialProvider,
        deviceID: UUID,
        deviceName: String,
        foreground: Bool,
        isParticipating: Bool = true,
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        identity: ClientIdentity = .unknown,
        session: URLSession = .cubbyShared,
        executor: CompanionImageCommandExecutor = CompanionImageCommandExecutor(),
        failureObserver: FailureObserver? = nil,
        activityObserver: ActivityObserver? = nil,
        jobObserver: JobObserver? = nil
    ) {
        self.init(
            baseURL: baseURL, credentials: credentials, deviceID: deviceID, deviceName: deviceName,
            foreground: foreground, isParticipating: isParticipating, outbox: outbox,
            session: session,
            transport: CubbyClient(
                baseURL: baseURL, credentials: credentials, identity: identity, session: session),
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
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        session: URLSession = .cubbyShared,
        transport: any CompanionImageBackgroundTransport,
        failureObserver: FailureObserver? = nil,
        activityObserver: ActivityObserver? = nil,
        jobObserver: JobObserver? = nil,
        execute: @escaping @Sendable (ImageProcessingCommand) async throws -> ImageProcessingResult,
        recordResult: (@Sendable (ImageProcessingResult, String) async throws -> Void)? = nil
    ) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.deviceID = deviceID
        self.deviceName = deviceName
        self.foreground = foreground
        self.isParticipating = isParticipating
        self.outbox = outbox
        self.recordResult = recordResult ?? { try await outbox.record($0, for: $1) }
        self.session = session
        self.transport = transport
        self.execute = execute
        self.failureObserver = failureObserver
        self.activityObserver = activityObserver
        self.jobObserver = jobObserver
        self.backgroundRunner = CompanionImageBackgroundRunner(
            outbox: outbox, execute: execute, failureObserver: failureObserver)
    }

    deinit {
        backgroundTask?.cancel()
        connectionTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    public func start() {
        shouldRun = true
        activityObserver?(.init(phase: .connecting))
        reconcileConnection()
    }

    public func stop() {
        backgroundTask?.cancel()
        shouldRun = false
        connectionGeneration += 1
        connectionTask?.cancel()
        connectionTask = nil
        cancelCommands()
        deferredCommands.removeAll()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        activityObserver?(.init(phase: .stopped))
    }

    /// Signing out ends the authenticated principal that owns every pending attempt. Do not let
    /// another account subsequently signed in on the same host replay those results.
    public func stopAndDiscardPendingResults() async throws {
        let background = backgroundTask
        let connection = connectionTask
        let commands = Array(commandTasks.values)
        stop()
        _ = await background?.value
        await connection?.value
        for command in commands { await command.value }
        try await outbox.removeAll()
    }

    public func setForeground(_ foreground: Bool) {
        self.foreground = foreground
        reconcileConnection()
    }

    /// The master "Automatic work on this device" switch. `start()` is still what arms
    /// `shouldRun` — this only gates whether `reconcileConnection()` may subscribe, so a later
    /// flip back on reconnects without a fresh `start()`.
    public func setParticipating(_ participating: Bool) {
        isParticipating = participating
        if !participating { backgroundTask?.cancel() }
        reconcileConnection()
    }

    /// The charging task owns this finite HTTP window; it does not reopen an iOS subscription.
    public func runInBackground(client: CubbyClient) async -> Bool {
        await runInBackground(transport: client, hello: hello(foreground: false))
    }

    func runInBackground(
        transport: any CompanionImageBackgroundTransport, hello: ImageProcessingHello
    ) async -> Bool {
        guard shouldRun, isParticipating, backgroundTask == nil else { return false }
        let task = Task { await backgroundRunner.run(transport: transport, hello: hello) }
        backgroundTask = task
        let resumable = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        backgroundTask = nil
        return resumable
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
        guard isParticipating else { return false }
        #if os(macOS)
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
            cancelCommands()
            socket?.cancel(with: .goingAway, reason: nil)
            socket = nil
            return
        }
        guard connectionTask == nil else { return }
        connectionGeneration += 1
        let generation = connectionGeneration
        connectionTask = Task { [weak self] in
            await self?.runConnectionLoop(generation: generation)
        }
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
                socket?.cancel(with: .abnormalClosure, reason: nil)
                socket = nil
                if !AuthenticatedSocketSupport.isExpectedReconnectFailure(error) {
                    failureObserver?(error)
                }
                activityObserver?(.init(phase: .connecting))
                do {
                    try await Task.sleep(
                        for: AuthenticatedSocketSupport.reconnectDelay(attempt: attempt))
                } catch {
                    break
                }
            }
        }
        if generation == connectionGeneration {
            socket?.cancel(with: .goingAway, reason: nil)
            socket = nil
            connectionTask = nil
        }
    }

    private func runOneConnection(generation: Int) async throws {
        let token = try await credentials.bearerToken()
        let endpoint = try AuthenticatedSocketSupport.socketURL(
            baseURL: baseURL, path: CompanionImageProcessingProtocol.doorbellPath,
            queryItems: [CompanionImageProcessingProtocol.doorbellTopic])
        let request = try AuthenticatedSocketSupport.request(
            url: endpoint,
            bearerToken: token,
            userAgent:
                "cubby-apple-image-worker/\(CompanionImageProcessingProtocol.version) (\(deviceID.uuidString.lowercased()))"
        )
        let socket = session.webSocketTask(with: request)
        guard generation == connectionGeneration else { throw CancellationError() }
        self.socket = socket
        socket.resume()
        // Per-subscription: a stale pause must not survive a reconnect whose first pull reports
        // otherwise.
        remotePaused = false
        // A protocol ping confirms the subscription opened; an application frame would end it.
        try await withCheckedThrowingContinuation { (opened: CheckedContinuation<Void, Error>) in
            socket.sendPing { error in
                if let error { opened.resume(throwing: error) } else { opened.resume() }
            }
        }
        openedSocket = socket
        activityObserver?(.init(phase: .idle))
        // Work already waiting is claimable now; do not wait for the first ring.
        requestDrain()
        while !Task.isCancelled, generation == connectionGeneration, self.socket === socket {
            // Any frame is a ring; its content is a refetch hint this worker does not need.
            _ = try await socket.receive()
            requestDrain()
        }
    }

    /// Coalesces rings: one drain runs at a time, and a ring during it runs one more pass.
    func requestDrain() {
        guard shouldRun else { return }
        drainRequested = true
        guard !isDraining else { return }
        isDraining = true
        Task { await self.drainWhileRequested() }
    }

    private func drainWhileRequested() async {
        defer { isDraining = false }
        while drainRequested, shouldRun {
            drainRequested = false
            do {
                try await drainOnce()
            } catch {
                failureObserver?(error)
            }
        }
    }

    /// Delivers recorded results, then pulls until no work is claimable or every slot is busy. A
    /// finished command requests another drain to refill its slot.
    private func drainOnce() async throws {
        for entry in try await outbox.pending() {
            try await transport.complete(deviceID: deviceID.uuidString.lowercased(), result: entry.result)
            try await outbox.acknowledge(entry.key)
        }
        #if os(macOS)
            let advertisedForeground = true
        #else
            let advertisedForeground = foreground
        #endif
        while shouldRun, acceptance == .open,
            commandTasks.count < Self.maximumConcurrentCommands
        {
            let pulled = try await transport.pull(
                hello: hello(foreground: advertisedForeground), leaseSeconds: 90)
            if pulled.remotePaused != remotePaused {
                remotePaused = pulled.remotePaused
                reportActivity()
            }
            guard let command = pulled.command,
                CompanionWorkAcceptance.acceptsCommand(remotePaused: pulled.remotePaused)
            else { return }
            startCommand(command)
        }
    }

    /// Tracks the command in `commandTasks` from acceptance until its result is durably recorded,
    /// which is what `drainState()` counts as outstanding.
    func startCommand(_ command: ImageProcessingCommand) {
        let metadata: CompanionImageCommandMetadata
        do { metadata = try CompanionImageCommandMetadata(command) } catch { failureObserver?(error); return }
        guard acceptance == .open else {
            // Held, not started: a paused check resumes it; a stopped worker drops it and the
            // server's lease expiry offers the job again.
            if acceptance == .paused { deferredCommands.append(command) }
            return
        }
        let key = CompanionImageProcessingProtocol.attemptKey(
            jobID: metadata.jobID, attemptID: metadata.attemptID)
        guard commandTasks[key] == nil else { return }
        commandTasks[key] = Task { [weak self] in
            await self?.run(command, key: key)
        }
    }

    /// Stops starting newly pulled commands for the rest of this worker's life (a standalone
    /// companion's shutdown); accepted ones keep running, recording, and delivering.
    public func stopAccepting() {
        acceptance = .stopped
        deferredCommands.removeAll()
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

    /// Returns once every accepted command has recorded its result or stopped.
    func commandsIdle() async {
        while !Task.isCancelled, let command = commandTasks.values.first {
            await command.waitUnlessCancelled()
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

    private func run(_ command: ImageProcessingCommand, key: String) async {
        defer {
            commandTasks[key] = nil
            requestDrain()
        }
        guard !Task.isCancelled else { return }
        defer { running[key] = nil; reportActivity() }
        do {
            let metadata = try CompanionImageCommandMetadata(command)
            running[key] = .init(
                phase: .processing, jobID: metadata.jobID, kind: metadata.kind,
                startedAt: .now)
            reportActivity()
            let started = ContinuousClock.now
            let result = try await execute(command)
            running[key] = nil
            reportActivity()
            guard !Task.isCancelled else { return }
            jobObserver?(.init(result, kind: metadata.kind, duration: started.duration(to: .now)))
            try await recordResult(result, key)
            // A failed delivery stays in the outbox; the next drain delivers it.
            try await transport.complete(deviceID: deviceID.uuidString.lowercased(), result: result)
            try await outbox.acknowledge(key)
        } catch {
            failureObserver?(error)
        }
    }

    private func cancelCommands() {
        for task in commandTasks.values { task.cancel() }
        running = [:]
    }

    private func reportActivity() {
        guard shouldRun else { return }
        let oldest = running.values.min { ($0.startedAt ?? .distantPast) < ($1.startedAt ?? .distantPast) }
        activityObserver?(oldest ?? .init(phase: .idle, remotePaused: remotePaused))
    }
}
