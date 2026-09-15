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
            #expect(request.headerFields[HTTPField.Name("x-cubby-read-consistency")!] == nil)
            #expect(request.headerFields[HTTPField.Name("x-cubby-fresh-read")!] == nil)
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
            #expect(request.headerFields[HTTPField.Name("x-cubby-read-consistency")!] == nil)
            #expect(request.headerFields[HTTPField.Name("x-cubby-fresh-read")!] == nil)
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
}
