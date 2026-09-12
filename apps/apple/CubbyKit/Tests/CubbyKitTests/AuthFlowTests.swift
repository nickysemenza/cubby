import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// A `URLProtocol` stub scoped to this file, distinct from `RawClientTests.StubURLProtocol`.
/// `AuthFlow` needs a response header (`set-auth-token`) that the fixed `Content-Type`-only stub
/// in `RawClientTests.swift` cannot express, and — as important — Swift Testing schedules
/// independent `@Suite` types concurrently even when each is individually `.serialized`, so
/// sharing one static handler across suites (confirmed empirically while writing these tests)
/// intermittently answers one suite's request with another's stubbed response. A dedicated type
/// per suite removes the shared mutable state entirely instead of relying on ordering.
private final class AuthStubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) -> (Int, [String: String], Data)
    static let handler = Mutex<Handler?>(nil)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler.withLock({ $0 }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (status, headers, data) = handler(request)
        var fields = headers
        fields["Content-Type"] = fields["Content-Type"] ?? "application/json"
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: fields
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AuthStubURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

@Suite("AuthFlow", .serialized)
struct AuthFlowTests {
    private func makeFlow(credential: CubbyCredential? = nil) throws -> (AuthFlow, CredentialProvider) {
        let store = InMemorySessionTokenStore()
        if let credential { try store.save(credential, for: "localhost:3000") }
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        let flow = AuthFlow(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: credentials,
            session: AuthStubURLProtocol.session()
        )
        return (flow, credentials)
    }

    private func resetHandlerAfterTest() {
        AuthStubURLProtocol.handler.withLock { $0 = nil }
    }

    @Test func signInStoresTheBearerToken() async throws {
        defer { resetHandlerAfterTest() }
        AuthStubURLProtocol.handler.withLock { handler in
            handler = { request in
                #expect(request.url?.path() == "/api/auth/sign-in/email")
                #expect(request.value(forHTTPHeaderField: "Origin") == "cubby-mobile://")
                return (200, ["set-auth-token": "session-token-abc"], Data("{}".utf8))
            }
        }
        let (flow, credentials) = try makeFlow()
        let credential = try await flow.signIn(email: "nicky@example.com", password: "hunter2")
        #expect(credential == .bearer("session-token-abc"))
        #expect(await credentials.current() == .bearer("session-token-abc"))
    }

    @Test func signInEveryRequestCarriesTheOriginHeader() async throws {
        defer { resetHandlerAfterTest() }
        let capturedOrigin = Mutex<String?>(nil)
        AuthStubURLProtocol.handler.withLock { handler in
            handler = { request in
                capturedOrigin.withLock { $0 = request.value(forHTTPHeaderField: "Origin") }
                return (200, ["set-auth-token": "tok"], Data("{}".utf8))
            }
        }
        let (flow, _) = try makeFlow()
        _ = try await flow.signIn(email: "nicky@example.com", password: "hunter2")
        #expect(capturedOrigin.withLock { $0 } == "cubby-mobile://")
    }

    @Test func signInWithoutTokenHeaderThrowsAndStoresNothing() async throws {
        defer { resetHandlerAfterTest() }
        AuthStubURLProtocol.handler.withLock { handler in
            handler = { _ in (200, [:], Data("{}".utf8)) }
        }
        let (flow, credentials) = try makeFlow()
        await #expect(throws: AuthError.missingToken) {
            _ = try await flow.signIn(email: "nicky@example.com", password: "hunter2")
        }
        #expect(await credentials.current() == nil)
    }

    @Test func signInWithBadCredentialsThrowsInvalidCredentials() async throws {
        defer { resetHandlerAfterTest() }
        AuthStubURLProtocol.handler.withLock { handler in
            handler = { _ in (401, [:], Data("{}".utf8)) }
        }
        let (flow, credentials) = try makeFlow()
        await #expect(throws: AuthError.invalidCredentials) {
            _ = try await flow.signIn(email: "nicky@example.com", password: "wrong")
        }
        #expect(await credentials.current() == nil)
    }

    @Test func signInRejectedOriginThrowsOriginRejected() async throws {
        defer { resetHandlerAfterTest() }
        AuthStubURLProtocol.handler.withLock { handler in
            handler = { _ in (403, [:], Data("{}".utf8)) }
        }
        let (flow, _) = try makeFlow()
        await #expect(throws: AuthError.originRejected) {
            _ = try await flow.signIn(email: "nicky@example.com", password: "hunter2")
        }
    }

    @Test func signInRateLimitedThrowsRateLimited() async throws {
        defer { resetHandlerAfterTest() }
        AuthStubURLProtocol.handler.withLock { handler in
            handler = { _ in (429, [:], Data("{}".utf8)) }
        }
        let (flow, _) = try makeFlow()
        await #expect(throws: AuthError.rateLimited) {
            _ = try await flow.signIn(email: "nicky@example.com", password: "hunter2")
        }
    }

    @Test func signOutClearsTheCredentialOnSuccess() async throws {
        defer { resetHandlerAfterTest() }
        AuthStubURLProtocol.handler.withLock { handler in
            handler = { request in
                #expect(request.url?.path() == "/api/auth/sign-out")
                #expect(request.value(forHTTPHeaderField: "Origin") == "cubby-mobile://")
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
                return (200, [:], Data("{}".utf8))
            }
        }
        let (flow, credentials) = try makeFlow(credential: .bearer("tok"))
        try await flow.signOut()
        #expect(await credentials.current() == nil)
    }

    @Test func signOutClearsTheCredentialEvenOnServerError() async throws {
        defer { resetHandlerAfterTest() }
        AuthStubURLProtocol.handler.withLock { handler in
            handler = { _ in (500, [:], Data("{}".utf8)) }
        }
        let (flow, credentials) = try makeFlow(credential: .bearer("tok"))
        await #expect(throws: AuthError.self) {
            try await flow.signOut()
        }
        #expect(await credentials.current() == nil)
    }
}
