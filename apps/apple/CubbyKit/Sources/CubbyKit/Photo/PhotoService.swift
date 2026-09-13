import Foundation

public struct ImageCode: RawRepresentable, Sendable, Hashable, Codable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
}

/// What `image.uploadImage` hands back: where to PUT the bytes, and the id to mark afterwards.
public struct ImageUpload: Sendable, Hashable, Decodable {
    public let uploadUrl: URL
    public let imageId: ImageCode
    public let key: String
    public let url: URL

    public init(uploadUrl: URL, imageId: ImageCode, key: String, url: URL) {
        self.uploadUrl = uploadUrl
        self.imageId = imageId
        self.key = key
        self.url = url
    }
}

extension EntityDescriptor {
    /// Whether `resources.<key>.update` takes `pendingImageIds`; read from the generated route
    /// table, so it tracks the server without a catalog change.
    public var acceptsImages: Bool { OperationRoute.imageAttachableEntities.contains(key.rawValue) }
}

/// The server calls behind adding a photo. `CubbyClient` conforms; tests stub it.
public protocol PhotoService: Sendable {
    func createUpload(filename: String, size: Int, format: ImageEncoding.Format, entity: EntityKey)
        async throws -> ImageUpload
    /// Finalizes standalone uploads. Garden entry attachment finalizes its pending batch atomically.
    func markUploaded(_ id: ImageCode) async throws
    /// Attaches uploaded images to any entity whose update body takes `pendingImageIds`; throws
    /// `EntityOperationError.unsupported` for one that does not.
    func attachImages(_ ids: [ImageCode], to entity: EntityKey, id: String) async throws
    /// The product's image ids in display order.
    func productImageIDs(_ product: ProductCode) async throws -> [ImageCode]
    func setImageOrder(_ order: [ImageCode], product: ProductCode) async throws
}

extension CubbyClient: PhotoService {
    public func createUpload(
        filename: String,
        size: Int,
        format: ImageEncoding.Format,
        entity: EntityKey
    ) async throws -> ImageUpload {
        try await uploadImage(filename: filename, size: size, format: format, entity: entity)
    }

    public func attachImages(_ ids: [ImageCode], to entity: EntityKey, id: String) async throws {
        try await attachImages(ids, to: EntityCatalog[entity], id: id)
    }

    public func setImageOrder(_ order: [ImageCode], product: ProductCode) async throws {
        try await setImageOrder(order, on: EntityCatalog[.product], id: product.rawValue)
    }
}
