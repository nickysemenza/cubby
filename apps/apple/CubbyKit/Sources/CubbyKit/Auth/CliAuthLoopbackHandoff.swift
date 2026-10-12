#if os(macOS)
    import Foundation
    import Network

    public enum CliAuthHandoffError: Error, Sendable, Equatable, LocalizedError {
        case timedOut
        case listenerFailed(String)
        case cancelled

        public var errorDescription: String? {
            switch self {
            case .timedOut:
                return "No sign-in arrived from the Cubby app in time."
            case .listenerFailed(let detail):
                return "Could not listen for the Cubby app's sign-in (\(detail))."
            case .cancelled:
                return "The sign-in handoff was cancelled."
            }
        }
    }

    /// The `cubby auth login` side of the app-to-CLI handoff: a one-shot loopback listener that
    /// accepts a single `POST /handoff` carrying `CliAuthHandoffPayload` whose nonce matches,
    /// then closes. Everything else gets a 4xx and the listener stays open until success,
    /// timeout, or `close()`.
    ///
    /// Queue confinement: every mutable property is touched only on `queue`, so no lock guards
    /// them; `@unchecked Sendable` holds because public methods only hop work onto the queue and
    /// continuations cross it as values. Network callbacks already arrive on `queue` (both the
    /// listener and every connection start there), so handlers never hop. The result travels on a
    /// buffered stream, so a POST that lands before `receive()` still delivers, and finishing the
    /// stream always releases a waiter — timeout and cancellation can never strand one.
    public final class CliAuthLoopbackHandoff: @unchecked Sendable {
        public static let path = "/handoff"
        private static let maxBytes = 16_384
        private static let delimiter = Data([13, 10, 13, 10])  // \r\n\r\n

        public let nonce: String

        private let queue = DispatchQueue(label: "com.nickysemenza.cubby.cli-auth-handoff")
        private let stream: AsyncThrowingStream<CliAuthHandoffPayload, Error>
        private let continuation: AsyncThrowingStream<CliAuthHandoffPayload, Error>.Continuation
        private var listener: NWListener?
        private var connections: [NWConnection] = []
        private var ready: CheckedContinuation<UInt16, Error>?
        private var consumed = false
        private var resultPublished = false
        private var closed = false

        public init(nonce: String = CliAuthRequest.makeNonce()) {
            self.nonce = nonce
            (stream, continuation) = AsyncThrowingStream.makeStream(
                of: CliAuthHandoffPayload.self, bufferingPolicy: .bufferingNewest(1))
        }

        /// Binds 127.0.0.1 on an ephemeral port and returns it for the `cubby://cli-auth` link.
        public func start() async throws -> UInt16 {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    queue.async { [weak self] in
                        guard let self else {
                            continuation.resume(throwing: CliAuthHandoffError.cancelled)
                            return
                        }
                        guard !self.closed else {
                            continuation.resume(throwing: CliAuthHandoffError.cancelled)
                            return
                        }
                        self.ready = continuation
                        do {
                            let parameters = NWParameters.tcp
                            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
                            let listener = try NWListener(using: parameters)
                            self.listener = listener
                            listener.stateUpdateHandler = { [weak self] state in
                                self?.handleState(state)
                            }
                            listener.newConnectionHandler = { [weak self] connection in
                                self?.handleConnection(connection)
                            }
                            listener.start(queue: self.queue)
                        } catch {
                            self.failStart(error)
                        }
                    }
                }
            } onCancel: {
                self.close()
            }
        }

        /// The bearer token checked for `baseURL`'s origin, from the first nonce-matching POST —
        /// whether it arrived before or after this call. Throws `timedOut` when the app never
        /// answers, or the origin mismatch before anything is stored. `sleep` is injectable so
        /// tests never wait on the clock.
        public func receive(
            for baseURL: URL,
            timeout: Duration = .seconds(300),
            sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
        ) async throws -> String {
            try await withThrowingTaskGroup(of: String.self) { group in
                defer { group.cancelAll() }
                group.addTask { [stream = self.stream] in
                    for try await payload in stream {
                        return try cliAuthToken(from: payload, for: baseURL)
                    }
                    throw CancellationError()
                }
                group.addTask {
                    try await sleep(timeout)
                    throw CliAuthHandoffError.timedOut
                }
                do {
                    guard let token = try await group.next() else { throw CancellationError() }
                    close()
                    return token
                } catch {
                    close()
                    throw error
                }
            }
        }

        /// Test observation: whether the accepted payload has been published to the stream.
        /// Read this, not a consumer task's progress, to assert nothing published yet — the
        /// consumer runs in another task and may lag publication. Tests only; never call from
        /// queue callbacks (it blocks on the queue).
        var hasPublishedResult: Bool { queue.sync { resultPublished } }

        public func close() {
            var hasPublishedResult: Bool { queue.sync { resultPublished } }
            queue.async { [weak self] in
                guard let self, !self.closed else { return }
                self.closed = true
                self.ready?.resume(throwing: CliAuthHandoffError.cancelled)
                self.ready = nil
                self.listener?.cancel()
                self.listener = nil
                for connection in self.connections { connection.cancel() }
                self.connections.removeAll()
                self.continuation.finish()
            }
        }

        private func handleState(_ state: NWListener.State) {
            switch state {
            case .ready:
                guard let port = listener?.port?.rawValue else { return }
                let ready = self.ready
                self.ready = nil
                ready?.resume(returning: port)
            case .failed(let error):
                failStart(error)
            default:
                break
            }
        }

        private func failStart(_ error: Error) {
            let ready = self.ready
            self.ready = nil
            let failure = CliAuthHandoffError.listenerFailed(String(describing: error))
            ready?.resume(throwing: failure)
            // A failure after readiness must reach a waiting `receive()` as its diagnostic, not
            // a bare cancellation — unless the result already published, in which case the token
            // stands and a normal finish follows. Acceptance alone is not publication: a request
            // accepted but not yet acknowledged must still surface the failure.
            if !resultPublished { continuation.finish(throwing: failure) }
            close()
        }

        /// Test seam: replays a listener failure as if Network delivered it.
        func injectListenerFailure(_ error: NWError) {
            queue.async { [weak self] in self?.handleState(.failed(error)) }
        }

        private func handleConnection(_ connection: NWConnection) {
            guard !closed && !consumed else { connection.cancel(); return }
            connections.append(connection)
            connection.start(queue: queue)
            read(connection, accumulated: Data())
        }

        private func read(_ connection: NWConnection, accumulated: Data) {
            connection.receive(minimumIncompleteLength: 1, maximumLength: Self.maxBytes) {
                [weak self] data, _, complete, error in
                guard let self else { connection.cancel(); return }
                var bytes = accumulated
                if let data { bytes.append(data) }
                guard bytes.count <= Self.maxBytes, error == nil else {
                    self.respond(connection, status: 400, message: "request too large")
                    return
                }
                switch Self.frame(bytes, complete: complete) {
                case .needMore:
                    self.read(connection, accumulated: bytes)
                case .malformed:
                    self.respond(connection, status: 400, message: "malformed request")
                case .request(let head, let body):
                    self.handleRequest(connection, head: head, body: body)
                }
            }
        }

        private enum Framed {
            case needMore
            case malformed
            case request(head: String, body: Data)
        }

        /// Classifies buffered bytes: more may complete them, they never can, or the head string
        /// and exact declared body are ready. Heads that are not UTF-8 or carry no single bounded
        /// `Content-Length` are malformed; trailing bytes past the declared body are ignored.
        private static func frame(_ bytes: Data, complete: Bool) -> Framed {
            guard let delimiter = bytes.range(of: Self.delimiter) else {
                return complete ? .malformed : .needMore
            }
            let bodyStart = delimiter.upperBound - bytes.startIndex
            guard let head = String(data: bytes[..<delimiter.lowerBound], encoding: .utf8),
                let length = contentLength(in: head, bodyStart: bodyStart)
            else { return .malformed }
            guard bytes.count - bytes.startIndex - bodyStart >= length else {
                return complete ? .malformed : .needMore
            }
            let start = bytes.index(bytes.startIndex, offsetBy: bodyStart)
            return .request(head: head, body: bytes[start..<bytes.index(start, offsetBy: length)])
        }

        /// One valid bounded `Content-Length`, or nil. Lengths past `maxBytes` can never arrive
        /// (the accumulator caps first), so bounding before arithmetic also closes the overflow.
        private static func contentLength(in head: String, bodyStart: Int) -> Int? {
            var lengths: [Int] = []
            for line in head.components(separatedBy: "\r\n").dropFirst() {
                let field = line.split(separator: ":", maxSplits: 1).map {
                    $0.trimmingCharacters(in: .whitespaces)
                }
                guard field.count == 2 else { continue }
                if field[0].caseInsensitiveCompare("content-length") == .orderedSame {
                    guard let value = Int(field[1]) else { return nil }
                    lengths.append(value)
                } else if field[0].caseInsensitiveCompare("transfer-encoding") == .orderedSame {
                    return nil
                }
            }
            guard lengths.count <= 1 else { return nil }
            let length = lengths.first ?? 0
            guard (0...maxBytes).contains(length), length <= maxBytes - bodyStart else { return nil }
            return length
        }

        private func handleRequest(_ connection: NWConnection, head: String, body: Data) {
            let line = head.components(separatedBy: "\r\n")[0].split(separator: " ")
            guard line.count == 3, line[0] == "POST", line[1] == Self.path else {
                respond(connection, status: 404, message: "unknown handoff endpoint")
                return
            }
            guard !consumed,
                let payload = try? JSONDecoder().decode(CliAuthHandoffPayload.self, from: body),
                !payload.token.isEmpty, payload.nonce == nonce
            else {
                respond(connection, status: 403, message: "invalid handoff payload")
                return
            }
            consumed = true
            respond(connection, status: 200, message: "ok", payload: payload)
        }

        private func respond(
            _ connection: NWConnection, status: Int, message: String,
            payload: CliAuthHandoffPayload? = nil
        ) {
            let reason =
                status == 200
                ? "OK"
                : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : "Bad Request"
            let body = "{\"\(status == 200 ? "ok" : "error")\":\"\(message)\"}"
            let response =
                "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
            connection.send(
                content: Data(response.utf8),
                completion: .contentProcessed { [weak self] _ in
                    self?.drain(connection) { [weak self] in
                        guard let self else { connection.cancel(); return }
                        // Publish only after the acknowledgment cycle completes: returning the
                        // token (or tearing down) first can RST bytes the app has not read yet,
                        // failing a handoff the CLI already reports as success. A timeout that
                        // closed first skips the publish; its buffered absence is harmless.
                        if let payload, !self.closed {
                            self.resultPublished = true
                            self.continuation.yield(payload)
                        }
                        connection.cancel()
                        self.connections.removeAll { $0 === connection }
                        if payload != nil { self.close() }
                    }
                })
        }

        /// Drains until the client closes or errors (it will: `Connection: close`), then runs
        /// cleanup. One receive is not proof: an unread request byte is not a close.
        private func drain(_ connection: NWConnection, then cleanup: @escaping () -> Void) {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) {
                [weak self] _, _, complete, error in
                guard let self else { connection.cancel(); cleanup(); return }
                if complete || error != nil {
                    cleanup()
                } else {
                    self.drain(connection, then: cleanup)
                }
            }
        }
    }

    /// The token to store for `baseURL`, or an error naming both origins. Checked inside
    /// `receive()`, so an app/CLI server mismatch preserves the previous CLI credential — a
    /// copied bearer must never be discovered wrong by sending it to another server.
    func cliAuthToken(from payload: CliAuthHandoffPayload, for baseURL: URL) throws -> String {
        guard let expected = CliAuthOrigin.of(baseURL), payload.origin == expected else {
            throw CliAuthOriginError.mismatch(
                expected: CliAuthOrigin.of(baseURL) ?? baseURL.absoluteString,
                received: payload.origin)
        }
        return payload.token
    }
#endif
