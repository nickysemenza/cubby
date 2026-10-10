extension Task where Success == Void, Failure == Never {
    /// Waits for this task to finish, or returns as soon as the waiting task is cancelled; the
    /// task itself keeps running. `await value` cannot be interrupted, so a test hook that waits
    /// through it would hang a time-limited test instead of letting the limit unwind it.
    public func waitUnlessCancelled() async {
        let (finished, signal) = AsyncStream<Never>.makeStream()
        let watcher = Task<Void, Never> {
            await value
            signal.finish()
        }
        for await _ in finished {}
        watcher.cancel()
    }
}
