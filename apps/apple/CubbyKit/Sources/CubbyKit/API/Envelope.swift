/// Cubby's success envelope: `{ok:true,data}`. The failure shape is `CubbyAPIError.ErrorDetail`,
/// decoded separately by `CubbyAPIError.decode`.
public struct SuccessEnvelope<T: Decodable & Sendable>: Decodable, Sendable {
    public let ok: Bool
    public let data: T
}

/// The `data` shape for every list endpoint: `{items, meta:{pageIndex,pageSize,totalCount}}`.
public struct ListPage<T: Decodable & Sendable>: Decodable, Sendable {
    public let items: [T]
    public let meta: PageMeta
}

public struct PageMeta: Decodable, Sendable {
    public let pageIndex: Int
    public let pageSize: Int
    public let totalCount: Int
}
