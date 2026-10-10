import CoreGraphics
import Foundation
import Testing

@testable import CubbyKit

struct BrowserBridgeRetirementTests {
    @Test(
        "Undecodable replay preserves its bytes and retirement identities instead of starting an empty ledger"
    )
    func unknownReplayRemainsInspectable() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("replay.json")
        let original = Data(
            """
            {"completed":{"synthetic-command":"unreadable historical result"},"retiredRuns":{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]}}
            """.utf8)
        try original.write(to: url)
        await #expect(throws: DecodingError.self) {
            try await FileBrowserBridgeReplayStore(fileURL: url).load()
        }
        #expect(FileManager.default.fileExists(atPath: url.path))
        if FileManager.default.fileExists(atPath: url.path) {
            #expect(try Data(contentsOf: url) == original)
        }
    }

    @Test("Retry prepares replay only after capture erasure succeeds, keeping the original ledger on failure")
    @MainActor
    func retryErasureBeforePersistingFence() async throws {
        let runID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("captures")
        try Data("Synthetic invalid staging root".utf8).write(to: root)
        let original = BrowserBridgeReplayLedger(completed: ["synthetic-result": Self.result(runID: runID)])
        let store = FileBrowserBridgeReplayStore(fileURL: directory.appendingPathComponent("replay.json"))
        try await store.save(original)
        var retired = original
        retired.forget(runID: runID, retirementID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
        let executor = CaptureCleanupExecutor(directory: root)
        await #expect(throws: (any Error).self) {
            try await retired.prepareForReplay(store: store, executor: executor)
        }
        #expect(try await store.load() == original)
        try FileManager.default.removeItem(at: root)
        let staging = try BrowserCaptureFileStore(rootDirectory: root).captureDirectory(
            runID: runID, commandID: UUID())
        try Data("Synthetic interrupted capture".utf8).write(
            to: staging.appendingPathComponent("capture.png"))
        try await retired.prepareForReplay(store: store, executor: executor)
        #expect(!FileManager.default.fileExists(atPath: staging.path))
        #expect(try await store.load() == retired)
        try await retired.prepareForReplay(store: store, executor: executor)
        #expect(executor.erasedRuns == [runID, runID, runID])
        #expect(try await store.load() == retired)
    }

    @Test("Run-owned captures survive interruption and cold erasure preserves other Runs and files")
    func interruptedCapturesHaveOwners() async throws {
        let runID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let otherRunID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let userFile = directory.appendingPathComponent("synthetic-chosen-photo.png")
        let otherBytes = Data("Synthetic bytes that must remain".utf8)
        try otherBytes.write(to: userFile)
        let root = directory.appendingPathComponent("captures")
        let cache = BrowserCaptureFileStore(rootDirectory: root)
        let first = try cache.captureDirectory(runID: runID, commandID: UUID())
        let other = try cache.captureDirectory(runID: otherRunID, commandID: UUID())
        try Data("Synthetic PNG staging bytes".utf8).write(to: first.appendingPathComponent("capture.png"))
        try otherBytes.write(to: other.appendingPathComponent("capture.png"))
        let context = try #require(
            CGContext(
                data: nil, width: 2, height: 2, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        )
        let image = try #require(context.makeImage())
        let pdf = try RenderedBrowserEvidencePDF.makeFile(
            from: image, to: first.appendingPathComponent("rendered.pdf"))
        #expect(try Data(contentsOf: pdf.url).sha256Hex == pdf.checksum)

        // A new instance has no memory of the interrupted writes.
        let coldCache = BrowserCaptureFileStore(rootDirectory: root)
        try await coldCache.forget(runID: runID)
        try await coldCache.forget(runID: runID)
        #expect(!FileManager.default.fileExists(atPath: first.path))
        #expect(try Data(contentsOf: other.appendingPathComponent("capture.png")) == otherBytes)
        #expect(try Data(contentsOf: userFile) == otherBytes)
        #expect(throws: (any Error).self) {
            try coldCache.captureDirectory(runID: "../synthetic-chosen-photo.png", commandID: UUID())
        }
    }

    @Test("Failed cold capture cleanup prevents reconnect and preserves its pending retirement")
    @MainActor
    func failedColdCleanupStopsReconnect() async throws {
        let runID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let brokenRoot = directory.appendingPathComponent("captures")
        try Data("Synthetic unreadable capture root".utf8).write(to: brokenRoot)
        var ledger = BrowserBridgeReplayLedger()
        let receiptID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        ledger.forget(runID: runID, retirementID: receiptID)
        let store = FileBrowserBridgeReplayStore(fileURL: directory.appendingPathComponent("replay.json"))
        try await store.save(ledger)
        let executor = CaptureCleanupExecutor(directory: brokenRoot)
        let bridge = URLSessionBrowserBridge(replayStore: store, executor: executor)
        await bridge.connect(
            .init(
                url: URL(string: "ws://127.0.0.1:9/synthetic-browser")!,
                bearerToken: "synthetic-token", deviceID: UUID(), browser: .chrome,
                capabilities: .current))
        let status = await bridge.currentStatus()
        guard case .failed(let message) = status else {
            Issue.record("Failed file erasure started a browser connection: \(status)")
            await bridge.disconnect()
            return
        }
        #expect(message.contains(brokenRoot.path))
        #expect(try await store.load().retiredRuns[runID] == [receiptID])
        #expect(FileManager.default.fileExists(atPath: brokenRoot.path))
        await bridge.disconnect()
    }

    @Test("Cold reconnect removes retired Run capture files before replaying cleanup acknowledgements")
    @MainActor
    func coldReconnectErasesCaptures() async throws {
        let runID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let otherRunID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let retiredDirectory = directory.appendingPathComponent(runID)
        let otherDirectory = directory.appendingPathComponent(otherRunID)
        for folder in [retiredDirectory, otherDirectory] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data("Synthetic disposable captured page".utf8).write(
                to: folder.appendingPathComponent("capture.png"))
        }
        var ledger = BrowserBridgeReplayLedger()
        ledger.forget(runID: runID, retirementID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
        let store = FileBrowserBridgeReplayStore(fileURL: directory.appendingPathComponent("replay.json"))
        try await store.save(ledger)
        let executor = CaptureCleanupExecutor(directory: directory)
        let bridge = URLSessionBrowserBridge(replayStore: store, executor: executor)
        await bridge.connect(
            .init(
                url: URL(string: "ws://127.0.0.1:9/synthetic-browser")!,
                bearerToken: "synthetic-token", deviceID: UUID(), browser: .chrome,
                capabilities: .current))
        #expect(executor.erasedRuns == [runID])
        #expect(!FileManager.default.fileExists(atPath: retiredDirectory.path))
        #expect(
            FileManager.default.fileExists(atPath: otherDirectory.appendingPathComponent("capture.png").path))
        await bridge.disconnect()
    }

    @Test("Retiring a Run cancels and joins only its commands, including a late dispatch")
    func retirementJoinsCommands() async {
        let runID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let otherRunID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        let commandID = UUID().uuidString.lowercased()
        let otherCommandID = UUID().uuidString.lowercased()
        var registry = BrowserBridgeCommandTaskRegistry()
        let started = registry.claim(commandID, runID: runID)
        let otherStarted = registry.claim(otherCommandID, runID: otherRunID)
        #expect(started && otherStarted)
        let task = Task<Void, Never> { _ = try? await Task.sleep(for: .seconds(60)) }
        let otherTask = Task<Void, Never> { _ = try? await Task.sleep(for: .seconds(60)) }
        registry.attach(task, to: commandID)
        registry.attach(otherTask, to: otherCommandID)
        let cancelled = registry.cancelRun(runID)
        #expect(cancelled.map(\.commandID) == [commandID])
        for pending in cancelled { await pending.task.value }
        #expect(task.isCancelled)
        #expect(!otherTask.isCancelled)
        let lateClaim = registry.claim(UUID().uuidString.lowercased(), runID: runID)
        #expect(!lateClaim)
        registry.cancelAll()
        await otherTask.value
    }

    @Test("Retirement removes one Run's replay bytes and survives a cold file reload")
    func retirementSurvivesReload() async throws {
        let runID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let otherRunID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        let receiptID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        let result = Self.result(runID: runID)
        let otherResult = Self.result(runID: otherRunID)
        var ledger = BrowserBridgeReplayLedger()
        ledger.record(result)
        ledger.record(otherResult)
        _ = ledger.recordRunCompletion(Self.completion(runID: runID))
        _ = ledger.recordRunCompletion(Self.completion(runID: otherRunID))
        let interrupted = BrowserBridgeCommand(
            id: UUID(), runID: runID, operationID: "synthetic-interrupted-action",
            deadline: .distantFuture,
            operation: .click(
                .init(
                    _type: .click, observationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                    ref: "synthetic-control", allowedHosts: ["shop.example.test"])))
        ledger.beginInteractive(interrupted)

        ledger.forget(runID: runID, retirementID: receiptID)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("replay.json")
        let store = FileBrowserBridgeReplayStore(fileURL: url)
        try await store.save(ledger)
        var reloaded = try await FileBrowserBridgeReplayStore(fileURL: url).load()

        #expect(reloaded.resultsForReplay == [otherResult])
        #expect(reloaded.runCompletionsForAcknowledgement == [Self.completion(runID: otherRunID)])
        #expect(reloaded.interruptedResult(for: interrupted.id) == nil)
        #expect(reloaded.retiredRuns[runID] == [receiptID])
        reloaded.record(result)
        reloaded.beginInteractive(interrupted)
        let restoredNotification = reloaded.recordRunCompletion(Self.completion(runID: runID))
        #expect(!restoredNotification)
        #expect(reloaded.replayResult(for: result.commandID) == nil)
        #expect(reloaded.interruptedResult(for: interrupted.id) == nil)
    }

    @Test("Independent cleanup receipts retain their acknowledgements without restoring source bytes")
    func multipleRetirementReceipts() throws {
        let runID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let first = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        let second = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        var ledger = BrowserBridgeReplayLedger()
        ledger.forget(runID: runID, retirementID: first)
        ledger.forget(runID: runID, retirementID: second)
        ledger.forget(runID: runID, retirementID: first)
        let reloaded = try JSONDecoder.browserBridge.decode(
            BrowserBridgeReplayLedger.self, from: JSONEncoder.browserBridge.encode(ledger))
        #expect(reloaded.retiredRuns[runID] == [first, second])
        #expect(reloaded.resultsForReplay.isEmpty)
    }

    private static func result(runID: String) -> BrowserBridgeCommandResult {
        BrowserBridgeCommandResult(
            commandID: UUID(), runID: runID, operationID: "synthetic-capture",
            completedAt: Date(timeIntervalSince1970: 100),
            outcome: .failed(
                code: .pageUnreadable, message: "Synthetic disposable source content",
                retryable: false, observation: .unobserved))
    }

    private static func completion(runID: String) -> BrowserBridgeRunCompletion {
        BrowserBridgeRunCompletion(
            runID: runID, terminalStatus: .completed, imported: 0, updated: 0,
            skipped: 1, findingCount: 0)
    }
}

@MainActor
private final class CaptureCleanupExecutor: BrowserCommandExecuting {
    private let directory: URL
    private(set) var erasedRuns: [String] = []

    init(directory: URL) { self.directory = directory }

    func execute(_ command: BrowserBridgeCommand) async -> BrowserBridgeCommandOutcome {
        .failed(
            code: .pageUnreadable, message: "Synthetic cleanup fixture does not execute browser actions",
            retryable: false, observation: .unobserved)
    }

    func cancel(commandID: UUID) {}
    func raiseAuthenticationWindow(isCurrent: @escaping @MainActor () -> Bool) {}

    func forget(runID: String) async throws {
        erasedRuns.append(runID)
        try await BrowserCaptureFileStore(rootDirectory: directory).forget(runID: runID)
    }
}
