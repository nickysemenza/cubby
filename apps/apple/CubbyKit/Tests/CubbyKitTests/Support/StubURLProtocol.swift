import Foundation
import Synchronization

/// Shared plumbing for a per-suite network stub: a handler installed per test answers every
/// request, on a private session configuration that never touches the real network.
///
/// Swift does not allow a stored `static` property on a generic type, so one `StubURLProtocol<Tag>`
/// shared across suites is not an option here. Every suite that stubs the network instead declares
/// its own tiny `final class: URLProtocol` with its own `static let handler = Mutex<Handler?>(nil)`,
/// forwarding the four required overrides into this enum — Swift Testing schedules independent
/// `@Suite` types concurrently even when each is individually `.serialized`, so a handler shared
/// across suites intermittently answers one suite's request with another's stubbed response
/// (confirmed empirically while writing the original per-file copies this replaces). This file
/// keeps everything but that per-suite stamp — building the response, the failure path, and the
/// ephemeral session — in one place.
///
/// ```swift
/// final class MySuiteStubProtocol: URLProtocol, @unchecked Sendable {
///     static let handler = Mutex<StubNetworking.Handler?>(nil)
///     override class func canInit(with request: URLRequest) -> Bool { true }
///     override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
///     override func startLoading() {
///         StubNetworking.startLoading(request, client: client, target: self, handler: Self.handler.withLock { $0 })
///     }
///     override func stopLoading() {}
///     static func session() -> URLSession { StubNetworking.session(protocolClass: self) }
/// }
/// ```
enum StubNetworking {
    typealias Handler = @Sendable (URLRequest) -> (Int, Data)

    static func startLoading(_ request: URLRequest, client: URLProtocolClient?, target: URLProtocol, handler: Handler?) {
        guard let handler else {
            client?.urlProtocol(target, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(target, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(target, didLoad: data)
        client?.urlProtocolDidFinishLoading(target)
    }

    static func session(protocolClass: AnyClass) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [protocolClass]
        return URLSession(configuration: configuration)
    }
}
