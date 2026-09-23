import Observation

/// One curated connection view. The server counts the full result and pages records with path evidence.
@MainActor
@Observable
public final class ConnectedSectionModel: Identifiable {
    public let spec: ConnectedViewSpec
    public let source: EntityRef
    public nonisolated let id: String
    public private(set) var items: [ConnectedRecord] = []
    public private(set) var totalCount = 0
    public private(set) var hopRange: ConnectedRecordsOutput.RouteHopRangePayload?
    public private(set) var loading = false
    public private(set) var loaded = false
    public private(set) var expanded = false
    public private(set) var error: String?
    public var hasMore: Bool { items.count < totalCount }

    private let client: CubbyClient
    private let pageSize = 20

    public init(spec: ConnectedViewSpec, source: EntityRef, client: CubbyClient) {
        self.spec = spec
        self.id = spec.key
        self.source = source
        self.client = client
    }

    public func loadInitial() async {
        guard !loaded else { return }
        await load(reset: true)
    }

    public func refresh() async { await load(reset: true) }

    public func loadNextPage() async {
        guard hasMore else { return }
        expanded = true
        await load(reset: false)
    }

    private func load(reset: Bool) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let result = try await client.connectedRecords(
                source: source, viewKey: spec.key,
                offset: reset ? 0 : items.count, limit: pageSize
            )
            items = reset ? result.items : items + result.items
            totalCount = result.totalCount
            hopRange = result.routeHopRange
            error = nil
            loaded = true
        } catch {
            self.error = String(describing: error)
        }
    }
}
