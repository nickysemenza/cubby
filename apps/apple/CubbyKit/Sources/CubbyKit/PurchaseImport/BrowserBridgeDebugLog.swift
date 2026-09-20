import Foundation
import OSLog

/// DEBUG-only metadata for tracing the purchase-import browser bridge end to end. Callers pass
/// typed protocol values so credentials, page text, full URLs, and evidence bytes cannot enter
/// the stream accidentally. Read it with:
/// `log stream --level debug --predicate 'subsystem == "com.nickysemenza.cubby" AND category == "PurchaseImport"'`
public protocol BrowserBridgeDebugReporting: Sendable {
    func report(_ record: BrowserBridgeDebugRecord) async
}

public struct BrowserBridgeDebugRecord: Codable, Sendable, Equatable {
    public let id: UUID
    public let occurredAt: Date
    public let event: BrowserBridgeDebugLog.Event
    public let runID: String?
    public let commandID: UUID?
    public let operationID: String?
    public let operationKind: String?
    public let host: String?
    public let browser: String?
    public let accountID: String?
    public let attempt: Int?
    public let count: Int?
    public let outcome: String?
    public let messageType: String?
    public let errorType: String?
    public let errorCode: Int?

    private enum CodingKeys: String, CodingKey {
        case id, occurredAt, event, host, browser, attempt, count, outcome, messageType, errorType,
            errorCode
        case runID = "runId"
        case commandID = "commandId"
        case operationID = "operationId"
        case operationKind, accountID
    }
}

private actor BrowserBridgeDebugHub {
    static let shared = BrowserBridgeDebugHub()
    private var reporter: (any BrowserBridgeDebugReporting)?

    func install(_ reporter: (any BrowserBridgeDebugReporting)?) { self.reporter = reporter }
    func report(_ record: BrowserBridgeDebugRecord) async { await reporter?.report(record) }
}

public actor URLSessionBrowserBridgeDebugReporter: BrowserBridgeDebugReporting {
    private struct Batch: Encodable { let events: [BrowserBridgeDebugRecord] }
    private let baseURL: URL
    private let credentials: CredentialProvider
    private let session: URLSession
    private var pending: [BrowserBridgeDebugRecord] = []
    private var flushTask: Task<Void, Never>?
    private var retryAttempt = 0

    public init(
        baseURL: URL, credentials: CredentialProvider, session: URLSession = .cubbyShared
    ) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.session = session
    }

    public func report(_ record: BrowserBridgeDebugRecord) async {
        // Connection chatter without a run cannot be authorized or usefully displayed per run.
        guard record.runID != nil else { return }
        pending.append(record)
        if pending.count >= 50 {
            await flush()
        } else if flushTask == nil {
            flushTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(500))
                await self?.flush()
            }
        }
    }

    private func flush() async {
        flushTask?.cancel()
        flushTask = nil
        guard !pending.isEmpty else { return }
        let batch = Array(pending.prefix(100))
        pending.removeFirst(batch.count)
        do {
            guard case .bearer(let token) = await credentials.current(), !token.isEmpty else {
                throw URLError(.userAuthenticationRequired)
            }
            var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
            components?.path = "/api/import/agent/debug-events"
            components?.query = nil
            components?.fragment = nil
            guard let url = components?.url else { throw URLError(.badURL) }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            request.httpBody = try encoder.encode(Batch(events: batch))
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
            else { throw URLError(.badServerResponse) }
            retryAttempt = 0
        } catch {
            pending = Array((batch + pending).suffix(500))
            retryAttempt += 1
        }
        if !pending.isEmpty, flushTask == nil, retryAttempt <= 5 {
            let delay = min(30, 1 << min(retryAttempt, 5))
            flushTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                await self?.flush()
            }
        }
    }
}

public enum BrowserBridgeDebugLog {
    public enum Event: String, Codable, Sendable {
        case connectRequested = "connect.requested"
        case replayLoaded = "replay.loaded"
        case connectionAttempt = "connection.attempt"
        case connectionReady = "connection.ready"
        case connectionRetry = "connection.retry"
        case disconnectRequested = "disconnect.requested"
        case messageReceived = "message.received"
        case commandStarted = "command.started"
        case commandDuplicate = "command.duplicate_suppressed"
        case commandReplayed = "command.result_replayed"
        case commandFinished = "command.finished"
        case appleEventStarted = "apple_event.started"
        case appleEventFinished = "apple_event.finished"
        case appleEventRejected = "apple_event.rejected"
        case appleEventFailed = "apple_event.failed"
        case resultPersisted = "result.persisted"
        case resultSent = "result.sent"
        case resultSendDeferred = "result.send_deferred"
        case acknowledgementReceived = "ack.received"
        case cancellationReceived = "cancel.received"
        case runCompleted = "run.completed"
        case controllerRoster = "controller.roster"
        case controllerStatus = "controller.status"
        case syncRequested = "sync.requested"
    }

    #if DEBUG
        private static let logger = Logger(
            subsystem: Bundle.main.bundleIdentifier ?? "com.nickysemenza.cubby",
            category: "PurchaseImport")
    #endif

    public static func installRemoteReporter(_ reporter: (any BrowserBridgeDebugReporting)?) async {
        #if DEBUG
            await BrowserBridgeDebugHub.shared.install(reporter)
        #endif
    }

    public static func emit(
        _ event: Event,
        command: BrowserBridgeCommand? = nil,
        commandID: UUID? = nil,
        runID: String? = nil,
        operationID: String? = nil,
        browser: BrowserChoice? = nil,
        accountID: String? = nil,
        attempt: Int? = nil,
        count: Int? = nil,
        outcome: BrowserBridgeCommandOutcome? = nil,
        messageType: String? = nil,
        error: (any Error)? = nil,
        errorCode: Int? = nil
    ) {
        #if DEBUG
            let resolvedRunID = command?.runID ?? runID
            let resolvedCommandID = command?.id ?? commandID
            let resolvedOperationID = command?.operationID ?? operationID
            let resolvedOperationKind = command.map { operationKind($0.operation) }
            let host = command.flatMap { operationHost($0.operation) }
            let resolvedOutcome = outcome.map { outcomeLabel($0) }
            let errorType = error.map { String(reflecting: type(of: $0)) }
            var fields = ["event=\(event.rawValue)"]
            if let command {
                fields.append("command=\(command.id.uuidString)")
                fields.append("run=\(command.runID)")
                fields.append("operation=\(command.operationID)")
                fields.append("kind=\(operationKind(command.operation))")
                if let host = operationHost(command.operation) { fields.append("host=\(host)") }
            } else {
                if let commandID { fields.append("command=\(commandID.uuidString)") }
                if let runID { fields.append("run=\(runID)") }
                if let operationID { fields.append("operation=\(operationID)") }
            }
            if let browser { fields.append("browser=\(browser.rawValue)") }
            if let accountID { fields.append("account=\(accountID)") }
            if let attempt { fields.append("attempt=\(attempt)") }
            if let count { fields.append("count=\(count)") }
            if let messageType { fields.append("message=\(messageType)") }
            if let outcome { fields.append("outcome=\(outcomeLabel(outcome))") }
            if let error { fields.append("error=\(String(reflecting: type(of: error)))") }
            if let errorCode { fields.append("errorCode=\(errorCode)") }
            logger.debug("\(fields.joined(separator: " "), privacy: .public)")
            let record = BrowserBridgeDebugRecord(
                id: UUID(), occurredAt: .now, event: event, runID: resolvedRunID,
                commandID: resolvedCommandID, operationID: resolvedOperationID,
                operationKind: resolvedOperationKind, host: host, browser: browser?.rawValue,
                accountID: accountID, attempt: attempt, count: count, outcome: resolvedOutcome,
                messageType: messageType, errorType: errorType, errorCode: errorCode)
            Task { await BrowserBridgeDebugHub.shared.report(record) }
        #endif
    }

    private static func operationKind(_ operation: BrowserBridgeOperation) -> String {
        switch operation {
        case .navigate: "navigate"
        case .followCapturedLink: "follow_captured_link"
        case .scroll: "scroll"
        case .capture: "capture"
        }
    }

    private static func operationHost(_ operation: BrowserBridgeOperation) -> String? {
        switch operation {
        case .navigate(let url, _): url.host()?.lowercased()
        case .followCapturedLink, .scroll: nil
        case .capture(_, _, let recoveryURL): recoveryURL?.host()?.lowercased()
        }
    }

    private static func outcomeLabel(_ outcome: BrowserBridgeCommandOutcome) -> String {
        switch outcome {
        case .completed(let capture): capture == nil ? "completed" : "completed_with_capture"
        case .failed(let code, _, let retryable):
            "failed:\(code.rawValue):retryable=\(retryable)"
        }
    }
}
