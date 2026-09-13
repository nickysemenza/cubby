import AsyncAlgorithms
import Foundation

/// Debounces free-text search input so `SearchModel` does not call the server on every keystroke.
/// One instance per screen: `send` pushes the latest raw value on every keystroke (including
/// empty strings, so clearing the field is observed too), and iterating `values()` yields at most
/// once per debounce window, always the most recently sent value.
///
/// All stored state is immutable and itself `Sendable` (`AsyncStream` and its `Continuation`
/// both are), so the type needs no isolation of its own.
public final class SearchDebouncer: Sendable {
    private let stream: AsyncStream<String>
    private let continuation: AsyncStream<String>.Continuation
    private let interval: Duration

    public init(interval: Duration = .milliseconds(250)) {
        self.interval = interval
        (stream, continuation) = AsyncStream<String>.makeStream()
    }

    /// Records one more keystroke's worth of text. Never blocks.
    public func send(_ text: String) {
        continuation.yield(text)
    }

    /// The debounced sequence: iterate this in a `Task` to react to settled input.
    public func values() -> some AsyncSequence<String, Never> {
        stream.debounce(for: interval)
    }

    deinit {
        continuation.finish()
    }
}
