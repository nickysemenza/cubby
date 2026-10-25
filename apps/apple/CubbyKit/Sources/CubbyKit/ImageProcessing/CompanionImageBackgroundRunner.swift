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

    // TODO(unclog integration): once `imageProcessing.renew` is in the image-processing contract,
    // add it to `CLIENT_PASSTHROUGH_METHODS` (apps/web/generator/http-api/native-methods.ts) as
    // `renewCompanionImageProcessing`, run `pnpm generate`, and call that generated method with its
    // generated input/output aliases instead of these wire structs.
    func renew(deviceID: String, claim: CompanionImageCommandClaim) async throws
        -> CompanionLeaseRenewal
    {
        let output: CompanionLeaseRenewalWire = try await request(
            "imageProcessing.renew",
            body: CompanionLeaseRenewalInputWire(
                jobId: claim.jobID, attemptId: claim.attemptID, deviceId: deviceID))
        return try output.renewal()
    }
}

/// `imageProcessing.renew` input: `{ jobId, attemptId, deviceId }`.
private struct CompanionLeaseRenewalInputWire: Encodable, Sendable {
    let jobId: String
    let attemptId: String
    let deviceId: String
}

/// `imageProcessing.renew` output: `{ ok: true, leaseExpiresAt }` or
/// `{ ok: false, reason: "lease_lost" | "job_obsolete" }`. An unknown refusal reason is still a
/// refusal; a body with neither field is a decoding error, never a silent renewal.
struct CompanionLeaseRenewalWire: Decodable, Sendable {
    let ok: Bool
    let leaseExpiresAt: Date?
    let reason: String?

    func renewal() throws -> CompanionLeaseRenewal {
        if ok, let leaseExpiresAt { return .renewed(leaseExpiresAt: leaseExpiresAt) }
        if !ok, let reason { return .refused(reason: reason) }
        throw DecodingError.dataCorrupted(
            .init(
                codingPath: [],
                debugDescription: "imageProcessing.renew returned neither a lease nor a reason"))
    }
}

/// Runs finite HTTP work in a granted charging window. The existing outbox is shared with the
/// foreground socket, so results are durable before either transport tries to send them.
actor CompanionImageBackgroundRunner {
    private let outbox: CompanionResultOutbox<ImageProcessingResult>
    private let execute: @Sendable (ImageProcessingCommand) async throws -> ImageProcessingResult
    private let failureObserver: CompanionImageWorker.FailureObserver?
    private var isRunning = false

    init(
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        execute: @escaping @Sendable (ImageProcessingCommand) async throws -> ImageProcessingResult,
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
                let result = try await execute(command)
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
