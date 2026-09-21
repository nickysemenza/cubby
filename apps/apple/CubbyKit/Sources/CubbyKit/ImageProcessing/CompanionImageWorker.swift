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

    public init(phase: Phase, jobID: String? = nil, kind: String? = nil, startedAt: Date? = nil) {
        self.phase = phase
        self.jobID = jobID
        self.kind = kind
        self.startedAt = startedAt
    }
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
    private var foreground: Bool
    private var shouldRun = false
    private var connectionGeneration = 0
    private var connectionTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?

    public init(
        baseURL: URL,
        credentials: CredentialProvider,
        deviceID: UUID,
        foreground: Bool,
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        session: URLSession = .cubbyShared,
        executor: CompanionImageCommandExecutor = CompanionImageCommandExecutor(),
        failureObserver: FailureObserver? = nil,
        activityObserver: ActivityObserver? = nil
    ) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.deviceID = deviceID
        self.foreground = foreground
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

    private var platformAllowsConnection: Bool {
        #if os(macOS)
            true
        #else
            foreground
        #endif
    }

    private func reconcileConnection() {
        guard shouldRun, platformAllowsConnection else {
            connectionGeneration += 1
            connectionTask?.cancel()
            connectionTask = nil
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
            userAgent: "cubby-apple-image-worker/\(CompanionImageProcessingProtocol.version)")
        let socket = session.webSocketTask(with: request)
        guard generation == connectionGeneration else { throw CancellationError() }
        self.socket = socket
        socket.resume()

        let descriptionAvailable =
            FoundationModelsImageDescriber().availability() == .available
        #if os(macOS)
            let advertisedForeground = true
        #else
            let advertisedForeground = foreground
        #endif
        try await send(
            .companionHello(
                deviceID: deviceID, foreground: advertisedForeground,
                imageDescriptionAvailable: descriptionAvailable),
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
        case .acknowledge(let envelope):
            try await outbox.acknowledge(
                CompanionImageProcessingProtocol.attemptKey(
                    jobID: envelope.jobId, attemptID: envelope.attemptId))
        case .command(let envelope):
            let command = envelope.command
            let key = CompanionImageProcessingProtocol.attemptKey(
                jobID: command.companionJobID, attemptID: command.companionAttemptID)
            if let completed = try await outbox.result(for: key) {
                try await send(.companionResult(completed), on: socket)
                return
            }
            activityObserver?(
                .init(
                    phase: .processing, jobID: command.companionJobID,
                    kind: command.companionKind, startedAt: .now))
            let result = await executor.execute(command)
            try Task.checkCancellation()
            try await outbox.record(result, for: key)
            try await send(.companionResult(result), on: socket)
            activityObserver?(.init(phase: .idle))
        }
    }

    private func send(
        _ message: ImageProcessingClientMessage, on socket: URLSessionWebSocketTask
    ) async throws {
        let data = try JSONEncoder.companionImageProcessing.encode(message)
        try await socket.send(.data(data))
    }

}
