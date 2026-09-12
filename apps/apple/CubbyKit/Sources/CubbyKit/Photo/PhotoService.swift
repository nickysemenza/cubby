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
    func createUpload(filename: String, size: Int, contentType: String, entity: EntityKey) async throws -> ImageUpload
    /// Never skipped: an image left `PENDING` is culled by the server.
    func markUploaded(_ id: ImageCode) async throws
    /// Attaches uploaded images to any entity whose update body takes `pendingImageIds`.
    func attachImages(_ ids: [ImageCode], to entity: EntityKey, id: String) async throws
    /// The product's uploaded image ids in display order.
    func productImageIDs(_ product: ProductCode) async throws -> [ImageCode]
    func setImageOrder(_ order: [ImageCode], product: ProductCode) async throws
}

public enum PhotoServiceError: Error, Sendable, Hashable {
    case entityDoesNotAcceptImages(EntityKey)
}

extension CubbyClient: PhotoService {
    /// `image.uploadImage`'s `entityType` names the owning table for storage placement; entities
    /// outside its enum upload untyped.
    private static let uploadEntityTypes: [EntityKey: String] = [
        .product: "PRODUCT", .recipe: "RECIPE", .cookbook: "COOKBOOK",
        .location: "LOCATION", .project: "PROJECT", .purchase: "PURCHASE",
    ]

    public func createUpload(filename: String, size: Int, contentType: String, entity: EntityKey) async throws -> ImageUpload {
        var body: [String: JSONValue] = [
            "filename": .string(filename), "size": .number(Double(size)), "contentType": .string(contentType),
        ]
        if let type = Self.uploadEntityTypes[entity] { body["entityType"] = .string(type) }
        return try await raw.call("image.uploadImage", body: .object(body), as: ImageUpload.self)
    }

    public func markUploaded(_ id: ImageCode) async throws {
        _ = try await raw.call("image.markUploaded", body: ["id": .string(id.rawValue)])
    }

    public func attachImages(_ ids: [ImageCode], to entity: EntityKey, id: String) async throws {
        let descriptor = EntityCatalog[entity]
        guard descriptor.acceptsImages else { throw PhotoServiceError.entityDoesNotAcceptImages(entity) }
        let route = try OperationRoute.lookup(method: .patch, path: "/api/v1/\(descriptor.basePath)/{id}")
        _ = try await raw.call(route, pathID: id, body: ["pendingImageIds": .array(ids.map { .string($0.rawValue) })])
    }

    public func productImageIDs(_ product: ProductCode) async throws -> [ImageCode] {
        let object = try await raw.get(basePath: EntityCatalog[.product].basePath, id: product.rawValue)
        guard let row = EntityCatalog[.product].row(from: object) else { return [] }
        return ProductRelations.gallery(from: row).map { ImageCode($0.id) }
    }

    public func setImageOrder(_ order: [ImageCode], product: ProductCode) async throws {
        let route = try OperationRoute.lookup(method: .patch, path: "/api/v1/\(EntityCatalog[.product].basePath)/{id}")
        _ = try await raw.call(route, pathID: product.rawValue, body: ["imageOrder": .array(order.map { .string($0.rawValue) })])
    }
}
