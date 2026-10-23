import Foundation
import Network
import Synchronization
import Testing

@testable import CubbyKit

private final class NativeTransportStub: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) async throws -> (Int, Data, [String: String])
    static let handler = Mutex<Handler?>(nil)
    private let loadingTask = Mutex<Task<Void, Never>?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let handler = Self.handler.withLock { $0 }
        let operation = Task { @Sendable [self] in
            do {
                guard let handler else { throw URLError(.badServerResponse) }
                let (status, data, headers) = try await handler(request)
                try Task.checkCancellation()
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: status,
                    httpVersion: "HTTP/1.1", headerFields: headers)!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
        loadingTask.withLock { $0 = operation }
    }
    override func stopLoading() { loadingTask.withLock { $0?.cancel() } }
    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [NativeTransportStub.self]
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration)
    }
}

@Suite("Native HTTP transport", .serialized)
struct NativeHTTPTransportTests {
    private func provider(with credential: CubbyCredential?) throws -> (
        CredentialProvider, InMemorySessionTokenStore
    ) {
        let store = InMemorySessionTokenStore()
        if let credential { try store.save(credential, for: "cubby.example") }
        return (CredentialProvider(host: "cubby.example", store: store), store)
    }

    private func transport(
        _ credentials: CredentialProvider, identity: ClientIdentity = .unknown,
        observer: (any RequestObserver)? = nil
    ) -> NativeHTTPTransport {
        NativeHTTPTransport(
            baseURL: URL(string: "https://cubby.example")!,
            credentials: credentials, identity: identity, session: NativeTransportStub.session(),
            observer: observer)
    }

    @Test func queryPreservesLiteralPlusSpacesPercentAndRepeatedKeys() async throws {
        let (credentials, _) = try provider(with: nil)
        NativeTransportStub.handler.withLock {
            $0 = { request in
                #expect(
                    request.url?.absoluteString
                        == "https://cubby.example/api/v1/search/find?q=USB%2BC%20%25&tag=a%2Bb&tag=c")
                return (200, Data(), [:])
            }
        }
        _ = try await transport(credentials).send(
            route: OperationRoute.all["search.find"]!,
            query: [("q", "USB+C %"), ("tag", "a+b"), ("tag", "c")])
    }

    @Test func headersApplyEvenWhenResponseBodyFails() async throws {
        for status in [200, 401, 426] {
            let (credentials, _) = try provider(with: .bearer("before"))
            let trace = await RequestTrace()
            let gate = Gate()
            // Bound a regression where body collection prevents observation of received headers.
            let timeout = Task {
                try await Task.sleep(for: .seconds(1)); gate.open()
            }
            defer { timeout.cancel() }
            let observer = HeaderObserver(trace: trace, gate: gate)
            let server = try await InterruptedHTTPServer.start(status: status, gate: gate)
            defer { server.listener.cancel() }
            let client = NativeHTTPTransport(
                baseURL: URL(string: "http://127.0.0.1:\(server.port)")!,
                credentials: credentials, identity: .unknown, session: URLSession(configuration: .ephemeral),
                observer: observer)
            do {
                _ = try await client.send(route: OperationRoute.all["entity.list"]!)
                Issue.record("Expected interrupted body")
            } catch {}
            #expect(await trace.last?.status == status, "Partial HTTP status \(status)")
            #expect(await trace.clientUpdateRequired == (status == 426))
            #expect(await credentials.current() == (status == 401 ? nil : .bearer("after")))
        }
    }

    @Test func bearerAndIdentityHeadersReachTheRequest() async throws {
        let (credentials, _) = try provider(with: .bearer("synthetic-token"))
        let installation = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
        NativeTransportStub.handler.withLock {
            $0 = { request in
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-token")
                #expect(request.value(forHTTPHeaderField: "x-api-key") == nil)
                #expect(
                    request.value(forHTTPHeaderField: "User-Agent")
                        == "cubby-apple/1.2.3 (ios; 11111111-1111-4111-8111-111111111111)")
                #expect(
                    request.value(forHTTPHeaderField: "x-cubby-device")
                        == installation.uuidString.lowercased())
                return (200, Data("{}".utf8), [:])
            }
        }
        let client = transport(
            credentials,
            identity: ClientIdentity(
                product: "cubby-apple", version: "1.2.3", platform: "ios", installationID: installation))
        #expect(try await client.send(route: OperationRoute.all["entity.list"]!) == Data("{}".utf8))
    }

    @Test func apiKeyAndCLIIdentityDoNotSendBearerOrDeviceHeaders() async throws {
        let (credentials, _) = try provider(with: .apiKey("synthetic-key"))
        NativeTransportStub.handler.withLock {
            $0 = { request in
                #expect(request.value(forHTTPHeaderField: "x-api-key") == "synthetic-key")
                #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                #expect(request.value(forHTTPHeaderField: "x-cubby-device") == nil)
                #expect(request.value(forHTTPHeaderField: "User-Agent") == "cubby-cli/0 (macos; none)")
                return (200, Data(), [:])
            }
        }
        _ = try await transport(
            credentials, identity: ClientIdentity(product: "cubby-cli", version: "0", platform: "macos")
        )
        .send(route: OperationRoute.all["entity.list"]!)
    }

    @Test func rotationPersistsOnlySignedSessionDataCookies() async throws {
        let (credentials, _) = try provider(with: .bearer("before"))
        NativeTransportStub.handler.withLock {
            $0 = { _ in
                (
                    200, Data(),
                    [
                        "set-auth-token": "after",
                        "Set-Cookie": "better-auth.session_data=cache; Max-Age=300; Path=/",
                    ]
                )
            }
        }
        let client = transport(credentials)
        _ = try await client.send(route: OperationRoute.all["entity.list"]!)
        #expect(await credentials.current() == .bearer("after"))
        #expect(await credentials.currentState()?.sessionDataCookies == ["better-auth.session_data": "cache"])
        NativeTransportStub.handler.withLock {
            $0 = { request in
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer after")
                #expect(request.value(forHTTPHeaderField: "Cookie") == "better-auth.session_data=cache")
                return (200, Data(), ["Set-Cookie": "better-auth.session_token=never-copy; Path=/"])
            }
        }
        _ = try await client.send(route: OperationRoute.all["entity.list"]!)
        #expect(await credentials.currentState()?.sessionDataCookies == ["better-auth.session_data": "cache"])
    }

    @Test func lateUnauthorizedResponseCannotClearANewerLogin() async throws {
        let (credentials, _) = try provider(with: .bearer("old"))
        let gate = Gate()
        NativeTransportStub.handler.withLock {
            $0 = { _ in
                try await gate.pass()
                return (401, Data(#"{"code":"UNAUTHORIZED","message":"synthetic"}"#.utf8), [:])
            }
        }
        let client = transport(credentials)
        let pending = Task { try await client.send(route: OperationRoute.all["entity.list"]!) }
        await gate.arrivals()
        try await credentials.set(.bearer("new"))
        gate.open()
        await #expect(throws: CubbyAPIError.self) { _ = try await pending.value }
        #expect(await credentials.current() == .bearer("new"))
    }

    @Test func unauthorizedInvalidatesCredentialAndKeepsErrorStatus() async throws {
        let (credentials, store) = try provider(with: .bearer("stale"))
        NativeTransportStub.handler.withLock {
            $0 = { _ in
                (
                    401,
                    Data(
                        #"{"code":"UNAUTHORIZED","message":"synthetic","requestId":"synthetic-request"}"#.utf8
                    ), [:]
                )
            }
        }
        do {
            _ = try await transport(credentials).send(route: OperationRoute.all["entity.list"]!)
            Issue.record("Expected authentication failure")
        } catch let error as CubbyAPIError {
            #expect(error.status == 401)
            #expect(error.detail?.requestId == "synthetic-request")
        }
        #expect(await credentials.current() == nil)
        #expect(try store.load(for: "cubby.example") == nil)
    }

    @Test func updateRequiredIsRecordedBeforeTheErrorIsThrown() async throws {
        let (credentials, _) = try provider(with: .bearer("valid"))
        let trace = await RequestTrace()
        NativeTransportStub.handler.withLock { $0 = { _ in (426, Data(), [:]) } }
        do {
            _ = try await transport(credentials, observer: trace).send(
                route: OperationRoute.all["entity.mutate"]!)
            Issue.record("Expected update requirement")
        } catch let error as CubbyAPIError {
            #expect(error.isClientUpdateRequired)
        }
        let last = await trace.last
        #expect(last?.operationID == "entity.mutate")
        #expect(last?.status == 426)
        #expect((last?.ms ?? -1) >= 0)
        #expect(await credentials.current() == .bearer("valid"))
    }

    @Test func nonJSONFailureRetainsRawDiagnosticsAndCredentials() async throws {
        let (credentials, _) = try provider(with: .bearer("valid"))
        let body = Data("Synthetic upstream failure".utf8)
        NativeTransportStub.handler.withLock { $0 = { _ in (502, body, [:]) } }
        do {
            _ = try await transport(credentials).send(route: OperationRoute.all["entity.list"]!)
            Issue.record("Expected upstream failure")
        } catch let error as CubbyAPIError {
            #expect(error.status == 502)
            #expect(error.rawBody == body)
            #expect(error.userMessage.contains("Synthetic upstream failure"))
        }
        #expect(await credentials.current() == .bearer("valid"))
    }

    @Test func cancellationKeepsItsIdentity() async throws {
        let (credentials, _) = try provider(with: nil)
        let gate = Gate()
        NativeTransportStub.handler.withLock {
            $0 = { _ in
                try await gate.pass()
                return (200, Data(), [:])
            }
        }
        let client = transport(credentials)
        let pending = Task { try await client.send(route: OperationRoute.all["entity.list"]!) }
        await gate.arrivals()
        pending.cancel()
        do {
            _ = try await pending.value
            Issue.record("Expected cancellation")
        } catch {
            #expect(error is CancellationError || (error as? URLError)?.code == .cancelled)
        }
    }

    @Test func responseCookiesPreserveSignedChunksAndApplyDeletion() async throws {
        let (credentials, _) = try provider(with: .bearer("tok.sig"))
        let request = await credentials.requestState()
        let url = URL(string: "https://cubby.example")!

        await credentials.processResponse(
            for: request,
            status: 200,
            setAuthToken: nil,
            setCookieHeaders: [
                "better-auth.session_data.0=chunk-a; Max-Age=300; Path=/",
                "better-auth.session_data.1=chunk-b; Max-Age=300; Path=/",
                "better-auth.session_token=never-copy; Max-Age=300; Path=/",
            ],
            responseURL: url
        )
        let afterWrite = await credentials.requestState()
        #expect(
            afterWrite.sessionDataCookies == [
                "better-auth.session_data.0": "chunk-a",
                "better-auth.session_data.1": "chunk-b",
            ])

        await credentials.processResponse(
            for: afterWrite,
            status: 200,
            setAuthToken: nil,
            setCookieHeaders: [
                "better-auth.session_data.0=; Max-Age=0; Path=/"
            ],
            responseURL: url
        )
        #expect(
            await credentials.requestState().sessionDataCookies == [
                "better-auth.session_data.1": "chunk-b"
            ])
    }

    @Test func staleResponsesCannotRotateOrInvalidateNewerCredentials() async throws {
        let (credentials, _) = try provider(with: .bearer("old"))
        let request = await credentials.requestState()
        try await credentials.set(.bearer("new"))

        await credentials.processResponse(
            for: request,
            status: 200,
            setAuthToken: "rotated-old",
            setCookieHeaders: [
                "better-auth.session_data=old-cache; Max-Age=300; Path=/"
            ],
            responseURL: URL(string: "https://cubby.example")!
        )
        await credentials.processResponse(
            for: request,
            status: 401,
            setAuthToken: nil,
            setCookieHeaders: [],
            responseURL: URL(string: "https://cubby.example")!
        )

        #expect(await credentials.current() == .bearer("new"))
        #expect(await credentials.currentState()?.sessionDataCookies == [:])
    }

    @Test func staleSignInAndSignOutSnapshotsCannotOverwriteNewerAuthentication() async throws {
        let (credentials, _) = try provider(with: nil)
        let signInRequest = await credentials.requestState()
        await credentials.invalidate()

        let accepted = try await credentials.completeSignIn(
            .bearer("late"),
            for: signInRequest,
            setCookieHeaders: [],
            responseURL: URL(string: "https://cubby.example")!
        )
        #expect(!accepted)
        #expect(await credentials.current() == nil)

        try await credentials.set(.bearer("current"))
        let signOutRequest = await credentials.requestState()
        try await credentials.set(.bearer("new-login"))
        await credentials.invalidate(for: signOutRequest)

        #expect(await credentials.current() == .bearer("new-login"))
    }

}

private struct HeaderObserver: RequestObserver {
    let trace: RequestTrace
    let gate: Gate
    func record(operationID: String, ms: Double, status: Int) async {
        await trace.record(operationID: operationID, ms: ms, status: status)
        gate.open()
    }
}

/// URLProtocol buffers response callbacks on some Foundation versions. A real partial HTTP
/// response exercises the received-headers boundary without relying on those stub semantics.
private struct InterruptedHTTPServer: Sendable {
    let listener: NWListener
    let port: UInt16

    static func start(status: Int, gate: Gate) async throws -> Self {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        let queue = DispatchQueue(label: "native-transport-partial-response")
        listener.newConnectionHandler = { connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in
                let response =
                    Data(
                        "HTTP/1.1 \(status) Synthetic\r\nContent-Length: 100000\r\nset-auth-token: after\r\nConnection: close\r\n\r\n"
                            .utf8) + Data(repeating: 65, count: 4096)
                connection.send(
                    content: response,
                    completion: .contentProcessed { _ in
                        Task {
                            try? await gate.pass()
                            connection.forceCancel()
                        }
                    })
            }
        }
        let port = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<UInt16, any Error>) in
            let pending = Mutex<CheckedContinuation<UInt16, any Error>?>(continuation)
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if let port = listener.port?.rawValue {
                        pending.withLock {
                            $0?.resume(returning: port); $0 = nil
                        }
                    }
                case .failed(let error):
                    pending.withLock {
                        $0?.resume(throwing: error); $0 = nil
                    }
                default: break
                }
            }
            listener.start(queue: queue)
        }
        return Self(listener: listener, port: port)
    }
}
