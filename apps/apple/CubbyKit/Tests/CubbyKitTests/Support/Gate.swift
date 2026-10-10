import Dispatch
import Observation
import Synchronization

/// A suspension point a test double parks on, so the test decides when the double's work
/// finishes instead of sleeping and hoping it is in flight.
///
/// The double calls `pass()` (`hold()` to ignore cancellation, `signal()` not to park); the
/// test awaits `arrivals(_:)` to know the double was reached, then lets it continue with
/// `release(_:)` or `open()`. A release with nobody parked is banked for the next caller. `pass()` throws
/// `CancellationError` when its task is cancelled, so a double standing in for long work stops
/// the way that work would.
// `nonisolated` because the app test targets default to MainActor isolation, and a double parks
// on the gate from any isolation.
nonisolated final class Gate: Sendable {
    private struct Parked {
        let id: Int
        let continuation: CheckedContinuation<Void, any Error>
    }
    private struct Watcher {
        let id: Int
        let count: Int
        let continuation: CheckedContinuation<Void, Never>
    }
    private struct State {
        var isOpen: Bool
        var arrived = 0
        var tickets = 0
        var nextID = 0
        var parked: [Parked] = []
        var watchers: [Watcher] = []

        mutating func arrive() -> [CheckedContinuation<Void, Never>] {
            arrived += 1
            let ready = watchers.filter { $0.count <= arrived }.map(\.continuation)
            watchers.removeAll { $0.count <= arrived }
            return ready
        }
    }
    private let state: Mutex<State>

    init(open: Bool = false) {
        state = Mutex(State(isOpen: open))
    }

    /// How many callers have reached the gate.
    var arrived: Int { state.withLock { $0.arrived } }

    /// Records an arrival and suspends until released, opened, or cancelled.
    func pass() async throws {
        let id = nextID()
        try await withTaskCancellationHandler {
            try await park(id: id, cancellable: true)
        } onCancel: {
            let parked = state.withLock { state in
                state.parked.firstIndex { $0.id == id }.map { state.parked.remove(at: $0) }
            }
            parked?.continuation.resume(throwing: CancellationError())
        }
    }

    /// Records an arrival and suspends until released or opened, ignoring cancellation, so a
    /// superseded request answers only when the test lets it. It parks a double's task, never the
    /// test's own, so a time-limited test still unwinds through `arrivals(_:)`.
    func hold() async {
        try? await park(id: nextID(), cancellable: false)
    }

    /// `hold()` for a synchronous double such as a URL protocol handler. Block only a thread
    /// nothing else in the test needs (`StubNetworking.startLoading(detached: true)`).
    func holdBlocking() {
        let released = DispatchSemaphore(value: 0)
        Task {
            await hold()
            released.signal()
        }
        released.wait()
    }

    private func nextID() -> Int {
        state.withLock { state in
            state.nextID += 1
            return state.nextID
        }
    }

    private func park(id: Int, cancellable: Bool) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            let (ready, proceed): ([CheckedContinuation<Void, Never>], Result<Void, any Error>?) =
                state.withLock { state in
                    let ready = state.arrive()
                    if cancellable, Task.isCancelled { return (ready, .failure(CancellationError())) }
                    if state.isOpen { return (ready, .success(())) }
                    if state.tickets > 0 {
                        state.tickets -= 1
                        return (ready, .success(()))
                    }
                    state.parked.append(Parked(id: id, continuation: continuation))
                    return (ready, nil)
                }
            for watcher in ready { watcher.resume() }
            if let proceed { continuation.resume(with: proceed) }
        }
    }

    /// Records an arrival without parking, for a double that only reports it was reached.
    func signal() {
        for watcher in state.withLock({ $0.arrive() }) { watcher.resume() }
    }

    /// Suspends until at least `count` callers have reached the gate, or the waiting task is
    /// cancelled (a test's time limit), so a double that is never reached fails rather than hangs.
    func arrivals(_ count: Int = 1) async {
        let id = nextID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let reached = state.withLock { state in
                    guard state.arrived < count, !Task.isCancelled else { return true }
                    state.watchers.append(Watcher(id: id, count: count, continuation: continuation))
                    return false
                }
                if reached { continuation.resume() }
            }
        } onCancel: {
            let watcher = state.withLock { state in
                state.watchers.firstIndex { $0.id == id }.map { state.watchers.remove(at: $0) }
            }
            watcher?.continuation.resume()
        }
    }

    /// Lets the `count` earliest parked callers through; any not yet parked pass on arrival.
    func release(_ count: Int = 1) {
        let released = state.withLock { state in
            let released = Array(state.parked.prefix(count))
            state.parked.removeFirst(released.count)
            state.tickets += count - released.count
            return released
        }
        for parked in released { parked.continuation.resume() }
    }

    /// Lets every parked and future caller through.
    func open() {
        let released = state.withLock { state in
            state.isOpen = true
            defer { state.parked = [] }
            return state.parked
        }
        for parked in released { parked.continuation.resume() }
    }
}

/// Suspends until `condition` holds, re-reading it only when an observed property it reads
/// changes. The condition must read `@Observable` state: a change to anything else never wakes
/// it, and a value that turns true and back between two reads is missed.
@MainActor
func observe(until condition: @escaping @MainActor @Sendable () -> Bool) async {
    for await satisfied in Observations(condition) where satisfied || Task.isCancelled { return }
}
