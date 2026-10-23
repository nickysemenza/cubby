import Foundation
import Synchronization

@testable import CubbyKit

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

    /// Answers `request` with `handler`. `detached` runs the handler on a global queue instead of
    /// the session's loading thread, so a handler that parks on a test `Gate` (`holdBlocking()`)
    /// cannot stall the session's other requests.
    static func startLoading(
        _ request: URLRequest, client: URLProtocolClient?, target: URLProtocol, handler: Handler?,
        detached: Bool = false
    ) {
        guard let handler else {
            client?.urlProtocol(target, didFailWithError: URLError(.badServerResponse))
            return
        }
        guard !detached else {
            // URLProtocol is not Sendable; the client is only messaged after the handler returns.
            nonisolated(unsafe) let target = target
            DispatchQueue.global().async {
                respond(request, with: handler(request), client: client, target: target)
            }
            return
        }
        respond(request, with: handler(request), client: client, target: target)
    }

    private static func respond(
        _ request: URLRequest, with answer: (status: Int, data: Data), client: URLProtocolClient?,
        target: URLProtocol
    ) {
        let responseData = operationResponseData(
            request: request, status: answer.status, data: answer.data)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: answer.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(target, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(target, didLoad: responseData)
        client?.urlProtocolDidFinishLoading(target)
    }

    static func operationInput(of request: URLRequest) -> JSONValue? {
        guard request.url?.path.hasPrefix("/api/operations/") == true,
            let data = try? requestBody(request),
            let envelope = try? JSONDecoder().decode(JSONValue.self, from: data),
            envelope["operation"]?.stringValue == request.url?.lastPathComponent
        else { return nil }
        return envelope["input"]
    }

    static func operationFields(of request: URLRequest) -> [String: JSONValue] {
        operationInput(of: request)?.objectValue ?? [:]
    }

    static func operationResponseData(request: URLRequest, status: Int, data: Data) -> Data {
        guard request.url?.path.hasPrefix("/api/operations/") == true,
            (200..<300).contains(status)
        else { return data }
        let payload =
            data.isEmpty
            ? NSNull()
            : (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) ?? NSNull()
        if (payload as? [String: Any])?["ok"] is Bool { return data }
        return
            (try? JSONSerialization.data(
                withJSONObject: ["ok": true, "data": payload],
                options: [.fragmentsAllowed, .sortedKeys])) ?? data
    }

    static func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { throw URLError(.cannotDecodeRawData) }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { return data }
            data.append(contentsOf: buffer.prefix(count))
        }
    }

    static func session(protocolClass: AnyClass) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [protocolClass]
        return URLSession(configuration: configuration)
    }
}
