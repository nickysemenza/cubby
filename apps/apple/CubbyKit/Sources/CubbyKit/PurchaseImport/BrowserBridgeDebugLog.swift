import Foundation
import OSLog

/// DEBUG-only metadata for tracing the purchase-import browser bridge end to end. Callers pass
/// typed protocol values so credentials, page text, full URLs, and evidence bytes cannot enter
/// the stream accidentally. Read it with:
/// `log stream --level debug --predicate 'subsystem == "com.nickysemenza.cubby" AND category == "PurchaseImport"'`
public enum BrowserBridgeDebugLog {
    public enum Event: String, Sendable {
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
        error: (any Error)? = nil
    ) {
        #if DEBUG
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
            logger.debug("\(fields.joined(separator: " "), privacy: .public)")
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
        case .followCapturedLink, .scroll, .capture: nil
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
