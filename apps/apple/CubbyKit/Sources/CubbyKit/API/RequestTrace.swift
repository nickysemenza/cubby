import Observation

/// Developer overlays' request-timing strip (PR C layer 6): the last 20 requests
/// `CubbyAuthMiddleware` observed, and the most recent one. Lives in CubbyKit (not the App target)
/// so a stub-client test can exercise it directly; `AppModel` owns one instance and passes it to
/// `CubbyClient` as its `RequestObserver`.
///
/// `@unchecked Sendable`: every stored property is `@MainActor`-isolated by the class annotation;
/// `RequestObserver.record` is `async` and `nonisolated`, so a call from `CubbyAuthMiddleware`
/// (which runs off the main actor, inside `CubbyClient`'s actor) already hops back onto the main
/// actor before touching `entries`.
@MainActor
@Observable
public final class RequestTrace: @unchecked Sendable {
    public struct Entry: Sendable, Equatable {
        public let operationID: String
        public let ms: Double
        public let status: Int

        public init(operationID: String, ms: Double, status: Int) {
            self.operationID = operationID
            self.ms = ms
            self.status = status
        }
    }

    public nonisolated static let capacity = 20
    public private(set) var entries: [Entry] = []
    public var last: Entry? { entries.last }

    public init() {}

    private func append(_ entry: Entry) {
        entries.append(entry)
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
    }
}

extension RequestTrace: RequestObserver {
    public nonisolated func record(operationID: String, ms: Double, status: Int) async {
        await append(Entry(operationID: operationID, ms: ms, status: status))
    }
}
