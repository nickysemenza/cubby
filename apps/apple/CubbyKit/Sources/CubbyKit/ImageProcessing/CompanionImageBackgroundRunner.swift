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

/// How a charging window ended, for the worker that owns it.
enum CompanionBackgroundOutcome: Sendable {
    /// Nothing claimable now.
    case settled
    /// Work (a claim, or a recorded result) is left for another window.
    case resumable
    /// The server refused this build (426 CLIENT_UPDATE_REQUIRED). Execution stopped, no claim was
    /// released (every write is refused the same way), and recorded results stay on disk.
    case updateRequired(any Error)
}

/// Runs finite HTTP work in a granted charging window. The existing outbox is shared with the
/// foreground socket, so results are durable before either transport tries to send them, and
/// both deliver through the one `CompanionResultDelivery` backoff. Claims use the resident
/// worker's 60 s lease and the same `heartbeatInterval` renewals, so a window that ends
/// mid-command loses at most one lease rather than holding a long claim.
actor CompanionImageBackgroundRunner {
    private let outbox: CompanionResultOutbox<ImageProcessingResult>
    private let delivery: CompanionResultDelivery
    private let execute: @Sendable (ImageProcessingCommand) async throws -> ImageProcessingResult
    private let failureObserver: CompanionImageWorker.FailureObserver?
    /// Waits between lease renewals; tests replace the clock with a gate.
    private let heartbeatPause: @Sendable () async throws -> Void
    private var isRunning = false

    init(
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        delivery: CompanionResultDelivery? = nil,
        execute: @escaping @Sendable (ImageProcessingCommand) async throws -> ImageProcessingResult,
        failureObserver: CompanionImageWorker.FailureObserver? = nil,
        heartbeatPause: (@Sendable () async throws -> Void)? = nil
    ) {
        self.outbox = outbox
        self.delivery =
            delivery ?? CompanionResultDelivery(outbox: outbox, failureObserver: failureObserver)
        self.execute = execute
        self.failureObserver = failureObserver
        self.heartbeatPause =
            heartbeatPause ?? {
                try await Task.sleep(for: CompanionImageProcessingProtocol.heartbeatInterval)
            }
    }

    /// One bounded window: due results first (a set-aside one never blocks the rest or the pulls),
    /// then up to `maximumJobs` claims.
    @discardableResult
    func run(
        transport: any CompanionImageBackgroundTransport,
        hello: ImageProcessingHello, maximumJobs: Int = 4
    ) async -> CompanionBackgroundOutcome {
        guard !isRunning, hello.participation.automaticWork else { return .settled }
        isRunning = true
        defer { isRunning = false }
        let end = Date.now.addingTimeInterval(120)
        var activeCommand: ImageProcessingCommand?
        var resultsRemain = false
        do {
            switch try await delivery.deliverDue(
                transport: transport, deviceID: hello.deviceId, limit: 8)
            {
            case .delivered: break
            case .setAside: resultsRemain = true
            case .updateRequired(let error): return .updateRequired(error)
            }
            if Date.now >= end { return .resumable }
            for _ in 0..<maximumJobs {
                try Task.checkCancellation()
                let remaining = Int(end.timeIntervalSinceNow) - 5
                guard remaining >= 20 else { return .resumable }
                let pulled = try await transport.pull(
                    hello: hello, leaseSeconds: CompanionImageProcessingProtocol.residentLeaseSeconds)
                guard let command = pulled.command else {
                    return resultsRemain ? .resumable : .settled
                }
                guard !pulled.remotePaused else {
                    return await released(command, transport: transport, hello: hello, or: .settled)
                }
                let metadata: CompanionImageCommandMetadata
                do { metadata = try CompanionImageCommandMetadata(command) } catch {
                    // Unsupported by this build: hand it back and leave the rest for a later window.
                    failureObserver?(error)
                    return await released(command, transport: transport, hello: hello, or: .settled)
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
                    return await released(
                        command, transport: transport, hello: hello, or: .resumable)
                }
                let key = CompanionImageProcessingProtocol.attemptKey(
                    jobID: metadata.jobID, attemptID: metadata.attemptID)
                try await outbox.record(result, for: key)
                let delivered = await delivery.deliver(
                    result, key: key, transport: transport, deviceID: hello.deviceId)
                // Before cancellation: a window ending as the server refuses this build still
                // latches the worker, keeps the recorded result, and releases nothing.
                if case .updateRequired(let error) = delivered { return .updateRequired(error) }
                if Task.isCancelled {
                    return await released(
                        command, transport: transport, hello: hello, or: .resumable)
                }
                activeCommand = nil
                if case .setAside = delivered { resultsRemain = true }
            }
            return .resumable
        } catch is CancellationError {
            guard let activeCommand else { return .resumable }
            return await released(activeCommand, transport: transport, hello: hello, or: .resumable)
        } catch {
            if CompanionResultDelivery.isClientUpdateRequired(error) { return .updateRequired(error) }
            if Task.isCancelled, let activeCommand {
                return await released(
                    activeCommand, transport: transport, hello: hello, or: .resumable)
            } else if !Task.isCancelled {
                failureObserver?(error)
            }
            return .resumable
        }
    }

    private enum Finished: Sendable {
        case executed(ImageProcessingResult)
        case refused
    }

    /// Executes `command` while renewing its lease every `heartbeatInterval`; the executor's
    /// deadline moves with each renewal. `nil` means a renewal was refused and the command was
    /// stopped. A failed renewal request keeps working until the lease deadline it already has,
    /// except a 426, which throws and cancels execution.
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
                    } catch let error where CompanionResultDelivery.isClientUpdateRequired(error) {
                        throw error
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

    /// Hands `command`'s claim back, then ends the window with `outcome`, unless the release was
    /// refused for this build's version.
    private func released(
        _ command: ImageProcessingCommand, transport: any CompanionImageBackgroundTransport,
        hello: ImageProcessingHello, or outcome: CompanionBackgroundOutcome
    ) async -> CompanionBackgroundOutcome {
        guard let claim = CompanionImageCommandClaim(command) else { return outcome }
        if let refusal = await CompanionClaimRelease.bestEffort(
            transport: transport, deviceID: hello.deviceId, claim: claim,
            failureObserver: failureObserver)
        {
            return .updateRequired(refusal)
        }
        return outcome
    }
}
