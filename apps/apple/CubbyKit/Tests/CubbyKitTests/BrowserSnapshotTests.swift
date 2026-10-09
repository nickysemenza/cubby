import CoreGraphics
import Foundation
import Testing

@testable import CubbyKit

@Suite("Browser bridge snapshot and outcome mapping")
struct BrowserSnapshotTests {
    // MARK: DOM encoding

    @Test("A DOM snapshot inflates back to the exact UTF-8 bytes it describes")
    func domRoundTrip() throws {
        let html =
            "<!doctype html><html><head><title>Example Seeds · Orders</title></head><body><p>Café crème — ✓</p></body></html>"
        let dom = try BrowserDOMEncoding.encode(html: html)

        let bytes = Data(html.utf8)
        #expect(dom.encoding == .deflateRawBase64)
        #expect(!dom.truncated)
        #expect(dom.byteSize == bytes.count)
        #expect(dom.sha256 == bytes.sha256Hex)
        #expect(try Self.inflate(dom.data) == bytes)
    }

    @Test("An oversized DOM keeps its head, cuts on a UTF-8 boundary, and fits the limit")
    func domTruncation() throws {
        // Incompressible, multi-byte text so the encoded form is larger than the limit.
        var generator = SyntheticGenerator(seed: 7)
        let alphabet = Array("abcdefghijklmnopqrstuvwxyzé✓漢字🌱0123456789")
        let body = String((0..<40_000).map { _ in alphabet[generator.next(below: alphabet.count)] })
        let html = "<!doctype html><html><body>" + body + "</body></html>"
        let limit = 20_000

        let dom = try BrowserDOMEncoding.encode(html: html, maximumEncodedCharacters: limit)

        #expect(dom.truncated)
        #expect(dom.data.count <= limit)
        let inflated = try Self.inflate(dom.data)
        #expect(inflated.count == dom.byteSize)
        #expect(inflated.sha256Hex == dom.sha256)
        let text = try #require(String(data: inflated, encoding: .utf8))
        #expect(html.hasPrefix(text))
        #expect(text.hasPrefix("<!doctype html><html><body>"))
    }

    @Test("An empty document is not a snapshot")
    func emptyDOM() {
        #expect(throws: ExecutionFailure.self) { try BrowserDOMEncoding.encode(html: "") }
    }

    // MARK: Screenshot modes

    private static let reference = BrowserEvidenceReference(
        id: "IMG-4K7M", kind: .screenshot, checksum: String(repeating: "a", count: 64),
        contentType: "image/png")

    @Test("skip never takes a screenshot, whatever the window state")
    func skipMode() throws {
        #expect(try BrowserScreenshotPolicy.resolve(mode: .skip, attempt: nil) == .skipped)
        #expect(
            try BrowserScreenshotPolicy.resolve(mode: .skip, attempt: .gap(.windowMinimized))
                == .skipped)
    }

    @Test("preferred returns the DOM with the precise gap when no screenshot is possible")
    func preferredMode() throws {
        #expect(
            try BrowserScreenshotPolicy.resolve(
                mode: .preferred, attempt: .captured([Self.reference]))
                == .captured([Self.reference]))
        for gap in BrowserScreenshotGap.allCases {
            #expect(
                try BrowserScreenshotPolicy.resolve(mode: .preferred, attempt: .gap(gap))
                    == .unavailable(gap))
        }
    }

    @Test("required fails retryably with screenshot_unavailable and the gap")
    func requiredMode() throws {
        #expect(
            try BrowserScreenshotPolicy.resolve(
                mode: .required, attempt: .captured([Self.reference]))
                == .captured([Self.reference]))
        do {
            _ = try BrowserScreenshotPolicy.resolve(mode: .required, attempt: .gap(.windowOffScreen))
            Issue.record("A required screenshot gap must fail the capture.")
        } catch {
            #expect(error.code == .screenshotUnavailable)
            #expect(error.screenshotGap == .windowOffScreen)
            #expect(error.retryable)
        }
        do {
            _ = try BrowserScreenshotPolicy.resolve(mode: .required, attempt: .gap(.uploadFailed))
            Issue.record("A required screenshot whose upload failed must fail the capture.")
        } catch {
            #expect(error.code == .uploadFailed)
            #expect(error.screenshotGap == .uploadFailed)
            #expect(error.retryable)
        }
    }

    @Test("The wire screenshot status follows the resolution")
    func screenshotWireStatus() throws {
        let unavailable = BrowserScreenshotResolution.unavailable(.screenRecordingDenied).payload
        let data = try JSONEncoder().encode(unavailable)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["status"] as? String == "unavailable")
        #expect(object["reason"] as? String == "screen_recording_denied")
    }

    // MARK: Failure codes

    @Test("Apple Event errors map to precise, correctly retryable failure codes")
    func appleScriptFailureMapping() {
        let javascriptOff = ExecutionFailure.appleScript(
            errorNumber: 12,
            message:
                "Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, "
                + "go to View > Developer > Allow JavaScript from Apple Events.")
        #expect(javascriptOff.code == .javascriptDisabled)
        #expect(!javascriptOff.retryable)

        let safariOff = ExecutionFailure.appleScript(
            errorNumber: 8,
            message:
                "You must enable the 'Allow JavaScript from Apple Events' option in Safari's Develop menu "
                + "to use 'do JavaScript'.")
        #expect(safariOff.code == .javascriptDisabled)

        let denied = ExecutionFailure.appleScript(errorNumber: -1743, message: nil)
        #expect(denied.code == .browserPermissionDenied)

        let missingWindow = ExecutionFailure.appleScript(errorNumber: -1728, message: nil)
        #expect(missingWindow.code == .browserUnavailable)
        #expect(missingWindow.retryable)

        let other = ExecutionFailure.appleScript(errorNumber: -2700, message: "Unknown error")
        #expect(other.code == .executionFailed)
    }

    @Test("Unreadable pages are retryable; invalid commands and cancellation are not")
    func failureRetryability() {
        #expect(ExecutionFailure.pageUnreadable.code == .pageUnreadable)
        #expect(ExecutionFailure.pageUnreadable.retryable)
        #expect(!ExecutionFailure.invalidCommand.retryable)
        #expect(!ExecutionFailure.cancelled.retryable)
        #expect(ExecutionFailure.deadlineExceeded.code == .deadlineExceeded)
        #expect(ExecutionFailure.pageUnreadable.screenshotGap == nil)
    }

    // MARK: Wire nulls

    @Test("A result carries explicit nulls for every nullable key the server requires")
    func resultEncodesExplicitNulls() throws {
        let result = BrowserBridgeCommandResult(
            commandID: UUID(uuidString: "66666666-6666-4666-8666-666666666666")!, runID: "RUN-EXAMPLE",
            operationID: "operation-example", completedAt: Date(timeIntervalSince1970: 100),
            outcome: .completed(
                snapshot: nil,
                observation: BrowserObservation(
                    window: .init(recovered: true), screenRecording: .denied, durationMs: 12)))
        let data = try BrowserBridgeWire.encode(.result(result))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let outcome = try #require((object["result"] as? [String: Any])?["outcome"] as? [String: Any])
        #expect(outcome["snapshot"] is NSNull)
        let observation = try #require(outcome["observation"] as? [String: Any])
        #expect(observation["url"] is NSNull)
        #expect(observation["title"] is NSNull)
        #expect(observation["readyState"] is NSNull)
        let window = try #require(observation["window"] as? [String: Any])
        #expect(window["recovered"] as? Bool == true)
        #expect(window["minimized"] is NSNull)
        #expect(window["onScreen"] is NSNull)

        let failed = BrowserBridgeCommandResult(
            commandID: UUID(uuidString: "77777777-7777-4777-8777-777777777777")!, runID: "RUN-EXAMPLE",
            operationID: "operation-example", completedAt: Date(timeIntervalSince1970: 100),
            outcome: .failed(
                code: .pageUnreadable, message: "unreadable", retryable: true,
                observation: .unobserved))
        let failedData = try BrowserBridgeWire.encode(.result(failed))
        let failedObject = try #require(
            JSONSerialization.jsonObject(with: failedData) as? [String: Any])
        let failedOutcome = try #require(
            (failedObject["result"] as? [String: Any])?["outcome"] as? [String: Any])
        #expect(failedOutcome["screenshotGap"] is NSNull)
        #expect((failedOutcome["observation"] as? [String: Any])?["window"] is NSNull)
    }

    // MARK: Status line

    @Test("The account status line names the operation and what the Mac saw")
    func commandSummary() throws {
        let navigate = BrowserBridgeCommandSummary.line(
            operation: .navigate(
                url: try #require(URL(string: "https://seeds.example.test/orders")),
                allowedHosts: ["seeds.example.test"]),
            outcome: .completed(
                snapshot: nil,
                observation: BrowserObservation(
                    url: "https://seeds.example.test/orders?page=2", title: "Orders",
                    readyState: .complete, window: .init(recovered: false, minimized: false),
                    screenRecording: .granted, durationMs: 40)))
        #expect(navigate == "navigate · seeds.example.test/orders · complete")

        let captureFailed = BrowserBridgeCommandSummary.line(
            operation: .read(
                BrowserBridgeOperationRead(
                    _type: .read, allowedHosts: ["seeds.example.test"], screenshot: .required)),
            outcome: .failed(
                code: .screenshotUnavailable, message: "", retryable: true,
                screenshotGap: .windowMinimized, observation: .unobserved))
        #expect(captureFailed == "read · window minimized → screenshot unavailable")

        let raise = BrowserBridgeCommandSummary.line(
            operation: .window(.init(_type: .window, action: .raise)),
            outcome: .failed(
                code: .javascriptDisabled, message: "", retryable: false, observation: .unobserved))
        #expect(raise == "window raise · failed: JavaScript from Apple Events is off")
    }

    // MARK: Window identity

    #if os(macOS)
        @Test("An adopted window's capture ID comes from its bounds, then its title, never a guess")
        func captureWindowMatching() throws {
            let state = try #require(
                MacBrowserCommandExecutor.parseWindowState("false|100,50,1300,850|Orders | Example Seeds"))
            #expect(state.title == "Orders | Example Seeds")
            #expect(state.bounds == CGRect(x: 100, y: 50, width: 1200, height: 800))

            let account = (
                id: CGWindowID(41), frame: CGRect(x: 100.5, y: 50, width: 1200, height: 800),
                title: String?("Orders | Example Seeds")
            )
            let other = (
                id: CGWindowID(42), frame: CGRect(x: 0, y: 0, width: 900, height: 700),
                title: String?("Mail")
            )
            let twin = (
                id: CGWindowID(43), frame: CGRect(x: 100, y: 50, width: 1200, height: 800),
                title: String?("Notes")
            )

            #expect(
                MacBrowserCommandExecutor.matchCaptureWindow(
                    state: state, candidates: [account, other], previous: nil) == 41)
            #expect(
                MacBrowserCommandExecutor.matchCaptureWindow(
                    state: state, candidates: [account, twin, other], previous: nil) == 41)
            #expect(
                MacBrowserCommandExecutor.matchCaptureWindow(
                    state: state, candidates: [other], previous: nil) == nil)

            let untitled = (id: CGWindowID(44), frame: account.frame, title: String?.none)
            #expect(
                MacBrowserCommandExecutor.matchCaptureWindow(
                    state: state, candidates: [untitled, twin], previous: nil) == nil)
            #expect(
                MacBrowserCommandExecutor.matchCaptureWindow(
                    state: state, candidates: [untitled, twin], previous: 44) == 44)
        }

        @Test("A malformed window-state reply is no window, not a zero-sized one")
        func malformedWindowState() {
            #expect(MacBrowserCommandExecutor.parseWindowState("true|1,2,3|t") == nil)
            #expect(MacBrowserCommandExecutor.parseWindowState("missing value") == nil)
            #expect(MacBrowserCommandExecutor.parseWindowState("true|0,0,10,10|")?.minimized == true)
        }
    #endif

    // MARK: Helpers

    private static func inflate(_ base64: String) throws -> Data {
        let compressed = try #require(Data(base64Encoded: base64))
        return try (compressed as NSData).decompressed(using: .zlib) as Data
    }

    /// Deterministic so a truncation failure reproduces.
    private struct SyntheticGenerator {
        var state: UInt64
        init(seed: UInt64) { state = seed }
        mutating func next(below bound: Int) -> Int {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((state >> 33) % UInt64(bound))
        }
    }
}
