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
}
