#if os(macOS)
    import Foundation
    import Network
    import Testing

    @testable import CubbyKit

    // Serialized: parallel loopback listeners flake with connection-lost errors under
    // load. Production is a single one-shot listener per CLI invocation, which is unaffected.
    @Suite("CLI auth handoff", .timeLimit(.minutes(1)), .serialized)
    struct CliAuthHandoffTests {
        private static let nonce = String(repeating: "n", count: 43)
        private static let origin = "https://cubby.example.com"
        private static let baseURL = URL(string: "https://cubby.example.com/")!

        @Test func nonceIsURLSafeAndBounded() {
            let nonce = CliAuthRequest.makeNonce()
            #expect(CliAuthRequest.isValidNonce(nonce))
            #expect(!CliAuthRequest.isValidNonce(""))
            #expect(!CliAuthRequest.isValidNonce(String(repeating: "a", count: 19)))
            #expect(!CliAuthRequest.isValidNonce(String(repeating: "a", count: 129)))
            #expect(!CliAuthRequest.isValidNonce("has space in it abcdefghij"))
            #expect(!CliAuthRequest.isValidNonce("plus+sign/seg=mentabcdefghij"))
        }

        @Test func originCanonicalizesSchemeHostAndPort() {
            #expect(
                CliAuthOrigin.of(URL(string: "https://cubby.example.com")!)
                    == "https://cubby.example.com")
            #expect(
                CliAuthOrigin.of(URL(string: "https://cubby.example.com/")!)
                    == "https://cubby.example.com")
            #expect(
                CliAuthOrigin.of(URL(string: "http://localhost:3000/api/v1")!)
                    == "http://localhost:3000")
            #expect(
                CliAuthOrigin.of(URL(string: "HTTPS://EXAMPLE.COM:8443/x")!)
                    == "https://example.com:8443")
        }

        @Test func senderAndListenerCompleteOneHandoff() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            let port = try await handoff.start()
            async let received = handoff.receive(for: Self.baseURL)
            try await CliAuthSender.post(
                token: "bearer.token", to: port, nonce: Self.nonce, origin: Self.origin)
            #expect(try await received == "bearer.token")
        }

        @Test func wrongNonceKeepsTheListenerOpen() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            let port = try await handoff.start()
            async let received = handoff.receive(for: Self.baseURL)
            await #expect(throws: CliAuthSenderError.self) {
                try await CliAuthSender.post(
                    token: "bearer.token", to: port, nonce: String(repeating: "x", count: 43),
                    origin: Self.origin)
            }
            try await CliAuthSender.post(
                token: "bearer.token", to: port, nonce: Self.nonce, origin: Self.origin)
            #expect(try await received == "bearer.token")
        }

        @Test func serverMismatchFailsBeforeStoring() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            let port = try await handoff.start()
            async let received = handoff.receive(for: URL(string: "http://localhost:3000")!)
            try await CliAuthSender.post(
                token: "bearer.token", to: port, nonce: Self.nonce, origin: Self.origin)
            do {
                _ = try await received
                Issue.record("Expected an origin mismatch, not a stored token.")
            } catch is CliAuthOriginError {
                // Expected: the app's server is not this CLI's server, so nothing is stored.
            } catch {
                Issue.record("Unexpected error: \(error)")
            }
        }

        @Test func postBeforeReceiveStillDelivers() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            let port = try await handoff.start()
            try await CliAuthSender.post(
                token: "bearer.token", to: port, nonce: Self.nonce, origin: Self.origin)
            #expect(try await handoff.receive(for: Self.baseURL) == "bearer.token")
        }

        @Test func secondHandoffAfterAcceptIsRejected() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            let port = try await handoff.start()
            async let received = handoff.receive(for: Self.baseURL)
            try await CliAuthSender.post(
                token: "bearer.token", to: port, nonce: Self.nonce, origin: Self.origin)
            #expect(try await received == "bearer.token")
            do {
                try await CliAuthSender.post(
                    token: "bearer.other", to: port, nonce: Self.nonce, origin: Self.origin)
                Issue.record("Expected the second handoff to fail.")
            } catch {
                // Either connection refused (listener closed) or 403 (already consumed):
                // the first handoff stands either way.
            }
        }

        @Test func unknownEndpointIsA404() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            let port = try await handoff.start()
            defer { handoff.close() }
            let (_, response) = try await URLSession.shared.data(
                for: URLRequest(url: URL(string: "http://127.0.0.1:\(port)/elsewhere")!))
            #expect((response as? HTTPURLResponse)?.statusCode == 404)
        }

        @Test func listenerFailureAfterStartSurfacesDiagnostic() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            _ = try await handoff.start()
            // Park the expiry so only the injected failure can finish the receive.
            let expiry = Gate()
            handoff.injectListenerFailure(.posix(.ECONNABORTED))
            do {
                _ = try await handoff.receive(for: Self.baseURL) { _ in try await expiry.pass() }
                Issue.record("Expected a listener failure.")
            } catch let error as CliAuthHandoffError {
                guard case .listenerFailed = error else {
                    Issue.record("Expected listenerFailed, got \(error).")
                    return
                }
            } catch {
                Issue.record("Unexpected error: \(error)")
            }
        }

        @Test func receiveWaitsForAcknowledgment() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            let port = try await handoff.start()
            let task = Task { try await handoff.receive(for: Self.baseURL) }
            defer { task.cancel() }
            let body = try JSONEncoder().encode(
                CliAuthHandoffPayload(
                    token: "bearer.token", nonce: Self.nonce, origin: Self.origin))
            let response = try await Self.sendRaw(
                to: port,
                chunks: [
                    Data(
                        "POST /handoff HTTP/1.1\r\nContent-Length: \(body.count)\r\n\r\n".utf8)
                        + body
                ],
                holdOpen: true)
            defer { response.connection?.cancel() }
            // The client holds the complete 200 bytes, but the server has not seen the close:
            // nothing may publish yet. Read at the producer boundary — a consumer task could
            // lag publication and hide a premature yield.
            #expect(response.status == 200)
            #expect(!handoff.hasPublishedResult)
            response.connection?.cancel()
            #expect(try await task.value == "bearer.token")
            #expect(handoff.hasPublishedResult)
        }

        @Test func listenerFailureDuringDrainSurfacesDiagnostic() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            let port = try await handoff.start()
            // Park the expiry so only the injected failure can finish the receive.
            let expiry = Gate()
            let task = Task {
                try await handoff.receive(for: Self.baseURL) { _ in try await expiry.pass() }
            }
            defer { task.cancel() }
            let body = try JSONEncoder().encode(
                CliAuthHandoffPayload(
                    token: "bearer.token", nonce: Self.nonce, origin: Self.origin))
            let response = try await Self.sendRaw(
                to: port,
                chunks: [
                    Data(
                        "POST /handoff HTTP/1.1\r\nContent-Length: \(body.count)\r\n\r\n".utf8)
                        + body
                ],
                holdOpen: true)
            defer { response.connection?.cancel() }
            // Accepted (200 fully read) but unpublished: the acknowledgment cycle is still open.
            #expect(response.status == 200)
            #expect(!handoff.hasPublishedResult)
            handoff.injectListenerFailure(.posix(.ECONNABORTED))
            do {
                _ = try await task.value
                Issue.record("Expected a listener failure.")
            } catch let error as CliAuthHandoffError {
                guard case .listenerFailed = error else {
                    Issue.record("Expected listenerFailed, got \(error).")
                    return
                }
            } catch {
                Issue.record("Unexpected error: \(error)")
            }
        }

        @Test func receiveTimesOutWithoutTheClock() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            _ = try await handoff.start()
            defer { handoff.close() }
            do {
                _ = try await handoff.receive(for: Self.baseURL) { _ in }
                Issue.record("Expected a timeout, not a token.")
            } catch let error as CliAuthHandoffError {
                #expect(error == .timedOut)
            } catch {
                Issue.record("Unexpected error: \(error)")
            }
        }

        @Test func fragmentedBodyStillParses() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            let port = try await handoff.start()
            async let received = handoff.receive(for: Self.baseURL)
            let body = try JSONEncoder().encode(
                CliAuthHandoffPayload(token: "bearer.token", nonce: Self.nonce, origin: Self.origin))
            let head =
                "POST /handoff HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\n\r\n"
            let split = head.index(head.startIndex, offsetBy: 20)
            let response = try await Self.sendRaw(
                to: port,
                chunks: [
                    Data(String(head.prefix(upTo: split)).utf8),
                    Data(String(head.suffix(from: split)).utf8) + body,
                ])
            #expect(response.status == 200)
            #expect(try await received == "bearer.token")
        }

        @Test func oversizedLengthIsRejectedAndListenerSurvives() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            let port = try await handoff.start()
            async let received = handoff.receive(for: Self.baseURL)
            let response = try await Self.sendRaw(
                to: port,
                chunks: [Data("POST /handoff HTTP/1.1\r\nContent-Length: 9999999999999999999\r\n\r\n".utf8)])
            #expect(response.status == 400)
            try await CliAuthSender.post(
                token: "bearer.token", to: port, nonce: Self.nonce, origin: Self.origin)
            #expect(try await received == "bearer.token")
        }

        @Test func trailingBytesPastTheBodyAreIgnored() async throws {
            let handoff = CliAuthLoopbackHandoff(nonce: Self.nonce)
            let port = try await handoff.start()
            async let received = handoff.receive(for: Self.baseURL)
            let body = try JSONEncoder().encode(
                CliAuthHandoffPayload(token: "bearer.token", nonce: Self.nonce, origin: Self.origin))
            let response = try await Self.sendRaw(
                to: port,
                chunks: [
                    Data(
                        "POST /handoff HTTP/1.1\r\nContent-Length: \(body.count)\r\n\r\n".utf8) + body
                        + Data("TRAILING-JUNK".utf8)
                ])
            #expect(response.status == 200)
            #expect(try await received == "bearer.token")
        }

        /// Sends raw chunks over one connection and reads one framed response. With `holdOpen`
        /// the connection stays open for the caller to close, so a test can observe what happens
        /// before the server's acknowledgment cycle completes.
        private static func sendRaw(to port: UInt16, chunks: [Data], holdOpen: Bool = false)
            async throws -> (status: Int, text: String, connection: NWConnection?)
        {
            let connection = NWConnection(
                host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
            let queue = DispatchQueue(label: "test.cli-auth-handoff-raw")
            try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<Void, Error>) in
                connection.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        continuation.resume()
                    case .failed(let error):
                        continuation.resume(throwing: error)
                    default:
                        break
                    }
                }
                connection.start(queue: queue)
            }
            for chunk in chunks {
                try await withCheckedThrowingContinuation {
                    (continuation: CheckedContinuation<Void, Error>) in
                    connection.send(
                        content: chunk,
                        completion: .contentProcessed { error in
                            if let error {
                                continuation.resume(throwing: error)
                            } else {
                                continuation.resume()
                            }
                        })
                }
            }
            var bytes = Data()
            while !Self.hasCompleteResponse(bytes) {
                let (data, complete): (Data?, Bool) = try await withCheckedThrowingContinuation {
                    continuation in
                    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
                        data, _, complete, error in
                        if let error {
                            continuation.resume(throwing: error)
                        } else {
                            continuation.resume(returning: (data, complete))
                        }
                    }
                }
                if let data { bytes.append(data) }
                if complete { break }
            }
            if !holdOpen { connection.cancel() }
            let text = String(data: bytes, encoding: .utf8) ?? ""
            let status =
                Int(
                    text.components(separatedBy: "\r\n").first?
                        .split(separator: " ").dropFirst().first.map(String.init) ?? "") ?? -1
            return (status, text, holdOpen ? connection : nil)
        }

        /// A response is complete once its headers and declared body have arrived. The server
        /// waits for the client to close before cleaning up (cancelling first can RST unread
        /// bytes), so the raw client frames instead of reading to EOF.
        private static func hasCompleteResponse(_ bytes: Data) -> Bool {
            let delimiter = Data([13, 10, 13, 10])
            guard let end = bytes.range(of: delimiter),
                let head = String(data: bytes[..<end.lowerBound], encoding: .utf8)
            else { return false }
            var length = 0
            for line in head.components(separatedBy: "\r\n").dropFirst() {
                let field = line.split(separator: ":", maxSplits: 1).map {
                    $0.trimmingCharacters(in: .whitespaces)
                }
                if field.count == 2,
                    field[0].caseInsensitiveCompare("content-length") == .orderedSame,
                    let value = Int(field[1])
                {
                    length = value
                }
            }
            return bytes.count - end.upperBound >= length
        }
    }
#endif
