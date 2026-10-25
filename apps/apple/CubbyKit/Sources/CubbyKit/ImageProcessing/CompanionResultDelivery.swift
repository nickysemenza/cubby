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
        var latestError: String?
        var nextAttemptAt: ContinuousClock.Instant?
    }

    private struct SetAside {
        var failures: Int
        var nextAttemptAt: ContinuousClock.Instant
    }

    private let outbox: CompanionResultOutbox<ImageProcessingResult>
    private let failureObserver: CompanionImageWorker.FailureObserver?
    private var setAside: [String: SetAside] = [:]
    private var latestError: String?

    init(
        outbox: CompanionResultOutbox<ImageProcessingResult>,
        failureObserver: CompanionImageWorker.FailureObserver?
    ) {
        self.outbox = outbox
        self.failureObserver = failureObserver
    }

    var snapshot: Snapshot {
        .init(
            undelivered: setAside.count, latestError: setAside.isEmpty ? nil : latestError,
            nextAttemptAt: setAside.values.map(\.nextAttemptAt).min())
    }

    /// Sends up to `limit` recorded results that are due, skipping those still backing off.
    func deliverDue(
        transport: any CompanionImageBackgroundTransport, deviceID: String, limit: Int = .max
    ) async throws -> Outcome {
        let pending = try await outbox.pending()
        let pendingKeys = Set(pending.map(\.key))
        // Delivered by another path or discarded.
        setAside = setAside.filter { pendingKeys.contains($0.key) }
        let now = ContinuousClock.now
        var attempted = 0
        var outcome = Outcome.delivered
        for entry in pending {
            if let held = setAside[entry.key], held.nextAttemptAt > now {
                outcome = .setAside
                continue
            }
            guard attempted < limit else { return .setAside }
            try Task.checkCancellation()
            attempted += 1
            switch await deliver(
                entry.result, key: entry.key, transport: transport, deviceID: deviceID)
            {
            case .delivered: break
            case .setAside: outcome = .setAside
            case .updateRequired(let error): return .updateRequired(error)
            }
        }
        return outcome
    }

    /// One delivery attempt; never throws, so a caller's remaining work continues. A cancelled
    /// send keeps the result without counting a failure.
    func deliver(
        _ result: ImageProcessingResult, key: String,
        transport: any CompanionImageBackgroundTransport, deviceID: String
    ) async -> Outcome {
        do {
            try await transport.complete(deviceID: deviceID, result: result)
            try await outbox.acknowledge(key)
            setAside[key] = nil
            return .delivered
        } catch {
            if Self.isClientUpdateRequired(error) { return .updateRequired(error) }
            if error is CancellationError || Task.isCancelled { return .setAside }
            let failures = (setAside[key]?.failures ?? 0) + 1
            setAside[key] = SetAside(
                failures: failures, nextAttemptAt: .now + Self.retryDelay(failures: failures))
            latestError = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            if !AuthenticatedSocketSupport.isExpectedReconnectFailure(error) {
                failureObserver?(error)
            }
            return .setAside
        }
    }

    /// Capped exponential backoff for one set-aside result: 2 s, 4 s, … up to 15 minutes.
    static func retryDelay(failures: Int) -> Duration {
        .seconds(min(900, 1 << min(max(1, failures), 10)))
    }

    static func isClientUpdateRequired(_ error: any Error) -> Bool {
        (error as? CubbyAPIError)?.isClientUpdateRequired == true
    }
}
