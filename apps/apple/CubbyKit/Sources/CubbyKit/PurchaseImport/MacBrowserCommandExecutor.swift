#if os(macOS)
    import AppKit
    import ApplicationServices
    import CoreGraphics
    import Foundation
    import ImageIO
    import ScreenCaptureKit
    import UniformTypeIdentifiers

    @MainActor
    public final class MacBrowserCommandExecutor: BrowserCommandExecuting {
        private struct BrowserScreenshot {
            let evidence: BrowserLocalEvidence
            let image: CGImage
        }
        /// Bumped when the fixed capture script's output changes. Version 2 adds schema.org
        /// Product identifiers (`structuredProducts`); version 3 reads them from a Product's
        /// `offers`, selecting only the served `?variant=` Offer; version 4 fails closed on an
        /// overlong identifier or an unreadable served variant.
        static let captureVersion = 4

        struct FixedCapturePayload: Decodable {
            struct Link: Decodable { let url: String; let label: String? }
            struct StructuredProduct: Decodable {
                let skus: [String]
                let mpns: [String]
                let gtins: [String]
                let productIds: [String]
            }
            struct StructuredProducts: Decodable {
                let products: [StructuredProduct]
                let variantGroup: Bool
            }
            struct Image: Decodable {
                let url: String
                let alt: String?
                let naturalWidth: Int?
                let naturalHeight: Int?
                let highResolutionUrl: String?
            }
            let url: String
            let canonicalUrl: String?
            let servedAmazonAsin: String?
            let variantMarkers: [String]
            let title: String
            let text: String
            let links: [Link]
            let images: [Image]
            let structuredProducts: StructuredProducts?
            let authenticationRequired: Bool
        }

        private let browser: BrowserChoice
        private let target: MacBrowserExecutionTarget
        private let targetBundleIdentifier: String
        /// The executor is instantiated once per VendorAccount. Keeping this identity on the executor
        /// makes every window lifecycle event attributable without ever logging page content or URLs.
        private let accountID: String
        private let evidenceUploader: any BrowserEvidenceUploading
        private let appleScript: SerializedAppleScriptExecutor
        private var ownedWindowID: Int?
        private var ownedCaptureWindowID: CGWindowID?
        private var capturedLinks: [String: URL] = [:]
        private var cancelled: Set<UUID> = []

        public init(
            target: MacBrowserExecutionTarget, accountID: String,
            evidenceUploader: any BrowserEvidenceUploading
        ) throws {
            try target.verifyOwnership()
            self.target = target
            browser = target.browser
            targetBundleIdentifier = target.bundleIdentifier
            self.accountID = accountID
            self.evidenceUploader = evidenceUploader
            appleScript = SerializedAppleScriptExecutor(target: target)
        }

        /// A rendered PDF is only advertised when the OS has granted the window-capture permission
        /// that lets Cubby render its own dedicated Safari or Chrome window into evidence.
        public static var supportsRenderedPDF: Bool { CGPreflightScreenCaptureAccess() }

        public func cancel(commandID: UUID) {
            cancelled.insert(commandID)
        }

        public func raiseAuthenticationWindow() {
            guard let ownedWindowID else { return }
            let script: String
            switch browser {
            case .safari:
                script = """
                    tell application id \(Self.appleScriptLiteral(targetBundleIdentifier))
                    activate
                    set visible of window id \(ownedWindowID) to true
                    set minimized of window id \(ownedWindowID) to false
                    set index of window id \(ownedWindowID) to 1
                    end tell
                    """
            case .chrome:
                script = """
                    tell application id \(Self.appleScriptLiteral(targetBundleIdentifier))
                    activate
                    set visible of window id \(ownedWindowID) to true
                    set minimized of window id \(ownedWindowID) to false
                    set index of window id \(ownedWindowID) to 1
                    end tell
                    """
            }
            Task { [appleScript, browser, accountID, targetBundleIdentifier, target] in
                do {
                    _ = try await appleScript.execute(script, action: "raise_auth_window")
                    BrowserBridgeDebugLog.emit(
                        .windowRaised, browser: browser, accountID: accountID)
                } catch {
                    BrowserBridgeDebugLog.emit(
                        .windowRaiseFailed, browser: browser, accountID: accountID, error: error)
                }
                do {
                    try target.verifyOwnership()
                } catch {
                    BrowserBridgeDebugLog.emit(
                        .windowRaiseFailed, browser: browser, accountID: accountID, error: error)
                    return
                }
                let bundleIdentifier = targetBundleIdentifier
                NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).first?
                    .activate(options: [.activateAllWindows])
            }
        }

        /// Keep the owned browser available to ScreenCaptureKit without stealing focus from the
        /// user's current app. A minimized window cannot be captured by the on-screen-only path.
        private func returnOwnedWindowToBackground() async {
            guard let ownedWindowID else { return }
            let script: String
            switch browser {
            case .safari:
                script = """
                    tell application id \(Self.appleScriptLiteral(targetBundleIdentifier))
                    set visible of window id \(ownedWindowID) to true
                    set minimized of window id \(ownedWindowID) to false
                    set index of window id \(ownedWindowID) to (count of windows)
                    end tell
                    """
            case .chrome:
                script = """
                    tell application id \(Self.appleScriptLiteral(targetBundleIdentifier))
                    set visible of window id \(ownedWindowID) to true
                    set minimized of window id \(ownedWindowID) to false
                    set index of window id \(ownedWindowID) to (count of windows)
                    end tell
                    """
            }
            do {
                _ = try await appleScript.execute(script, action: "background_window")
                BrowserBridgeDebugLog.emit(
                    .windowBackgrounded, browser: browser, accountID: accountID)
            } catch {
                BrowserBridgeDebugLog.emit(
                    .windowBackgroundFailed, browser: browser, accountID: accountID, error: error)
            }
        }

        /// Minimize only after the server declares the run terminal.
        public func minimizeOwnedWindow() {
            guard let ownedWindowID else { return }
            let script =
                "tell application id \(Self.appleScriptLiteral(targetBundleIdentifier)) to set minimized of window id \(ownedWindowID) to true"
            Task { [appleScript, browser, accountID] in
                do {
                    _ = try await appleScript.execute(script, action: "minimize_window")
                    BrowserBridgeDebugLog.emit(
                        .windowMinimized, browser: browser, accountID: accountID)
                } catch {
                    BrowserBridgeDebugLog.emit(
                        .windowMinimizeFailed, browser: browser, accountID: accountID, error: error)
                }
            }
        }

        public func execute(_ command: BrowserBridgeCommand) async -> BrowserBridgeCommandOutcome {
            guard command.deadline > .now else {
                return .failed(
                    code: .deadlineExceeded, message: "The browser command deadline elapsed.",
                    retryable: false)
            }
            guard let commandID = command.commandUUID else {
                return .failed(
                    code: .invalidCommand, message: "The browser command identifier was invalid.",
                    retryable: false)
            }
            guard cancelled.remove(commandID) == nil else {
                return .failed(
                    code: .cancelled, message: "The browser command was cancelled.", retryable: false)
            }
            do {
                try target.verifyOwnership()
                switch command.operation {
                case .navigate(let payload):
                    guard let url = URL(string: payload.url) else { throw ExecutionFailure.invalidCommand }
                    let allowedHosts = Set(payload.allowedHosts)
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
                case .followCapturedLink(let payload):
                    guard let url = capturedLinks[payload.linkID] else { throw ExecutionFailure.unknownLink }
                    let allowedHosts = Set(payload.allowedHosts)
                    let validated = try BrowserBridgeURLPolicy.validate(url, allowedHosts: allowedHosts)
                    try await setOwnedWindowURL(validated)
                    capturedLinks = [:]
                    return .completed(capture: nil)
                case .scroll(let payload):
                    guard (1...20).contains(payload.pageCount) else { throw ExecutionFailure.invalidCommand }
                    _ = try await runFixedJavaScript(
                        "window.scrollBy(0, window.innerHeight * \(payload.pageCount)); true;")
                    await returnOwnedWindowToBackground()
                    return .completed(capture: nil)
                case .capture(let payload):
                    let allowedHosts = Set(payload.allowedHosts)
                    let recoveryURL = payload.recoveryURL.flatMap(URL.init(string:))
                    let targetURL = try await prepareCaptureWindow(
                        recoveryURL: recoveryURL, allowedHosts: allowedHosts)
                    let result = try await capture(
                        command: command, allowedHosts: allowedHosts,
                        enhancedEvidence: payload.enhancedEvidence, targetURL: targetURL,
                        evidenceScope: payload.evidenceScope.map {
                            BrowserEvidenceUploadScope(
                                runID: $0.runId, targetID: $0.targetId)
                        })
                    await returnOwnedWindowToBackground()
                    return .completed(capture: result)
                }
            } catch let failure as MacBrowserExecutionTarget.Failure {
                return .failed(
                    code: .browserUnavailable, message: failure.localizedDescription, retryable: false)
            } catch let failure as BrowserBridgeURLPolicy.Failure {
                return .failed(code: .disallowedURL, message: failure.message, retryable: false)
            } catch let failure as ExecutionFailure {
                if case .authenticationRequired = failure { raiseAuthenticationWindow() }
                return .failed(code: failure.code, message: failure.message, retryable: failure.retryable)
            } catch {
                return .failed(
                    code: .executionFailed, message: error.localizedDescription,
                    retryable: true)
            }
        }

        private func navigate(_ url: URL) async throws -> Int {
            let foregroundApplicationBeforeBrowserWork = NSWorkspace.shared.frontmostApplication
            let target = Self.appleScriptLiteral(url.absoluteString)
            let windowID: Int
            switch (browser, ownedWindowID) {
            case (.safari, .some(let existingWindowID)):
                let script =
                    "tell application id \(Self.appleScriptLiteral(targetBundleIdentifier)) to set URL of current tab of window id \(existingWindowID) to \(target)\nreturn \(existingWindowID)"
                windowID = try await browserWindowID(from: script, action: "navigate")
            case (.safari, .none):
                let script =
                    "tell application id \(Self.appleScriptLiteral(targetBundleIdentifier))\nmake new document with properties {URL:\(target)}\nreturn id of front window\nend tell"
                windowID = try await browserWindowID(from: script, action: "navigate")
            case (.chrome, .some(let existingWindowID)):
                let script =
                    "tell application id \(Self.appleScriptLiteral(targetBundleIdentifier)) to set URL of active tab of window id \(existingWindowID) to \(target)\nreturn \(existingWindowID)"
                windowID = try await browserWindowID(from: script, action: "navigate")
            case (.chrome, .none):
                let newWindowID = try await createChromeWindow()
                ownedWindowID = newWindowID
                let navigateScript =
                    "tell application id \(Self.appleScriptLiteral(targetBundleIdentifier)) to set URL of active tab of window id \(newWindowID) to \(target)\nreturn \(newWindowID)"
                windowID = try await browserWindowID(from: navigateScript, action: "navigate")
            }
            await returnOwnedWindowToBackground()
            if let foregroundApplicationBeforeBrowserWork,
                foregroundApplicationBeforeBrowserWork.bundleIdentifier
                    != targetBundleIdentifier
            {
                foregroundApplicationBeforeBrowserWork.activate()
            }
            return windowID
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
                tell application id \(Self.appleScriptLiteral(targetBundleIdentifier)) to make new window
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
                tell application id \(Self.appleScriptLiteral(targetBundleIdentifier))
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

        /// Browser commands outlive both the WebSocket and the Mac process. A capture target is the
        /// page the command asks us to capture, and also the safe recovery location when the owned
        /// window disappeared. Never adopt an arbitrary user window, and never reload an owned window
        /// that is already at the target during command replay.
        private func prepareCaptureWindow(
            recoveryURL: URL?, allowedHosts: Set<String>
        ) async throws -> URL? {
            let targetURL = try recoveryURL.map {
                try BrowserBridgeURLPolicy.validate($0, allowedHosts: allowedHosts)
            }
            if ownedWindowID != nil {
                do {
                    let currentURL = URL(string: try await runFixedJavaScript("location.href"))
                    if let targetURL,
                        BrowserCaptureNavigationPolicy.shouldNavigate(
                            currentURL: currentURL, targetURL: targetURL)
                    {
                        try await setOwnedWindowURL(targetURL)
                        capturedLinks = [:]
                    }
                    return targetURL
                } catch ExecutionFailure.browserUnavailable {
                    ownedWindowID = nil
                    ownedCaptureWindowID = nil
                }
            }
            guard let targetURL else { throw ExecutionFailure.browserUnavailable }
            let previousCaptureWindows = await browserCaptureWindowIDs()
            ownedWindowID = try await navigate(targetURL)
            ownedCaptureWindowID = await identifyCreatedCaptureWindow(
                excluding: previousCaptureWindows)
            capturedLinks = [:]
            return targetURL
        }

        private func runFixedJavaScript(_ javascript: String) async throws -> String {
            guard let ownedWindowID else { throw ExecutionFailure.browserUnavailable }
            let source = Self.appleScriptLiteral(javascript)
            let script: String
            switch browser {
            case .safari:
                script =
                    "tell application id \(Self.appleScriptLiteral(targetBundleIdentifier)) to do JavaScript \(source) in current tab of window id \(ownedWindowID)"
            case .chrome:
                script =
                    "tell application id \(Self.appleScriptLiteral(targetBundleIdentifier)) to execute active tab of window id \(ownedWindowID) javascript \(source)"
            }
            return try await appleScript.execute(script, action: "fixed_javascript")
        }

        private func capture(
            command: BrowserBridgeCommand, allowedHosts: Set<String>, enhancedEvidence: Bool,
            targetURL: URL?, evidenceScope: BrowserEvidenceUploadScope?
        ) async throws -> BrowserPageCapture {
            try await waitForPageReady(targetURL: targetURL)
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
                let highResolutionURL = image.highResolutionUrl.flatMap(URL.init(string:)).flatMap {
                    candidate in
                    (try? BrowserBridgeURLPolicy.validate(candidate, allowedHosts: allowedHosts))
                }
                return BrowserCapturedImage(
                    url: url, alt: image.alt, naturalWidth: image.naturalWidth,
                    naturalHeight: image.naturalHeight, highResolutionURL: highResolutionURL)
            }
            let canonicalURL = payload.canonicalUrl.flatMap(URL.init(string:)).flatMap { candidate in
                (try? BrowserBridgeURLPolicy.validate(candidate, allowedHosts: allowedHosts))
            }
            let capturedAt = Date.now
            let normalized = try await NormalizedEvidencePDF.makeFile(
                NormalizedBrowserEvidence(
                    sourceURL: sourceURL, capturedAt: capturedAt, captureVersion: Self.captureVersion,
                    readableText: payload.text))
            defer { try? FileManager.default.removeItem(at: normalized.url) }
            try Task.checkCancellation()
            guard let commandID = command.commandUUID, cancelled.remove(commandID) == nil else {
                throw ExecutionFailure.cancelled
            }
            guard Self.supportsRenderedPDF else {
                let references: [BrowserEvidenceReference]
                do {
                    references = [
                        try await evidenceUploader.upload(
                            normalized, runID: command.runID, scope: evidenceScope)
                    ]
                } catch {
                    throw ExecutionFailure.uploading(error)
                }
                return BrowserPageCapture(
                    sourceURL: sourceURL, title: payload.title, capturedAt: capturedAt,
                    captureVersion: Self.captureVersion,
                    readableText: payload.text, links: Array(links), images: images,
                    evidence: references, canonicalURL: canonicalURL,
                    requestedAmazonASIN: Self.amazonASIN(in: targetURL),
                    servedAmazonASIN: payload.servedAmazonAsin,
                    variantMarkers: payload.variantMarkers,
                    structuredProducts: payload.structuredProducts?.capture)
            }

            BrowserBridgeDebugLog.emit(.visualCaptureStarted, command: command)
            let screenshot: BrowserScreenshot
            let rendered: BrowserLocalEvidence
            do {
                screenshot = try await captureBrowserScreenshot()
                rendered = try RenderedBrowserEvidencePDF.makeFile(from: screenshot.image)
            } catch {
                BrowserBridgeDebugLog.emit(.visualCaptureFailed, command: command, error: error)
                throw ExecutionFailure.captureUnavailable
            }
            defer {
                try? FileManager.default.removeItem(at: screenshot.evidence.url)
                try? FileManager.default.removeItem(at: rendered.url)
            }

            var references: [BrowserEvidenceReference] = []
            do {
                references.append(
                    try await evidenceUploader.upload(
                        normalized, runID: command.runID, scope: evidenceScope))
                if enhancedEvidence {
                    references.append(
                        try await evidenceUploader.upload(
                            screenshot.evidence, runID: command.runID, scope: evidenceScope))
                }
                references.append(
                    try await evidenceUploader.upload(
                        rendered, runID: command.runID, scope: evidenceScope))
                BrowserBridgeDebugLog.emit(.visualCaptureFinished, command: command)
            } catch {
                BrowserBridgeDebugLog.emit(.visualCaptureFailed, command: command, error: error)
                throw ExecutionFailure.uploading(error)
            }
            return BrowserPageCapture(
                sourceURL: sourceURL, title: payload.title, capturedAt: capturedAt,
                captureVersion: Self.captureVersion,
                readableText: payload.text, links: Array(links), images: images,
                evidence: references, canonicalURL: canonicalURL,
                requestedAmazonASIN: Self.amazonASIN(in: targetURL),
                servedAmazonASIN: payload.servedAmazonAsin,
                variantMarkers: payload.variantMarkers,
                structuredProducts: payload.structuredProducts?.capture)
        }

        private func captureBrowserScreenshot() async throws -> BrowserScreenshot {
            guard let ownedCaptureWindowID else { throw ExecutionFailure.captureUnavailable }
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            let bundleIdentifier = targetBundleIdentifier
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
            let url = directory.appendingPathComponent(
                "browser-view-\(UUID().uuidString).png")
            try (data as Data).write(to: url, options: .atomic)
            return BrowserScreenshot(
                evidence: BrowserLocalEvidence(
                    url: url, kind: .screenshot,
                    checksum: (data as Data).sha256Hex, contentType: "image/png"),
                image: image)
        }

        /// ScreenCaptureKit uses CGWindowIDs, while browser Apple Events expose a different window
        /// identifier. Cubby correlates them only when creating its dedicated window: exactly one new
        /// on-screen window from the selected browser must appear. Ambiguity disables screenshots.
        private func identifyCreatedCaptureWindow(
            excluding previous: Set<CGWindowID>?
        ) async -> CGWindowID? {
            guard let previous else { return nil }
            for _ in 0..<40 {
                guard let current = await browserCaptureWindowIDs() else { return nil }
                let candidates = current.subtracting(previous)
                if candidates.count == 1 {
                    BrowserBridgeDebugLog.emit(.captureWindowCorrelated, browser: browser, count: 1)
                    return candidates.first
                }
                if candidates.count > 1 {
                    BrowserBridgeDebugLog.emit(
                        .captureWindowCorrelationFailed, browser: browser, count: candidates.count)
                    return nil
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
            BrowserBridgeDebugLog.emit(.captureWindowCorrelationFailed, browser: browser, count: 0)
            return nil
        }

        private func browserCaptureWindowIDs() async -> Set<CGWindowID>? {
            guard CGPreflightScreenCaptureAccess() else { return nil }
            let content = try? await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            let bundleIdentifier = targetBundleIdentifier
            return content.map {
                Set(
                    $0.windows.lazy.filter {
                        $0.owningApplication?.bundleIdentifier == bundleIdentifier && $0.isOnScreen
                    }.map(\.windowID))
            }
        }

        private func waitForPageReady(targetURL: URL?) async throws {
            for _ in 0..<40 {
                try Task.checkCancellation()
                let currentURLString = try? await runFixedJavaScript("location.href")
                let currentURL = currentURLString.flatMap(URL.init(string:))
                let readyState = try? await runFixedJavaScript("document.readyState")
                if BrowserCaptureNavigationPolicy.isReady(
                    currentURL: currentURL, targetURL: targetURL,
                    documentReadyState: readyState ?? "")
                {
                    return
                }
                try await Task.sleep(for: .milliseconds(250))
            }
            throw ExecutionFailure.captureUnavailable
        }

        private static func appleScriptLiteral(_ value: String) -> String {
            "\""
                + value.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"") + "\""
        }

        /// The requested ASIN belongs to the broker-selected recovery URL; the served ASIN is
        /// extracted from the page separately so an Amazon redirect or variant switch stays visible.
        private static func amazonASIN(in url: URL?) -> String? {
            guard let url else { return nil }
            let components = url.pathComponents
            guard
                let marker = components.indices.first(where: { index in
                    let lowercased = components[index].lowercased()
                    return lowercased == "dp"
                        || (lowercased == "product" && markerHasAmazonGPParent(components, at: index))
                }),
                components.indices.contains(marker + 1)
            else { return nil }
            let value = components[marker + 1].uppercased()
            guard value.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else {
                return nil
            }
            return value
        }

        private static func markerHasAmazonGPParent(_ components: [String], at index: Int?) -> Bool {
            guard let index, components.indices.contains(index - 1) else { return false }
            return components[index - 1].lowercased() == "gp"
        }

        /// The ld+json Product walker the capture script calls, kept as its own expression so the
        /// tests evaluate the exact production source in JavaScriptCore.
        nonisolated static let structuredProductsScript = #"""
            () => {
              const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
              // Only schema.org Product nodes in ld+json blocks; never page text. Every cap fails
              // closed: anything left unread marks the capture a variant group, never exact.
              let truncated = false;
              const values = (node, keys) => {
                const out = [];
                for (const key of keys) {
                  for (const item of [].concat(node[key] ?? [])) {
                    if (typeof item !== 'string' && typeof item !== 'number') continue;
                    const full = clean(item);
                    // A clipped identifier could equal another variant's; never compare prefixes.
                    if (full.length > 100) truncated = true;
                    const text = full.slice(0, 100);
                    if (text && !out.includes(text)) out.push(text);
                  }
                }
                if (out.length > 10) truncated = true;
                return out.slice(0, 10);
              };
              const hasType = (node, name) => [].concat(node['@type'] ?? []).includes(name);
              const identifiers = node => ({
                skus: values(node, ['sku']),
                mpns: values(node, ['mpn']),
                gtins: values(node, ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14']),
                productIds: values(node, ['productID'])
              });
              const fields = ['skus', 'mpns', 'gtins', 'productIds'];
              const merge = (...sets) => {
                const out = { skus: [], mpns: [], gtins: [], productIds: [] };
                for (const set of sets) {
                  for (const key of fields) {
                    for (const item of set[key]) if (!out[key].includes(item)) out[key].push(item);
                  }
                }
                for (const key of fields) {
                  if (out[key].length > 10) truncated = true;
                  out[key] = out[key].slice(0, 10);
                }
                return out;
              };
              const sameList = (left, right) =>
                left.length === right.length && left.every(item => right.includes(item));
              const sameSet = (left, right) => fields.every(key => sameList(left[key], right[key]));
              const conflicts = (left, right) =>
                left.length > 0 && right.length > 0 && !sameList(left, right);
              // Shopify-style `?variant=<id>`, hand-parsed because JavaScriptCore has no URL: only
              // the query component counts and names and values are decoded. No variant parameter
              // is null; a repeated, empty or undecodable one is `invalid`, which never matches and
              // never lets a Product and its Offers merge.
              const invalid = {};
              const variantOf = url => {
                const beforeFragment = String(url ?? '').split('#')[0];
                const start = beforeFragment.indexOf('?');
                if (start < 0) return null;
                const found = [];
                for (const pair of beforeFragment.slice(start + 1).split('&')) {
                  const equals = pair.indexOf('=');
                  const decode = text => decodeURIComponent(text.replace(/\+/g, ' '));
                  let name;
                  let value;
                  try {
                    name = decode(equals < 0 ? pair : pair.slice(0, equals));
                    value = decode(equals < 0 ? '' : pair.slice(equals + 1));
                  } catch { return invalid; }
                  if (name === 'variant') found.push(value);
                }
                if (found.length === 0) return null;
                return found.length === 1 && found[0] ? found[0] : invalid;
              };
              const servedVariant = variantOf(location.href);
              const products = [];
              let variantGroup = false;
              // Offers have their own budget so a long offer list cannot starve the graph walk.
              let visited = 0;
              let offerBudget = 1000;
              const collectOffers = product => {
                const offers = [];
                for (const offer of [].concat(product.offers ?? [])) {
                  if (!offer || typeof offer !== 'object') continue;
                  const nested = offer.offers && typeof offer.offers === 'object'
                    ? [].concat(offer.offers) : [offer];
                  for (const item of nested) {
                    if (!item || typeof item !== 'object') continue;
                    if (offers.length >= 100 || --offerBudget < 0) { truncated = true; return offers; }
                    offers.push(item);
                  }
                }
                return offers;
              };
              // Per-variant identifiers live in a Product's `offers` (an Offer, an array of Offers,
              // or an AggregateOffer carrying `offers`). Never choose between variants: Product and
              // Offers merge only when they agree, and otherwise only the one Offer whose
              // `?variant=` is the served page's own variant may stand for the page.
              const productIdentifiers = product => {
                const own = identifiers(product);
                const offers = collectOffers(product);
                if (offers.length === 0) return own;
                // The page's variant cannot be read, so no Offer may stand for it.
                if (servedVariant === invalid) {
                  variantGroup = true;
                  return own;
                }
                const offerSets = offers.map(identifiers);
                const offerVariants = offers.map(offer => variantOf(offer.url));
                const agree = offerSets.every(set => sameSet(set, offerSets[0]))
                  && !conflicts(own.skus, offerSets[0].skus)
                  && !conflicts(own.gtins, offerSets[0].gtins)
                  && !(servedVariant
                    && offerVariants.some(variant => variant !== null && variant !== servedVariant));
                if (agree) return merge(own, offerSets[0]);
                const served = servedVariant
                  ? offerVariants.flatMap((variant, index) => variant === servedVariant ? [index] : [])
                  : [];
                if (served.length !== 1) {
                  variantGroup = true;
                  return own;
                }
                // Product-level sku/gtin describe the default variant, not the served one.
                return merge(
                  { skus: [], mpns: own.mpns, gtins: [], productIds: own.productIds },
                  offerSets[served[0]]);
              };
              const walk = (value, depth) => {
                if (!value || typeof value !== 'object') return;
                if (depth > 8 || ++visited > 500) { truncated = true; return; }
                if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
                if (hasType(value, 'ProductGroup')) variantGroup = true;
                if (hasType(value, 'Product')) products.push(productIdentifiers(value));
                for (const key of ['@graph', 'hasVariant', 'mainEntity', 'itemListElement', 'item']) {
                  walk(value[key], depth + 1);
                }
              };
              const blocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
              if (blocks.length > 20) truncated = true;
              for (const script of blocks.slice(0, 20)) {
                const raw = script.textContent || '';
                if (raw.length > 524288) { truncated = true; continue; }
                let parsed;
                try { parsed = JSON.parse(raw); } catch { continue; }
                walk(parsed, 0);
              }
              if (products.length > 20) truncated = true;
              return { products: products.slice(0, 20), variantGroup: variantGroup || truncated };
            }
            """#

        /// Fixed and versioned. Page text is treated only as data; it cannot introduce a selector,
        /// script, navigation, click, or form action into the browser executor.
        private static let captureScript = #"""
            (() => {
              const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
              return JSON.stringify({
                url: location.href,
                canonicalUrl: (() => {
                  const raw = document.querySelector('link[rel="canonical"]')?.href;
                  try { return raw ? new URL(raw, location.href).href : null; } catch { return null; }
                })(),
                servedAmazonAsin: (() => {
                  const match = location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
                  return match ? match[1].toUpperCase() : null;
                })(),
                variantMarkers: Array.from(document.querySelectorAll(
                  '#variation_color_name .selection, #variation_size_name .selection, [data-asin][aria-checked="true"], select[name*="variation"] option:checked'
                )).map(node => clean(node.getAttribute('data-asin') || node.textContent)).filter(Boolean).slice(0, 50),
                structuredProducts: (\#(structuredProductsScript))(),
                title: clean(document.title).slice(0, 500),
                text: clean(document.body?.innerText).slice(0, 24576),
                links: Array.from(document.querySelectorAll('a[href]')).slice(0, 200).map(a => ({
                  url: a.href,
                  label: clean(a.innerText || a.getAttribute('aria-label')).slice(0, 300) || null
                })),
                images: Array.from(document.images).slice(0, 200).map(image => {
                  const attributeURLs = [
                    image.getAttribute('data-a-hires'), image.getAttribute('data-old-hires'),
                    image.getAttribute('data-hires'), image.getAttribute('data-zoom-image')
                  ].filter(Boolean);
                  const dynamicURL = (() => {
                    try {
                      const dynamic = JSON.parse(image.getAttribute('data-a-dynamic-image') || '{}');
                      return Object.entries(dynamic).sort((left, right) => {
                        const leftSize = Array.isArray(left[1]) ? left[1][0] * left[1][1] : 0;
                        const rightSize = Array.isArray(right[1]) ? right[1][0] * right[1][1] : 0;
                        return rightSize - leftSize;
                      })[0]?.[0] || null;
                    } catch { return null; }
                  })();
                  return {
                    url: image.currentSrc || image.src,
                    alt: clean(image.alt).slice(0, 500) || null,
                    naturalWidth: image.naturalWidth || null,
                    naturalHeight: image.naturalHeight || null,
                    highResolutionUrl: attributeURLs[0] || dynamicURL
                  };
                }),
                authenticationRequired: Boolean(document.querySelector('input[type="password"]'))
              });
            })();
            """#
    }

    private actor SerializedAppleScriptExecutor {
        private let target: MacBrowserExecutionTarget

        init(target: MacBrowserExecutionTarget) {
            self.target = target
        }

        func execute(_ source: String, action: String, timeoutSeconds: Int = 15) async throws -> String {
            try await target.verifyOwnership()
            // NSAppleScript is synchronous. Keeping it on this dedicated serial executor prevents a
            // slow browser or macOS Automation prompt from freezing SwiftUI and the WebSocket bridge.
            BrowserBridgeDebugLog.emit(.appleEventStarted, messageType: action)
            let target = NSAppleEventDescriptor(bundleIdentifier: self.target.bundleIdentifier)
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

    enum ExecutionFailure: Error, LocalizedError, Sendable {
        case invalidCommand
        case unknownLink
        case browserUnavailable
        case permissionDenied
        case javascriptAutomationDisabled
        case authenticationRequired
        case captureUnavailable
        case uploadFailed
        case clientUpdateRequired
        case executionFailed
        case cancelled

        /// An upload refused by the server's version gate is an outdated app, not a staging
        /// failure: retrying cannot help until the app updates.
        static func uploading(_ error: any Error) -> Self {
            (error as? CubbyAPIError)?.isClientUpdateRequired == true
                ? .clientUpdateRequired : .uploadFailed
        }

        var errorDescription: String? { message }

        var code: BrowserBridgeFailureCode {
            switch self {
            case .invalidCommand: .invalidCommand
            case .unknownLink: .unknownLink
            case .browserUnavailable: .browserUnavailable
            case .permissionDenied, .javascriptAutomationDisabled: .browserPermissionDenied
            case .authenticationRequired: .authenticationRequired
            case .captureUnavailable: .captureUnavailable
            case .uploadFailed: .uploadFailed
            case .clientUpdateRequired: .clientUpdateRequired
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
                .javascriptAutomationDisabled, .clientUpdateRequired,
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
            case .clientUpdateRequired:
                "This Cubby for Mac is too old for the server. Update it; the run resumes when it reconnects."
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

    extension MacBrowserCommandExecutor.FixedCapturePayload.StructuredProducts {
        /// The bounded wire shape; the server proves identifiers from this, never from page text.
        var capture: BrowserStructuredProducts {
            BrowserStructuredProducts(
                products: products.prefix(20).map {
                    BrowserStructuredProduct(
                        skus: Array($0.skus.prefix(10)), mpns: Array($0.mpns.prefix(10)),
                        gtins: Array($0.gtins.prefix(10)), productIds: Array($0.productIds.prefix(10)))
                },
                variantGroup: variantGroup)
        }
    }

#endif
