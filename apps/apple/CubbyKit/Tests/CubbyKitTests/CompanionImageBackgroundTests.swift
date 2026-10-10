import Foundation
import Testing

@testable import CubbyKit

// A completed result survives a failed HTTP send; cancellation releases the assigned capability
// instead of writing a failed result that can consume the next background window's work.
@Suite("Companion image background window")
struct CompanionImageBackgroundTests {
    private func command() throws -> ImageProcessingCommand {
        let value = """
            {"kind":"describe_image","jobId":"00000000-0000-4000-8000-000000000001","attemptId":"00000000-0000-4000-8000-000000000002","deadline":"2099-01-01T00:00:00Z","source":{"url":"https://example.test/panel.jpg","sha256":"\(String(repeating: "a", count: 64))","contentType":"image/jpeg"},"promptRevision":1,"resultSchemaRevision":1}
            """
        return try JSONDecoder.companionImageProcessing.decode(
            ImageProcessingCommand.self, from: Data(value.utf8))
    }
    private func hello() -> ImageProcessingHello {
        guard
            case .hello(let value) = ImageProcessingClientMessage.companionHello(
                deviceID: UUID(), deviceName: "Synthetic phone", foreground: false,
                imageDescriptionAvailable: true, automaticWork: true)
        else { preconditionFailure("Expected hello") }
        return value
    }
    private func outboxFile() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "companion-background-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("outbox.json")
    }
    @Test func replayAcknowledgesWithoutRepeatingExecution() async throws {
        let command = try command()
        let transport = BackgroundTransportFixture(commands: [command], failFirstCompletion: true)
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let executions = BackgroundExecutionFixture()
        let runner = CompanionImageBackgroundRunner(
            outbox: outbox,
            execute: { command in
                await executions.complete(command)
            })
        await runner.run(transport: transport, hello: hello(), maximumJobs: 1)
        #expect(try await outbox.pending().count == 1)
        let restored = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        let replayRunner = CompanionImageBackgroundRunner(
            outbox: restored,
            execute: { command in
                await executions.complete(command)
            })
        await replayRunner.run(transport: transport, hello: hello(), maximumJobs: 1)
        #expect(try await restored.pending().isEmpty)
        #expect(await executions.count == 1)
        #expect(await transport.completionCount == 2)
    }
    @Test func cancellationReleasesAndKeepsTheOutboxEmpty() async throws {
        let command = try command()
        let transport = BackgroundTransportFixture(commands: [command])
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let execution = Gate()
        let runner = CompanionImageBackgroundRunner(
            outbox: outbox,
            execute: { command in
                // Cancellation is the fixture's stop signal.
                try? await execution.pass()
                return await BackgroundExecutionFixture().complete(command)
            })
        let task = Task { await runner.run(transport: transport, hello: hello(), maximumJobs: 1) }
        await execution.arrivals(1)
        task.cancel()
        await task.value
        #expect(await transport.releaseCount == 1)
        #expect(try await outbox.pending().isEmpty)
    }

    @Test func signOutWaitsForCancelledBackgroundCleanupBeforeDiscardingResults() async throws {
        let command = try command()
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let result = await BackgroundExecutionFixture().complete(command)
        try await outbox.record(result, for: "synthetic-pending")
        let credentials = CredentialProvider(host: "example.test", store: InMemorySessionTokenStore())
        let worker = CompanionImageWorker(
            baseURL: URL(string: "https://example.test")!, credentials: credentials,
            deviceID: UUID(), deviceName: "Synthetic phone", foreground: false, outbox: outbox)
        let transport = SignOutCleanupFixture()
        let completed = SignOutCompletionFixture()
        await worker.start()
        let hello = hello()
        let run = Task { await worker.runInBackground(transport: transport, hello: hello) }
        await transport.started.arrivals(1)
        let signOut = Task {
            try await worker.stopAndDiscardPendingResults()
            await completed.markFinished()
        }
        await transport.cancelled.arrivals(1)
        #expect(!(await completed.finished))
        #expect(try await outbox.pending().count == 1)
        await transport.finishCleanup()
        try await signOut.value
        _ = await run.value
        #expect(await completed.finished)
        #expect(try await outbox.pending().isEmpty)
    }

    @Test func cancellationDuringCompletionReleasesAndRetainsDurableResult() async throws {
        let command = try command()
        let transport = BackgroundTransportFixture(commands: [command], waitDuringCompletion: true)
        let fileURL = try outboxFile()
        let outbox = CompanionResultOutbox<ImageProcessingResult>(fileURL: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let runner = CompanionImageBackgroundRunner(
            outbox: outbox, execute: { command in await BackgroundExecutionFixture().complete(command) })
        let task = Task { await runner.run(transport: transport, hello: hello(), maximumJobs: 1) }
        await transport.completion.arrivals(1)
        #expect(await transport.completionCount == 1)
        task.cancel()
        _ = await task.value
        #expect(await transport.releaseCount == 1)
        #expect(try await outbox.pending().count == 1)
    }
}

private actor SignOutCompletionFixture {
    private(set) var finished = false
    func markFinished() { finished = true }
}

private actor SignOutCleanupFixture: CompanionImageBackgroundTransport {
    let started = Gate()
    let cancelled = Gate()
    private var cleanup: CheckedContinuation<Void, Never>?
    func pull(hello: ImageProcessingHello, leaseSeconds: Int) async throws
        -> PullCompanionImageProcessingOutput
    {
        .init(command: nil, remotePaused: false)
    }
    func complete(deviceID: String, result: ImageProcessingResult) async throws {
        do { try await started.pass() } catch {
            cancelled.signal()
            await withCheckedContinuation { cleanup = $0 }
            throw CancellationError()
        }
    }
    func release(deviceID: String, command: ImageProcessingCommand) async throws {}
    func finishCleanup() { cleanup?.resume(); cleanup = nil }
}

private actor BackgroundTransportFixture: CompanionImageBackgroundTransport {
    enum Failure: Error { case network }
    var commands: [ImageProcessingCommand]
    var failFirstCompletion: Bool
    var waitDuringCompletion: Bool
    private(set) var completionCount = 0
    private(set) var releaseCount = 0
    /// Holds a completion while `waitDuringCompletion`; it ends only by cancellation.
    let completion = Gate()
    init(
        commands: [ImageProcessingCommand], failFirstCompletion: Bool = false,
        waitDuringCompletion: Bool = false
    ) {
        self.commands = commands
        self.failFirstCompletion = failFirstCompletion
        self.waitDuringCompletion = waitDuringCompletion
    }
    func pull(hello: ImageProcessingHello, leaseSeconds: Int) async throws
        -> PullCompanionImageProcessingOutput
    {
        .init(command: commands.isEmpty ? nil : commands.removeFirst(), remotePaused: false)
    }
    func complete(deviceID: String, result: ImageProcessingResult) async throws {
        completionCount += 1
        if waitDuringCompletion { try await completion.pass() }
        if failFirstCompletion { failFirstCompletion = false; throw Failure.network }
    }
    func release(deviceID: String, command: ImageProcessingCommand) async throws { releaseCount += 1 }
}

private actor BackgroundExecutionFixture {
    private(set) var count = 0
    func complete(_ command: ImageProcessingCommand) -> ImageProcessingResult {
        count += 1
        return .init(
            jobId: command.companionJobID, attemptId: command.companionAttemptID,
            completedAt: .now,
            outcome: .init(
                value3: .init(
                    kind: .describeImage,
                    status: .failed, retryable: true, reason: "Synthetic failure")))
    }
}
