/// One HTTP operation from the OpenAPI document: method, path template, and what it accepts.
/// The table itself (`OperationRoute.all`) is generated into `Generated/OperationRoutes.swift`
/// by `scripts/generator/http-api/native.ts`, so every operation the server exposes is
/// reachable from `CubbyDebugClient` and the CLI without a hand-kept list. The generated
/// `Client` covers the same document but cannot be enumerated at runtime.
public struct OperationRoute: Sendable, Hashable {
    public enum Method: String, Sendable {
        case get = "GET"
        case post = "POST"
        case patch = "PATCH"
        case delete = "DELETE"
    }

    public let operationID: String
    public let method: Method
    /// Path relative to the base URL. `{id}` is substituted by `CubbyDebugClient`.
    public let path: String
    /// Names of the `{…}` placeholders in `path` (only `id` today).
    public let pathParameters: [String]
    /// Query parameter names the operation declares. Values travel literally; an array repeats
    /// its key.
    public let queryParameters: [String]
    public let hasBody: Bool

    public init(
        operationID: String,
        method: Method,
        path: String,
        pathParameters: [String] = [],
        queryParameters: [String] = [],
        hasBody: Bool = false
    ) {
        self.operationID = operationID
        self.method = method
        self.path = path
        self.pathParameters = pathParameters
        self.queryParameters = queryParameters
        self.hasBody = hasBody
    }
}
