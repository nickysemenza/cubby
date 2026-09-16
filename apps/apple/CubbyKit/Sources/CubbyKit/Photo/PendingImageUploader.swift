import CoreGraphics
import Foundation

/// Uploads a batch of photos as pending images for one entity, for an editor or a photo import to
/// attach in a single record mutation (`pendingImageIds`). Photos stay intact: no subject lifting
/// or background removal on this path, unlike `PhotoUploader`.
public struct PendingImageUploader: Sendable {
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

    public let entity: EntityKey
    private let pending: PendingImageUpload

    public init(
        entity: EntityKey,
        service: any PhotoService,
        put: @escaping PresignedUpload.FilePut = {
            try await PresignedUpload.putFile($0, to: $1, contentType: $2)
        }
    ) {
        self.entity = entity
        pending = PendingImageUpload(service: service, put: put)
    }

    public func upload(
        _ files: [PhotoFile],
        progress: (@Sendable (Step) -> Void)? = nil
    ) async throws -> [ImageCode] {
        var ids: [ImageCode] = []
        for (offset, file) in files.enumerated() {
            let position = offset + 1
            do {
                progress?(.encoding(position, files.count))
                let photo = try PreparedPhoto.prepare(file: file)
                let result = try await pending.upload(photo, entity: entity) { phase in
                    if phase == .uploading { progress?(.uploading(position, files.count)) }
                }
                // The record mutation that attaches the batch marks the images uploaded in the
                // same transaction (see `PhotoService.markUploaded`); this path never calls it.
                // The id is kept after PUT so a failed save reuses the bytes.
                ids.append(result.imageID)
            } catch {
                throw PartialFailure(completedIDs: ids, completedCount: offset, underlying: error)
            }
        }
        progress?(.done)
        return ids
    }

    public func upload(
        _ images: [CGImage],
        progress: (@Sendable (Step) -> Void)? = nil
    ) async throws -> [ImageCode] {
        var files: [PhotoFile] = []
        do {
            for image in images {
                let data = try ImageEncoding.encode(image, as: .jpeg)
                files.append(
                    try PhotoFile.materialize(
                        data,
                        filename: "\(entity.rawValue)-\(UUID().uuidString).jpg",
                        contentType: ImageEncoding.Format.jpeg.contentType))
            }
        } catch {
            throw PartialFailure(completedIDs: [], completedCount: 0, underlying: error)
        }
        return try await upload(files, progress: progress)
    }
}
