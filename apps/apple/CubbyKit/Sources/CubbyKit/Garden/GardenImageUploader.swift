import CoreGraphics
import Foundation

/// Uploads garden photos as pending images. Garden scenes intentionally stay intact: there is no
/// subject lifting or background removal in this path.
public struct GardenImageUploader: Sendable {
    public enum Step: Sendable, Equatable {
        case encoding(Int, Int)
        case uploading(Int, Int)
        case done
    }

    /// A failed batch retains the ids which did finish. Callers can retry the remaining local
    /// images, then attach the combined ids in one record mutation.
    public struct PartialFailure: Error, Sendable {
        public let completedIDs: [ImageCode]
        public let completedCount: Int
        public let underlying: Error
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
            do {
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
                // Garden entry attachment marks pending images uploaded in the same transaction
                // as the entry. Keep this id after PUT so failed record saves reuse the bytes.
                ids.append(upload.imageId)
            } catch {
                throw PartialFailure(completedIDs: ids, completedCount: offset, underlying: error)
            }
        }
        progress?(.done)
        return ids
    }
}
