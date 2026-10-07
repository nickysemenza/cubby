import Foundation

/// The page's trimmed DOM as the bridge sends it: raw DEFLATE, base64, with the size and digest
/// of exactly the bytes that were compressed so the server can verify what it inflates.
enum BrowserDOMEncoding {
    /// `BROWSER_DOM_MAX_ENCODED` in the contract.
    static let maximumEncodedCharacters = 1_000_000

    static func encode(
        html: String, maximumEncodedCharacters: Int = maximumEncodedCharacters
    ) throws(ExecutionFailure) -> BrowserPageSnapshot.DomPayload {
        var bytes = Data(html.utf8)
        guard !bytes.isEmpty else { throw .pageUnreadable }
        var truncated = false
        while true {
            let encoded = try deflate(bytes).base64EncodedString()
            if encoded.count <= maximumEncodedCharacters {
                return BrowserPageSnapshot.DomPayload(
                    encoding: .deflateRawBase64, data: encoded, byteSize: bytes.count,
                    sha256: bytes.sha256Hex, truncated: truncated)
            }
            truncated = true
            // Scale by the observed ratio with a margin so the loop converges in a pass or two.
            let ratio = Double(maximumEncodedCharacters) / Double(encoded.count)
            let target = min(bytes.count - 1, Int(Double(bytes.count) * ratio * 0.97))
            bytes = utf8Prefix(bytes, length: target)
            guard !bytes.isEmpty else { throw .pageUnreadable }
        }
    }

    /// Never split a multi-byte scalar: the server decodes the inflated bytes as UTF-8.
    static func utf8Prefix(_ bytes: Data, length: Int) -> Data {
        guard length > 0 else { return Data() }
        guard length < bytes.count else { return bytes }
        var end = bytes.startIndex + length
        while end > bytes.startIndex, bytes[end] & 0xC0 == 0x80 { end -= 1 }
        return bytes[bytes.startIndex..<end]
    }

    /// Foundation's `.zlib` algorithm writes raw DEFLATE (RFC 1951), no zlib header.
    private static func deflate(_ bytes: Data) throws(ExecutionFailure) -> Data {
        do {
            return try (bytes as NSData).compressed(using: .zlib) as Data
        } catch {
            throw .executionFailed
        }
    }
}

public enum BrowserScreenshotAttempt: Sendable, Equatable {
    case captured([BrowserEvidenceReference])
    case gap(BrowserScreenshotGap)
}

public enum BrowserScreenshotResolution: Sendable, Equatable {
    case captured([BrowserEvidenceReference])
    case skipped
    case unavailable(BrowserScreenshotGap)

    public var payload: BrowserPageSnapshot.ScreenshotPayload {
        switch self {
        case .captured(let evidence): .captured(.init(status: .captured, evidence: evidence))
        case .skipped: .skipped(.init(status: .skipped))
        case .unavailable(let reason): .unavailable(.init(status: .unavailable, reason: reason))
        }
    }
}

public enum BrowserScreenshotPolicy {
    public typealias Mode = BrowserBridgeOperationCapture.ScreenshotPayload

    /// `required` fails without a screenshot; `preferred` still returns the DOM and says why;
    /// `skip` never looks at the window.
    static func resolve(
        mode: Mode, attempt: BrowserScreenshotAttempt?
    ) throws(ExecutionFailure) -> BrowserScreenshotResolution {
        guard mode != .skip, let attempt else { return .skipped }
        switch attempt {
        case .captured(let evidence):
            return .captured(evidence)
        case .gap(let gap):
            if mode == .required { throw .screenshotUnavailable(gap) }
            return .unavailable(gap)
        }
    }
}

extension BrowserObservation {
    /// For results the bridge writes without reaching the browser (deadline, rebound command).
    public static var unobserved: Self {
        BrowserObservation(window: nil, screenRecording: .unknown, durationMs: 0)
    }
}

enum ExecutionFailure: Error, LocalizedError, Sendable, Equatable {
    case invalidCommand
    case browserUnavailable
    case permissionDenied
    case javascriptDisabled
    case pageUnreadable
    case screenshotUnavailable(BrowserScreenshotGap)
    case uploadFailed
    case clientUpdateRequired
    case executionFailed
    case cancelled
    case deadlineExceeded

    /// An upload refused by the server's version gate is an outdated app, not a staging
    /// failure: retrying cannot help until the app updates.
    static func uploading(_ error: any Error) -> Self {
        (error as? CubbyAPIError)?.isClientUpdateRequired == true
            ? .clientUpdateRequired : .uploadFailed
    }

    /// Chrome and Safari word the disabled-JavaScript refusal differently; both name the menu item.
    static func appleScript(errorNumber: Int?, message: String?) -> Self {
        if errorNumber == -1743 { return .permissionDenied }
        if let message,
            message.contains("JavaScript through AppleScript is turned off")
                || message.contains("Allow JavaScript from Apple Events")
        {
            return .javascriptDisabled
        }
        if errorNumber == -1728 { return .browserUnavailable }
        return .executionFailed
    }

    var errorDescription: String? { message }

    var code: BrowserBridgeFailureCode {
        switch self {
        case .invalidCommand: .invalidCommand
        case .browserUnavailable: .browserUnavailable
        case .permissionDenied: .browserPermissionDenied
        case .javascriptDisabled: .javascriptDisabled
        case .pageUnreadable: .pageUnreadable
        case .screenshotUnavailable(let gap): gap == .uploadFailed ? .uploadFailed : .screenshotUnavailable
        case .uploadFailed: .uploadFailed
        case .clientUpdateRequired: .clientUpdateRequired
        case .executionFailed: .executionFailed
        case .cancelled: .cancelled
        case .deadlineExceeded: .deadlineExceeded
        }
    }

    var screenshotGap: BrowserScreenshotGap? {
        if case .screenshotUnavailable(let gap) = self { return gap }
        return nil
    }

    var retryable: Bool {
        switch self {
        case .browserUnavailable, .permissionDenied, .pageUnreadable, .screenshotUnavailable,
            .uploadFailed, .executionFailed:
            true
        case .invalidCommand, .javascriptDisabled, .clientUpdateRequired, .cancelled,
            .deadlineExceeded:
            false
        }
    }

    var message: String {
        switch self {
        case .invalidCommand: "The browser command was invalid."
        case .browserUnavailable: "The selected browser or Cubby-owned window is unavailable."
        case .permissionDenied: "macOS did not allow Cubby to control the selected browser."
        case .javascriptDisabled:
            "Allow JavaScript from Apple Events: in Chrome, View > Developer; in Safari, the Develop menu."
        case .pageUnreadable: "The page's DOM could not be read; it may still be loading."
        case .screenshotUnavailable(let gap):
            "The screenshot could not be taken: \(BrowserBridgeCommandSummary.label(gap))."
        case .uploadFailed: "The evidence file could not be staged."
        case .clientUpdateRequired:
            "This Cubby for Mac is too old for the server. Update it, then restart the run."
        case .executionFailed: "The browser did not complete the requested operation."
        case .cancelled: "The browser command was cancelled."
        case .deadlineExceeded: "The browser command deadline elapsed."
        }
    }
}

/// One compact line per account for Settings: the operation and the facts the Mac observed.
public enum BrowserBridgeCommandSummary {
    public static func line(
        operation: BrowserBridgeOperation, outcome: BrowserBridgeCommandOutcome
    ) -> String {
        var parts = [label(operation)]
        switch outcome {
        case .completed(let payload):
            if let page = page(payload.observation.url) { parts.append(page) }
            switch payload.snapshot?.screenshot {
            case .captured: parts.append("screenshot captured")
            case .unavailable(let value): parts.append("\(label(value.reason)) → screenshot unavailable")
            case .skipped, nil:
                if let readyState = payload.observation.readyState { parts.append(readyState.rawValue) }
            }
            if payload.snapshot?.dom.truncated == true { parts.append("DOM truncated") }
        case .failed(let payload):
            if let page = page(payload.observation.url) { parts.append(page) }
            if let gap = payload.screenshotGap {
                parts.append("\(label(gap)) → \(payload.code == .uploadFailed ? "upload failed" : "screenshot unavailable")")
            } else {
                parts.append("failed: \(label(payload.code))")
            }
        }
        return parts.joined(separator: " · ")
    }

    static func label(_ gap: BrowserScreenshotGap) -> String {
        switch gap {
        case .windowNotFound: "window not found"
        case .windowMinimized: "window minimized"
        case .windowOffScreen: "window off screen"
        case .screenRecordingDenied: "Screen Recording denied"
        case .captureFailed: "capture failed"
        case .uploadFailed: "upload failed"
        }
    }

    private static func label(_ operation: BrowserBridgeOperation) -> String {
        switch operation {
        case .navigate: "navigate"
        case .scroll: "scroll"
        case .capture: "capture"
        case .window(let payload): "window \(payload.action.rawValue)"
        }
    }

    private static func label(_ code: BrowserBridgeFailureCode) -> String {
        switch code {
        case .javascriptDisabled: "JavaScript from Apple Events is off"
        case .browserPermissionDenied: "browser control not allowed"
        case .disallowedUrl: "URL outside the allowlist"
        default: code.rawValue.replacingOccurrences(of: "_", with: " ")
        }
    }

    private static func page(_ url: String?) -> String? {
        guard let url, let components = URLComponents(string: url), let host = components.host
        else { return nil }
        let path = components.path == "/" ? "" : components.path
        return String((host + path).prefix(60))
    }
}
