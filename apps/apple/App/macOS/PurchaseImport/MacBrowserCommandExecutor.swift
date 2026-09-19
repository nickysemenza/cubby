import AppKit
import CoreGraphics
import CubbyKit
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

@MainActor
final class MacBrowserCommandExecutor: BrowserCommandExecuting {
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
    private var ownedWindowID: Int?
    private var ownedCaptureWindowID: CGWindowID?
    private var capturedLinks: [String: URL] = [:]
    private var cancelled: Set<UUID> = []

    init(browser: BrowserChoice, evidenceUploader: any BrowserEvidenceUploading) {
        self.browser = browser
        self.evidenceUploader = evidenceUploader
    }

    func cancel(commandID: UUID) {
        cancelled.insert(commandID)
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
                ownedWindowID = try navigate(validated)
                if isCreatingWindow {
                    ownedCaptureWindowID = await identifyCreatedCaptureWindow(
                        excluding: previousCaptureWindows)
                }
                capturedLinks = [:]
                return .completed(capture: nil)
            case .followCapturedLink(let linkID, let allowedHosts):
                guard let url = capturedLinks[linkID] else { throw ExecutionFailure.unknownLink }
                let validated = try BrowserBridgeURLPolicy.validate(url, allowedHosts: allowedHosts)
                try setOwnedWindowURL(validated)
                capturedLinks = [:]
                return .completed(capture: nil)
            case .scroll(let pageCount):
                guard (1...20).contains(pageCount) else { throw ExecutionFailure.invalidCommand }
                _ = try runFixedJavaScript("window.scrollBy(0, window.innerHeight * \(pageCount)); true;")
                return .completed(capture: nil)
            case .capture(let allowedHosts, let enhancedEvidence):
                return .completed(
                    capture: try await capture(
                        command: command, allowedHosts: allowedHosts,
                        enhancedEvidence: enhancedEvidence))
            }
        } catch let failure as BrowserBridgeURLPolicy.Failure {
            return .failed(code: .disallowedURL, message: failure.message, retryable: false)
        } catch let failure as ExecutionFailure {
            return .failed(code: failure.code, message: failure.message, retryable: failure.retryable)
        } catch {
            return .failed(
                code: .executionFailed, message: "The browser command could not be completed.",
                retryable: true)
        }
    }

    private func navigate(_ url: URL) throws -> Int {
        let target = Self.appleScriptLiteral(url.absoluteString)
        let script: String
        switch (browser, ownedWindowID) {
        case (.safari, .some(let windowID)):
            script =
                "tell application \"Safari\" to set URL of current tab of window id \(windowID) to \(target)\nreturn \(windowID)"
        case (.safari, .none):
            script =
                "tell application \"Safari\"\nmake new document with properties {URL:\(target)}\nreturn id of front window\nend tell"
        case (.chrome, .some(let windowID)):
            script =
                "tell application \"Google Chrome\" to set URL of active tab of window id \(windowID) to \(target)\nreturn \(windowID)"
        case (.chrome, .none):
            script =
                "tell application \"Google Chrome\"\nset w to make new window\nset URL of active tab of w to \(target)\nreturn id of w\nend tell"
        }
        let value = try execute(script)
        guard let id = Int(value) else { throw ExecutionFailure.browserUnavailable }
        return id
    }

    private func setOwnedWindowURL(_ url: URL) throws {
        guard let ownedWindowID else { throw ExecutionFailure.browserUnavailable }
        _ = try navigate(url)
        self.ownedWindowID = ownedWindowID
    }

    private func runFixedJavaScript(_ javascript: String) throws -> String {
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
        return try execute(script)
    }

    private func capture(
        command: BrowserBridgeCommand, allowedHosts: Set<String>, enhancedEvidence: Bool
    ) async throws -> BrowserPageCapture {
        try await waitForPageReady()
        let raw = try runFixedJavaScript(Self.captureScript)
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
        if enhancedEvidence, CGPreflightScreenCaptureAccess(),
            let screenshot = try? await captureBrowserScreenshot()
        {
            defer { try? FileManager.default.removeItem(at: screenshot.url) }
            if let reference = try? await evidenceUploader.upload(screenshot, runID: command.runID) {
                references.append(reference)
            }
        }
        return BrowserPageCapture(
            sourceURL: sourceURL, title: payload.title, capturedAt: capturedAt, captureVersion: 1,
            readableText: payload.text, links: Array(links), images: images,
            evidence: references)
    }

    private func captureBrowserScreenshot() async throws -> BrowserLocalEvidence {
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
        return BrowserLocalEvidence(
            url: url, kind: .screenshot,
            checksum: NormalizedEvidencePDF.sha256(data as Data), contentType: "image/png")
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
            if (try? runFixedJavaScript("document.readyState")) == "complete" { return }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw ExecutionFailure.captureUnavailable
    }

    private func execute(_ source: String) throws -> String {
        guard let script = NSAppleScript(source: source) else { throw ExecutionFailure.invalidCommand }
        var details: NSDictionary?
        let result = script.executeAndReturnError(&details)
        if let details {
            let number = details[NSAppleScript.errorNumber] as? Int
            if number == -1743 { throw ExecutionFailure.permissionDenied }
            throw ExecutionFailure.executionFailed
        }
        return result.stringValue ?? String(result.int32Value)
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

private enum ExecutionFailure: Error {
    case invalidCommand
    case unknownLink
    case browserUnavailable
    case permissionDenied
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
        case .permissionDenied: .browserPermissionDenied
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
        case .invalidCommand, .unknownLink, .authenticationRequired, .cancelled: false
        }
    }

    var message: String {
        switch self {
        case .invalidCommand: "The browser command was invalid."
        case .unknownLink: "The captured link is no longer available."
        case .browserUnavailable: "The selected browser or Cubby-owned window is unavailable."
        case .permissionDenied: "macOS did not allow Cubby to control the selected browser."
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
