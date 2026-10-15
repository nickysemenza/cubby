import CubbyKit
import Foundation
import Synchronization
import Testing

@testable import Cubby

/// A `SessionTokenStore` that parks reads on a gate, so a server switch can be interleaved
/// deterministically inside `approveCliAuth`'s credential read. Parking uses the shared `Gate`
/// rather than the clock; the blocked thread is the credential actor's, never the test's.
private nonisolated final class GatedTokenStore: SessionTokenStore, @unchecked Sendable {
    private let inner = InMemorySessionTokenStore()
    private let gate: Gate

    init(gate: Gate) {
        self.gate = gate
    }

    func loadState(for host: String) throws -> CubbyAuthState? {
        gate.holdBlocking()
        return try inner.loadState(for: host)
    }

    func saveState(_ state: CubbyAuthState, for host: String) throws {
        try inner.saveState(state, for: host)
    }

    func clear(for host: String) throws {
        try inner.clear(for: host)
    }
}

/// Intercepts the handoff POST the app would send to a waiting CLI. Per-suite static handler
/// (never a global registration): only this suite posts to a `/handoff` URL.
private nonisolated final class HandoffStub: URLProtocol, @unchecked Sendable {
    struct Posted: Sendable {
        let token: String
        let nonce: String
        let origin: String
    }

    static let posted = Mutex<Posted?>(nil)
    static let status = Mutex(200)

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "127.0.0.1" && request.url?.path == "/handoff"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        if request.httpMethod == "POST", let body = Self.body(of: request),
            let json = try? JSONSerialization.jsonObject(with: body) as? [String: String],
            let token = json["token"], let nonce = json["nonce"], let origin = json["origin"]
        {
            Self.posted.withLock { $0 = Posted(token: token, nonce: nonce, origin: origin) }
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.status.withLock({ $0 }), httpVersion: nil,
            headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }

    /// URLSession may hand the stub a stream instead of `httpBody` (mirrors
    /// `ClientQueryTests.requestBody`).
    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { return count < 0 ? nil : data }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
}

@MainActor
@Suite("CLI auth approval", .timeLimit(.minutes(1)), .serialized)
struct CliAuthApprovalTests {
    private static let serverA = URL(string: "http://127.0.0.1:1/")!
    private static let serverB = URL(string: "http://127.0.0.1:2/")!
    private static let nonce = String(repeating: "n", count: 43)

    private static func stubSession() -> URLSession {
        HandoffStub.posted.withLock { $0 = nil }
        HandoffStub.status.withLock { $0 = 200 }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HandoffStub.self]
        return URLSession(configuration: configuration)
    }

    @Test func approvalPostsThisInstallsToken() async throws {
        let session = Self.stubSession()
        defer { HandoffStub.posted.withLock { $0 = nil } }
        let model = AppModel.preview(signedIn: true, baseURL: Self.serverA)
        await model.approveCliAuth(
            CliAuthRequest(port: 54321, nonce: Self.nonce), session: session)
        #expect(model.cliAuthNotice == nil)
        let posted = HandoffStub.posted.withLock({ $0 })
        #expect(posted?.token == "preview.token")
        #expect(posted?.nonce == Self.nonce)
        #expect(posted?.origin == "http://127.0.0.1:1")
    }

    @Test func serverSwitchDuringApprovalSendsNothing() async throws {
        let gate = Gate()
        let store = GatedTokenStore(gate: gate)
        let session = Self.stubSession()
        defer { HandoffStub.posted.withLock { $0 = nil } }
        // `baseURL` persists to defaults on switch; restore it so no other test can observe it.
        let savedBaseURL = UserDefaults.standard.string(forKey: "cubby.baseURL")
        defer {
            if let savedBaseURL {
                UserDefaults.standard.set(savedBaseURL, forKey: "cubby.baseURL")
            } else {
                UserDefaults.standard.removeObject(forKey: "cubby.baseURL")
            }
        }
        let model = AppModel.preview(signedIn: true, baseURL: Self.serverA, store: store)
        let approval = Task {
            await model.approveCliAuth(
                CliAuthRequest(port: 54321, nonce: Self.nonce), session: session)
        }
        // Parked inside the credential read: the approval holds server A's provider, and the
        // token it would send belongs to A.
        await gate.arrivals(1)
        model.baseURL = Self.serverB
        gate.open()
        await approval.value
        // Aborted before posting: the provider no longer matches, so no token goes out labeled
        // with another server's origin.
        #expect(HandoffStub.posted.withLock({ $0 }) == nil)
        #expect(
            model.cliAuthNotice == "The server changed during approval. Approve the command line again."
        )
    }
}
