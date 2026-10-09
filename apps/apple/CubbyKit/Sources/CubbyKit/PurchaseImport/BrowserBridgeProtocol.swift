import Foundation

public enum BrowserBridgeProtocol {
    /// This value binds every websocket envelope and durable command/result. An older peer is
    /// deliberately rejected so cached work cannot cross protocol versions.
    public static let currentProtocolVersion = 4
    /// The DOM trimming rules of `MacBrowserCommandExecutor.snapshotScript`; bump it when they change.
    public static let snapshotVersion = 2
}

// The wire payloads below are generated from @cubby/schemas through OpenAPI. This file adds only
// domain conveniences and the socket execution protocol; it does not duplicate Codable shapes.
public typealias BrowserBridgeCommand = BrowserBridgeRequest
public typealias BrowserBridgeCommandResult = BrowserBridgeResult

extension BrowserChoice: Identifiable {
    public var id: Self { self }

    public var title: String {
        switch self {
        case .safari: "Safari"
        case .chrome: "Google Chrome"
        }
    }
}

extension BrowserBridgeFailureCode {
    public static let disallowedURL = Self.disallowedUrl
}

extension BrowserBridgeRequest {
    public init(
        protocolVersion: ProtocolVersionPayload = ._4, id: UUID, runID: String,
        operationID: String, deadline: Date, operation: BrowserBridgeOperation
    ) {
        self.init(
            protocolVersion: protocolVersion, id: id.uuidString.lowercased(),
            operationId: operationID, runID: runID, deadline: deadline, operation: operation)
    }

    public var operationID: String { operationId }
    public var commandUUID: UUID? { UUID(uuidString: id) }
}

extension BrowserBridgeOperation {
    public static func navigate(url: URL, allowedHosts: Set<String>) -> Self {
        .navigate(
            BrowserBridgeOperationNavigate(
                _type: .navigate, url: url.absoluteString, allowedHosts: allowedHosts.sorted()))
    }

    public static func scroll(pageCount: Int, allowedHosts: Set<String>) -> Self {
        .scroll(
            BrowserBridgeOperationScroll(
                _type: .scroll, pageCount: pageCount, allowedHosts: allowedHosts.sorted()))
    }

    public static func read(
        allowedHosts: Set<String>, screenshot: BrowserScreenshotPolicy.Mode, recoveryURL: URL? = nil
    ) -> Self {
        .read(
            BrowserBridgeOperationRead(
                _type: .read, allowedHosts: allowedHosts.sorted(), screenshot: screenshot,
                recoveryURL: recoveryURL?.absoluteString))
    }

    public static func window(_ action: BrowserBridgeOperationWindow.ActionPayload) -> Self {
        .window(BrowserBridgeOperationWindow(_type: .window, action: action))
    }
}

extension BrowserBridgeCommandOutcome {
    public static func completed(
        snapshot: BrowserPageSnapshot?, observation: BrowserObservation
    ) -> Self {
        .completed(
            BrowserBridgeCommandOutcomeCompleted(
                status: .completed, snapshot: snapshot, observation: observation))
    }

    public static func failed(
        code: BrowserBridgeFailureCode, message: String, retryable: Bool,
        screenshotGap: BrowserScreenshotGap? = nil, observation: BrowserObservation
    ) -> Self {
        .failed(
            BrowserBridgeCommandOutcomeFailed(
                status: .failed, code: code, message: String(message.prefix(2_000)),
                retryable: retryable, screenshotGap: screenshotGap, observation: observation))
    }

    public var observation: BrowserObservation {
        switch self {
        case .completed(let payload): payload.observation
        case .failed(let payload): payload.observation
        }
    }
}

extension BrowserBridgeResult: Identifiable {
    public var id: String { commandID }
    public var commandUUID: UUID? { UUID(uuidString: commandID) }

    public init(
        protocolVersion: ProtocolVersionPayload = ._4, commandID: UUID, runID: String,
        operationID: String, completedAt: Date, outcome: BrowserBridgeCommandOutcome
    ) {
        self.init(
            protocolVersion: protocolVersion, commandID: commandID.uuidString.lowercased(),
            operationID: operationID, runID: runID, completedAt: completedAt, outcome: outcome)
    }

    public init(
        commandID: String, runID: String, operationID: String, completedAt: Date,
        outcome: BrowserBridgeCommandOutcome
    ) {
        self.init(
            protocolVersion: ._4, commandID: commandID, operationID: operationID,
            runID: runID, completedAt: completedAt, outcome: outcome)
    }
}

extension BrowserBridgeCapabilities {
    /// Every Mac build can screenshot its window; whether macOS allows it right now is reported
    /// per command in `BrowserObservation.screenRecording`.
    public static let current = Self(
        snapshotVersion: BrowserBridgeProtocol.snapshotVersion, screenshot: true,
        actions: [.navigate, .read, .click, ._type, .select, .scroll, .window])
}

extension BrowserBridgeClientMessage {
    public static func runForgotten(runID: String, retirementID: String, deviceID: UUID) -> Self {
        .forgetRunAck(
            .init(
                protocolVersion: ._4, _type: .forgetRunAck, runID: runID,
                retirementID: retirementID, deviceID: deviceID.uuidString.lowercased()))
    }

    public static func hello(
        deviceID: UUID, browser: BrowserChoice, capabilities: BrowserBridgeCapabilities
    ) -> Self {
        .hello(
            BrowserBridgeClientMessageHello(
                protocolVersion: ._4, _type: .hello,
                deviceID: deviceID.uuidString.lowercased(),
                browser: browser == .chrome ? .chrome : .safari,
                capabilities: capabilities))
    }

    public static func pong(timestamp: Date) -> Self {
        .pong(BrowserBridgeClientMessagePong(protocolVersion: ._4, _type: .pong, timestamp: timestamp))
    }

    public static func result(_ result: BrowserBridgeCommandResult) -> Self {
        .result(
            BrowserBridgeClientMessageResult(
                protocolVersion: ._4, _type: .result, result: result))
    }

    public static func runCompletedAcknowledged(runID: String) -> Self {
        .runCompletedAck(
            BrowserBridgeClientMessageRunCompletedAck(
                protocolVersion: ._4, _type: .runCompletedAck, runID: runID))
    }
}

/// The generated encoder omits a nil optional, but the contract's nullable result keys are
/// required: the server rejects a result whose `snapshot`, `screenshotGap` or observation fields
/// are absent rather than `null`. Restore those nulls at the socket boundary.
public enum BrowserBridgeWire {
    public static func encode(_ message: BrowserBridgeClientMessage) throws -> Data {
        let data = try JSONEncoder.browserBridge.encode(message)
        guard case .result = message,
            var object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            var result = object["result"] as? [String: Any],
            var outcome = result["outcome"] as? [String: Any]
        else { return data }
        let nullable = outcome["status"] as? String == "completed" ? "snapshot" : "screenshotGap"
        if outcome[nullable] == nil { outcome[nullable] = NSNull() }
        if var observation = outcome["observation"] as? [String: Any] {
            for key in ["url", "title", "readyState", "window"] where observation[key] == nil {
                observation[key] = NSNull()
            }
            if var window = observation["window"] as? [String: Any] {
                for key in ["minimized", "onScreen"] where window[key] == nil { window[key] = NSNull() }
                observation["window"] = window
            }
            outcome["observation"] = observation
        }
        result["outcome"] = outcome
        object["result"] = result
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}

extension BrowserBridgeRunCompletion: Identifiable {
    public var id: String { runID }

    /// A needs-review or failed targeted run must leave its account window available for the next
    /// explicit action. Only a completed terminal result may minimize Cubby's owned window.
    public var isSuccessful: Bool { terminalStatus == .completed }
}

extension BrowserBridgeServerMessage {
    public static func command(_ command: BrowserBridgeCommand) -> Self {
        .command(
            BrowserBridgeServerMessageCommand(
                protocolVersion: ._4, _type: .command, command: command))
    }

    public static func raiseAuthWindow(runID: String) -> Self {
        .raiseAuthWindow(
            BrowserBridgeServerMessageRaiseAuthWindow(
                protocolVersion: ._4, _type: .raiseAuthWindow, runID: runID))
    }

    public static func runCompleted(_ completion: BrowserBridgeRunCompletion) -> Self {
        let terminalStatus: BrowserBridgeServerMessageRunCompleted.TerminalStatusPayload =
            switch completion.terminalStatus {
            case .completed: .completed
            case .needsReview: .needsReview
            case .failed: .failed
            case .dispatchFailed: .dispatchFailed
            }
        return .runCompleted(
            BrowserBridgeServerMessageRunCompleted(
                protocolVersion: ._4, _type: .runCompleted, runID: completion.runID,
                terminalStatus: terminalStatus, outcome: completion.outcome,
                imported: completion.imported, updated: completion.updated,
                skipped: completion.skipped, findingCount: completion.findingCount))
    }
}

@MainActor
public protocol BrowserCommandExecuting: AnyObject, Sendable {
    func execute(_ command: BrowserBridgeCommand) async -> BrowserBridgeCommandOutcome
    func cancel(commandID: UUID)
    func forget(runID: String) async throws
    func raiseAuthenticationWindow()
}
