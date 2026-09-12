import Foundation
import OpenAPIRuntime
import OpenAPIURLSession

/// The typed path into the API for the operations whose payload shape is load-bearing: scanning,
/// stray resolution, product lookup and creation, inventory creation, and the assistant.
///
/// Query-string operations (entity lists, UPC lookup, search, image list) live on `raw`, because
/// this API JSON-encodes query parameters and the tagged OpenAPI runtime cannot emit that yet.
/// Both paths share the credential provider and error decoding, so behaviour is identical.
public actor CubbyClient {
    public let baseURL: URL
    public let raw: CubbyRawClient
    public let credentials: CredentialProvider
    private let api: Client

    public init(baseURL: URL, credentials: CredentialProvider, session: URLSession = .cubbyShared) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.raw = CubbyRawClient(baseURL: baseURL, credentials: credentials, session: session)
        // The spec's `servers` entry is "/", so the base URL must always be supplied here.
        self.api = Client(
            serverURL: baseURL,
            configuration: .cubby,
            transport: URLSessionTransport(configuration: .init(session: session)),
            middlewares: [CubbyAuthMiddleware(credentials: credentials)]
        )
    }

    public func product(_ id: ProductCode) async throws -> ProductSummary {
        let output = try await api.resources_product_get(path: .init(id: id.rawValue))
        return ProductSummary(try output.ok.body.json)
    }

    public func scan(_ code: ScanCode, at location: LocationCode) async throws -> ScanResult {
        let output = try await api.inventory_scanAtLocation(body: .json(.init(location: location, code: code)))
        return ScanResult(try output.ok.body.json)
    }

    public func resolveStrays(to target: LocationCode, moves: [StrayMove]) async throws -> StrayResolution {
        let output = try await api.inventory_resolveScanStrays(body: .json(.init(target: target, moves: moves)))
        return StrayResolution(try output.ok.body.json)
    }

    public func findOrCreateProduct(upc: String, defaultName: String? = nil) async throws -> FoundProduct {
        let output = try await api.product_findOrCreateByUPC(body: .json(.init(upc: upc, defaultName: defaultName)))
        return FoundProduct(try output.ok.body.json)
    }

    /// Creates an inventory row counted in units ("each"). Returns the new entry's shortcode.
    public func createInventory(product: ProductCode, at location: LocationCode, count: Double) async throws -> InventoryEntryCode {
        let output = try await api.resources_inventory_create(
            body: .json(.init(productId: product.rawValue, locationId: location.rawValue, amount: .init(count), placement: nil))
        )
        // Generic mutation results wrap the row: `{action, entity, item, sideEffects}`.
        let created = try output.created.body.json
        return InventoryEntryCode(created.data.item.id)
    }

    public func ask(_ query: String) async throws -> AgentAnswer {
        let output = try await api.agent_ask(body: .json(.init(query: query)))
        return AgentAnswer(try output.ok.body.json)
    }
}
