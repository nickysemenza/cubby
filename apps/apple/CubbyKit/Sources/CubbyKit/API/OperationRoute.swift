/// One native HTTP operation derived from its declaration by `pnpm generate`.
/// Typed calls and the CLI share this table rather than keeping route literals.
public struct OperationRoute: Sendable, Hashable {
    public enum Method: String, Sendable {
        case get = "GET"
        case post = "POST"
        case patch = "PATCH"
        case delete = "DELETE"
    }

    public let operationID: String
    public let method: Method
    /// Path relative to the base URL.
    public let path: String
    /// Query parameter names the operation declares. Values travel literally; an array repeats
    /// its key.
    public let queryParameters: [String]
    public let hasBody: Bool

    public init(
        operationID: String,
        method: Method,
        path: String,
        queryParameters: [String] = [],
        hasBody: Bool = false
    ) {
        self.operationID = operationID
        self.method = method
        self.path = path
        self.queryParameters = queryParameters
        self.hasBody = hasBody
    }
}
