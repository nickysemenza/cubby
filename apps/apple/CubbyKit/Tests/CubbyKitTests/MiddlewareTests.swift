import Foundation
import HTTPTypes
import OpenAPIRuntime
import Testing

@testable import CubbyKit

@Suite("CubbyAuthMiddleware")
struct MiddlewareTests {
    private func provider(with credential: CubbyCredential?) throws -> (
        CredentialProvider, InMemorySessionTokenStore
    ) {
        let store = InMemorySessionTokenStore()
        if let credential { try store.save(credential, for: "localhost:3000") }
        return (CredentialProvider(host: "localhost:3000", store: store), store)
    }

    @Test func injectsBearerHeaderAndPassesSuccessThrough() async throws {
        let (credentials, _) = try provider(with: .bearer("tok.sig"))
        let middleware = CubbyAuthMiddleware(credentials: credentials)
        let (response, _) = try await middleware.intercept(
            HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/v1/products"),
            body: nil,
            baseURL: URL(string: "http://localhost:3000")!,
            operationID: "resources.product.list"
        ) { request, body, _ in
            #expect(request.headerFields[.authorization] == "Bearer tok.sig")
            #expect(request.headerFields[.xAPIKey] == nil)
            return (HTTPResponse(status: .ok), body)
        }
        #expect(response.status == .ok)
    }

    @Test func persistsAndSendsOnlySignedSessionDataCookies() async throws {
        let (credentials, _) = try provider(with: .bearer("tok.sig"))
        let middleware = CubbyAuthMiddleware(credentials: credentials)
        var fields = HTTPFields()
        fields[values: .setCookie] = [
            "better-auth.session_data.0=cache-a; Path=/; HttpOnly",
            "better-auth.session_token=do-not-store; Path=/; HttpOnly",
        ]
        let responseHeaders = fields
        _ = try await middleware.intercept(
            HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/v1/products"),
            body: nil,
            baseURL: URL(string: "http://localhost:3000")!,
            operationID: "resources.product.list"
        ) { _, body, _ in
            (HTTPResponse(status: .ok, headerFields: responseHeaders), body)
        }

        _ = try await middleware.intercept(
            HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/v1/vendors"),
            body: nil,
            baseURL: URL(string: "http://localhost:3000")!,
            operationID: "resources.vendor.list"
        ) { request, body, _ in
            #expect(request.headerFields[.cookie] == "better-auth.session_data.0=cache-a")
            #expect(request.headerFields[.cookie]?.contains("session_token") == false)
            return (HTTPResponse(status: .ok), body)
        }
    }

    @Test func appliesTokenRotationAndCookiesFromTypedResponses() async throws {
        let (credentials, _) = try provider(with: .bearer("before"))
        let middleware = CubbyAuthMiddleware(credentials: credentials)
        var mutableFields = HTTPFields()
        mutableFields[HTTPField.Name("set-auth-token")!] = "after"
        mutableFields[values: .setCookie] = [
            "better-auth.session_data=cache; Max-Age=300; Path=/"
        ]
        // Swift 6 rejects capturing a `var` in the concurrently-executing response closure.
        let fields = mutableFields

        _ = try await middleware.intercept(
            HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/v1/products"),
            body: nil,
            baseURL: URL(string: "https://cubby.example")!,
            operationID: "resources.product.list"
        ) { _, body, _ in
            (HTTPResponse(status: .ok, headerFields: fields), body)
        }

        #expect(await credentials.current() == .bearer("after"))
        #expect(
            await credentials.currentState()?.sessionDataCookies == [
                "better-auth.session_data": "cache"
            ])
    }

    @Test func lateTypedUnauthorizedResponseCannotClearANewerLogin() async throws {
        let (credentials, _) = try provider(with: .bearer("old"))
        let middleware = CubbyAuthMiddleware(credentials: credentials)
        let body = try Fixtures.data(named: "error-unauthorized.json")

        await #expect(throws: CubbyAPIError.self) {
            _ = try await middleware.intercept(
                HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/v1/products"),
                body: nil,
                baseURL: URL(string: "https://cubby.example")!,
                operationID: "resources.product.list"
            ) { _, _, _ in
                try await credentials.set(.bearer("new"))
                return (HTTPResponse(status: .unauthorized), HTTPBody(body))
            }
        }

        #expect(await credentials.current() == .bearer("new"))
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

    @Test func injectsAPIKeyHeader() async throws {
        let (credentials, _) = try provider(with: .apiKey("cubby_x"))
        let middleware = CubbyAuthMiddleware(credentials: credentials)
        _ = try await middleware.intercept(
            HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/x"),
            body: nil,
            baseURL: URL(string: "http://localhost:3000")!,
            operationID: "x"
        ) { request, body, _ in
            #expect(request.headerFields[.xAPIKey] == "cubby_x")
            #expect(request.headerFields[.authorization] == nil)
            return (HTTPResponse(status: .ok), body)
        }
    }

    @Test func unauthorizedDecodesEnvelopeAndInvalidatesCredential() async throws {
        let (credentials, store) = try provider(with: .bearer("stale"))
        let middleware = CubbyAuthMiddleware(credentials: credentials)
        let body = try Fixtures.data(named: "error-unauthorized.json")
        await #expect(throws: CubbyAPIError.self) {
            _ = try await middleware.intercept(
                HTTPRequest(method: .post, scheme: nil, authority: nil, path: "/x"),
                body: nil,
                baseURL: URL(string: "http://localhost:3000")!,
                operationID: "inventory.scanAtLocation"
            ) { _, _, _ in
                (HTTPResponse(status: .unauthorized), HTTPBody(body))
            }
        }
        #expect(await credentials.current() == nil)
        #expect(try store.load(for: "localhost:3000") == nil)
    }

    @Test func serverErrorWithoutEnvelopeHasNoDetail() async throws {
        let (credentials, store) = try provider(with: .bearer("fine"))
        let middleware = CubbyAuthMiddleware(credentials: credentials)
        let html = try Fixtures.data(named: "error-html-502.txt")
        do {
            _ = try await middleware.intercept(
                HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/x"),
                body: nil,
                baseURL: URL(string: "http://localhost:3000")!,
                operationID: "resources.product.get"
            ) { _, _, _ in
                (HTTPResponse(status: .badGateway), HTTPBody(html))
            }
            Issue.record("expected CubbyAPIError")
        } catch let error as CubbyAPIError {
            #expect(error.status == 502)
            #expect(error.detail == nil)
            #expect(error.operationID == "resources.product.get")
        }
        // A 502 is not an auth failure; the credential survives.
        #expect(try store.load(for: "localhost:3000") == .bearer("fine"))
    }

    /// Developer overlays layer 6: the installed `RequestObserver` records every request's
    /// operation id, timing, and status — including a decoded error response, whose status is
    /// still known before the middleware throws.
    @Test func recordsOperationIDTimingAndStatusThroughTheInstalledObserver() async throws {
        let (credentials, _) = try provider(with: .bearer("tok.sig"))
        let trace = await RequestTrace()
        let middleware = CubbyAuthMiddleware(credentials: credentials, observer: trace)
        _ = try await middleware.intercept(
            HTTPRequest(method: .get, scheme: nil, authority: nil, path: "/api/v1/products"),
            body: nil,
            baseURL: URL(string: "http://localhost:3000")!,
            operationID: "resources.product.list"
        ) { _, body, _ in
            (HTTPResponse(status: .ok), body)
        }
        let last = await trace.last
        #expect(last?.operationID == "resources.product.list")
        #expect(last?.status == 200)
        #expect((last?.ms ?? -1) >= 0)
    }
}
