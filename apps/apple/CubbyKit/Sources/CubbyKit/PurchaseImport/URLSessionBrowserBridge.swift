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
    struct PendingCommand {
        let commandID: String
        let task: Task<Void, Never>
    }
    private var claimed: Set<String> = []
    private var settled: Set<String> = []
    private var tasks: [String: Task<Void, Never>] = [:]
    private var runs: [String: String] = [:]
    private var retiredRuns: Set<String> = []

    mutating func claim(_ commandID: String, runID: String) -> Bool {
        guard !settled.contains(commandID), !retiredRuns.contains(runID) else { return false }
        guard claimed.insert(commandID).inserted else { return false }
        runs[commandID] = runID
        return true
    }

    mutating func cancelRun(_ runID: String) -> [PendingCommand] {
        retiredRuns.insert(runID)
        let ids = runs.filter { $0.value == runID }.keys.sorted()
        var pending: [PendingCommand] = []
        for commandID in ids {
            claimed.remove(commandID)
            runs.removeValue(forKey: commandID)
            if let task = tasks.removeValue(forKey: commandID) {
                task.cancel()
                pending.append(PendingCommand(commandID: commandID, task: task))
            }
        }
        return pending
    }

    mutating func attach(_ task: Task<Void, Never>, to commandID: String) {
        guard claimed.contains(commandID) else { return task.cancel() }
        tasks[commandID] = task
    }

    mutating func finish(_ commandID: String) {
        claimed.remove(commandID)
        runs.removeValue(forKey: commandID)
        tasks.removeValue(forKey: commandID)
        settled.insert(commandID)
    }

    mutating func cancel(_ commandID: String) {
        claimed.remove(commandID)
        runs.removeValue(forKey: commandID)
        tasks.removeValue(forKey: commandID)?.cancel()
    }

    mutating func transientDisconnect() {}

    mutating func cancelAll() {
        for task in tasks.values { task.cancel() }
        claimed = []
        tasks = [:]
        runs = [:]
    }
}

public actor URLSessionBrowserBridge {
    public typealias StatusObserver = @Sendable (BrowserBridgeConnectionStatus) -> Void
    public typealias ResultObserver = @Sendable (BrowserBridgeCommandResult, BrowserBridgeOperation) -> Void
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
            try await ledger.prepareForReplay(store: replayStore, executor: executor)
            BrowserBridgeDebugLog.emit(.replayLoaded, count: ledger.resultsForReplay.count)
        } catch {
            publish(.failed(message: String(describing: error)))
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
                "cubby-apple-browser-bridge/\(BrowserBridgeProtocol.currentProtocolVersion) (\(configuration.deviceID.uuidString.lowercased()))"
        )
        let socket = session.webSocketTask(with: request)
        self.socket = socket
        socket.resume()
        try await send(
            .hello(
                deviceID: configuration.deviceID, browser: configuration.browser,
                capabilities: configuration.capabilities),
            on: socket)
        // A previous file error cannot become an acknowledgement on reconnect.
        // Persist the current fences before replaying any cleanup acknowledgement.
        try await ledger.prepareForReplay(store: replayStore, executor: executor)
        for runID in ledger.retiredRuns.keys.sorted() {
            for receiptID in (ledger.retiredRuns[runID] ?? []).sorted() {
                try await send(
                    .runForgotten(
                        runID: runID, retirementID: receiptID, deviceID: configuration.deviceID),
                    on: socket)
            }
        }
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
        case .forgetRun(let payload):
            ledger.forget(runID: payload.runID, retirementID: payload.retirementID)
            let pending = commandTasks.cancelRun(payload.runID)
            for command in pending {
                if let commandID = UUID(uuidString: command.commandID) {
                    await executor.cancel(commandID: commandID)
                }
            }
            // Join writes already in progress before persisting the erased ledger.
            // Cancellation alone does not prevent a suspended save from finishing later.
            for command in pending { await command.task.value }
            try await ledger.prepareForReplay(store: replayStore, executor: executor)
            if let configuration {
                try await send(
                    .runForgotten(
                        runID: payload.runID, retirementID: payload.retirementID,
                        deviceID: configuration.deviceID), on: socket)
            }
        case .command(let envelope):
            let command = envelope.command
            guard ledger.retiredRuns[command.runID] == nil else { return }
            if let result = ledger.replayResult(for: command.id) {
                guard result.protocolVersion.rawValue == command.protocolVersion.rawValue,
                    result.runID == command.runID, result.operationID == command.operationID
                else {
                    // A command identifier may never be rebound to another run or operation. Do
                    // not replay a cached result into that mismatched server state.
                    let rejection = BrowserBridgeCommandResult(
                        commandID: command.id, runID: command.runID, operationID: command.operationID,
                        completedAt: .now,
                        outcome: .failed(
                            code: .invalidCommand,
                            message: "The browser command identifier was rebound to different work.",
                            retryable: false, observation: .unobserved))
                    resultObserver?(rejection, command.operation)
                    try await send(.result(rejection), on: socket)
                    return
                }
                BrowserBridgeDebugLog.emit(.commandReplayed, command: command, outcome: result.outcome)
                try await send(.result(result), on: socket)
                return
            }
            guard !ledger.cancelled.contains(command.id) else { return }
            guard commandTasks.claim(command.id, runID: command.runID) else {
                BrowserBridgeDebugLog.emit(.commandDuplicate, command: command)
                return
            }
            if let interrupted = ledger.interruptedResult(for: command.id) {
                // A task lost during stop/relaunch must never repeat an interactive side effect.
                try await finish(interrupted, operation: command.operation)
                return
            }
            if command.deadline <= .now {
                let result = BrowserBridgeCommandResult(
                    commandID: command.id, runID: command.runID, operationID: command.operationID,
                    completedAt: .now,
                    outcome: .failed(
                        code: .deadlineExceeded, message: "The browser command deadline elapsed.",
                        retryable: false, observation: .unobserved))
                try await finish(result, operation: command.operation)
                return
            }
            switch command.operation {
            case .click, ._type, .select:
                ledger.beginInteractive(command)
                do { try await replayStore.save(ledger) } catch {
                    commandTasks.finish(command.id)
                    throw error
                }
            case .navigate, .read, .scroll, .window: break
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
                await self.finishIgnoringSendFailure(result, operation: command.operation)
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
            guard ledger.retiredRuns[payload.runID] == nil else { return }
            await executor.raiseAuthenticationWindow()
            authWindowObserver?(payload.runID)
        case .runCompleted(let payload):
            guard ledger.retiredRuns[payload.runID] == nil else { return }
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
                skipped: payload.skipped, findingCount: payload.findingCount,
                notice: payload.notice)
            BrowserBridgeDebugLog.emit(.runCompleted, runID: completion.runID)
            let isNew = ledger.recordRunCompletion(completion)
            try await replayStore.save(ledger)
            try await send(.runCompletedAcknowledged(runID: completion.runID), on: socket)
            if isNew { runCompletionObserver?(completion) }
        }
    }

    private func finishIgnoringSendFailure(
        _ result: BrowserBridgeCommandResult, operation: BrowserBridgeOperation
    ) async {
        do {
            try await finish(result, operation: operation)
        } catch {
            BrowserBridgeDebugLog.emit(
                .resultSendDeferred, commandID: result.commandUUID, runID: result.runID,
                operationID: result.operationID, outcome: result.outcome, error: error)
            // The durable result is intentionally kept. A reconnect replays it before accepting
            // new work, so a lost acknowledgement can never repeat business writes.
        }
    }

    private func finish(
        _ result: BrowserBridgeCommandResult, operation: BrowserBridgeOperation
    ) async throws {
        defer { commandTasks.finish(result.commandID) }
        guard ledger.retiredRuns[result.runID] == nil,
            !ledger.cancelled.contains(result.commandID)
        else { return }
        ledger.record(result)
        try await replayStore.save(ledger)
        guard ledger.retiredRuns[result.runID] == nil,
            !ledger.cancelled.contains(result.commandID)
        else { return }
        BrowserBridgeDebugLog.emit(
            .resultPersisted, commandID: result.commandUUID, runID: result.runID,
            operationID: result.operationID, outcome: result.outcome)
        resultObserver?(result, operation)
        guard let socket else { return }
        try await send(.result(result), on: socket)
        BrowserBridgeDebugLog.emit(
            .resultSent, commandID: result.commandUUID, runID: result.runID,
            operationID: result.operationID, outcome: result.outcome)
    }

    private func send(
        _ message: BrowserBridgeClientMessage, on socket: URLSessionWebSocketTask
    ) async throws {
        let data = try BrowserBridgeWire.encode(message)
        try await socket.send(.data(data))
    }

    private func publish(_ value: BrowserBridgeConnectionStatus) {
        guard status != value else { return }
        status = value
        statusObserver?(value)
    }

    private static func messageType(_ message: BrowserBridgeServerMessage) -> String {
        switch message {
        case .forgetRun: "forget_run"
        case .command: "command"
        case .acknowledge: "acknowledge"
        case .cancel: "cancel"
        case .ping: "ping"
        case .raiseAuthWindow: "raise_auth_window"
        case .runCompleted: "run_completed"
        }
    }
}
