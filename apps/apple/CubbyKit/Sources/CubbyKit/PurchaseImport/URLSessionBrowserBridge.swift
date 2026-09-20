import Foundation

public struct BrowserBridgeConnectionConfiguration: Sendable {
    public let url: URL
    public let deviceID: UUID
    public let browser: BrowserChoice
    public let capabilities: BrowserBridgeCapabilities
    private let bearerTokenProvider: @Sendable () async -> String?

    public init(
        url: URL, bearerToken: String, deviceID: UUID, browser: BrowserChoice,
        capabilities: BrowserBridgeCapabilities
    ) {
        self.url = url
        self.deviceID = deviceID
        self.browser = browser
        self.capabilities = capabilities
        bearerTokenProvider = { bearerToken }
    }

    public init(
        url: URL, deviceID: UUID, browser: BrowserChoice,
        capabilities: BrowserBridgeCapabilities,
        bearerTokenProvider: @escaping @Sendable () async -> String?
    ) {
        self.url = url
        self.deviceID = deviceID
        self.browser = browser
        self.capabilities = capabilities
        self.bearerTokenProvider = bearerTokenProvider
    }

    func currentBearerToken() async -> String? { await bearerTokenProvider() }

    public var isSecureOrLocalDevelopment: Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased()
        else { return false }
        if scheme == "wss" { return true }
        return scheme == "ws" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
    }
}

public enum BrowserBridgeConnectionStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case waitingToReconnect(attempt: Int)
    case failed(message: String)
}

public actor URLSessionBrowserBridge {
    public typealias StatusObserver = @Sendable (BrowserBridgeConnectionStatus) -> Void
    public typealias ResultObserver = @Sendable (BrowserBridgeCommandResult) -> Void
    public typealias AuthWindowObserver = @Sendable (String) -> Void
    public typealias RunCompletionObserver = @Sendable (BrowserBridgeRunCompletion) -> Void

    private let session: URLSession
    private let replayStore: any BrowserBridgeReplayStoring
    private let executor: any BrowserCommandExecuting
    private let statusObserver: StatusObserver?
    private let resultObserver: ResultObserver?
    private let authWindowObserver: AuthWindowObserver?
    private let runCompletionObserver: RunCompletionObserver?
    private var configuration: BrowserBridgeConnectionConfiguration?
    private var socket: URLSessionWebSocketTask?
    private var connectionTask: Task<Void, Never>?
    private var commandTasks: [UUID: Task<Void, Never>] = [:]
    private var ledger = BrowserBridgeReplayLedger()
    private var status: BrowserBridgeConnectionStatus = .disconnected

    public init(
        replayStore: any BrowserBridgeReplayStoring,
        executor: any BrowserCommandExecuting,
        session: URLSession = .cubbyShared,
        statusObserver: StatusObserver? = nil,
        resultObserver: ResultObserver? = nil,
        authWindowObserver: AuthWindowObserver? = nil,
        runCompletionObserver: RunCompletionObserver? = nil
    ) {
        self.replayStore = replayStore
        self.executor = executor
        self.session = session
        self.statusObserver = statusObserver
        self.resultObserver = resultObserver
        self.authWindowObserver = authWindowObserver
        self.runCompletionObserver = runCompletionObserver
    }

    deinit {
        connectionTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        for task in commandTasks.values { task.cancel() }
    }

    public func connect(_ configuration: BrowserBridgeConnectionConfiguration) async {
        disconnect()
        guard configuration.isSecureOrLocalDevelopment else {
            publish(.failed(message: "The browser bridge requires WSS outside local development."))
            return
        }
        guard let bearerToken = await configuration.currentBearerToken(), !bearerToken.isEmpty else {
            publish(.failed(message: "Browser bridge authorization is missing."))
            return
        }
        self.configuration = configuration
        do {
            ledger = try await replayStore.load()
        } catch {
            publish(.failed(message: "Pending browser results could not be restored."))
            return
        }
        connectionTask = Task { [weak self] in await self?.runConnectionLoop() }
    }

    public func disconnect() {
        connectionTask?.cancel()
        connectionTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        for task in commandTasks.values { task.cancel() }
        commandTasks = [:]
        configuration = nil
        publish(.disconnected)
    }

    public func currentStatus() -> BrowserBridgeConnectionStatus { status }

    private func runConnectionLoop() async {
        var attempt = 0
        while !Task.isCancelled, let configuration {
            publish(attempt == 0 ? .connecting : .waitingToReconnect(attempt: attempt))
            do {
                try await runOneConnection(configuration)
                attempt = 0
            } catch is CancellationError {
                break
            } catch {
                cancelInFlightForDisconnect()
                attempt += 1
                socket?.cancel(with: .abnormalClosure, reason: nil)
                socket = nil
                publish(.waitingToReconnect(attempt: attempt))
                do {
                    try await Task.sleep(for: Self.reconnectDelay(attempt: attempt))
                } catch {
                    break
                }
            }
        }
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        if configuration == nil || Task.isCancelled { publish(.disconnected) }
    }

    private func runOneConnection(_ configuration: BrowserBridgeConnectionConfiguration) async throws {
        guard let bearerToken = await configuration.currentBearerToken(), !bearerToken.isEmpty else {
            throw URLError(.userAuthenticationRequired)
        }
        var request = URLRequest(url: configuration.url)
        request.timeoutInterval = 30
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.setValue(
            "cubby-apple/\(BrowserBridgeProtocol.currentProtocolVersion)",
            forHTTPHeaderField: "User-Agent")
        let socket = session.webSocketTask(with: request)
        self.socket = socket
        socket.resume()
        try await send(
            .hello(
                deviceID: configuration.deviceID, browser: configuration.browser,
                capabilities: configuration.capabilities),
            on: socket)
        for result in ledger.resultsForReplay { try await send(.result(result), on: socket) }
        for completion in ledger.runCompletionsForAcknowledgement {
            try await send(.runCompletedAcknowledged(runID: completion.runID), on: socket)
        }
        publish(.connected)

        while !Task.isCancelled, self.socket === socket {
            let message = try await socket.receive()
            let data: Data
            switch message {
            case .data(let payload): data = payload
            case .string(let text): data = Data(text.utf8)
            @unknown default: continue
            }
            let serverMessage = try JSONDecoder.browserBridge.decode(
                BrowserBridgeServerMessage.self, from: data)
            try await handle(serverMessage, socket: socket)
        }
    }

    private func handle(
        _ message: BrowserBridgeServerMessage, socket: URLSessionWebSocketTask
    ) async throws {
        switch message {
        case .command(let command):
            if let result = ledger.replayResult(for: command.id) {
                guard result.protocolVersion == command.protocolVersion,
                    result.runID == command.runID, result.operationID == command.operationID
                else {
                    // A command identifier may never be rebound to another run or operation. Do
                    // not replay a cached result into that mismatched server state.
                    ledger.discardReplayResult(for: command.id)
                    try await replayStore.save(ledger)
                    let rejection = BrowserBridgeCommandResult(
                        commandID: command.id, runID: command.runID, operationID: command.operationID,
                        completedAt: .now,
                        outcome: .failed(
                            code: .invalidCommand,
                            message: "The browser command identifier was rebound to different work.",
                            retryable: false))
                    try await finish(rejection)
                    return
                }
                try await send(.result(result), on: socket)
                return
            }
            guard commandTasks[command.id] == nil, !ledger.cancelled.contains(command.id) else { return }
            if command.deadline <= .now {
                let result = BrowserBridgeCommandResult(
                    commandID: command.id, runID: command.runID, operationID: command.operationID,
                    completedAt: .now,
                    outcome: .failed(
                        code: .deadlineExceeded, message: "The browser command deadline elapsed.",
                        retryable: false))
                try await finish(result)
                return
            }
            let task = Task { [weak self] in
                guard let self else { return }
                let outcome = await executor.execute(command)
                guard !Task.isCancelled else { return }
                let result = BrowserBridgeCommandResult(
                    commandID: command.id, runID: command.runID, operationID: command.operationID,
                    completedAt: .now, outcome: outcome)
                await self.finishIgnoringSendFailure(result)
            }
            commandTasks[command.id] = task
        case .acknowledge(let commandID):
            ledger.acknowledge(commandID)
            try await replayStore.save(ledger)
        case .cancel(let commandID):
            commandTasks.removeValue(forKey: commandID)?.cancel()
            await executor.cancel(commandID: commandID)
            ledger.cancel(commandID)
            try await replayStore.save(ledger)
        case .ping(let timestamp):
            try await send(.pong(timestamp: timestamp), on: socket)
        case .raiseAuthWindow(let runID):
            await executor.raiseAuthenticationWindow()
            authWindowObserver?(runID)
        case .runCompleted(let completion):
            let isNew = ledger.recordRunCompletion(completion)
            try await replayStore.save(ledger)
            try await send(.runCompletedAcknowledged(runID: completion.runID), on: socket)
            if isNew { runCompletionObserver?(completion) }
        }
    }

    private func finishIgnoringSendFailure(_ result: BrowserBridgeCommandResult) async {
        do {
            try await finish(result)
        } catch {
            // The durable result is intentionally kept. A reconnect replays it before accepting
            // new work, so a lost acknowledgement can never repeat business writes.
        }
    }

    private func finish(_ result: BrowserBridgeCommandResult) async throws {
        commandTasks.removeValue(forKey: result.commandID)
        guard !ledger.cancelled.contains(result.commandID) else { return }
        ledger.record(result)
        try await replayStore.save(ledger)
        resultObserver?(result)
        guard let socket else { return }
        try await send(.result(result), on: socket)
    }

    private func cancelInFlightForDisconnect() {
        for task in commandTasks.values { task.cancel() }
        commandTasks = [:]
    }

    private func send(
        _ message: BrowserBridgeClientMessage, on socket: URLSessionWebSocketTask
    ) async throws {
        let data = try JSONEncoder.browserBridge.encode(message)
        try await socket.send(.data(data))
    }

    private func publish(_ value: BrowserBridgeConnectionStatus) {
        guard status != value else { return }
        status = value
        statusObserver?(value)
    }

    private static func reconnectDelay(attempt: Int) -> Duration {
        .seconds(min(30, 1 << min(max(0, attempt - 1), 5)))
    }
}
