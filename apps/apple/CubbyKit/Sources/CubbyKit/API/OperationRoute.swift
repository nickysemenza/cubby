/// One HTTP operation from the OpenAPI document: method, path template, and what it accepts.
/// The table itself (`OperationRoute.all`) is generated into `Generated/OperationRoutes.swift`
/// by `apps/web/scripts/generate-http-openapi.ts`, so every operation the server exposes is
/// reachable from the raw client and the CLI without a hand-kept list.
public struct OperationRoute: Sendable, Hashable {
    public enum Method: String, Sendable {
        case get = "GET"
        case post = "POST"
        case patch = "PATCH"
        case delete = "DELETE"
    }

    public let operationID: String
    public let method: Method
    /// Path relative to the base URL. `{id}` is substituted by `CubbyRawClient`.
    public let path: String
    /// Names of the `{…}` placeholders in `path` (only `id` today).
    public let pathParameters: [String]
    /// Query parameter names the operation declares; every value is JSON-encoded on the wire.
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

    /// The route for an operationId, or a status-0 `CubbyAPIError` naming the id when the
    /// document has no such operation.
    public static func lookup(_ operationID: String) throws -> OperationRoute {
        guard let route = all[operationID] else {
            throw CubbyAPIError(status: 0, operationID: operationID, detail: nil)
        }
        return route
    }

    /// The route serving `method path`, for callers that know an entity's `basePath` but not its
    /// key (operationIds use the singular key, `resources.product.list`; paths use the plural
    /// base path, `/api/v1/products`).
    public static func lookup(method: Method, path: String) throws -> OperationRoute {
        guard let route = byMethodAndPath["\(method.rawValue) \(path)"] else {
            throw CubbyAPIError(status: 0, operationID: "\(method.rawValue) \(path)", detail: nil)
        }
        return route
    }

    private static let byMethodAndPath: [String: OperationRoute] = Dictionary(
        uniqueKeysWithValues: all.values.map { ("\($0.method.rawValue) \($0.path)", $0) }
    )
}
