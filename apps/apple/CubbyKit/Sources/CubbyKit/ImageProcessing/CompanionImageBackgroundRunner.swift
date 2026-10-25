import Foundation

protocol CompanionImageBackgroundTransport: Sendable {
    func pull(hello: ImageProcessingHello, leaseSeconds: Int) async throws
        -> PullCompanionImageProcessingOutput
    func complete(deviceID: String, result: ImageProcessingResult) async throws
    /// Hands a claim back; the server does not count a release as an attempt.
    func release(deviceID: String, claim: CompanionImageCommandClaim) async throws
    /// Extends a live claim's lease through `imageProcessing.renew`.
    func renew(deviceID: String, claim: CompanionImageCommandClaim) async throws
        -> CompanionLeaseRenewal
}

extension CompanionImageBackgroundTransport {
    func release(deviceID: String, command: ImageProcessingCommand) async throws {
        guard let claim = CompanionImageCommandClaim(command) else {
            throw UnsupportedNativeResponse(
                context: "image-processing command without a claim",
                raw: try JSONValue(encoding: command))
        }
        try await release(deviceID: deviceID, claim: claim)
    }
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

    func release(deviceID: String, claim: CompanionImageCommandClaim) async throws {
        _ = try await releaseCompanionImageProcessing(
            .init(deviceId: deviceID, jobId: claim.jobID, attemptId: claim.attemptID))
    }

    func renew(deviceID: String, claim: CompanionImageCommandClaim) async throws
        -> CompanionLeaseRenewal
    {
        try CompanionLeaseRenewal(
            await renewCompanionImageProcessing(
                .init(deviceId: deviceID, jobId: claim.jobID, attemptId: claim.attemptID)))
    }
}

extension CompanionLeaseRenewal {
    /// An unknown refusal reason is still a refusal; an answer with neither shape is unsupported,
    /// never a silent renewal.
    init(_ output: RenewCompanionImageProcessingOutput) throws {
        switch output {
        case .value1(let renewed): self = .renewed(leaseExpiresAt: renewed.leaseExpiresAt)
        case .value2(let refused): self = .refused(reason: refused.reason.rawValue)
        case .unrecognized(let raw):
            throw UnsupportedNativeResponse(context: "imageProcessing.renew answer", raw: raw)
        }
    }
}

/// Runs finite HTTP work in a granted charging window. The existing outbox is shared with the
/// foreground socket, so results are durable before either transport tries to send them. Claims
/// use the resident worker's 60 s lease and the same `heartbeatInterval` renewals, so a window
/// that ends mid-command loses at most one lease rather than holding a long claim.
actor CompanionImageBackgroundRunner {
    private let outbox: CompanionResultOutbox<ImageProcessingResult>
    private let execute: @Sendable (ImageProcessingCommand) async throws -> ImageProcessingResult
    private let failureObserver: CompanionImageWorker.FailureObserver?
    /// Waits between lease renewals; tests replace the clock with a gate.
    private let heartbeatPause: @Sendable () async throws -> Void
    private var isRunning = false

    init(
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        execute: @escaping @Sendable (ImageProcessingCommand) async throws -> ImageProcessingResult,
        failureObserver: CompanionImageWorker.FailureObserver? = nil,
        heartbeatPause: (@Sendable () async throws -> Void)? = nil
    ) {
        self.outbox = outbox
        self.execute = execute
        self.failureObserver = failureObserver
        self.heartbeatPause =
            heartbeatPause ?? {
                try await Task.sleep(for: CompanionImageProcessingProtocol.heartbeatInterval)
            }
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
                let pulled = try await transport.pull(
                    hello: hello, leaseSeconds: CompanionImageProcessingProtocol.residentLeaseSeconds)
                guard let command = pulled.command else { return false }
                guard !pulled.remotePaused else {
                    await releaseClaim(transport: transport, hello: hello, command: command)
                    return false
                }
                let metadata: CompanionImageCommandMetadata
                do { metadata = try CompanionImageCommandMetadata(command) } catch {
                    // Unsupported by this build: hand it back and leave the rest for a later window.
                    await releaseClaim(transport: transport, hello: hello, command: command)
                    failureObserver?(error)
                    return false
                }
                activeCommand = command
                guard
                    let result = try await executeRenewing(
                        command, metadata: metadata, transport: transport, deviceID: hello.deviceId)
                else {
                    // The server retired or reassigned this attempt: nothing to record or release.
                    activeCommand = nil
                    continue
                }
                if Task.isCancelled {
                    await releaseClaim(transport: transport, hello: hello, command: command)
                    return true
                }
                let key = CompanionImageProcessingProtocol.attemptKey(
                    jobID: metadata.jobID, attemptID: metadata.attemptID)
                try await outbox.record(result, for: key)
                try await transport.complete(deviceID: hello.deviceId, result: result)
                try await outbox.acknowledge(key)
                activeCommand = nil
            }
            return true
        } catch is CancellationError {
            if let activeCommand {
                await releaseClaim(transport: transport, hello: hello, command: activeCommand)
            }
            return true
        } catch {
            if Task.isCancelled, let activeCommand {
                await releaseClaim(transport: transport, hello: hello, command: activeCommand)
            } else if !Task.isCancelled {
                failureObserver?(error)
            }
            return true
        }
    }

    private enum Finished: Sendable {
        case executed(ImageProcessingResult)
        case refused
    }

    /// Executes `command` while renewing its lease every `heartbeatInterval`; the executor's
    /// deadline moves with each renewal. `nil` means a renewal was refused and the command was
    /// stopped. A failed renewal request keeps working until the lease deadline it already has.
    private func executeRenewing(
        _ command: ImageProcessingCommand, metadata: CompanionImageCommandMetadata,
        transport: any CompanionImageBackgroundTransport, deviceID: String
    ) async throws -> ImageProcessingResult? {
        let lease = CompanionCommandLease(deadline: metadata.deadline)
        let claim = CompanionImageCommandClaim(jobID: metadata.jobID, attemptID: metadata.attemptID)
        let execute = self.execute
        let pause = heartbeatPause
        let failureObserver = self.failureObserver
        return try await withThrowingTaskGroup(of: Finished.self) { group in
            group.addTask {
                .executed(
                    try await CompanionCommandLease.$current.withValue(lease) {
                        try await execute(command)
                    })
            }
            group.addTask {
                while true {
                    try await pause()
                    do {
                        switch try await transport.renew(deviceID: deviceID, claim: claim) {
                        case .renewed(let leaseExpiresAt): lease.extend(to: leaseExpiresAt)
                        case .refused(let reason):
                            failureObserver?(CompanionLeaseRefused(jobID: claim.jobID, reason: reason))
                            return .refused
                        }
                    } catch is CancellationError {
                        throw CancellationError()
                    } catch {
                        failureObserver?(error)
                    }
                }
            }
            // The first child to finish decides; the other is cancelled and its outcome ignored.
            defer { group.cancelAll() }
            switch try await group.next() {
            case .executed(let result): return result
            case .refused, nil: return nil
            }
        }
    }

    private func releaseClaim(
        transport: any CompanionImageBackgroundTransport,
        hello: ImageProcessingHello, command: ImageProcessingCommand
    ) async {
        guard let claim = CompanionImageCommandClaim(command) else { return }
        await CompanionClaimRelease.bestEffort(
            transport: transport, deviceID: hello.deviceId, claim: claim,
            failureObserver: failureObserver)
    }
}
