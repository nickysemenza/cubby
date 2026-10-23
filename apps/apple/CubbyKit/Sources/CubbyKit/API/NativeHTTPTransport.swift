import Foundation
import HTTPTypes
import Synchronization

/// The shared HTTP implementation for typed native operations and dynamic commands.
struct NativeHTTPTransport: Sendable {
    let baseURL: URL
    let credentials: CredentialProvider
    let identity: ClientIdentity
    let session: URLSession
    let observer: (any RequestObserver)?

    func send(
        route: OperationRoute,
        query: [(String, String)] = [],
        body: Data? = nil
    ) async throws -> Data {
        try Task.checkCancellation()
        guard
            var components = URLComponents(
                url: baseURL.appending(path: route.path), resolvingAgainstBaseURL: false
            )
        else {
            throw URLError(.badURL)
        }
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.0, value: $0.1) }
            // URLSearchParams treats an unescaped plus as a space. Preserve literal plus values.
            components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(
                of: "+", with: "%2B")
        }
        guard let url = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = route.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        }
        let authentication = await credentials.requestState()
        var fields = HTTPFields()
        NativeRequestHeaders.apply(authentication, identity: identity, to: &fields)
        for field in fields {
            request.setValue(field.value, forHTTPHeaderField: field.name.rawName)
        }
        let start = Date()
        let delegate = NativeResponseDelegate { response in
            await credentials.processResponse(
                for: authentication,
                status: response.statusCode,
                setAuthToken: response.value(forHTTPHeaderField: "set-auth-token"),
                setCookieHeaders: Self.setCookieHeaders(response),
                responseURL: response.url ?? url)
            await observer?.record(
                operationID: route.operationID,
                ms: Date().timeIntervalSince(start) * 1000,
                status: response.statusCode)
        }
        let task = session.dataTask(with: request)
        task.delegate = delegate
        let (data, response) = try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await delegate.collect(task)
        } onCancel: {
            task.cancel()
        }
        try Task.checkCancellation()
        guard (200..<300).contains(response.statusCode) else {
            throw CubbyAPIError.decode(
                status: response.statusCode, operationID: route.operationID, body: data)
        }
        return data
    }

    private static func setCookieHeaders(_ response: HTTPURLResponse) -> [String] {
        response.allHeaderFields.flatMap { key, value -> [String] in
            guard String(describing: key).caseInsensitiveCompare("Set-Cookie") == .orderedSame else {
                return []
            }
            if let values = value as? [String] { return values }
            return [String(describing: value)]
        }
    }
}

extension CubbyClient {
    func request<Output: Decodable & Sendable>(_ operation: String) async throws -> Output {
        try await decodeResponse(operation: operation)
    }

    func request<Body: Encodable & Sendable, Output: Decodable & Sendable>(
        _ operation: String, body: Body
    ) async throws -> Output {
        try await decodeResponse(operation: operation, body: JSONEncoder.cubby().encode(body))
    }

    func request<Query: Encodable & Sendable, Output: Decodable & Sendable>(
        _ operation: String, query: Query
    ) async throws -> Output {
        let value = try JSONValue(encoding: query)
        guard let fields = value.objectValue else {
            throw NativeRequestError.invalidQuery(operation)
        }
        let parameters = try fields.sorted { $0.key < $1.key }.flatMap { key, value -> [(String, String)] in
            if value == .null { return [] }
            let values = value.arrayValue ?? [value]
            return try values.map { value in
                let text: String
                switch value {
                case .string(let string): text = string
                case .bool(let boolean): text = boolean ? "true" : "false"
                case .number(let number):
                    let number = String(number)
                    text = number.hasSuffix(".0") ? String(number.dropLast(2)) : number
                default: throw NativeRequestError.invalidQuery("\(operation).\(key)")
                }
                return (key, text)
            }
        }
        return try await decodeResponse(operation: operation, query: parameters)
    }

    private func decodeResponse<Output: Decodable & Sendable>(
        operation: String, query: [(String, String)] = [], body: Data? = nil
    ) async throws -> Output {
        guard let route = OperationRoute.all[operation] else {
            throw NativeRequestError.unknownOperation(operation)
        }
        let data = try await nativeTransport.send(route: route, query: query, body: body)
        try Task.checkCancellation()
        return try JSONDecoder.cubby().decode(Output.self, from: data)
    }
}

enum NativeRequestError: Error, LocalizedError {
    case unknownOperation(String)
    case invalidQuery(String)

    var errorDescription: String? {
        switch self {
        case .unknownOperation(let operation): "Undeclared native operation: \(operation)"
        case .invalidQuery(let operation): "Native query requires flat scalar values: \(operation)"
        }
    }
}

/// A task delegate keeps received-header policy separate from body completion.
private final class NativeResponseDelegate: NSObject, URLSessionDataDelegate, Sendable {
    private struct State {
        var data = Data()
        var response: HTTPURLResponse?
        var headers: Task<Void, Never>?
        var continuation: CheckedContinuation<(Data, HTTPURLResponse), any Error>?
        var result: Result<(Data, HTTPURLResponse), any Error>?
    }
    private let state = Mutex(State())
    let receive: @Sendable (HTTPURLResponse) async -> Void
    init(receive: @escaping @Sendable (HTTPURLResponse) async -> Void) { self.receive = receive }

    func collect(_ task: URLSessionDataTask) async throws -> (Data, HTTPURLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            state.withLock { state in
                if let result = state.result {
                    continuation.resume(with: result)
                } else {
                    state.continuation = continuation
                }
            }
            task.delegate = self
            task.resume()
        }
    }

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        guard let response = response as? HTTPURLResponse else { completionHandler(.cancel); return }
        state.withLock { state in
            state.response = response
            state.headers = Task {
                await receive(response); completionHandler(.allow)
            }
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        state.withLock { $0.data.append(data) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        let headers = state.withLock { $0.headers }
        Task {
            await headers?.value
            state.withLock { state in
                let result: Result<(Data, HTTPURLResponse), any Error>
                if let error {
                    result = .failure(error)
                } else if let response = state.response {
                    result = .success((state.data, response))
                } else {
                    result = .failure(URLError(.badServerResponse))
                }
                state.result = result
                state.continuation?.resume(with: result)
                state.continuation = nil
            }
        }
    }
}
