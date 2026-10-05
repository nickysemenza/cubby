#if os(macOS)
    import AppKit
    import CryptoKit
    import Foundation
    import Network

    public enum ChatGptSignInError: Error, LocalizedError {
        case invalidCallback, browserUnavailable, timedOut, invalidServer
        public var errorDescription: String? {
            switch self {
            case .invalidServer: "Cubby must use an HTTPS origin, except a local development server."
            case .invalidCallback: "ChatGPT authorization was denied or returned an invalid registration."
            case .browserUnavailable: "macOS could not open ChatGPT sign-in."
            case .timedOut: "ChatGPT sign-in timed out."
            }
        }
    }

    @MainActor public enum ChatGptSignIn {
        public static func connect(client: CubbyClient) async throws -> ChatGptStatus {
            let base = client.baseURL
            guard let components = URLComponents(url: base, resolvingAgainstBaseURL: false),
                components.user == nil, components.password == nil, components.query == nil,
                components.fragment == nil, ["", "/"].contains(components.path),
                components.scheme == "https"
                    || (components.scheme == "http"
                        && ["localhost", "127.0.0.1"].contains(components.host ?? ""))
            else { throw ChatGptSignInError.invalidServer }
            let attempt = ChatGptAuthorizationAttempt(host: try await client.chatGptAuthorizationHost())
            let callback = try ChatGptLoopbackCallback(state: attempt.state)
            defer { callback.close() }
            let redirect = try await callback.start()
            guard NSWorkspace.shared.open(try attempt.authorizationURL(redirect: redirect)) else {
                throw ChatGptSignInError.browserUnavailable
            }
            let url = try await callback.receive()
            return try await client.connectChatGpt(attempt.authorization(callback: url, redirect: redirect))
        }
    }

    extension Data {
        var chatGptBase64URL: String {
            base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
    }

    struct ChatGptAuthorizationAttempt: Sendable {
        let host: ChatGptAuthorizationHost
        let state = random()
        let nonce = random()
        let verifier = random()

        private static func random() -> String {
            var generator = SystemRandomNumberGenerator()
            return Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
                .chatGptBase64URL
        }

        func authorizationURL(redirect: URL) throws -> URL {
            var components = URLComponents(string: "https://auth.openai.com/api/accounts/authorize")!
            var values = [
                "client_id": host.clientId ?? "dynamic_agent_client", "ext_agent_host_id": host.hostId,
                "response_type": "code", "redirect_uri": redirect.absoluteString,
                "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
                "resource": "https://api.openai.com/v1", "state": state, "nonce": nonce,
                "code_challenge_method": "S256",
                "code_challenge": Data(SHA256.hash(data: Data(verifier.utf8))).chatGptBase64URL,
            ]
            if host.clientId == nil { values["agent_name_hint"] = "Cubby" }
            components.queryItems = values.sorted { $0.key < $1.key }.map {
                .init(name: $0.key, value: $0.value)
            }
            guard let url = components.url else { throw ChatGptSignInError.invalidCallback }
            return url
        }

        func authorization(callback: URL, redirect: URL) throws -> ChatGptAuthorization {
            let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
            func value(_ key: String) -> String? {
                let matches = items.filter { $0.name == key }
                return matches.count == 1 ? matches[0].value : nil
            }
            guard callback.path == "/auth/callback", value("state") == state, value("error") == nil,
                let code = value("code"), !code.isEmpty,
                let clientId = value("client_id") ?? host.clientId, clientId.hasPrefix("oaiapp_"),
                host.clientId == nil || host.clientId == clientId
            else { throw ChatGptSignInError.invalidCallback }
            return .init(
                code: code, clientId: clientId, verifier: verifier, nonce: nonce,
                redirectUri: redirect.absoluteString)
        }
    }

    // Network.framework callbacks bridge onto the main actor; it owns the listener and every connection.
    @MainActor final class ChatGptLoopbackCallback {
        private let listener: NWListener
        private let state: String
        private let stream: AsyncThrowingStream<URL, Error>
        private let continuation: AsyncThrowingStream<URL, Error>.Continuation
        private var connections: [NWConnection] = []
        private var consumed = false
        private var ready: CheckedContinuation<URL, Error>?

        init(state: String) throws {
            self.state = state
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
            listener = try NWListener(using: parameters)
            (stream, continuation) = AsyncThrowingStream.makeStream()
        }

        func start() async throws -> URL {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { ready in
                    self.ready = ready
                    listener.stateUpdateHandler = { [weak self] state in
                        Task { @MainActor in
                            guard let self else { return }
                            switch state {
                            case .ready:
                                guard let port = self.listener.port else { return }
                                self.ready?.resume(
                                    returning: URL(string: "http://127.0.0.1:\(port.rawValue)/auth/callback")!
                                )
                                self.ready = nil
                            case .failed(let error):
                                self.ready?.resume(throwing: error)
                                self.ready = nil
                                self.continuation.finish(throwing: error)
                            default: break
                            }
                        }
                    }
                    listener.newConnectionHandler = { [weak self] connection in
                        Task { @MainActor in
                            guard let self else { connection.cancel(); return }
                            self.connections.append(connection)
                            connection.start(queue: .main)
                            self.read(connection, accumulated: Data())
                        }
                    }
                    listener.start(queue: .main)
                }
            } onCancel: {
                Task { @MainActor in self.close() }
            }
        }

        func receive(timeout: Duration = .seconds(600)) async throws -> URL {
            let stream = stream
            return try await withThrowingTaskGroup(of: URL.self) { group in
                defer { group.cancelAll() }
                group.addTask {
                    for try await url in stream { return url }
                    throw CancellationError()
                }
                group.addTask {
                    try await Task.sleep(for: timeout)
                    throw ChatGptSignInError.timedOut
                }
                guard let url = try await group.next() else { throw CancellationError() }
                return url
            }
        }

        func close() {
            consumed = true
            ready?.resume(throwing: CancellationError())
            ready = nil
            listener.cancel()
            for connection in connections { connection.cancel() }
            connections.removeAll()
            continuation.finish()
        }

        private func read(_ connection: NWConnection, accumulated: Data) {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) {
                [weak self] data, _, complete, error in
                Task { @MainActor in
                    guard let self else { connection.cancel(); return }
                    var bytes = accumulated
                    if let data { bytes.append(data) }
                    guard bytes.count <= 16384, error == nil else {
                        self.respond(connection, status: 400); return
                    }
                    guard let text = String(data: bytes, encoding: .utf8), text.contains("\r\n\r\n") else {
                        if complete {
                            self.respond(connection, status: 400)
                        } else {
                            self.read(connection, accumulated: bytes)
                        }
                        return
                    }
                    let request = text.components(separatedBy: "\r\n")[0].split(separator: " ")
                    guard request.count == 3, request[0] == "GET", request[1].hasPrefix("/"),
                        let url = URL(string: "http://127.0.0.1\(request[1])"), url.path == "/auth/callback"
                    else { self.respond(connection, status: 404); return }
                    let states =
                        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.filter {
                            $0.name == "state"
                        } ?? []
                    guard !self.consumed, states.count == 1, states[0].value == self.state else {
                        self.respond(connection, status: 400); return
                    }
                    self.consumed = true
                    self.respond(connection, status: 200, callback: url)
                }
            }
        }

        private func respond(_ connection: NWConnection, status: Int, callback: URL? = nil) {
            let body =
                status == 200 ? "Authorization received. Return to Cubby." : "Invalid sign-in callback."
            let response =
                "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Bad Request")\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
            connection.send(
                content: Data(response.utf8),
                completion: .contentProcessed { [weak self] error in
                    connection.cancel()
                    Task { @MainActor in
                        guard let self else { return }
                        self.connections.removeAll { $0 === connection }
                        if let error, callback != nil {
                            self.continuation.finish(throwing: error)
                        } else if let callback {
                            self.continuation.yield(callback); self.continuation.finish()
                        }
                    }
                })
        }
    }
#endif
