import Foundation
import Observation

/// What a `PolledRead` keeps fresh: one read, and whether the server says the record is live.
@MainActor
protocol PolledReadOwner: AnyObject {
    var live: Bool { get }
    func refresh() async
}

/// One server read kept fresh while live, shared by the report slot and batch models: reads
/// never overlap, readers retain and release the poll loop, and a status the screen does not
/// show asks it once to reload. Polling is the only refresh mechanism; there is no realtime
/// transport.
@MainActor @Observable
final class PolledRead {
    nonisolated static let pollInterval: Duration = .seconds(3)

    private(set) var isLoading = false
    /// Callers waiting for the read in flight to finish. Observed, so a test can see a read
    /// queue behind the one in flight.
    private var loadWaiters: [CheckedContinuation<Void, Never>] = []
    var queuedLoads: Int { loadWaiters.count }

    @ObservationIgnored weak var owner: (any PolledReadOwner)?
    @ObservationIgnored private let waitForNextPoll: @Sendable () async throws -> Void
    @ObservationIgnored private var watchers = 0
    @ObservationIgnored private(set) var pollTask: Task<Void, Never>?
    @ObservationIgnored private var staleStatusReported: String?

    init(waitForNextPoll: @escaping @Sendable () async throws -> Void) {
        self.waitForNextPoll = waitForNextPoll
    }

    /// Runs `body` once the read in flight finishes; a later read never overlaps it.
    func read(_ body: () async -> Void) async {
        while isLoading { await withCheckedContinuation { loadWaiters.append($0) } }
        isLoading = true
        defer {
            isLoading = false
            let waiters = loadWaiters
            loadWaiters = []
            for waiter in waiters { waiter.resume() }
        }
        await body()
    }

    /// Whether `status` should make the screen reload its record: it differs from `shown` and
    /// has not been reported already.
    func isStale(_ status: String?, shown: String?) -> Bool {
        guard let status, let shown, shown != status, staleStatusReported != status else { return false }
        staleStatusReported = status
        return true
    }

    /// The first reader starts the loop and the last stops it.
    func retain() {
        watchers += 1
        startPolling()
    }

    func release() {
        watchers = max(0, watchers - 1)
        if watchers == 0 {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    /// Retains until the calling task is cancelled, then releases.
    func hold() async {
        retain()
        defer { release() }
        let (cancelled, continuation) = AsyncStream<Never>.makeStream()
        for await _ in cancelled {}
        continuation.finish()
    }

    /// Starts the loop if a reader waits and none runs: after the record's status changes (a
    /// stopped run resumed) or an action ran.
    func startPolling() {
        guard pollTask == nil, watchers > 0 else { return }
        pollTask = Task { [weak self] in
            guard let self else { return }
            await self.owner?.refresh()
            while !Task.isCancelled, self.owner?.live == true {
                try? await self.waitForNextPoll()
                if Task.isCancelled { return }
                await self.owner?.refresh()
            }
            // A stopped record is not polled; a later `retain()` or action starts it again.
            self.pollTask = nil
        }
    }
}

extension PolledRead {
    nonisolated static let defaultPause: @Sendable () async throws -> Void = {
        try await Task.sleep(for: pollInterval)
    }
}
