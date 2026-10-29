import Foundation

/// The one delivery policy for recorded image-processing results, shared by the resident worker
/// and the iOS charging window. A failed send sets that result aside with its own capped
/// backoff — it stays on disk — so one undeliverable result never blocks later deliveries or
/// pulls. A 426 CLIENT_UPDATE_REQUIRED stops delivery and keeps every result for the updated
/// build.
actor CompanionResultDelivery {
    enum Outcome: Sendable {
        case delivered
        /// A result stays recorded: its send failed, it is waiting out its backoff, or the batch
        /// limit left it for the next pass.
        case setAside
        /// The server refuses writes from this build.
        case updateRequired(any Error)
    }

    /// What Activity shows about set-aside results, and when the next one is due.
    struct Snapshot: Sendable, Equatable {
        var undelivered = 0
        var completedCount = 0
        var latestError: String?
        var nextAttemptAt: ContinuousClock.Instant?
    }

    private struct SetAside {
        var failures: Int
        var nextAttemptAt: ContinuousClock.Instant
        var error: String
    }

    private let outbox: CompanionResultOutbox<ImageProcessingResult>
    private let failureObserver: CompanionImageWorker.FailureObserver?
    /// The backoff clock; tests advance it by hand.
    private let now: @Sendable () -> ContinuousClock.Instant
    private var setAside: [String: SetAside] = [:]
    private var latestErrorKey: String?
    private var inFlight: Set<String> = []
    private var cachedSnapshot = Snapshot()

    init(
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        failureObserver: CompanionImageWorker.FailureObserver?,
        now: @escaping @Sendable () -> ContinuousClock.Instant = { .now }
    ) {
        self.outbox = outbox
        self.failureObserver = failureObserver
        self.now = now
    }

    var snapshot: Snapshot {
        cachedSnapshot
    }

    /// Use the delivery clock for both backoff and eligibility; a caller's clock can disagree
    /// with an injected clock and repeatedly schedule batches that cannot send anything.
    var hasDueResults: Bool {
        guard let next = cachedSnapshot.nextAttemptAt else { return false }
        return next <= now()
    }

    /// Includes recorded results that have not yet had a delivery attempt.
    @discardableResult
    func refreshSnapshot() async -> Snapshot {
        guard let pending = try? await outbox.pending() else { return cachedSnapshot }
        let keys = Set(pending.map(\.key))
        setAside = setAside.filter { keys.contains($0.key) }
        if let key = latestErrorKey, setAside[key] == nil { latestErrorKey = setAside.keys.first }
        let now = self.now()
        cachedSnapshot = .init(
            undelivered: pending.count,
            completedCount: cachedSnapshot.completedCount,
            latestError: latestErrorKey.flatMap { setAside[$0]?.error },
            nextAttemptAt: pending.compactMap { entry in
                guard !inFlight.contains(entry.key) else { return nil }
                return max(setAside[entry.key]?.nextAttemptAt ?? now, now)
            }.min())
        return cachedSnapshot
    }

    /// Sends up to `limit` recorded results that are due, skipping those still backing off, in
    /// the outbox's durable replay order (never attempted, then least recently attempted).
    func deliverDue(
        transport: any CompanionImageBackgroundTransport, deviceID: String, limit: Int = 8
    ) async throws -> Outcome {
        let pending = try await outbox.pending()
        await refreshSnapshot()
        let now = self.now()
        var attempted = 0
        var outcome = Outcome.delivered
        for entry in pending {
            if inFlight.contains(entry.key) {
                outcome = .setAside
                continue
            }
            if let held = setAside[entry.key], held.nextAttemptAt > now {
                outcome = .setAside
                continue
            }
            guard attempted < limit else {
                await refreshSnapshot()
                return .setAside
            }
            try Task.checkCancellation()
            attempted += 1
            switch await deliver(
                entry.result, key: entry.key, transport: transport, deviceID: deviceID)
            {
            case .delivered: break
            case .setAside: outcome = .setAside
            case .updateRequired(let error):
                await refreshSnapshot()
                return .updateRequired(error)
            }
        }
        await refreshSnapshot()
        return outcome
    }

    /// One delivery attempt; never throws, so a caller's remaining work continues. A cancelled
    /// send keeps the result without counting a failure.
    func deliver(
        _ result: ImageProcessingResult, key: String,
        transport: any CompanionImageBackgroundTransport, deviceID: String
    ) async -> Outcome {
        guard inFlight.insert(key).inserted else { return .setAside }
        let outcome: Outcome
        do {
            // A concurrent delivery may have acknowledged an entry after a replay pass read it.
            guard try await outbox.result(for: key) != nil else {
                inFlight.remove(key)
                await refreshSnapshot()
                return .delivered
            }
            // Rotation must survive a relaunch, or the same rejected results lead every window;
            // the order is advisory, so a failed write never blocks the send.
            try? await outbox.markAttempted(key)
            let adopted = try await transport.complete(deviceID: deviceID, result: Self.normalized(result))
            try await outbox.acknowledge(key)
            if adopted, case .completed = result.outcome { cachedSnapshot.completedCount += 1 }
            setAside[key] = nil
            outcome = .delivered
        } catch {
            if Self.isClientUpdateRequired(error) {
                outcome = .updateRequired(error)
            } else if error is CancellationError || Task.isCancelled {
                outcome = .setAside
            } else {
                let failures = (setAside[key]?.failures ?? 0) + 1
                let attemptedAt = now()
                setAside[key] = SetAside(
                    failures: failures, nextAttemptAt: attemptedAt + Self.retryDelay(failures: failures),
                    error: (error as? LocalizedError)?.errorDescription ?? String(describing: error))
                latestErrorKey = key
                if !AuthenticatedSocketSupport.isExpectedReconnectFailure(error) {
                    failureObserver?(error)
                }
                outcome = .setAside
            }
        }
        inFlight.remove(key)
        await refreshSnapshot()
        return outcome
    }

    /// Generated claims are optional evidence. Empty model output is not a claim and the server
    /// rejects it; normalize the outgoing copy so already-recorded results can replay too.
    private static func normalized(_ result: ImageProcessingResult) -> ImageProcessingResult {
        guard case .completed(.describeImage(var description)) = result.outcome else { return result }
        description.description.claims = description.description.claims.compactMap { claim in
            var claim = claim
            claim.text = claim.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return claim.text.isEmpty ? nil : claim
        }
        var result = result
        result.outcome = .completed(.describeImage(description))
        return result
    }

    /// Capped exponential backoff for one set-aside result: 2 s, 4 s, … up to 15 minutes.
    static func retryDelay(failures: Int) -> Duration {
        .seconds(min(900, 1 << min(max(1, failures), 10)))
    }

    static func isClientUpdateRequired(_ error: any Error) -> Bool {
        (error as? CubbyAPIError)?.isClientUpdateRequired == true
    }
}
