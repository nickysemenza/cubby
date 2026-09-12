import CubbyAPI

/// One page of rows. Every list endpoint declares its own generated page type — sixteen of them,
/// one per entity, all with the same `{items, meta}` shape — so CubbyKit exposes one generic page
/// instead of surfacing all sixteen.
public struct ListPage<T: Sendable>: Sendable {
    public let items: [T]
    public let meta: PageMeta

    public init(items: [T], meta: PageMeta) {
        self.items = items
        self.meta = meta
    }
}

public struct PageMeta: Sendable, Hashable {
    /// 1-based, as the API numbers pages.
    public let pageIndex: Int
    public let pageSize: Int
    public let totalCount: Int

    public init(pageIndex: Int, pageSize: Int, totalCount: Int) {
        self.pageIndex = pageIndex
        self.pageSize = pageSize
        self.totalCount = totalCount
    }

    init(_ meta: Components.Schemas.ListPageMeta) {
        self.init(pageIndex: meta.pageIndex, pageSize: meta.pageSize, totalCount: meta.totalCount)
    }
}
