import CubbyAPI

/// One page of rows. Every list endpoint declares its own generated page type — one per entity,
/// all with the same `{items, meta}` shape — so CubbyKit exposes one generic page instead.
public struct ListPage<T: Sendable>: Sendable {
    public let items: [T]
    public let meta: ListPageMeta
    /// Native presentation work captured for this exact query/page; legacy callers leave it nil.
    public let deferred: EntityListDeferred?

    public init(items: [T], meta: ListPageMeta, deferred: EntityListDeferred? = nil) {
        self.items = items
        self.meta = meta
        self.deferred = deferred
    }

    /// Pages through `fetch(page, pageSize)` until a short page, the server total, or `limit`
    /// items. The one paging loop; callers never hand-roll `while true { page += 1 }`.
    public static func collectAll(
        limit: Int = .max,
        pageSize: Int = 200,
        fetch: @Sendable (_ page: Int, _ pageSize: Int) async throws -> ListPage<T>
    ) async throws -> [T] {
        var items: [T] = []
        var page = 1
        while items.count < limit {
            let result = try await fetch(page, pageSize)
            items += result.items
            if result.items.count < pageSize || page * pageSize >= result.meta.totalCount { break }
            page += 1
        }
        return Array(items.prefix(limit))
    }
}

extension CubbyClient {
    /// Every row id of `descriptor` matching `filters`.
    public func listAllIDs(
        _ descriptor: EntityDescriptor, filters: EntityFilterState = EntityFilterState()
    ) async throws -> Set<String> {
        Set(
            try await ListPage.collectAll { page, size in
                try await list(descriptor, page: page, pageSize: size, filters: filters)
            }.map(\.id))
    }
}
