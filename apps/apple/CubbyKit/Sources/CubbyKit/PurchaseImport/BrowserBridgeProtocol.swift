import Foundation

public enum BrowserBridgeProtocol {
    /// This value binds every websocket envelope and every durable command/result. A v1 peer is
    /// deliberately rejected during the Flue cutover so a cached command can never cross the old
    /// orchestration boundary.
    public static let currentProtocolVersion = 2
    public static let maximumReadableTextCharacters = 24 * 1_024
    public static let maximumCapturedLinks = 200
    public static let maximumCapturedImages = 200

    static func supports(protocolVersion: Int) -> Bool {
        protocolVersion == currentProtocolVersion
    }
}

public enum BrowserChoice: String, Codable, CaseIterable, Identifiable, Sendable {
    case safari
    case chrome

    public var id: Self { self }

    public var title: String {
        switch self {
        case .safari: "Safari"
        case .chrome: "Google Chrome"
        }
    }
}

public struct BrowserBridgeCommand: Codable, Hashable, Identifiable, Sendable {
    public let protocolVersion: Int
    public let id: UUID
    public let runID: String
    public let operationID: String
    public let deadline: Date
    public let operation: BrowserBridgeOperation

    public init(
        protocolVersion: Int = BrowserBridgeProtocol.currentProtocolVersion, id: UUID, runID: String,
        operationID: String, deadline: Date, operation: BrowserBridgeOperation
    ) {
        self.protocolVersion = protocolVersion
        self.id = id
        self.runID = runID
        self.operationID = operationID
        self.deadline = deadline
        self.operation = operation
    }

    private enum CodingKeys: String, CodingKey {
        case protocolVersion, id, runID, deadline, operation
        case operationID = "operationId"
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
        guard BrowserBridgeProtocol.supports(protocolVersion: protocolVersion) else {
            throw DecodingError.dataCorruptedError(
                forKey: .protocolVersion, in: values,
                debugDescription: "Unsupported browser bridge protocol version")
        }
        self.init(
            protocolVersion: protocolVersion,
            id: try values.decode(UUID.self, forKey: .id),
            runID: try values.decode(String.self, forKey: .runID),
            operationID: try values.decode(String.self, forKey: .operationID),
            deadline: try values.decode(Date.self, forKey: .deadline),
            operation: try values.decode(BrowserBridgeOperation.self, forKey: .operation))
    }
}

/// The closed set of browser operations the server can request. There is deliberately no raw
/// script, selector, click, form, or free-form browser action in this protocol.
public enum BrowserBridgeOperation: Codable, Hashable, Sendable {
    case navigate(url: URL, allowedHosts: Set<String>)
    case followCapturedLink(linkID: String, allowedHosts: Set<String>)
    case scroll(pageCount: Int)
    case capture(allowedHosts: Set<String>, enhancedEvidence: Bool, recoveryURL: URL? = nil)

    private enum CodingKeys: String, CodingKey {
        case type, url, allowedHosts, linkID, pageCount, enhancedEvidence, recoveryURL
    }

    private enum Kind: String, Codable {
        case navigate
        case followCapturedLink = "follow_captured_link"
        case scroll
        case capture
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .type) {
        case .navigate:
            self = try .navigate(
                url: values.decode(URL.self, forKey: .url),
                allowedHosts: values.decode(Set<String>.self, forKey: .allowedHosts))
        case .followCapturedLink:
            self = try .followCapturedLink(
                linkID: values.decode(String.self, forKey: .linkID),
                allowedHosts: values.decode(Set<String>.self, forKey: .allowedHosts))
        case .scroll:
            self = try .scroll(pageCount: values.decode(Int.self, forKey: .pageCount))
        case .capture:
            self = try .capture(
                allowedHosts: values.decode(Set<String>.self, forKey: .allowedHosts),
                enhancedEvidence: values.decode(Bool.self, forKey: .enhancedEvidence),
                recoveryURL: values.decodeIfPresent(URL.self, forKey: .recoveryURL))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .navigate(let url, let allowedHosts):
            try values.encode(Kind.navigate, forKey: .type)
            try values.encode(url, forKey: .url)
            try values.encode(allowedHosts, forKey: .allowedHosts)
        case .followCapturedLink(let linkID, let allowedHosts):
            try values.encode(Kind.followCapturedLink, forKey: .type)
            try values.encode(linkID, forKey: .linkID)
            try values.encode(allowedHosts, forKey: .allowedHosts)
        case .scroll(let pageCount):
            try values.encode(Kind.scroll, forKey: .type)
            try values.encode(pageCount, forKey: .pageCount)
        case .capture(let allowedHosts, let enhancedEvidence, let recoveryURL):
            try values.encode(Kind.capture, forKey: .type)
            try values.encode(allowedHosts, forKey: .allowedHosts)
            try values.encode(enhancedEvidence, forKey: .enhancedEvidence)
            try values.encodeIfPresent(recoveryURL, forKey: .recoveryURL)
        }
    }
}

public struct BrowserCapturedLink: Codable, Hashable, Sendable {
    public let id: String
    public let url: URL
    public let label: String?

    public init(id: String, url: URL, label: String?) {
        self.id = id
        self.url = url
        self.label = label
    }
}

public struct BrowserCapturedImage: Codable, Hashable, Sendable {
    public let url: URL
    public let alt: String?

    public init(url: URL, alt: String?) {
        self.url = url
        self.alt = alt
    }
}

public struct BrowserPaymentEvidence: Codable, Hashable, Sendable {
    public let methodLabel: String?
    public let lastFour: String?
    public let amountText: String?

    public init(methodLabel: String? = nil, lastFour: String? = nil, amountText: String? = nil) {
        self.methodLabel = methodLabel
        self.lastFour = lastFour
        self.amountText = amountText
    }
}

public enum BrowserEvidenceKind: String, Codable, Hashable, Sendable {
    case normalizedPDF = "normalized_pdf"
    case renderedPDF = "rendered_pdf"
    case screenshot
}

/// An opaque reference returned by the injected staged-upload adapter. Local file paths and bytes
/// never enter the socket protocol.
public struct BrowserEvidenceReference: Codable, Hashable, Sendable {
    public let id: String
    public let kind: BrowserEvidenceKind
    public let checksum: String
    public let contentType: String

    public init(id: String, kind: BrowserEvidenceKind, checksum: String, contentType: String) {
        self.id = id
        self.kind = kind
        self.checksum = checksum
        self.contentType = contentType
    }
}

public struct BrowserPageCapture: Codable, Hashable, Sendable {
    public let sourceURL: URL
    public let title: String
    public let capturedAt: Date
    public let captureVersion: Int
    public let readableText: String
    public let links: [BrowserCapturedLink]
    public let images: [BrowserCapturedImage]
    public let paymentEvidence: [BrowserPaymentEvidence]
    public let evidence: [BrowserEvidenceReference]

    public init(
        sourceURL: URL, title: String, capturedAt: Date, captureVersion: Int, readableText: String,
        links: [BrowserCapturedLink], images: [BrowserCapturedImage],
        paymentEvidence: [BrowserPaymentEvidence] = [], evidence: [BrowserEvidenceReference] = []
    ) {
        self.sourceURL = sourceURL
        self.title = String(title.prefix(500))
        self.capturedAt = capturedAt
        self.captureVersion = captureVersion
        self.readableText = String(readableText.prefix(BrowserBridgeProtocol.maximumReadableTextCharacters))
        self.links = Array(links.prefix(BrowserBridgeProtocol.maximumCapturedLinks))
        self.images = Array(images.prefix(BrowserBridgeProtocol.maximumCapturedImages))
        self.paymentEvidence = paymentEvidence
        self.evidence = evidence
    }
}

public enum BrowserBridgeFailureCode: String, Codable, Hashable, Sendable {
    case cancelled
    case deadlineExceeded = "deadline_exceeded"
    case invalidCommand = "invalid_command"
    case disallowedURL = "disallowed_url"
    case unknownLink = "unknown_link"
    case browserUnavailable = "browser_unavailable"
    case browserPermissionDenied = "browser_permission_denied"
    case authenticationRequired = "authentication_required"
    case captureUnavailable = "capture_unavailable"
    case uploadFailed = "upload_failed"
    case executionFailed = "execution_failed"
}

public enum BrowserBridgeCommandOutcome: Codable, Hashable, Sendable {
    case completed(capture: BrowserPageCapture?)
    case failed(code: BrowserBridgeFailureCode, message: String, retryable: Bool)

    private enum CodingKeys: String, CodingKey { case status, capture, code, message, retryable }
    private enum Status: String, Codable { case completed, failed }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Status.self, forKey: .status) {
        case .completed:
            self = try .completed(capture: values.decodeIfPresent(BrowserPageCapture.self, forKey: .capture))
        case .failed:
            self = try .failed(
                code: values.decode(BrowserBridgeFailureCode.self, forKey: .code),
                message: values.decode(String.self, forKey: .message),
                retryable: values.decode(Bool.self, forKey: .retryable))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .completed(let capture):
            try values.encode(Status.completed, forKey: .status)
            try values.encodeIfPresent(capture, forKey: .capture)
        case .failed(let code, let message, let retryable):
            try values.encode(Status.failed, forKey: .status)
            try values.encode(code, forKey: .code)
            try values.encode(message, forKey: .message)
            try values.encode(retryable, forKey: .retryable)
        }
    }
}

public struct BrowserBridgeCommandResult: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID { commandID }
    public let protocolVersion: Int
    public let commandID: UUID
    public let runID: String
    public let operationID: String
    public let completedAt: Date
    public let outcome: BrowserBridgeCommandOutcome

    public init(
        protocolVersion: Int = BrowserBridgeProtocol.currentProtocolVersion, commandID: UUID, runID: String,
        operationID: String, completedAt: Date, outcome: BrowserBridgeCommandOutcome
    ) {
        self.protocolVersion = protocolVersion
        self.commandID = commandID
        self.runID = runID
        self.operationID = operationID
        self.completedAt = completedAt
        self.outcome = outcome
    }

    private enum CodingKeys: String, CodingKey {
        case protocolVersion, commandID, runID, operationID, completedAt, outcome
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
        guard BrowserBridgeProtocol.supports(protocolVersion: protocolVersion) else {
            throw DecodingError.dataCorruptedError(
                forKey: .protocolVersion, in: values,
                debugDescription: "Unsupported browser bridge protocol version")
        }
        self.init(
            protocolVersion: protocolVersion,
            commandID: try values.decode(UUID.self, forKey: .commandID),
            runID: try values.decode(String.self, forKey: .runID),
            operationID: try values.decode(String.self, forKey: .operationID),
            completedAt: try values.decode(Date.self, forKey: .completedAt),
            outcome: try values.decode(BrowserBridgeCommandOutcome.self, forKey: .outcome))
    }
}

public struct BrowserBridgeCapabilities: Codable, Hashable, Sendable {
    public let fixedCaptureVersion: Int
    public let enhancedScreenshot: Bool
    public let renderedPDF: Bool

    public init(fixedCaptureVersion: Int = 1, enhancedScreenshot: Bool, renderedPDF: Bool) {
        self.fixedCaptureVersion = fixedCaptureVersion
        self.enhancedScreenshot = enhancedScreenshot
        self.renderedPDF = renderedPDF
    }
}

public enum BrowserBridgeClientMessage: Codable, Hashable, Sendable {
    case hello(deviceID: UUID, browser: BrowserChoice, capabilities: BrowserBridgeCapabilities)
    case result(BrowserBridgeCommandResult)
    case pong(timestamp: Date)
    case runCompletedAcknowledged(runID: String)

    private enum CodingKeys: String, CodingKey {
        case protocolVersion, type, deviceID, browser, capabilities, result, timestamp, runID
    }
    private enum Kind: String, Codable {
        case hello, result, pong
        case runCompletedAcknowledged = "run_completed_ack"
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
        guard BrowserBridgeProtocol.supports(protocolVersion: protocolVersion) else {
            throw DecodingError.dataCorruptedError(
                forKey: .protocolVersion, in: values,
                debugDescription: "Unsupported browser bridge protocol version")
        }
        switch try values.decode(Kind.self, forKey: .type) {
        case .hello:
            self = try .hello(
                deviceID: values.decode(UUID.self, forKey: .deviceID),
                browser: values.decode(BrowserChoice.self, forKey: .browser),
                capabilities: values.decode(BrowserBridgeCapabilities.self, forKey: .capabilities))
        case .result:
            self = try .result(values.decode(BrowserBridgeCommandResult.self, forKey: .result))
        case .pong:
            self = try .pong(timestamp: values.decode(Date.self, forKey: .timestamp))
        case .runCompletedAcknowledged:
            self = try .runCompletedAcknowledged(runID: values.decode(String.self, forKey: .runID))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(BrowserBridgeProtocol.currentProtocolVersion, forKey: .protocolVersion)
        switch self {
        case .hello(let deviceID, let browser, let capabilities):
            try values.encode(Kind.hello, forKey: .type)
            try values.encode(deviceID, forKey: .deviceID)
            try values.encode(browser, forKey: .browser)
            try values.encode(capabilities, forKey: .capabilities)
        case .result(let result):
            try values.encode(Kind.result, forKey: .type)
            try values.encode(result, forKey: .result)
        case .pong(let timestamp):
            try values.encode(Kind.pong, forKey: .type)
            try values.encode(timestamp, forKey: .timestamp)
        case .runCompletedAcknowledged(let runID):
            try values.encode(Kind.runCompletedAcknowledged, forKey: .type)
            try values.encode(runID, forKey: .runID)
        }
    }
}

public struct BrowserBridgeRunCompletion: Codable, Hashable, Sendable, Identifiable {
    public var id: String { runID }
    public let runID: String
    public let imported: Int
    public let updated: Int
    public let skipped: Int
    public let findingCount: Int

    public init(runID: String, imported: Int, updated: Int, skipped: Int, findingCount: Int) {
        self.runID = runID
        self.imported = imported
        self.updated = updated
        self.skipped = skipped
        self.findingCount = findingCount
    }
}

public enum BrowserBridgeServerMessage: Codable, Hashable, Sendable {
    case command(BrowserBridgeCommand)
    case acknowledge(commandID: UUID)
    case cancel(commandID: UUID)
    case ping(timestamp: Date)
    case raiseAuthWindow(runID: String)
    case runCompleted(BrowserBridgeRunCompletion)

    private enum CodingKeys: String, CodingKey {
        case protocolVersion, type, command, commandID, timestamp, runID, imported, updated, skipped,
            findingCount
    }
    private enum Kind: String, Codable {
        case command, acknowledge, cancel, ping
        case raiseAuthWindow = "raise_auth_window"
        case runCompleted = "run_completed"
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
        guard BrowserBridgeProtocol.supports(protocolVersion: protocolVersion) else {
            throw DecodingError.dataCorruptedError(
                forKey: .protocolVersion, in: values,
                debugDescription: "Unsupported browser bridge protocol version")
        }
        switch try values.decode(Kind.self, forKey: .type) {
        case .command: self = try .command(values.decode(BrowserBridgeCommand.self, forKey: .command))
        case .acknowledge:
            self = try .acknowledge(commandID: values.decode(UUID.self, forKey: .commandID))
        case .cancel: self = try .cancel(commandID: values.decode(UUID.self, forKey: .commandID))
        case .ping: self = try .ping(timestamp: values.decode(Date.self, forKey: .timestamp))
        case .raiseAuthWindow:
            self = try .raiseAuthWindow(runID: values.decode(String.self, forKey: .runID))
        case .runCompleted:
            self = try .runCompleted(
                BrowserBridgeRunCompletion(
                    runID: values.decode(String.self, forKey: .runID),
                    imported: values.decode(Int.self, forKey: .imported),
                    updated: values.decode(Int.self, forKey: .updated),
                    skipped: values.decode(Int.self, forKey: .skipped),
                    findingCount: values.decode(Int.self, forKey: .findingCount)))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(BrowserBridgeProtocol.currentProtocolVersion, forKey: .protocolVersion)
        switch self {
        case .command(let command):
            try values.encode(Kind.command, forKey: .type)
            try values.encode(command, forKey: .command)
        case .acknowledge(let commandID):
            try values.encode(Kind.acknowledge, forKey: .type)
            try values.encode(commandID, forKey: .commandID)
        case .cancel(let commandID):
            try values.encode(Kind.cancel, forKey: .type)
            try values.encode(commandID, forKey: .commandID)
        case .ping(let timestamp):
            try values.encode(Kind.ping, forKey: .type)
            try values.encode(timestamp, forKey: .timestamp)
        case .raiseAuthWindow(let runID):
            try values.encode(Kind.raiseAuthWindow, forKey: .type)
            try values.encode(runID, forKey: .runID)
        case .runCompleted(let completion):
            try values.encode(Kind.runCompleted, forKey: .type)
            try values.encode(completion.runID, forKey: .runID)
            try values.encode(completion.imported, forKey: .imported)
            try values.encode(completion.updated, forKey: .updated)
            try values.encode(completion.skipped, forKey: .skipped)
            try values.encode(completion.findingCount, forKey: .findingCount)
        }
    }
}

@MainActor
public protocol BrowserCommandExecuting: AnyObject, Sendable {
    func execute(_ command: BrowserBridgeCommand) async -> BrowserBridgeCommandOutcome
    func cancel(commandID: UUID)
    func raiseAuthenticationWindow()
}
