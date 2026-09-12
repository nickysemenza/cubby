/// A hand-written (method, path) table for the operations the raw client and the CLI `call`
/// command can reach by operationId. Deliberately small: the typed generated client covers the
/// body-carrying operations, and the generic entity paths come from `EntityCatalog.basePath`.
/// Grow this from the spec with a script only once the hand-written list is actually limiting.
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

    public init(operationID: String, method: Method, path: String) {
        self.operationID = operationID
        self.method = method
        self.path = path
    }

    public static let known: [String: OperationRoute] = Dictionary(
        uniqueKeysWithValues: [
            OperationRoute(operationID: "resources.location.list", method: .get, path: "/api/v1/locations"),
            OperationRoute(operationID: "resources.product.list", method: .get, path: "/api/v1/products"),
            OperationRoute(operationID: "resources.product.get", method: .get, path: "/api/v1/products/{id}"),
            OperationRoute(operationID: "resources.inventory.create", method: .post, path: "/api/v1/inventory"),
            OperationRoute(operationID: "inventory.scanAtLocation", method: .post, path: "/api/v1/inventory/scanAtLocation"),
            OperationRoute(operationID: "inventory.resolveScanStrays", method: .post, path: "/api/v1/inventory/resolveScanStrays"),
            OperationRoute(operationID: "product.findOrCreateByUPC", method: .post, path: "/api/v1/product/findOrCreateByUPC"),
            OperationRoute(operationID: "upc.lookup", method: .get, path: "/api/v1/upc/lookup"),
            OperationRoute(operationID: "image.list", method: .get, path: "/api/v1/image/list"),
            OperationRoute(operationID: "search.find", method: .get, path: "/api/v1/search/find"),
            OperationRoute(operationID: "agent.ask", method: .post, path: "/api/v1/agent/ask"),
        ].map { ($0.operationID, $0) }
    )
}
