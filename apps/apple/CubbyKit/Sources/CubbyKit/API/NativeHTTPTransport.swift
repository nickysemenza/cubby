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
        operationID: String,
        body: Data? = nil,
        nullInput: Bool = false
    ) async throws -> Data {
        try Task.checkCancellation()
        guard OperationCatalog.all.contains(operationID) else {
            throw NativeRequestError.unknownOperation(operationID)
        }
        guard !nullInput || body == nil else {
            throw NativeRequestError.conflictingInput(operationID)
        }
        let encodedID = operationID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        guard let encodedID else { throw URLError(.badURL) }
        let url = baseURL.appending(path: "api/operations/\(encodedID)")
        var envelope: [String: Any] = ["operation": operationID]
        if let body {
            envelope["input"] = try JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed])
        } else if nullInput {
            envelope["input"] = NSNull()
        }
        let requestBody = try JSONSerialization.data(
            withJSONObject: envelope, options: [.fragmentsAllowed, .sortedKeys])
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = requestBody
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
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
                operationID: operationID,
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
                status: response.statusCode, operationID: operationID, body: data)
        }
        do {
            guard
                let envelope = try JSONSerialization.jsonObject(
                    with: data, options: [.fragmentsAllowed])
                    as? [String: Any],
                envelope["ok"] as? Bool == true,
                let value = envelope["data"]
            else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: [], debugDescription: "Expected a successful operation envelope"))
            }
            return try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        } catch {
            throw CubbyAPIError.decode(status: response.statusCode, operationID: operationID, body: data)
        }
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

    func request<Output: Decodable & Sendable>(
        _ operation: String, nullInput: Bool
    ) async throws -> Output {
        try await decodeResponse(operation: operation, nullInput: nullInput)
    }

    func request<Body: Encodable & Sendable, Output: Decodable & Sendable>(
        _ operation: String, body: Body
    ) async throws -> Output {
        try await decodeResponse(operation: operation, body: JSONEncoder.cubby().encode(body))
    }

    private func decodeResponse<Output: Decodable & Sendable>(
        operation: String, body: Data? = nil, nullInput: Bool = false
    ) async throws -> Output {
        guard OperationCatalog.all.contains(operation) else {
            throw NativeRequestError.unknownOperation(operation)
        }
        let data = try await nativeTransport.send(
            operationID: operation, body: body, nullInput: nullInput)
        try Task.checkCancellation()
        return try JSONDecoder.cubby().decode(Output.self, from: data)
    }
}

enum NativeRequestError: Error, LocalizedError {
    case unknownOperation(String)
    case conflictingInput(String)

    var errorDescription: String? {
        switch self {
        case .unknownOperation(let operation): "Undeclared native operation: \(operation)"
        case .conflictingInput(let operation):
            "Operation input cannot be both null and a JSON body: \(operation)"
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
