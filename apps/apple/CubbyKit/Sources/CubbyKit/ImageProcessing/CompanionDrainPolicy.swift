import Foundation

/// The worker's authoritative drain inputs, read from `CompanionImageWorker.drainState()`.
/// Connectivity and commands are independent: a command outlives a reconnect, and the activity
/// phase is reported for jobs whether or not a socket is open.
public struct CompanionDrainState: Sendable, Equatable {
    /// A socket is open and this connection's hello has been sent.
    public let connected: Bool
    /// Commands accepted and not yet finished: queued for a slot, executing, or recording.
    public let outstandingCommands: Int
    /// Recorded results the server has not acknowledged.
    public let pendingResults: Int

    public init(connected: Bool, outstandingCommands: Int, pendingResults: Int) {
        self.connected = connected
        self.outstandingCommands = outstandingCommands
        self.pendingResults = pendingResults
    }

    /// Nothing accepted remains to execute, record, or deliver.
    public var isSettled: Bool { outstandingCommands == 0 && pendingResults == 0 }
}

/// When `cubby companion --once` stops: connected and settled (no outstanding command, no
/// unacknowledged result) continuously for `idleWindow`. A job finishing, a state becoming
/// settled again, and a reconnect each restart that window. The window only bounds how long this
/// process waits for the server to dispatch: whether waiting jobs are offered on hello at all is
/// the server's choice, so a quiet window is not proof the household queue is empty. Disconnected for `connectTimeout` (counted
/// from start, or from a drop, regardless of running jobs) is `.unreachable`.
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

    public init(idleWindow: Duration, connectTimeout: Duration, startedAt: ContinuousClock.Instant) {
        self.idleWindow = idleWindow
        self.connectTimeout = connectTimeout
        self.disconnectedSince = startedAt
    }

    public mutating func observe(_ state: CompanionDrainState, at now: ContinuousClock.Instant) {
        if state.connected {
            disconnectedSince = nil
        } else if disconnectedSince == nil {
            disconnectedSince = now
        }
        if state.connected, state.isSettled {
            if quietSince == nil { quietSince = now }
        } else {
            quietSince = nil
        }
    }

    public mutating func observeJobFinished(
        _ status: CompanionImageJobReport.Status, at now: ContinuousClock.Instant
    ) {
        if status == .failed { failedJobs += 1 }
        if quietSince != nil { quietSince = now }
    }

    public func decision(at now: ContinuousClock.Instant) -> Decision {
        if let disconnectedSince, disconnectedSince.duration(to: now) >= connectTimeout {
            return .unreachable
        }
        if let quietSince, quietSince.duration(to: now) >= idleWindow { return .drained }
        return .keepRunning
    }
}
