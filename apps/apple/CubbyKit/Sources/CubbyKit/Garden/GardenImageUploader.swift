import CoreGraphics
import Foundation

/// Uploads garden photos as pending images. The record-entry workflow attaches the completed ids
/// in the same server transaction that creates the Garden Entry, so this intentionally does not
/// call `PhotoService.attachImages` itself.
public struct GardenImageUploader: Sendable {
    public enum Step: Sendable, Equatable {
        case encoding(Int, Int)
        case uploading(Int, Int)
        case done
    }

    private let service: any PhotoService
    private let put: @Sendable (Data, URL, String) async throws -> Void

    public init(
        service: any PhotoService,
        put: @escaping @Sendable (Data, URL, String) async throws -> Void = { data, url, contentType in
            try await PresignedUpload.put(data, to: url, contentType: contentType)
        }
    ) {
        self.service = service
        self.put = put
    }

    public func upload(
        _ images: [CGImage],
        progress: (@Sendable (Step) -> Void)? = nil
    ) async throws -> [ImageCode] {
        let entity = EntityKey(rawValue: "gardenEntry")!
        var ids: [ImageCode] = []
        for (offset, image) in images.enumerated() {
            let position = offset + 1
            progress?(.encoding(position, images.count))
            let data = try ImageEncoding.encode(image, as: .jpeg)
            let upload = try await service.createUpload(
                filename: "garden-entry-\(UUID().uuidString).jpg",
                size: data.count,
                format: .jpeg,
                entity: entity
            )
            progress?(.uploading(position, images.count))
            try await put(data, upload.uploadUrl, ImageEncoding.Format.jpeg.contentType)
            try await service.markUploaded(upload.imageId)
            ids.append(upload.imageId)
        }
        progress?(.done)
        return ids
    }
}
