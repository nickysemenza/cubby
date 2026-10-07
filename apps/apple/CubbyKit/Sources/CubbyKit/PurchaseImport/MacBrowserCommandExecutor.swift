#if os(macOS)
    import AppKit
    import ApplicationServices
    import CoreGraphics
    import Foundation
    import ImageIO
    import ScreenCaptureKit
    import UniformTypeIdentifiers

    /// A thin browser hand: it opens allowlisted URLs, scrolls, raises or backgrounds its account
    /// window, and captures the trimmed DOM plus an optional screenshot. It never interprets the
    /// page; the server derives every fact from the DOM. Every outcome carries what it observed.
    @MainActor
    public final class MacBrowserCommandExecutor: BrowserCommandExecuting {
        private struct BrowserScreenshot {
            let evidence: BrowserLocalEvidence
            let image: CGImage
        }

        private enum ScreenshotTake {
            case taken(BrowserScreenshot)
            case gap(BrowserScreenshotGap)
        }

        private struct PageSnapshotPayload: Decodable {
            let url: String
            let title: String
            let html: String
        }

        private struct PageProbe: Decodable {
            let url: String
            let title: String
            let readyState: String
        }

        struct WindowState: Equatable {
            let minimized: Bool
            let bounds: CGRect
            let title: String
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
        /// The owned window was re-found by its marker (after a Cubby or browser relaunch).
        private var windowRecovered = false
        private var cancelled: Set<UUID> = []
        /// The raw error behind the current command's failure (AppleScript, upload), for its message.
        private var failureDiagnostic: String?

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

        /// `window.name` survives reloads and same-tab navigation and is readable through Apple
        /// Events, so it identifies the account's window across Cubby and browser relaunches. Cubby
        /// re-asserts it on every probe because some browsers clear it on cross-site navigation.
        var windowMarker: String { "cubby:account:\(accountID)" }

        public func cancel(commandID: UUID) {
            cancelled.insert(commandID)
        }

        public func raiseAuthenticationWindow() {
            Task { [weak self] in
                guard let self else { return }
                do {
                    try await requireOwnedWindow()
                    try await raiseOwnedWindow()
                } catch {
                    BrowserBridgeDebugLog.emit(
                        .windowRaiseFailed, browser: browser, accountID: accountID, error: error)
                }
            }
        }

        /// Minimize only after the server declares the run terminal.
        public func minimizeOwnedWindow() {
            guard let ownedWindowID else { return }
            let script =
                "tell application id \(Self.appleScriptLiteral(targetBundleIdentifier)) to set \(minimizedProperty) of window id \(ownedWindowID) to true"
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
            let clock = ContinuousClock()
            let started = clock.now
            failureDiagnostic = nil
            let result: Result<BrowserPageSnapshot?, any Error>
            do {
                result = .success(try await perform(command))
            } catch {
                result = .failure(error)
            }
            let durationMs = Int(started.duration(to: clock.now) / .milliseconds(1))
            let observation = await observe(durationMs: max(0, durationMs))
            switch result {
            case .success(let snapshot):
                return .completed(snapshot: snapshot, observation: observation)
            case .failure(let error):
                return failedOutcome(error, observation: observation)
            }
        }

        private func failedOutcome(
            _ error: any Error, observation: BrowserObservation
        ) -> BrowserBridgeCommandOutcome {
            switch error {
            case let failure as BrowserBridgeURLPolicy.Failure:
                return .failed(
                    code: .disallowedURL, message: failure.message, retryable: false,
                    observation: observation)
            case let failure as MacBrowserExecutionTarget.Failure:
                return .failed(
                    code: .browserUnavailable, message: failure.localizedDescription, retryable: false,
                    observation: observation)
            case is CancellationError:
                return failedOutcome(ExecutionFailure.cancelled, observation: observation)
            case let failure as ExecutionFailure:
                let message = [failure.message, failureDiagnostic].compactMap(\.self)
                    .joined(separator: " ")
                return .failed(
                    code: failure.code, message: message, retryable: failure.retryable,
                    screenshotGap: failure.screenshotGap, observation: observation)
            default:
                return .failed(
                    code: .executionFailed, message: String(describing: error), retryable: true,
                    observation: observation)
            }
        }

        private func perform(_ command: BrowserBridgeCommand) async throws -> BrowserPageSnapshot? {
            guard command.deadline > .now else { throw ExecutionFailure.deadlineExceeded }
            guard let commandID = command.commandUUID else { throw ExecutionFailure.invalidCommand }
            guard cancelled.remove(commandID) == nil else { throw ExecutionFailure.cancelled }
            try target.verifyOwnership()
            switch command.operation {
            case .navigate(let payload):
                guard let url = URL(string: payload.url) else { throw ExecutionFailure.invalidCommand }
                let validated = try BrowserBridgeURLPolicy.validate(
                    url, allowedHosts: Set(payload.allowedHosts))
                try await navigateOwnedWindow(to: validated)
                return nil
            case .scroll(let payload):
                guard (1...10).contains(payload.pageCount) else { throw ExecutionFailure.invalidCommand }
                try await requireOwnedWindow()
                _ = try await runFixedJavaScript(
                    "window.scrollBy(0, window.innerHeight * \(payload.pageCount)); true;")
                await returnOwnedWindowToBackground()
                return nil
            case .window(let payload):
                try await requireOwnedWindow()
                switch payload.action {
                case .raise: try await raiseOwnedWindow()
                case .background: try await backgroundOwnedWindow()
                }
                return nil
            case .capture(let payload):
                let snapshot = try await capture(payload, command: command)
                await returnOwnedWindowToBackground()
                return snapshot
            }
        }

        // MARK: Owned window

        private var minimizedProperty: String { browser == .safari ? "miniaturized" : "minimized" }

        private var isBrowserRunning: Bool {
            !NSRunningApplication.runningApplications(withBundleIdentifier: targetBundleIdentifier)
                .isEmpty
        }

        /// Never adopts an arbitrary user window: only the one this executor created, or one whose
        /// active tab carries this account's marker.
        @discardableResult
        private func resolveOwnedWindow() async throws -> Bool {
            if let ownedWindowID {
                if isBrowserRunning, try await windowExists(ownedWindowID) { return true }
                forgetOwnedWindow()
            }
            guard isBrowserRunning, let found = try await findMarkedWindow() else { return false }
            ownedWindowID = found
            windowRecovered = true
            BrowserBridgeDebugLog.emit(.windowRecovered, browser: browser, accountID: accountID)
            return true
        }

        private func requireOwnedWindow() async throws {
            guard try await resolveOwnedWindow() else { throw ExecutionFailure.browserUnavailable }
        }

        private func forgetOwnedWindow() {
            ownedWindowID = nil
            ownedCaptureWindowID = nil
            windowRecovered = false
        }

        private func windowExists(_ windowID: Int) async throws -> Bool {
            let script =
                "tell application id \(Self.appleScriptLiteral(targetBundleIdentifier)) to return (exists window id \(windowID)) as text"
            return try await runAppleScript(script, action: "window_exists") == "true"
        }

        private func findMarkedWindow() async throws -> Int? {
            let read =
                switch browser {
                case .chrome: "execute active tab of browserWindow javascript \"window.name\""
                case .safari: "do JavaScript \"window.name\" in current tab of browserWindow"
                }
            let script = """
                tell application id \(Self.appleScriptLiteral(targetBundleIdentifier))
                set output to ""
                repeat with browserWindow in every window
                try
                if (\(read)) is \(Self.appleScriptLiteral(windowMarker)) then set output to output & (id of browserWindow as text) & ","
                end try
                end repeat
                return output
                end tell
                """
            let value = try await runAppleScript(script, action: "find_marked_window", timeoutSeconds: 30)
            return value.split(separator: ",").compactMap { Int($0) }.first
        }

        private func setWindowMarker() async throws {
            _ = try await runFixedJavaScript(
                "window.name = \(Self.javaScriptLiteral(windowMarker)); true;")
        }

        private func navigateOwnedWindow(to url: URL) async throws {
            let foregroundApplicationBeforeBrowserWork = NSWorkspace.shared.frontmostApplication
            let application = Self.appleScriptLiteral(targetBundleIdentifier)
            let target = Self.appleScriptLiteral(url.absoluteString)
            if try await resolveOwnedWindow(), let ownedWindowID {
                let tab = browser == .safari ? "current tab" : "active tab"
                _ = try await runAppleScript(
                    "tell application id \(application) to set URL of \(tab) of window id \(ownedWindowID) to \(target)",
                    action: "navigate")
            } else {
                let windowID: Int
                switch browser {
                case .safari:
                    let script =
                        "tell application id \(application)\nmake new document with properties {URL:\(target)}\nreturn id of front window\nend tell"
                    guard let id = Int(try await runAppleScript(script, action: "navigate")) else {
                        throw ExecutionFailure.browserUnavailable
                    }
                    windowID = id
                case .chrome:
                    windowID = try await createChromeWindow()
                    _ = try await runAppleScript(
                        "tell application id \(application) to set URL of active tab of window id \(windowID) to \(target)",
                        action: "navigate")
                }
                forgetOwnedWindow()
                ownedWindowID = windowID
            }
            // Best effort: the new document may not have committed yet; every probe re-asserts it.
            try? await setWindowMarker()
            await returnOwnedWindowToBackground()
            if let foregroundApplicationBeforeBrowserWork,
                foregroundApplicationBeforeBrowserWork.bundleIdentifier != targetBundleIdentifier
            {
                foregroundApplicationBeforeBrowserWork.activate()
            }
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
            _ = try await runAppleScript(script, action: "create_window_request")
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
            let value = try await runAppleScript(script, action: "list_windows")
            return Set(value.split(separator: ",").compactMap { Int($0) })
        }

        private func raiseOwnedWindow() async throws {
            guard let ownedWindowID else { throw ExecutionFailure.browserUnavailable }
            let script = """
                tell application id \(Self.appleScriptLiteral(targetBundleIdentifier))
                activate
                set visible of window id \(ownedWindowID) to true
                set \(minimizedProperty) of window id \(ownedWindowID) to false
                set index of window id \(ownedWindowID) to 1
                end tell
                """
            _ = try await runAppleScript(script, action: "raise_window")
            try target.verifyOwnership()
            NSRunningApplication.runningApplications(withBundleIdentifier: targetBundleIdentifier).first?
                .activate(options: [.activateAllWindows])
            BrowserBridgeDebugLog.emit(.windowRaised, browser: browser, accountID: accountID)
        }

        /// Keep the owned browser available to ScreenCaptureKit without stealing focus from the
        /// user's current app. A minimized window cannot be captured by the on-screen-only path.
        private func backgroundOwnedWindow() async throws {
            guard let ownedWindowID else { throw ExecutionFailure.browserUnavailable }
            let script = """
                tell application id \(Self.appleScriptLiteral(targetBundleIdentifier))
                set visible of window id \(ownedWindowID) to true
                set \(minimizedProperty) of window id \(ownedWindowID) to false
                set index of window id \(ownedWindowID) to (count of windows)
                end tell
                """
            _ = try await runAppleScript(script, action: "background_window")
            BrowserBridgeDebugLog.emit(.windowBackgrounded, browser: browser, accountID: accountID)
        }

        private func returnOwnedWindowToBackground() async {
            do {
                try await backgroundOwnedWindow()
            } catch {
                BrowserBridgeDebugLog.emit(
                    .windowBackgroundFailed, browser: browser, accountID: accountID, error: error)
            }
        }

        private func windowState(_ windowID: Int) async throws -> WindowState {
            let script = """
                tell application id \(Self.appleScriptLiteral(targetBundleIdentifier))
                set browserWindow to window id \(windowID)
                set b to bounds of browserWindow
                return ((\(minimizedProperty) of browserWindow) as text) & "|" & (item 1 of b as text) & "," & (item 2 of b as text) & "," & (item 3 of b as text) & "," & (item 4 of b as text) & "|" & (name of browserWindow)
                end tell
                """
            let value = try await runAppleScript(script, action: "window_state")
            guard let state = Self.parseWindowState(value) else { throw ExecutionFailure.browserUnavailable }
            return state
        }

        /// `minimized|left,top,right,bottom|title`; AppleScript bounds use the same top-left
        /// global coordinates as ScreenCaptureKit window frames.
        nonisolated static func parseWindowState(_ value: String) -> WindowState? {
            let parts = value.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count == 3 else { return nil }
            let edges = parts[1].split(separator: ",").compactMap { Double($0) }
            guard edges.count == 4 else { return nil }
            return WindowState(
                minimized: parts[0] == "true",
                bounds: CGRect(
                    x: edges[0], y: edges[1], width: edges[2] - edges[0], height: edges[3] - edges[1]),
                title: String(parts[2]))
        }

        /// ScreenCaptureKit uses CGWindowIDs, while browser Apple Events expose a different window
        /// identifier. Re-derive the CGWindowID from the browser's own bounds (and title, to break a
        /// tie) so an adopted window is capturable too. Ambiguity yields nil, never a guess.
        nonisolated static func matchCaptureWindow(
            state: WindowState, candidates: [(id: CGWindowID, frame: CGRect, title: String?)],
            previous: CGWindowID?
        ) -> CGWindowID? {
            let tolerance = 2.0
            let byFrame = candidates.filter {
                abs($0.frame.minX - state.bounds.minX) <= tolerance
                    && abs($0.frame.minY - state.bounds.minY) <= tolerance
                    && abs($0.frame.width - state.bounds.width) <= tolerance
                    && abs($0.frame.height - state.bounds.height) <= tolerance
            }
            if byFrame.count == 1 { return byFrame[0].id }
            if let previous, byFrame.contains(where: { $0.id == previous }) { return previous }
            let byTitle = byFrame.filter { $0.title == state.title }
            return byTitle.count == 1 ? byTitle[0].id : nil
        }

        private func captureWindow(state: WindowState) async throws -> SCWindow? {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
            let bundleIdentifier = targetBundleIdentifier
            let windows = content.windows.filter {
                $0.owningApplication?.bundleIdentifier == bundleIdentifier && $0.windowLayer == 0
            }
            guard
                let id = Self.matchCaptureWindow(
                    state: state, candidates: windows.map { ($0.windowID, $0.frame, $0.title) },
                    previous: ownedCaptureWindowID)
            else {
                BrowserBridgeDebugLog.emit(
                    .captureWindowCorrelationFailed, browser: browser, count: windows.count)
                return nil
            }
            ownedCaptureWindowID = id
            return windows.first { $0.windowID == id }
        }

        // MARK: Capture

        private func capture(
            _ payload: BrowserBridgeOperationCapture, command: BrowserBridgeCommand
        ) async throws -> BrowserPageSnapshot {
            let allowedHosts = Set(payload.allowedHosts)
            let recoveryURL = try payload.recoveryURL.map { raw in
                guard let url = URL(string: raw) else { throw ExecutionFailure.invalidCommand }
                return try BrowserBridgeURLPolicy.validate(url, allowedHosts: allowedHosts)
            }
            if try await resolveOwnedWindow() {
                // Never reload an owned window already at the target: a replayed capture would
                // otherwise become a refresh loop.
                if let recoveryURL {
                    let current = try? await probePage()
                    if BrowserCaptureNavigationPolicy.shouldNavigate(
                        currentURL: current.flatMap { URL(string: $0.url) }, targetURL: recoveryURL)
                    {
                        try await navigateOwnedWindow(to: recoveryURL)
                    }
                }
            } else {
                guard let recoveryURL else { throw ExecutionFailure.browserUnavailable }
                try await navigateOwnedWindow(to: recoveryURL)
            }
            try await waitForPageReady(targetURL: recoveryURL)
            let raw = try await runFixedJavaScript(Self.snapshotScript)
            try Task.checkCancellation()
            guard let page = try? JSONDecoder().decode(PageSnapshotPayload.self, from: Data(raw.utf8)),
                let sourceURL = URL(string: page.url)
            else { throw ExecutionFailure.pageUnreadable }
            _ = try BrowserBridgeURLPolicy.validate(sourceURL, allowedHosts: allowedHosts)
            let dom = try BrowserDOMEncoding.encode(html: page.html)
            guard let commandID = command.commandUUID, cancelled.remove(commandID) == nil else {
                throw ExecutionFailure.cancelled
            }
            let attempt =
                payload.screenshot == .skip
                ? nil
                : try await screenshotAttempt(
                    command: command,
                    scope: payload.evidenceScope.map {
                        BrowserEvidenceUploadScope(runID: $0.runId, targetID: $0.targetId)
                    })
            let screenshot = try BrowserScreenshotPolicy.resolve(
                mode: payload.screenshot, attempt: attempt)
            return BrowserPageSnapshot(
                sourceURL: page.url, title: String(page.title.prefix(500)), capturedAt: .now, dom: dom,
                screenshot: screenshot.payload)
        }

        private func screenshotAttempt(
            command: BrowserBridgeCommand, scope: BrowserEvidenceUploadScope?
        ) async throws -> BrowserScreenshotAttempt {
            BrowserBridgeDebugLog.emit(.visualCaptureStarted, command: command)
            let screenshot: BrowserScreenshot
            switch await takeScreenshot() {
            case .taken(let value): screenshot = value
            case .gap(let gap):
                BrowserBridgeDebugLog.emit(
                    .visualCaptureFailed, command: command, messageType: gap.rawValue)
                return .gap(gap)
            }
            defer { try? FileManager.default.removeItem(at: screenshot.evidence.url) }
            let rendered: BrowserLocalEvidence
            do {
                rendered = try RenderedBrowserEvidencePDF.makeFile(from: screenshot.image)
            } catch {
                BrowserBridgeDebugLog.emit(.visualCaptureFailed, command: command, error: error)
                return .gap(.captureFailed)
            }
            defer { try? FileManager.default.removeItem(at: rendered.url) }
            do {
                var references: [BrowserEvidenceReference] = []
                for evidence in [screenshot.evidence, rendered] {
                    references.append(
                        try await evidenceUploader.upload(evidence, runID: command.runID, scope: scope))
                }
                BrowserBridgeDebugLog.emit(.visualCaptureFinished, command: command)
                return .captured(references)
            } catch {
                BrowserBridgeDebugLog.emit(.visualCaptureFailed, command: command, error: error)
                let failure = ExecutionFailure.uploading(error)
                if failure == .clientUpdateRequired { throw failure }
                failureDiagnostic = String(describing: error)
                return .gap(.uploadFailed)
            }
        }

        private func takeScreenshot() async -> ScreenshotTake {
            guard CGPreflightScreenCaptureAccess() else { return .gap(.screenRecordingDenied) }
            guard let ownedWindowID, let state = try? await windowState(ownedWindowID) else {
                return .gap(.windowNotFound)
            }
            if state.minimized { return .gap(.windowMinimized) }
            let window: SCWindow
            do {
                guard let found = try await captureWindow(state: state) else {
                    return .gap(.windowNotFound)
                }
                window = found
            } catch {
                return .gap(.captureFailed)
            }
            guard window.isOnScreen else { return .gap(.windowOffScreen) }
            do {
                return .taken(try await screenshot(of: window))
            } catch {
                return .gap(.captureFailed)
            }
        }

        private func screenshot(of window: SCWindow) async throws -> BrowserScreenshot {
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
            else { throw ExecutionFailure.executionFailed }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { throw ExecutionFailure.executionFailed }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
                "CubbyBrowserEvidence", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("browser-view-\(UUID().uuidString).png")
            try (data as Data).write(to: url, options: .atomic)
            return BrowserScreenshot(
                evidence: BrowserLocalEvidence(
                    url: url, kind: .screenshot, checksum: (data as Data).sha256Hex,
                    contentType: "image/png"),
                image: image)
        }

        /// Setting a tab URL returns before the new document loads; a navigation still in flight
        /// after the wait is an unreadable page, which the server may retry.
        private func waitForPageReady(targetURL: URL?) async throws {
            var lastURL: String?
            var stableProbes = 0
            for _ in 0..<40 {
                try Task.checkCancellation()
                do {
                    let probe = try await probePage()
                    stableProbes =
                        probe.readyState == "complete" && probe.url == lastURL ? stableProbes + 1 : 0
                    lastURL = probe.url
                    if BrowserCaptureNavigationPolicy.isReady(
                        currentURL: URL(string: probe.url), targetURL: targetURL,
                        documentReadyState: probe.readyState, stableProbes: stableProbes)
                    {
                        return
                    }
                } catch ExecutionFailure.executionFailed, ExecutionFailure.pageUnreadable {
                    stableProbes = 0
                }
                try await Task.sleep(for: .milliseconds(250))
            }
            throw ExecutionFailure.pageUnreadable
        }

        // MARK: Observation

        private func probePage() async throws -> PageProbe {
            let raw = try await runFixedJavaScript(Self.probeScript(marker: windowMarker))
            guard let probe = try? JSONDecoder().decode(PageProbe.self, from: Data(raw.utf8)) else {
                throw ExecutionFailure.pageUnreadable
            }
            return probe
        }

        /// Read-only apart from re-asserting the marker; it never launches a quit browser.
        private func observe(durationMs: Int) async -> BrowserObservation {
            let screenRecording: BrowserObservation.ScreenRecordingPayload =
                CGPreflightScreenCaptureAccess() ? .granted : .denied
            guard let ownedWindowID, isBrowserRunning,
                let state = try? await windowState(ownedWindowID)
            else {
                return BrowserObservation(
                    window: nil, screenRecording: screenRecording, durationMs: durationMs)
            }
            let probe = try? await probePage()
            var onScreen: Bool?
            if state.minimized {
                onScreen = false
            } else if screenRecording == .granted, let window = try? await captureWindow(state: state) {
                onScreen = window.isOnScreen
            }
            let url = probe.flatMap { URL(string: $0.url)?.scheme == nil ? nil : $0.url }
            return BrowserObservation(
                url: url, title: probe.map { String($0.title.prefix(500)) },
                readyState: probe.flatMap {
                    BrowserObservation.ReadyStatePayload(rawValue: $0.readyState)
                },
                window: .init(recovered: windowRecovered, minimized: state.minimized, onScreen: onScreen),
                screenRecording: screenRecording, durationMs: durationMs)
        }

        // MARK: Apple Events

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
            return try await runAppleScript(script, action: "fixed_javascript")
        }

        private func runAppleScript(
            _ script: String, action: String, timeoutSeconds: Int = 15
        ) async throws -> String {
            do {
                return try await appleScript.execute(
                    script, action: action, timeoutSeconds: timeoutSeconds)
            } catch let error as AppleScriptFailure {
                failureDiagnostic = error.diagnostic
                throw error.failure
            }
        }

        private static func appleScriptLiteral(_ value: String) -> String {
            "\""
                + value.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"") + "\""
        }

        private static func javaScriptLiteral(_ value: String) -> String {
            let data = (try? JSONEncoder().encode(value)) ?? Data("\"\"".utf8)
            return String(decoding: data, as: UTF8.self)
        }

        static func probeScript(marker: String) -> String {
            let marker = javaScriptLiteral(marker)
            return """
                (() => {
                  if (window.name !== \(marker)) window.name = \(marker);
                  return JSON.stringify({ url: location.href, title: document.title, readyState: document.readyState });
                })();
                """
        }

        /// Fixed, with no page-derived input. Trims what the server never reads (scripts other
        /// than ld+json, styles, SVG, frames, comments) and every form value, so typed text and
        /// credentials never leave the Mac; password inputs keep their `type` for sign-in detection.
        static let snapshotScript = #"""
            (() => {
              const root = document.documentElement.cloneNode(true);
              root.querySelectorAll(
                'script:not([type="application/ld+json" i]), style, svg, noscript, template, iframe, link[rel~="stylesheet" i], link[rel~="preload" i]'
              ).forEach(node => node.remove());
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
              const comments = [];
              while (walker.nextNode()) comments.push(walker.currentNode);
              comments.forEach(node => node.remove());
              root.querySelectorAll(
                'input:not([type="submit" i]):not([type="button" i]):not([type="reset" i]):not([type="image" i])'
              ).forEach(input => input.removeAttribute('value'));
              root.querySelectorAll('textarea').forEach(area => { area.textContent = ''; });
              return JSON.stringify({
                url: location.href,
                title: document.title,
                readyState: document.readyState,
                html: '<!doctype html>' + root.outerHTML
              });
            })();
            """#
    }

    /// An Apple Event failure: the bridge code it maps to plus the raw AppleScript error.
    struct AppleScriptFailure: Error {
        let failure: ExecutionFailure
        let diagnostic: String?
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
                throw AppleScriptFailure(
                    failure: .permissionDenied,
                    diagnostic: "AEDeterminePermissionToAutomateTarget returned \(permission).")
            }
            guard permission == noErr else {
                throw AppleScriptFailure(
                    failure: .browserUnavailable,
                    diagnostic: "AEDeterminePermissionToAutomateTarget returned \(permission).")
            }
            let bounded = "with timeout of \(timeoutSeconds) seconds\n\(source)\nend timeout"
            guard let script = NSAppleScript(source: bounded) else {
                throw ExecutionFailure.invalidCommand
            }
            var details: NSDictionary?
            let result = script.executeAndReturnError(&details)
            if let details {
                let number = details[NSAppleScript.errorNumber] as? Int
                let message = details[NSAppleScript.errorMessage] as? String
                let failure = ExecutionFailure.appleScript(errorNumber: number, message: message)
                BrowserBridgeDebugLog.emit(
                    failure == .executionFailed ? .appleEventFailed : .appleEventRejected,
                    messageType: action, errorCode: number)
                throw AppleScriptFailure(
                    failure: failure,
                    diagnostic:
                        "AppleScript \(action) error \(number.map(String.init) ?? "?"): "
                        + (message ?? "no message"))
            }
            BrowserBridgeDebugLog.emit(.appleEventFinished, messageType: action)
            return result.stringValue ?? String(result.int32Value)
        }
    }

    extension BrowserBridgeURLPolicy.Failure {
        fileprivate var message: String {
            switch self {
            case .httpsRequired: "Only HTTPS browser URLs are allowed."
            case .credentialsForbidden: "Browser URLs cannot contain credentials."
            case .hostMissing: "The browser URL has no host."
            case .hostNotAllowed: "The browser URL is outside the Vendor allowlist."
            case .fragmentForbidden: "Browser URL fragments are not allowed."
            }
        }
    }
#endif
