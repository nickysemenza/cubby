import Observation

/// One curated connection view's complete list, opened from the detail page's "N more" row. The
/// server counts the full result and pages records with path evidence.
@MainActor
@Observable
public final class ConnectedSectionModel: Identifiable {
    public let spec: ConnectedViewSpec
    public let source: EntityRef
    public nonisolated let id: String
    public private(set) var items: [ConnectedRecord] = []
    public private(set) var totalCount = 0
    public private(set) var loading = false
    public private(set) var loaded = false
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
            error = nil
            loaded = true
        } catch {
            self.error = String(describing: error)
        }
    }
}

/// The detail page's one Connected records section: every curated view's count and first rows
/// from a single `entity.connectedRecordsPreview` read.
@MainActor
@Observable
public final class ConnectedRecordsPreviewModel {
    public let source: EntityRef
    public private(set) var preview: ConnectedRecordsPreviewOutput?
    public private(set) var loading = false
    public private(set) var error: String?

    private let client: CubbyClient

    public init(source: EntityRef, client: CubbyClient) {
        self.source = source
        self.client = client
    }

    public func loadInitial() async {
        guard preview == nil else { return }
        await refresh()
    }

    public func refresh() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            preview = try await client.connectedRecordsPreview(source: source)
            error = nil
        } catch {
            self.error = String(describing: error)
        }
    }
}

/// How a connected row's path and hop count read on every client.
public enum ConnectedPathPresentation {
    /// The records strictly between source and target; empty for a direct connection. They read
    /// by entity kind because paths repeat names (an Expense is named after its Product).
    public static func intermediates(_ path: [ConnectedPathNode]) -> [ConnectedPathNode] {
        path.count > 2 ? Array(path.dropFirst().dropLast()) : []
    }

    public static func hopLabel(_ hops: Int) -> String { hops == 1 ? "1 hop" : "\(hops) hops" }
}
