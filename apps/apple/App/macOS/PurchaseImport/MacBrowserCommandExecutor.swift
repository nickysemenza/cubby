import AppKit
import ApplicationServices
import CoreGraphics
import CubbyKit
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

@MainActor
final class MacBrowserCommandExecutor: BrowserCommandExecuting {
    private struct BrowserScreenshot {
        let evidence: BrowserLocalEvidence
        let image: CGImage
    }
    private struct FixedCapturePayload: Decodable {
        struct Link: Decodable { let url: String; let label: String? }
        struct Image: Decodable { let url: String; let alt: String? }
        let url: String
        let title: String
        let text: String
        let links: [Link]
        let images: [Image]
        let authenticationRequired: Bool
    }

    private let browser: BrowserChoice
    private let evidenceUploader: any BrowserEvidenceUploading
    private let appleScript: SerializedAppleScriptExecutor
    private var ownedWindowID: Int?
    private var ownedCaptureWindowID: CGWindowID?
    private var capturedLinks: [String: URL] = [:]
    private var cancelled: Set<UUID> = []

    init(browser: BrowserChoice, evidenceUploader: any BrowserEvidenceUploading) {
        self.browser = browser
        self.evidenceUploader = evidenceUploader
        appleScript = SerializedAppleScriptExecutor(
            targetBundleIdentifier: browser == .safari ? "com.apple.Safari" : "com.google.Chrome")
    }

    /// A rendered PDF is only advertised when the OS has granted the window-capture permission
    /// that lets Cubby render its own dedicated Safari or Chrome window into evidence.
    static var supportsRenderedPDF: Bool { CGPreflightScreenCaptureAccess() }

    func cancel(commandID: UUID) {
        cancelled.insert(commandID)
    }

    func raiseAuthenticationWindow() {
        guard let ownedWindowID else { return }
        let script: String
        switch browser {
        case .safari:
            script = """
                tell application "Safari"
                activate
                set index of window id \(ownedWindowID) to 1
                end tell
                """
        case .chrome:
            script = """
                tell application "Google Chrome"
                activate
                set index of window id \(ownedWindowID) to 1
                end tell
                """
        }
        Task { [appleScript, browser] in
            _ = try? await appleScript.execute(script, action: "raise_auth_window")
            let bundleIdentifier = browser == .safari ? "com.apple.Safari" : "com.google.Chrome"
            NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first?
                .activate(options: [.activateAllWindows])
        }
    }

    func execute(_ command: BrowserBridgeCommand) async -> BrowserBridgeCommandOutcome {
        guard command.deadline > .now else {
            return .failed(
                code: .deadlineExceeded, message: "The browser command deadline elapsed.",
                retryable: false)
        }
        guard cancelled.remove(command.id) == nil else {
            return .failed(code: .cancelled, message: "The browser command was cancelled.", retryable: false)
        }
        do {
            switch command.operation {
            case .navigate(let url, let allowedHosts):
                let validated = try BrowserBridgeURLPolicy.validate(url, allowedHosts: allowedHosts)
                let isCreatingWindow = ownedWindowID == nil
                let previousCaptureWindows =
                    isCreatingWindow ? await browserCaptureWindowIDs() : nil
                ownedWindowID = try await navigate(validated)
                if isCreatingWindow {
                    ownedCaptureWindowID = await identifyCreatedCaptureWindow(
                        excluding: previousCaptureWindows)
                }
                capturedLinks = [:]
                return .completed(capture: nil)
            case .followCapturedLink(let linkID, let allowedHosts):
                guard let url = capturedLinks[linkID] else { throw ExecutionFailure.unknownLink }
                let validated = try BrowserBridgeURLPolicy.validate(url, allowedHosts: allowedHosts)
                try await setOwnedWindowURL(validated)
                capturedLinks = [:]
                return .completed(capture: nil)
            case .scroll(let pageCount):
                guard (1...20).contains(pageCount) else { throw ExecutionFailure.invalidCommand }
                _ = try await runFixedJavaScript(
                    "window.scrollBy(0, window.innerHeight * \(pageCount)); true;")
                return .completed(capture: nil)
            case .capture(let allowedHosts, let enhancedEvidence, let recoveryURL):
                try await prepareCaptureWindow(
                    recoveryURL: recoveryURL, allowedHosts: allowedHosts)
                return .completed(
                    capture: try await capture(
                        command: command, allowedHosts: allowedHosts,
                        enhancedEvidence: enhancedEvidence))
            }
        } catch let failure as BrowserBridgeURLPolicy.Failure {
            return .failed(code: .disallowedURL, message: failure.message, retryable: false)
        } catch let failure as ExecutionFailure {
            if case .authenticationRequired = failure { raiseAuthenticationWindow() }
            return .failed(code: failure.code, message: failure.message, retryable: failure.retryable)
        } catch {
            return .failed(
                code: .executionFailed, message: "The browser command could not be completed.",
                retryable: true)
        }
    }

    private func navigate(_ url: URL) async throws -> Int {
        let target = Self.appleScriptLiteral(url.absoluteString)
        switch (browser, ownedWindowID) {
        case (.safari, .some(let windowID)):
            let script =
                "tell application \"Safari\" to set URL of current tab of window id \(windowID) to \(target)\nreturn \(windowID)"
            return try await browserWindowID(from: script, action: "navigate")
        case (.safari, .none):
            let script =
                "tell application \"Safari\"\nmake new document with properties {URL:\(target)}\nreturn id of front window\nend tell"
            return try await browserWindowID(from: script, action: "navigate")
        case (.chrome, .some(let windowID)):
            let script =
                "tell application \"Google Chrome\" to set URL of active tab of window id \(windowID) to \(target)\nreturn \(windowID)"
            return try await browserWindowID(from: script, action: "navigate")
        case (.chrome, .none):
            let windowID = try await createChromeWindow()
            ownedWindowID = windowID
            let navigateScript =
                "tell application \"Google Chrome\" to set URL of active tab of window id \(windowID) to \(target)\nreturn \(windowID)"
            return try await browserWindowID(from: navigateScript, action: "navigate")
        }
    }

    private func browserWindowID(
        from script: String, action: String, timeoutSeconds: Int = 15
    ) async throws -> Int {
        let value = try await appleScript.execute(
            script, action: action, timeoutSeconds: timeoutSeconds)
        guard let id = Int(value) else { throw ExecutionFailure.browserUnavailable }
        return id
    }

    /// Chrome 153 can create a window and then never reply to the `make new window` Apple Event.
    /// Send that one event without requesting a reply, then prove which window was created from
    /// the before/after ID sets. Ambiguous changes are rejected instead of adopting a user window.
    private func createChromeWindow() async throws -> Int {
        let previous = try await chromeWindowIDs()
        let script = """
            ignoring application responses
            tell application "Google Chrome" to make new window
            end ignoring
            return "requested"
            """
        _ = try await appleScript.execute(script, action: "create_window_request")
        for _ in 0..<40 {
            try await Task.sleep(for: .milliseconds(250))
            let candidates = try await chromeWindowIDs().subtracting(previous)
            if candidates.count == 1, let windowID = candidates.first { return windowID }
            if candidates.count > 1 { throw ExecutionFailure.browserUnavailable }
        }
        throw ExecutionFailure.executionFailed
    }

    private func chromeWindowIDs() async throws -> Set<Int> {
        let script = """
            tell application "Google Chrome"
            set output to ""
            repeat with browserWindow in every window
            set output to output & (id of browserWindow as text) & ","
            end repeat
            return output
            end tell
            """
        let value = try await appleScript.execute(script, action: "list_windows")
        return Set(value.split(separator: ",").compactMap { Int($0) })
    }

    private func setOwnedWindowURL(_ url: URL) async throws {
        guard let ownedWindowID else { throw ExecutionFailure.browserUnavailable }
        _ = try await navigate(url)
        self.ownedWindowID = ownedWindowID
    }

    /// Browser commands outlive both the WebSocket and the Mac process. A resumed Flue run may
    /// therefore deliver `capture` after the in-memory window handle disappeared. Recreate only
    /// from the server-provided, allowlisted recovery URL; never adopt an arbitrary user window.
    private func prepareCaptureWindow(recoveryURL: URL?, allowedHosts: Set<String>) async throws {
        if ownedWindowID != nil {
            do {
                _ = try await runFixedJavaScript("location.href")
                return
            } catch ExecutionFailure.browserUnavailable {
                ownedWindowID = nil
                ownedCaptureWindowID = nil
            }
        }
        guard let recoveryURL else { throw ExecutionFailure.browserUnavailable }
        let validated = try BrowserBridgeURLPolicy.validate(
            recoveryURL, allowedHosts: allowedHosts)
        let previousCaptureWindows = await browserCaptureWindowIDs()
        ownedWindowID = try await navigate(validated)
        ownedCaptureWindowID = await identifyCreatedCaptureWindow(
            excluding: previousCaptureWindows)
        capturedLinks = [:]
    }

    private func runFixedJavaScript(_ javascript: String) async throws -> String {
        guard let ownedWindowID else { throw ExecutionFailure.browserUnavailable }
        let source = Self.appleScriptLiteral(javascript)
        let script: String
        switch browser {
        case .safari:
            script =
                "tell application \"Safari\" to do JavaScript \(source) in current tab of window id \(ownedWindowID)"
        case .chrome:
            script =
                "tell application \"Google Chrome\" to execute active tab of window id \(ownedWindowID) javascript \(source)"
        }
        return try await appleScript.execute(script, action: "fixed_javascript")
    }

    private func capture(
        command: BrowserBridgeCommand, allowedHosts: Set<String>, enhancedEvidence: Bool
    ) async throws -> BrowserPageCapture {
        try await waitForPageReady()
        let raw = try await runFixedJavaScript(Self.captureScript)
        try Task.checkCancellation()
        guard let data = raw.data(using: .utf8) else { throw ExecutionFailure.captureUnavailable }
        let payload: FixedCapturePayload
        do { payload = try JSONDecoder().decode(FixedCapturePayload.self, from: data) } catch {
            throw ExecutionFailure.captureUnavailable
        }
        if payload.authenticationRequired { throw ExecutionFailure.authenticationRequired }
        guard let sourceURL = URL(string: payload.url) else { throw ExecutionFailure.captureUnavailable }
        _ = try BrowserBridgeURLPolicy.validate(sourceURL, allowedHosts: allowedHosts)
        let links = payload.links.prefix(BrowserBridgeProtocol.maximumCapturedLinks).compactMap {
            row -> BrowserCapturedLink? in
            guard let url = URL(string: row.url),
                (try? BrowserBridgeURLPolicy.validate(url, allowedHosts: allowedHosts)) != nil
            else { return nil }
            let id = UUID().uuidString
            capturedLinks[id] = url
            return BrowserCapturedLink(id: id, url: url, label: row.label)
        }
        let images = payload.images.prefix(BrowserBridgeProtocol.maximumCapturedImages).compactMap {
            image -> BrowserCapturedImage? in
            guard let url = URL(string: image.url),
                (try? BrowserBridgeURLPolicy.validate(url, allowedHosts: allowedHosts)) != nil
            else { return nil }
            return BrowserCapturedImage(url: url, alt: image.alt)
        }
        let capturedAt = Date.now
        let normalized = try await NormalizedEvidencePDF.makeFile(
            NormalizedBrowserEvidence(
                sourceURL: sourceURL, capturedAt: capturedAt, captureVersion: 1,
                readableText: payload.text))
        defer { try? FileManager.default.removeItem(at: normalized.url) }
        try Task.checkCancellation()
        guard cancelled.remove(command.id) == nil else { throw ExecutionFailure.cancelled }
        var references: [BrowserEvidenceReference]
        do {
            references = [try await evidenceUploader.upload(normalized, runID: command.runID)]
        } catch {
            throw ExecutionFailure.uploadFailed
        }
        if Self.supportsRenderedPDF, let screenshot = try? await captureBrowserScreenshot() {
            defer { try? FileManager.default.removeItem(at: screenshot.evidence.url) }
            if enhancedEvidence,
                let reference = try? await evidenceUploader.upload(
                    screenshot.evidence, runID: command.runID)
            {
                references.append(reference)
            }
            if let rendered = try? RenderedBrowserEvidencePDF.makeFile(from: screenshot.image) {
                defer { try? FileManager.default.removeItem(at: rendered.url) }
                if let reference = try? await evidenceUploader.upload(rendered, runID: command.runID) {
                    references.append(reference)
                }
            }
        }
        return BrowserPageCapture(
            sourceURL: sourceURL, title: payload.title, capturedAt: capturedAt, captureVersion: 1,
            readableText: payload.text, links: Array(links), images: images,
            evidence: references)
    }

    private func captureBrowserScreenshot() async throws -> BrowserScreenshot {
        guard let ownedCaptureWindowID else { throw ExecutionFailure.captureUnavailable }
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
        let bundleIdentifier = browser == .safari ? "com.apple.Safari" : "com.google.Chrome"
        guard
            let window = content.windows.first(where: {
                $0.windowID == ownedCaptureWindowID
                    && $0.owningApplication?.bundleIdentifier == bundleIdentifier && $0.isOnScreen
            })
        else { throw ExecutionFailure.captureUnavailable }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(window.frame.width * 2))
        configuration.height = max(1, Int(window.frame.height * 2))
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = false
        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: configuration)
        let data = NSMutableData()
        guard
            let destination = CGImageDestinationCreateWithData(
                data, UTType.png.identifier as CFString, 1, nil)
        else { throw ExecutionFailure.captureUnavailable }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw ExecutionFailure.captureUnavailable }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "CubbyBrowserEvidence", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(UUID().uuidString + ".png")
        try (data as Data).write(to: url, options: .atomic)
        return BrowserScreenshot(
            evidence: BrowserLocalEvidence(
                url: url, kind: .screenshot,
                checksum: NormalizedEvidencePDF.sha256(data as Data), contentType: "image/png"),
            image: image)
    }

    /// ScreenCaptureKit uses CGWindowIDs, while browser Apple Events expose a different window
    /// identifier. Cubby correlates them only when creating its dedicated window: exactly one new
    /// on-screen window from the selected browser must appear. Ambiguity disables screenshots and
    /// leaves the normalized PDF as the evidence source.
    private func identifyCreatedCaptureWindow(
        excluding previous: Set<CGWindowID>?
    ) async -> CGWindowID? {
        guard let previous else { return nil }
        for _ in 0..<3 {
            guard let current = await browserCaptureWindowIDs() else { return nil }
            let candidates = current.subtracting(previous)
            if candidates.count == 1 { return candidates.first }
            if candidates.count > 1 { return nil }
            await Task.yield()
        }
        return nil
    }

    private func browserCaptureWindowIDs() async -> Set<CGWindowID>? {
        guard CGPreflightScreenCaptureAccess() else { return nil }
        let content = try? await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true)
        let bundleIdentifier = browser == .safari ? "com.apple.Safari" : "com.google.Chrome"
        return content.map {
            Set(
                $0.windows.lazy.filter {
                    $0.owningApplication?.bundleIdentifier == bundleIdentifier && $0.isOnScreen
                }.map(\.windowID))
        }
    }

    private func waitForPageReady() async throws {
        for _ in 0..<40 {
            try Task.checkCancellation()
            if (try? await runFixedJavaScript("document.readyState")) == "complete" { return }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw ExecutionFailure.captureUnavailable
    }

    private static func appleScriptLiteral(_ value: String) -> String {
        "\""
            + value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// Fixed and versioned. Page text is treated only as data; it cannot introduce a selector,
    /// script, navigation, click, or form action into the browser executor.
    private static let captureScript = #"""
        (() => {
          const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
          return JSON.stringify({
            url: location.href,
            title: clean(document.title).slice(0, 500),
            text: clean(document.body?.innerText).slice(0, 24576),
            links: Array.from(document.querySelectorAll('a[href]')).slice(0, 200).map(a => ({
              url: a.href,
              label: clean(a.innerText || a.getAttribute('aria-label')).slice(0, 300) || null
            })),
            images: Array.from(document.images).slice(0, 200).map(image => ({
              url: image.currentSrc || image.src,
              alt: clean(image.alt).slice(0, 500) || null
            })),
            authenticationRequired: Boolean(document.querySelector('input[type="password"]'))
          });
        })();
        """#
}

private actor SerializedAppleScriptExecutor {
    private let targetBundleIdentifier: String

    init(targetBundleIdentifier: String) {
        self.targetBundleIdentifier = targetBundleIdentifier
    }

    func execute(_ source: String, action: String, timeoutSeconds: Int = 15) throws -> String {
        // NSAppleScript is synchronous. Keeping it on this dedicated serial executor prevents a
        // slow browser or macOS Automation prompt from freezing SwiftUI and the WebSocket bridge.
        BrowserBridgeDebugLog.emit(.appleEventStarted, messageType: action)
        let target = NSAppleEventDescriptor(bundleIdentifier: targetBundleIdentifier)
        guard let descriptor = target.aeDesc else { throw ExecutionFailure.browserUnavailable }
        let permission = AEDeterminePermissionToAutomateTarget(
            descriptor, typeWildCard, typeWildCard, true)
        if permission == errAEEventNotPermitted || permission == errAEEventWouldRequireUserConsent {
            BrowserBridgeDebugLog.emit(.appleEventRejected, messageType: action)
            throw ExecutionFailure.permissionDenied
        }
        guard permission == noErr else { throw ExecutionFailure.browserUnavailable }
        let bounded = "with timeout of \(timeoutSeconds) seconds\n\(source)\nend timeout"
        guard let script = NSAppleScript(source: bounded) else {
            throw ExecutionFailure.invalidCommand
        }
        var details: NSDictionary?
        let result = script.executeAndReturnError(&details)
        if let details {
            let number = details[NSAppleScript.errorNumber] as? Int
            let message = details[NSAppleScript.errorMessage] as? String
            if number == -1743 {
                BrowserBridgeDebugLog.emit(
                    .appleEventRejected, messageType: action, errorCode: number)
                throw ExecutionFailure.permissionDenied
            }
            if number == -1728 {
                BrowserBridgeDebugLog.emit(
                    .appleEventFailed, messageType: action, errorCode: number)
                throw ExecutionFailure.browserUnavailable
            }
            if message?.contains("JavaScript through AppleScript is turned off") == true {
                BrowserBridgeDebugLog.emit(
                    .appleEventRejected, messageType: action, errorCode: number)
                throw ExecutionFailure.javascriptAutomationDisabled
            }
            BrowserBridgeDebugLog.emit(
                .appleEventFailed, messageType: action, errorCode: number)
            throw ExecutionFailure.executionFailed
        }
        BrowserBridgeDebugLog.emit(.appleEventFinished, messageType: action)
        return result.stringValue ?? String(result.int32Value)
    }
}

private enum ExecutionFailure: Error, Sendable {
    case invalidCommand
    case unknownLink
    case browserUnavailable
    case permissionDenied
    case javascriptAutomationDisabled
    case authenticationRequired
    case captureUnavailable
    case uploadFailed
    case executionFailed
    case cancelled

    var code: BrowserBridgeFailureCode {
        switch self {
        case .invalidCommand: .invalidCommand
        case .unknownLink: .unknownLink
        case .browserUnavailable: .browserUnavailable
        case .permissionDenied, .javascriptAutomationDisabled: .browserPermissionDenied
        case .authenticationRequired: .authenticationRequired
        case .captureUnavailable: .captureUnavailable
        case .uploadFailed: .uploadFailed
        case .executionFailed: .executionFailed
        case .cancelled: .cancelled
        }
    }

    var retryable: Bool {
        switch self {
        case .browserUnavailable, .permissionDenied, .captureUnavailable, .uploadFailed,
            .executionFailed:
            true
        case .invalidCommand, .unknownLink, .authenticationRequired,
            .javascriptAutomationDisabled,
            .cancelled:
            false
        }
    }

    var message: String {
        switch self {
        case .invalidCommand: "The browser command was invalid."
        case .unknownLink: "The captured link is no longer available."
        case .browserUnavailable: "The selected browser or Cubby-owned window is unavailable."
        case .permissionDenied: "macOS did not allow Cubby to control the selected browser."
        case .javascriptAutomationDisabled:
            "In Chrome, choose View > Developer > Allow JavaScript from Apple Events."
        case .authenticationRequired: "The vendor needs you to sign in in Cubby's browser window."
        case .captureUnavailable: "The signed-in page could not be captured."
        case .uploadFailed: "The evidence file could not be staged."
        case .executionFailed: "The browser did not complete the requested operation."
        case .cancelled: "The browser command was cancelled."
        }
    }
}

private extension BrowserBridgeURLPolicy.Failure {
    var message: String {
        switch self {
        case .httpsRequired: "Only HTTPS browser URLs are allowed."
        case .credentialsForbidden: "Browser URLs cannot contain credentials."
        case .hostMissing: "The browser URL has no host."
        case .hostNotAllowed: "The browser URL is outside the Vendor allowlist."
        case .fragmentForbidden: "Browser URL fragments are not allowed."
        }
    }
}
