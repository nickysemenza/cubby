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
        AuthenticatedSocketSupport.isSecureOrLocalDevelopment(url)
    }
}

public enum BrowserBridgeConnectionStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case waitingToReconnect(attempt: Int)
    case failed(message: String)
}

struct BrowserBridgeCommandTaskRegistry {
    private var claimed: Set<String> = []
    private var settled: Set<String> = []
    private var tasks: [String: Task<Void, Never>] = [:]

    mutating func claim(_ commandID: String) -> Bool {
        guard !settled.contains(commandID) else { return false }
        return claimed.insert(commandID).inserted
    }

    mutating func attach(_ task: Task<Void, Never>, to commandID: String) {
        guard claimed.contains(commandID) else { return task.cancel() }
        tasks[commandID] = task
    }

    mutating func finish(_ commandID: String) {
        claimed.remove(commandID)
        tasks.removeValue(forKey: commandID)
        settled.insert(commandID)
    }

    mutating func cancel(_ commandID: String) {
        claimed.remove(commandID)
        tasks.removeValue(forKey: commandID)?.cancel()
    }

    mutating func transientDisconnect() {}

    mutating func cancelAll() {
        for task in tasks.values { task.cancel() }
        claimed = []
        tasks = [:]
    }
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
    private var commandTasks = BrowserBridgeCommandTaskRegistry()
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
        commandTasks.cancelAll()
    }

    public func connect(_ configuration: BrowserBridgeConnectionConfiguration) async {
        disconnect()
        BrowserBridgeDebugLog.emit(
            .connectRequested, browser: configuration.browser,
            messageType: configuration.url.host()?.lowercased())
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
            BrowserBridgeDebugLog.emit(.replayLoaded, count: ledger.resultsForReplay.count)
        } catch {
            publish(.failed(message: "Pending browser results could not be restored."))
            return
        }
        connectionTask = Task { [weak self] in await self?.runConnectionLoop() }
    }

    public func disconnect() {
        BrowserBridgeDebugLog.emit(.disconnectRequested)
        connectionTask?.cancel()
        connectionTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        commandTasks.cancelAll()
        configuration = nil
        publish(.disconnected)
    }

    public func currentStatus() -> BrowserBridgeConnectionStatus { status }

    private func runConnectionLoop() async {
        var attempt = 0
        while !Task.isCancelled, let configuration {
            BrowserBridgeDebugLog.emit(
                .connectionAttempt, browser: configuration.browser, attempt: attempt)
            publish(attempt == 0 ? .connecting : .waitingToReconnect(attempt: attempt))
            do {
                try await runOneConnection(configuration)
                attempt = 0
            } catch is CancellationError {
                break
            } catch {
                commandTasks.transientDisconnect()
                attempt += 1
                BrowserBridgeDebugLog.emit(.connectionRetry, attempt: attempt, error: error)
                socket?.cancel(with: .abnormalClosure, reason: nil)
                socket = nil
                publish(.waitingToReconnect(attempt: attempt))
                do {
                    try await Task.sleep(
                        for: AuthenticatedSocketSupport.reconnectDelay(attempt: attempt))
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
        let request = try AuthenticatedSocketSupport.request(
            url: configuration.url,
            bearerToken: bearerToken,
            userAgent:
                "cubby-apple/\(BrowserBridgeProtocol.currentProtocolVersion) (\(configuration.deviceID.uuidString.lowercased()))"
        )
        let socket = session.webSocketTask(with: request)
        self.socket = socket
        socket.resume()
        try await send(
            .hello(
                deviceID: configuration.deviceID, browser: configuration.browser,
                capabilities: configuration.capabilities),
            on: socket)
        for result in ledger.resultsForReplay {
            BrowserBridgeDebugLog.emit(
                .commandReplayed, commandID: result.commandUUID, runID: result.runID,
                operationID: result.operationID, outcome: result.outcome)
            try await send(.result(result), on: socket)
        }
        for completion in ledger.runCompletionsForAcknowledgement {
            try await send(.runCompletedAcknowledged(runID: completion.runID), on: socket)
        }
        publish(.connected)
        BrowserBridgeDebugLog.emit(.connectionReady, browser: configuration.browser)

        while !Task.isCancelled, self.socket === socket {
            guard
                let data = AuthenticatedSocketSupport.data(from: try await socket.receive())
            else { continue }
            let serverMessage = try JSONDecoder.browserBridge.decode(
                BrowserBridgeServerMessage.self, from: data)
            BrowserBridgeDebugLog.emit(
                .messageReceived, messageType: Self.messageType(serverMessage))
            try await handle(serverMessage, socket: socket)
        }
    }

    private func handle(
        _ message: BrowserBridgeServerMessage, socket: URLSessionWebSocketTask
    ) async throws {
        switch message {
        case .command(let envelope):
            let command = envelope.command
            if let result = ledger.replayResult(for: command.id) {
                guard result.protocolVersion.rawValue == command.protocolVersion.rawValue,
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
                BrowserBridgeDebugLog.emit(.commandReplayed, command: command, outcome: result.outcome)
                try await send(.result(result), on: socket)
                return
            }
            guard !ledger.cancelled.contains(command.id) else { return }
            guard commandTasks.claim(command.id) else {
                BrowserBridgeDebugLog.emit(.commandDuplicate, command: command)
                return
            }
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
                BrowserBridgeDebugLog.emit(.commandStarted, command: command)
                let outcome = await executor.execute(command)
                BrowserBridgeDebugLog.emit(.commandFinished, command: command, outcome: outcome)
                guard !Task.isCancelled else { return }
                let result = BrowserBridgeCommandResult(
                    commandID: command.id, runID: command.runID, operationID: command.operationID,
                    completedAt: .now, outcome: outcome)
                await self.finishIgnoringSendFailure(result)
            }
            commandTasks.attach(task, to: command.id)
        case .acknowledge(let payload):
            let commandID = payload.commandID
            let completed = ledger.replayResult(for: commandID)
            BrowserBridgeDebugLog.emit(
                .acknowledgementReceived, commandID: UUID(uuidString: commandID), runID: completed?.runID,
                operationID: completed?.operationID)
            ledger.acknowledge(commandID)
            try await replayStore.save(ledger)
        case .cancel(let payload):
            let commandID = payload.commandID
            BrowserBridgeDebugLog.emit(
                .cancellationReceived, commandID: UUID(uuidString: commandID))
            commandTasks.cancel(commandID)
            if let commandUUID = UUID(uuidString: commandID) {
                await executor.cancel(commandID: commandUUID)
            }
            ledger.cancel(commandID)
            try await replayStore.save(ledger)
        case .ping(let payload):
            try await send(.pong(timestamp: payload.timestamp), on: socket)
        case .raiseAuthWindow(let payload):
            await executor.raiseAuthenticationWindow()
            authWindowObserver?(payload.runID)
        case .runCompleted(let payload):
            let terminalStatus: BrowserBridgeRunCompletion.TerminalStatusPayload =
                switch payload.terminalStatus {
                case .completed: .completed
                case .needsReview: .needsReview
                case .failed: .failed
                case .dispatchFailed: .dispatchFailed
                }
            let completion = BrowserBridgeRunCompletion(
                runID: payload.runID, terminalStatus: terminalStatus,
                outcome: payload.outcome, imported: payload.imported, updated: payload.updated,
                skipped: payload.skipped, findingCount: payload.findingCount)
            BrowserBridgeDebugLog.emit(.runCompleted, runID: completion.runID)
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
            BrowserBridgeDebugLog.emit(
                .resultSendDeferred, commandID: result.commandUUID, runID: result.runID,
                operationID: result.operationID, outcome: result.outcome, error: error)
            // The durable result is intentionally kept. A reconnect replays it before accepting
            // new work, so a lost acknowledgement can never repeat business writes.
        }
    }

    private func finish(_ result: BrowserBridgeCommandResult) async throws {
        commandTasks.finish(result.commandID)
        guard !ledger.cancelled.contains(result.commandID) else { return }
        ledger.record(result)
        try await replayStore.save(ledger)
        BrowserBridgeDebugLog.emit(
            .resultPersisted, commandID: result.commandUUID, runID: result.runID,
            operationID: result.operationID, outcome: result.outcome)
        resultObserver?(result)
        guard let socket else { return }
        try await send(.result(result), on: socket)
        BrowserBridgeDebugLog.emit(
            .resultSent, commandID: result.commandUUID, runID: result.runID,
            operationID: result.operationID, outcome: result.outcome)
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

    private static func messageType(_ message: BrowserBridgeServerMessage) -> String {
        switch message {
        case .command: "command"
        case .acknowledge: "acknowledge"
        case .cancel: "cancel"
        case .ping: "ping"
        case .raiseAuthWindow: "raise_auth_window"
        case .runCompleted: "run_completed"
        }
    }
}
