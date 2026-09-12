import CoreGraphics
import Foundation

/// Adds one photo to an entity, in the only order the server accepts:
///
/// 1. `image.uploadImage` presigns a PUT for exactly these bytes.
/// 2. PUT the bytes (no auth header; see `PresignedUpload`).
/// 3. `image.markUploaded` — never skipped, a `PENDING` image is culled.
/// 4. `PATCH <entity>/{id} {pendingImageIds}` attaches it.
/// 5. For a product cover, a **second** PATCH `{imageOrder: [new] + existing}`: the server
///    applies `imageOrder` before `pendingImageIds`, so ordering in the same call as attaching
///    would name an image that is not yet attached.
public actor PhotoUploader {
    public enum Step: Sendable, Hashable, CaseIterable {
        case encoding, presigning, uploading, marking, attaching, ordering, done
    }

    public struct Request: Sendable {
        public let image: CGImage
        public let format: ImageEncoding.Format
        public let entity: EntityKey
        public let entityID: String
        public let makeCover: Bool
        public let filenameBase: String
        public let maxPixelSize: Int

        public init(
            image: CGImage,
            format: ImageEncoding.Format = .jpeg,
            entity: EntityKey,
            entityID: String,
            makeCover: Bool = false,
            filenameBase: String = "photo",
            maxPixelSize: Int = 2048
        ) {
            self.image = image
            self.format = format
            self.entity = entity
            self.entityID = entityID
            self.makeCover = makeCover
            self.filenameBase = filenameBase
            self.maxPixelSize = maxPixelSize
        }
    }

    public struct Outcome: Sendable, Hashable {
        public let imageID: ImageCode
        public let url: URL
        public let byteCount: Int
    }

    private let service: any PhotoService
    private let put: PresignedUpload.Put

    public init(service: any PhotoService, put: @escaping PresignedUpload.Put = { try await PresignedUpload.put($0, to: $1, contentType: $2) }) {
        self.service = service
        self.put = put
    }

    public func upload(_ request: Request, progress: (@Sendable (Step) -> Void)? = nil) async throws -> Outcome {
        progress?(.encoding)
        let scaled = try ImageEncoding.downscaled(request.image, maxPixelSize: request.maxPixelSize)
        let data = try ImageEncoding.encode(scaled, as: request.format)

        progress?(.presigning)
        let filename = "\(request.filenameBase).\(request.format.fileExtension)"
        let upload = try await service.createUpload(
            filename: filename, size: data.count, format: request.format, entity: request.entity
        )

        progress?(.uploading)
        try await put(data, upload.uploadUrl, request.format.contentType)

        progress?(.marking)
        try await service.markUploaded(upload.imageId)

        progress?(.attaching)
        try await service.attachImages([upload.imageId], to: request.entity, id: request.entityID)

        if request.makeCover, request.entity == .product {
            progress?(.ordering)
            let product = ProductCode(request.entityID)
            let existing = try await service.productImageIDs(product).filter { $0 != upload.imageId }
            try await service.setImageOrder([upload.imageId] + existing, product: product)
        }

        progress?(.done)
        return Outcome(imageID: upload.imageId, url: upload.url, byteCount: data.count)
    }
}
