import CubbyAPI

/// One page of rows. Every list endpoint declares its own generated page type — one per entity,
/// all with the same `{items, meta}` shape — so CubbyKit exposes one generic page instead.
public struct ListPage<T: Sendable>: Sendable {
    public let items: [T]
    public let meta: ListPageMeta

    public init(items: [T], meta: ListPageMeta) {
        self.items = items
        self.meta = meta
    }
}
