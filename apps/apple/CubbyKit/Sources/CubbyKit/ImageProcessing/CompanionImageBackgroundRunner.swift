import Foundation

protocol CompanionImageBackgroundTransport: Sendable {
    func pull(hello: ImageProcessingHello, leaseSeconds: Int) async throws
        -> PullCompanionImageProcessingOutput
    func complete(deviceID: String, result: ImageProcessingResult) async throws
    func release(deviceID: String, command: ImageProcessingCommand) async throws
}

extension CubbyClient: CompanionImageBackgroundTransport {
    func pull(hello: ImageProcessingHello, leaseSeconds: Int) async throws
        -> PullCompanionImageProcessingOutput
    {
        try await pullCompanionImageProcessing(.init(hello: hello, leaseSeconds: leaseSeconds))
    }

    func complete(deviceID: String, result: ImageProcessingResult) async throws {
        _ = try await completeCompanionImageProcessing(.init(deviceId: deviceID, result: result))
    }

    func release(deviceID: String, command: ImageProcessingCommand) async throws {
        _ = try await releaseCompanionImageProcessing(
            .init(
                deviceId: deviceID, jobId: command.companionJobID, attemptId: command.companionAttemptID))
    }
}

/// Runs finite HTTP work in a granted charging window. The existing outbox is shared with the
/// foreground socket, so results are durable before either transport tries to send them.
actor CompanionImageBackgroundRunner {
    private let outbox: CompanionResultOutbox<ImageProcessingResult>
    private let execute: @Sendable (ImageProcessingCommand) async -> ImageProcessingResult
    private let failureObserver: CompanionImageWorker.FailureObserver?
    private var isRunning = false

    init(
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        execute: @escaping @Sendable (ImageProcessingCommand) async -> ImageProcessingResult,
        failureObserver: CompanionImageWorker.FailureObserver? = nil
    ) {
        self.outbox = outbox
        self.execute = execute
        self.failureObserver = failureObserver
    }

    /// True means there is resumable work for another window, rather than an unbounded poll.
    func run(
        transport: any CompanionImageBackgroundTransport,
        hello: ImageProcessingHello, maximumJobs: Int = 4
    ) async -> Bool {
        guard !isRunning, hello.participation.automaticWork else { return false }
        isRunning = true
        defer { isRunning = false }
        let end = Date.now.addingTimeInterval(120)
        var activeCommand: ImageProcessingCommand?
        do {
            let pending = try await outbox.pending()
            for entry in pending.prefix(8) {
                try Task.checkCancellation()
                try await transport.complete(deviceID: hello.deviceId, result: entry.result)
                try await outbox.acknowledge(entry.key)
                if Date.now >= end { return true }
            }
            if pending.count > 8 { return true }
            for _ in 0..<maximumJobs {
                try Task.checkCancellation()
                let remaining = Int(end.timeIntervalSinceNow) - 5
                guard remaining >= 20 else { return true }
                let pulled = try await transport.pull(hello: hello, leaseSeconds: min(90, remaining))
                guard let command = pulled.command, !pulled.remotePaused else { return false }
                activeCommand = command
                let result = await execute(command)
                if Task.isCancelled {
                    await releaseAfterCancellation(transport: transport, hello: hello, command: command)
                    return true
                }
                let key = CompanionImageProcessingProtocol.attemptKey(
                    jobID: command.companionJobID, attemptID: command.companionAttemptID)
                try await outbox.record(result, for: key)
                try await transport.complete(deviceID: hello.deviceId, result: result)
                try await outbox.acknowledge(key)
                activeCommand = nil
            }
            return true
        } catch is CancellationError {
            if let activeCommand {
                await releaseAfterCancellation(transport: transport, hello: hello, command: activeCommand)
            }
            return true
        } catch {
            if Task.isCancelled, let activeCommand {
                await releaseAfterCancellation(transport: transport, hello: hello, command: activeCommand)
            } else if !Task.isCancelled {
                failureObserver?(error)
            }
            return true
        }
    }

    private func releaseAfterCancellation(
        transport: any CompanionImageBackgroundTransport,
        hello: ImageProcessingHello, command: ImageProcessingCommand
    ) async {
        // A cleanup task must start uncancelled; its HTTP request is cancelled after three seconds
        // if the remaining system window cannot accommodate the best-effort release.
        let cleanup = Task {
            await withTaskGroup(of: Void.self) { group in
                group.addTask { [failureObserver] in
                    do { try await transport.release(deviceID: hello.deviceId, command: command) } catch {
                        failureObserver?(error)
                    }
                }
                group.addTask { try? await Task.sleep(for: .seconds(3)) }
                await group.next()
                group.cancelAll()
            }
        }
        await cleanup.value
    }
}
