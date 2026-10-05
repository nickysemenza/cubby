import Foundation

/// When `cubby companion --once` stops: the worker is connected, runs no job, and has no
/// unacknowledged result in its outbox, continuously for `idleWindow` — the server dispatches every
/// queued job right after hello, so a quiet window means the queue it would give this device is
/// drained. Any job start, job finish, or new pending result restarts that window, and so does a
/// reconnect. Disconnected for `connectTimeout` (counted from start, or from a drop) is
/// `.unreachable`.
public struct CompanionDrainPolicy: Sendable {
    public enum Decision: Sendable, Equatable {
        case keepRunning
        case drained
        case unreachable
    }

    public let idleWindow: Duration
    public let connectTimeout: Duration
    public private(set) var failedJobs = 0

    private var disconnectedSince: ContinuousClock.Instant?
    private var quietSince: ContinuousClock.Instant?
    private var processing = false
    private var pendingResults = 0

    public init(idleWindow: Duration, connectTimeout: Duration, startedAt: ContinuousClock.Instant) {
        self.idleWindow = idleWindow
        self.connectTimeout = connectTimeout
        self.disconnectedSince = startedAt
    }

    public mutating func observe(
        _ activity: CompanionImageWorkerActivity, at now: ContinuousClock.Instant
    ) {
        switch activity.phase {
        case .stopped, .connecting:
            if disconnectedSince == nil { disconnectedSince = now }
            processing = false
        case .idle:
            disconnectedSince = nil
            processing = false
        case .processing:
            disconnectedSince = nil
            processing = true
        }
        refreshQuiet(at: now, restart: false)
    }

    public mutating func observePendingResults(_ count: Int, at now: ContinuousClock.Instant) {
        let cleared = pendingResults > 0 && count == 0
        pendingResults = count
        refreshQuiet(at: now, restart: cleared)
    }

    public mutating func observeJobFinished(
        _ status: CompanionImageJobReport.Status, at now: ContinuousClock.Instant
    ) {
        if status == .failed { failedJobs += 1 }
        refreshQuiet(at: now, restart: true)
    }

    public func decision(at now: ContinuousClock.Instant) -> Decision {
        if let disconnectedSince, disconnectedSince.duration(to: now) >= connectTimeout {
            return .unreachable
        }
        if let quietSince, quietSince.duration(to: now) >= idleWindow { return .drained }
        return .keepRunning
    }

    private mutating func refreshQuiet(at now: ContinuousClock.Instant, restart: Bool) {
        guard disconnectedSince == nil, !processing, pendingResults == 0 else {
            quietSince = nil
            return
        }
        if restart || quietSince == nil { quietSince = now }
    }
}
