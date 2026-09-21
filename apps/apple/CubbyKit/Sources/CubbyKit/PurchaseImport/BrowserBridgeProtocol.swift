import Foundation

public enum BrowserBridgeProtocol {
    /// This value binds every websocket envelope and durable command/result. A v1 peer is
    /// deliberately rejected during the Flue cutover so cached work cannot cross runtimes.
    public static let currentProtocolVersion = 2
    public static let maximumReadableTextCharacters = 24 * 1_024
    public static let maximumCapturedLinks = 200
    public static let maximumCapturedImages = 200
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
        protocolVersion: ProtocolVersionPayload = ._2, id: UUID, runID: String,
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

    public static func followCapturedLink(linkID: String, allowedHosts: Set<String>) -> Self {
        .followCapturedLink(
            BrowserBridgeOperationFollowCapturedLink(
                _type: .followCapturedLink, linkID: linkID, allowedHosts: allowedHosts.sorted()))
    }

    public static func scroll(pageCount: Int) -> Self {
        .scroll(BrowserBridgeOperationScroll(_type: .scroll, pageCount: pageCount))
    }

    public static func capture(
        allowedHosts: Set<String>, enhancedEvidence: Bool, recoveryURL: URL? = nil
    ) -> Self {
        .capture(
            BrowserBridgeOperationCapture(
                _type: .capture, allowedHosts: allowedHosts.sorted(),
                enhancedEvidence: enhancedEvidence, recoveryURL: recoveryURL?.absoluteString))
    }
}

extension BrowserCapturedLink {
    public init(id: String, url: URL, label: String?) {
        self.init(id: id, url: url.absoluteString, label: label)
    }
}

extension BrowserCapturedImage {
    public init(
        url: URL, alt: String?, naturalWidth: Int? = nil, naturalHeight: Int? = nil,
        highResolutionURL: URL? = nil
    ) {
        self.init(url: url.absoluteString, alt: alt)
        self.naturalWidth = naturalWidth
        self.naturalHeight = naturalHeight
        highResolutionUrl = highResolutionURL?.absoluteString
    }
}

extension BrowserPageCapture {
    public init(
        sourceURL: URL, title: String, capturedAt: Date, captureVersion: Int, readableText: String,
        links: [BrowserCapturedLink], images: [BrowserCapturedImage],
        paymentEvidence: [BrowserPaymentEvidence] = [], evidence: [BrowserEvidenceReference] = [],
        canonicalURL: URL? = nil, requestedAmazonASIN: String? = nil,
        servedAmazonASIN: String? = nil, variantMarkers: [String] = []
    ) {
        self.init(
            sourceURL: sourceURL.absoluteString,
            canonicalUrl: canonicalURL?.absoluteString,
            requestedAmazonAsin: requestedAmazonASIN,
            servedAmazonAsin: servedAmazonASIN,
            variantMarkers: Array(variantMarkers.prefix(50)),
            title: String(title.prefix(500)),
            capturedAt: capturedAt, captureVersion: captureVersion,
            readableText: String(readableText.prefix(BrowserBridgeProtocol.maximumReadableTextCharacters)),
            links: Array(links.prefix(BrowserBridgeProtocol.maximumCapturedLinks)),
            images: Array(images.prefix(BrowserBridgeProtocol.maximumCapturedImages)),
            paymentEvidence: paymentEvidence, evidence: evidence)
    }
}

extension BrowserBridgeCommandOutcome {
    public static func completed(capture: BrowserPageCapture?) -> Self {
        .completed(BrowserBridgeCommandOutcomeCompleted(status: .completed, capture: capture))
    }

    public static func failed(
        code: BrowserBridgeFailureCode, message: String, retryable: Bool
    ) -> Self {
        .failed(
            BrowserBridgeCommandOutcomeFailed(
                status: .failed, code: code, message: message, retryable: retryable))
    }
}

extension BrowserBridgeResult: Identifiable {
    public var id: String { commandID }
    public var commandUUID: UUID? { UUID(uuidString: commandID) }

    public init(
        protocolVersion: ProtocolVersionPayload = ._2, commandID: UUID, runID: String,
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
            protocolVersion: ._2, commandID: commandID, operationID: operationID,
            runID: runID, completedAt: completedAt, outcome: outcome)
    }
}

extension BrowserBridgeCapabilities {
    public init(enhancedScreenshot: Bool, renderedPDF: Bool) {
        self.init(
            fixedCaptureVersion: 1, enhancedScreenshot: enhancedScreenshot,
            renderedPDF: renderedPDF)
    }
}

extension BrowserBridgeClientMessage {
    public static func hello(
        deviceID: UUID, browser: BrowserChoice, capabilities: BrowserBridgeCapabilities
    ) -> Self {
        .hello(
            BrowserBridgeClientMessageHello(
                protocolVersion: ._2, _type: .hello,
                deviceID: deviceID.uuidString.lowercased(),
                browser: browser == .chrome ? .chrome : .safari,
                capabilities: .init(
                    fixedCaptureVersion: capabilities.fixedCaptureVersion,
                    enhancedScreenshot: capabilities.enhancedScreenshot,
                    renderedPDF: capabilities.renderedPDF)))
    }

    public static func pong(timestamp: Date) -> Self {
        .pong(BrowserBridgeClientMessagePong(protocolVersion: ._2, _type: .pong, timestamp: timestamp))
    }

    public static func result(_ result: BrowserBridgeCommandResult) -> Self {
        .result(
            BrowserBridgeClientMessageResult(
                protocolVersion: ._2, _type: .result, result: result))
    }

    public static func runCompletedAcknowledged(runID: String) -> Self {
        .runCompletedAck(
            BrowserBridgeClientMessageRunCompletedAck(
                protocolVersion: ._2, _type: .runCompletedAck, runID: runID))
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
                protocolVersion: ._2, _type: .command, command: command))
    }

    public static func raiseAuthWindow(runID: String) -> Self {
        .raiseAuthWindow(
            BrowserBridgeServerMessageRaiseAuthWindow(
                protocolVersion: ._2, _type: .raiseAuthWindow, runID: runID))
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
                protocolVersion: ._2, _type: .runCompleted, runID: completion.runID,
                terminalStatus: terminalStatus, outcome: completion.outcome,
                imported: completion.imported, updated: completion.updated,
                skipped: completion.skipped, findingCount: completion.findingCount))
    }
}

@MainActor
public protocol BrowserCommandExecuting: AnyObject, Sendable {
    func execute(_ command: BrowserBridgeCommand) async -> BrowserBridgeCommandOutcome
    func cancel(commandID: UUID)
    func raiseAuthenticationWindow()
}
