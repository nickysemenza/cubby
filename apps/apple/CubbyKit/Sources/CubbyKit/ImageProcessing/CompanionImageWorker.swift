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

/// Whether an incoming command should be executed — `false` when the web has paused this
/// connection (`ImageProcessingServerMessageHelloAck.remotePaused`), same as participation-off.
/// A tiny pure decision, kept apart from the actor so it is directly unit-testable without a live
/// socket.
enum CompanionWorkAcceptance {
    static func acceptsCommand(remotePaused: Bool) -> Bool { !remotePaused }
}

public actor CompanionImageWorker {
    public typealias FailureObserver = @Sendable (any Error) -> Void
    public typealias ActivityObserver = @Sendable (CompanionImageWorkerActivity) -> Void

    private let baseURL: URL
    private let credentials: CredentialProvider
    private let session: URLSession
    private let executor: CompanionImageCommandExecutor
    private let outbox: CompanionResultOutbox<ImageProcessingResult>
    private let failureObserver: FailureObserver?
    private let activityObserver: ActivityObserver?
    private let deviceID: UUID
    private let deviceName: String
    private var foreground: Bool
    /// The master "Automatic work on this device" switch. `false` keeps `start()`/`stop()` working
    /// normally but never opens a socket (`platformAllowsConnection`); flipping it off mid-session
    /// closes the socket via `reconcileConnection()`, and flipping it back on reconnects.
    private var isParticipating: Bool
    /// Set from `.helloAck(remotePaused)` on the current connection: the server paused this device
    /// from the web. Reset on every new connection attempt.
    private var remotePaused = false
    private var shouldRun = false
    private var connectionGeneration = 0
    private var connectionTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    /// The server dispatches every queued job at once; executing each inline in the receive loop
    /// ran a photo run's describe and cutout jobs strictly one after another. Commands now run
    /// concurrently up to this bound, and each command's own deadline still applies while queued.
    static let maximumConcurrentCommands = 4
    private var commandTasks: [String: Task<Void, Never>] = [:]
    private var running: [String: CompanionImageWorkerActivity] = [:]
    private var runningCount = 0
    private var slotWaiters: [CheckedContinuation<Void, Never>] = []

    public init(
        baseURL: URL,
        credentials: CredentialProvider,
        deviceID: UUID,
        deviceName: String,
        foreground: Bool,
        isParticipating: Bool = true,
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        session: URLSession = .cubbyShared,
        executor: CompanionImageCommandExecutor = CompanionImageCommandExecutor(),
        failureObserver: FailureObserver? = nil,
        activityObserver: ActivityObserver? = nil
    ) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.deviceID = deviceID
        self.deviceName = deviceName
        self.foreground = foreground
        self.isParticipating = isParticipating
        self.outbox = outbox
        self.session = session
        self.executor = executor
        self.failureObserver = failureObserver
        self.activityObserver = activityObserver
    }

    deinit {
        connectionTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
    }

    public func start() {
        shouldRun = true
        activityObserver?(.init(phase: .connecting))
        reconcileConnection()
    }

    public func stop() {
        shouldRun = false
        connectionGeneration += 1
        connectionTask?.cancel()
        connectionTask = nil
        cancelCommands()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        activityObserver?(.init(phase: .stopped))
    }

    /// Signing out ends the authenticated principal that owns every pending attempt. Do not let
    /// another account subsequently signed in on the same host replay those results.
    public func stopAndDiscardPendingResults() async throws {
        stop()
        try await outbox.removeAll()
    }

    public func setForeground(_ foreground: Bool) {
        self.foreground = foreground
        reconcileConnection()
    }

    /// The master "Automatic work on this device" switch. `start()` is still what arms
    /// `shouldRun` — this only gates whether `reconcileConnection()` is allowed to open a socket,
    /// so a later flip back on reconnects without a fresh `start()`.
    public func setParticipating(_ participating: Bool) {
        isParticipating = participating
        reconcileConnection()
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
        guard let credential = await credentials.current(),
            case .bearer(let token) = credential, !token.isEmpty
        else {
            throw URLError(.userAuthenticationRequired)
        }
        let endpoint = try AuthenticatedSocketSupport.socketURL(
            baseURL: baseURL, path: "/api/companion/image-processing/socket")
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
        // Per-connection: a stale pause from a prior connection must not survive a reconnect that
        // (re)establishes an unpaused session.
        remotePaused = false

        let descriptionAvailable =
            FoundationModelsImageDescriber().availability() == .available
        #if os(macOS)
            let advertisedForeground = true
        #else
            let advertisedForeground = foreground
        #endif
        try await send(
            .companionHello(
                deviceID: deviceID, deviceName: deviceName, foreground: advertisedForeground,
                imageDescriptionAvailable: descriptionAvailable, automaticWork: isParticipating),
            on: socket)
        activityObserver?(.init(phase: .idle))
        for pending in try await outbox.pending() {
            try await send(.companionResult(pending.result), on: socket)
        }

        while !Task.isCancelled, generation == connectionGeneration, self.socket === socket {
            guard
                let data = AuthenticatedSocketSupport.data(from: try await socket.receive())
            else { continue }
            let message = try JSONDecoder.companionImageProcessing.decode(
                ImageProcessingServerMessage.self, from: data)
            try await handle(message, socket: socket)
        }
    }

    private func handle(
        _ message: ImageProcessingServerMessage, socket: URLSessionWebSocketTask
    ) async throws {
        switch message {
        case .helloAck(let ack):
            // The web paused this device (`Device.remotePaused`): treat it like participation-off
            // for this connection — no work is accepted until a fresh hello reports otherwise.
            remotePaused = ack.remotePaused
            activityObserver?(.init(phase: .idle, remotePaused: ack.remotePaused))
        case .acknowledge(let envelope):
            try await outbox.acknowledge(
                CompanionImageProcessingProtocol.attemptKey(
                    jobID: envelope.jobId, attemptID: envelope.attemptId))
        case .command(let envelope):
            guard CompanionWorkAcceptance.acceptsCommand(remotePaused: remotePaused) else { return }
            let command = envelope.command
            let key = CompanionImageProcessingProtocol.attemptKey(
                jobID: command.companionJobID, attemptID: command.companionAttemptID)
            if let completed = try await outbox.result(for: key) {
                try await send(.companionResult(completed), on: socket)
                return
            }
            guard commandTasks[key] == nil else { return }
            commandTasks[key] = Task { [weak self] in
                await self?.run(command, key: key, socket: socket)
            }
        }
    }

    private func run(
        _ command: ImageProcessingCommand, key: String, socket: URLSessionWebSocketTask
    ) async {
        await acquireSlot()
        defer {
            releaseSlot()
            commandTasks[key] = nil
        }
        guard !Task.isCancelled else { return }
        running[key] = .init(
            phase: .processing, jobID: command.companionJobID, kind: command.companionKind,
            startedAt: .now)
        reportActivity()
        let result = await executor.execute(command)
        running[key] = nil
        reportActivity()
        guard !Task.isCancelled else { return }
        do {
            try await outbox.record(result, for: key)
            // A reconnect replays the outbox, so a result from a dropped socket is not lost.
            guard self.socket === socket else { return }
            try await send(.companionResult(result), on: socket)
        } catch {
            failureObserver?(error)
        }
    }

    private func acquireSlot() async {
        guard runningCount >= Self.maximumConcurrentCommands else {
            runningCount += 1
            return
        }
        await withCheckedContinuation { slotWaiters.append($0) }
    }

    private func releaseSlot() {
        if slotWaiters.isEmpty {
            runningCount -= 1
        } else {
            slotWaiters.removeFirst().resume()
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

    private func send(
        _ message: ImageProcessingClientMessage, on socket: URLSessionWebSocketTask
    ) async throws {
        let data = try JSONEncoder.companionImageProcessing.encode(message)
        try await socket.send(.data(data))
    }

}
