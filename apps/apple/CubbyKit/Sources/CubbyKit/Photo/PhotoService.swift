import CubbyAPI
import Foundation

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

    /// A response whose URLs do not parse is an operation failure, not a decode failure.
    public init(_ out: InitiateUploadWithoutEntityResponse) throws {
        guard let uploadURL = URL(string: out.uploadUrl), let url = URL(string: out.url) else {
            throw CubbyAPIError(status: 0, operationID: "image.uploadImage", detail: nil)
        }
        self.init(uploadUrl: uploadURL, imageId: out.imageId, key: out.key, url: url)
    }
}

public struct ImageUploadRequest: Sendable, Hashable {
    public let filename: String
    public let size: Int
    public let contentType: String
    public let entity: EntityKey?
    public let algorithmRevision: Int
    public let perceptualHash: PerceptualHash64
    public let sourceFingerprint: SourceFingerprint
    public let width: Int
    public let height: Int

    public init(
        filename: String,
        size: Int,
        contentType: String,
        entity: EntityKey? = nil,
        algorithmRevision: Int = PerceptualHash64.algorithmRevision,
        perceptualHash: PerceptualHash64,
        sourceFingerprint: SourceFingerprint,
        width: Int,
        height: Int
    ) {
        self.filename = filename
        self.size = size
        self.contentType = contentType
        self.entity = entity
        self.algorithmRevision = algorithmRevision
        self.perceptualHash = perceptualHash
        self.sourceFingerprint = sourceFingerprint
        self.width = width
        self.height = height
    }
}

extension EntityDescriptor {
    /// Whether `resources.<key>.update` takes `pendingImageIds`; read from the generated route
    /// table, so it tracks the server without a catalog change.
    public var acceptsImages: Bool { OperationRoute.imageAttachableEntities.contains(key.rawValue) }
}

/// The server calls behind adding a photo. `CubbyClient` conforms; tests stub it.
public protocol PhotoService: Sendable {
    func createUpload(_ request: ImageUploadRequest) async throws -> ImageUpload
    /// Finalizes standalone uploads. Garden entry attachment finalizes its pending batch atomically.
    func markUploaded(_ id: ImageCode) async throws
    /// Attaches uploaded images to any entity whose update body takes `pendingImageIds`; throws
    /// `EntityOperationError.unsupported` for one that does not.
    func attachImages(_ ids: [ImageCode], to entity: EntityKey, id: String) async throws
    /// The entity's image ids in display order — the order `setImageOrder` rewrites.
    func imageIDs(entity: EntityKey, id: String) async throws -> [ImageCode]
    /// Rewrites the display order for any entity whose update body takes `imageOrder`; throws
    /// `EntityOperationError.unsupported` for one that does not.
    func setImageOrder(_ order: [ImageCode], entity: EntityKey, id: String) async throws
}

extension CubbyClient: PhotoService {
    public func createUpload(_ request: ImageUploadRequest) async throws -> ImageUpload {
        try await uploadImage(request)
    }

    public func attachImages(_ ids: [ImageCode], to entity: EntityKey, id: String) async throws {
        try await attachImages(ids, to: EntityCatalog[entity], id: id)
    }

    public func imageIDs(entity: EntityKey, id: String) async throws -> [ImageCode] {
        try await imageIDs(EntityCatalog[entity], id: id)
    }

    public func setImageOrder(_ order: [ImageCode], entity: EntityKey, id: String) async throws {
        try await setImageOrder(order, on: EntityCatalog[entity], id: id)
    }
}
