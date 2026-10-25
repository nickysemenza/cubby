import Foundation

protocol CompanionImageBackgroundTransport: Sendable {
    func deviceBacklog() async throws -> DeviceBacklogBanner?
    func pull(hello: ImageProcessingHello, leaseSeconds: Int, maxCommands: Int) async throws
        -> PullCompanionImageProcessingOutput
    func complete(deviceID: String, result: ImageProcessingResult) async throws
    /// Hands a claim back; the server does not count a release as an attempt.
    func release(deviceID: String, claim: CompanionImageCommandClaim) async throws
    /// Extends a live claim's lease through `imageProcessing.renew`.
    func renew(deviceID: String, claim: CompanionImageCommandClaim) async throws
        -> CompanionLeaseRenewal
}

extension CompanionImageBackgroundTransport {
    func deviceBacklog() async throws -> DeviceBacklogBanner? { nil }

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
    func deviceBacklog() async throws -> DeviceBacklogBanner? {
        try await DeviceBacklogBanner.load(client: self)
    }

    func pull(hello: ImageProcessingHello, leaseSeconds: Int, maxCommands: Int) async throws
        -> PullCompanionImageProcessingOutput
    {
        try await pullCompanionImageProcessing(
            .init(hello: hello, maxCommands: maxCommands, leaseSeconds: leaseSeconds))
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
/// mid-command releases its unrecorded claims instead of holding long leases.
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

    /// A system-granted window. Pull only into free slots and keep results durable independently
    /// of delivery. The task's cancellation releases both executing and just-returned claims.
    @discardableResult
    func run(
        transport: any CompanionImageBackgroundTransport,
        hello: ImageProcessingHello, maximumJobs: Int = .max,
        maximumConcurrentCommands: @escaping @Sendable () async -> Int = { 1 },
        activity: (@Sendable (_ processed: Int, _ running: Int) async -> Void)? = nil
    ) async -> CompanionBackgroundOutcome {
        guard !isRunning, hello.participation.automaticWork else { return .settled }
        isRunning = true
        defer { isRunning = false }
        return await withTaskGroup(of: (CompanionBackgroundOutcome, Bool, Bool).self) { group in
            var active = 0
            var accepted = 0
            var processed = 0
            var resultsRemain = false
            var exhausted = false
            var stopped = false
            var updateError: (any Error)?
            do {
                switch try await delivery.deliverDue(
                    transport: transport, deviceID: hello.deviceId, limit: 8)
                {
                case .delivered: break
                case .setAside: resultsRemain = true
                case .updateRequired(let error): return .updateRequired(error)
                }
                repeat {
                    try Task.checkCancellation()
                    let slots = CompanionImageConcurrency.slots(for: await maximumConcurrentCommands())
                    if !stopped, !exhausted, accepted < maximumJobs, active < slots {
                        let pulled = try await transport.pull(
                            hello: hello,
                            leaseSeconds: CompanionImageProcessingProtocol.residentLeaseSeconds,
                            maxCommands: min(slots - active, maximumJobs - accepted))
                        exhausted = pulled.commands.isEmpty
                        for command in pulled.commands {
                            if Task.isCancelled || pulled.remotePaused {
                                let outcome = await released(
                                    command, transport: transport, hello: hello, or: .resumable)
                                if case .updateRequired(let error) = outcome { updateError = error }
                                stopped = true
                                continue
                            }
                            accepted += 1
                            active += 1
                            group.addTask {
                                await self.process(command, transport: transport, hello: hello)
                            }
                        }
                        await activity?(processed, active)
                        if Task.isCancelled { throw CancellationError() }
                        if pulled.remotePaused { stopped = true }
                    }
                    if active > 0, let (outcome, stopPulling, recorded) = await group.next() {
                        stopped = stopped || stopPulling
                        active -= 1
                        if recorded { processed += 1 }
                        switch outcome {
                        case .settled:
                            break
                        case .resumable:
                            resultsRemain = true
                        case .updateRequired(let error):
                            updateError = error
                            stopped = true
                            group.cancelAll()
                        }
                        await activity?(processed, active)
                        // A completion frees a slot; probe again even if the previous pull was empty.
                        if !stopped { exhausted = false }
                    }
                } while active > 0 || (!exhausted && !stopped && accepted < maximumJobs)
            } catch {
                stopped = true
                group.cancelAll()
                if CompanionResultDelivery.isClientUpdateRequired(error) {
                    updateError = error
                } else if !(error is CancellationError) {
                    failureObserver?(error)
                }
            }
            // Cancellation-aware executions release before this system task reports completion.
            for await (outcome, _, _) in group {
                if case .updateRequired(let error) = outcome { updateError = error }
            }
            if let updateError { return .updateRequired(updateError) }
            return stopped || resultsRemain || !exhausted ? .resumable : .settled
        }
    }

    private func process(
        _ command: ImageProcessingCommand, transport: any CompanionImageBackgroundTransport,
        hello: ImageProcessingHello
    ) async -> (CompanionBackgroundOutcome, Bool, Bool) {
        // A released or refused lease is not a completed image. Count only durable results.
        var recorded = false
        do {
            try Task.checkCancellation()
            let metadata = try CompanionImageCommandMetadata(command)
            guard
                let result = try await executeRenewing(
                    command, metadata: metadata, transport: transport, deviceID: hello.deviceId)
            else { return (.settled, false, false) }
            try Task.checkCancellation()
            let key = CompanionImageProcessingProtocol.attemptKey(
                jobID: metadata.jobID, attemptID: metadata.attemptID)
            try await outbox.record(result, for: key)
            recorded = true
            let delivered = await delivery.deliver(
                result, key: key, transport: transport, deviceID: hello.deviceId)
            if case .updateRequired(let error) = delivered { return (.updateRequired(error), true, recorded) }
            try Task.checkCancellation()
            switch delivered {
            case .delivered: return (.settled, false, recorded)
            case .setAside: return (.resumable, false, recorded)
            case .updateRequired(let error): return (.updateRequired(error), true, recorded)
            }
        } catch {
            if CompanionResultDelivery.isClientUpdateRequired(error) {
                return (.updateRequired(error), true, recorded)
            }
            if !(error is CancellationError) { failureObserver?(error) }
            return (
                await released(command, transport: transport, hello: hello, or: .resumable), true, recorded
            )
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
