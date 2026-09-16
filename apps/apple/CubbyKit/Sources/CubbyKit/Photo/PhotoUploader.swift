import CoreGraphics
import Foundation

/// Adds one photo to an entity, in the only order the server accepts:
///
/// 1. `image.uploadImage` presigns a PUT for exactly these bytes.
/// 2. PUT the bytes (no auth header; see `PresignedUpload`).
/// 3. `image.markUploaded` — never skipped, a `PENDING` image is culled.
/// 4. `PATCH <entity>/{id} {pendingImageIds}` attaches it.
/// 5. For a cover (`makeCover`), a **second** PATCH `{imageOrder: [new] + existing}`: the server
///    applies `imageOrder` before `pendingImageIds`, so ordering in the same call as attaching
///    would name an image that is not yet attached.
public actor PhotoUploader {
    public enum Step: Sendable, Hashable, CaseIterable {
        case encoding, presigning, uploading, marking, attaching, ordering, done
    }

    public struct Request: Sendable {
        fileprivate let preparedPhoto: PreparedPhoto?
        fileprivate let file: PhotoFile?
        fileprivate let image: CGImage?
        fileprivate let format: ImageEncoding.Format
        fileprivate let sourceFingerprint: SourceFingerprint?
        public let entity: EntityKey
        public let entityID: String
        public let makeCover: Bool
        public let filenameBase: String

        public init(
            photo: PreparedPhoto,
            entity: EntityKey,
            entityID: String,
            makeCover: Bool = false
        ) {
            preparedPhoto = photo
            file = nil
            image = nil
            format = .jpeg
            sourceFingerprint = photo.sourceFingerprint
            self.entity = entity
            self.entityID = entityID
            self.makeCover = makeCover
            filenameBase = "photo"
        }

        public init(
            file: PhotoFile,
            entity: EntityKey,
            entityID: String,
            makeCover: Bool = false
        ) {
            preparedPhoto = nil
            self.file = file
            image = nil
            format = .jpeg
            sourceFingerprint = nil
            self.entity = entity
            self.entityID = entityID
            self.makeCover = makeCover
            filenameBase = "photo"
        }

        public init(
            image: CGImage,
            format: ImageEncoding.Format = .jpeg,
            entity: EntityKey,
            entityID: String,
            makeCover: Bool = false,
            filenameBase: String = "photo",
            sourceFingerprint: SourceFingerprint? = nil
        ) {
            preparedPhoto = nil
            file = nil
            self.image = image
            self.format = format
            self.sourceFingerprint = sourceFingerprint
            self.entity = entity
            self.entityID = entityID
            self.makeCover = makeCover
            self.filenameBase = filenameBase
        }
    }

    public struct Outcome: Sendable, Hashable {
        public let imageID: ImageCode
        public let url: URL
        public let byteCount: Int
    }

    public struct Checkpoint: Sendable {
        fileprivate let outcome: Outcome
        fileprivate var marked = false
        fileprivate var attached = false
    }

    public struct Failure: Error, Sendable {
        public let checkpoint: Checkpoint?
        public let underlying: Error
    }

    private let service: any PhotoService
    private let pending: PendingImageUpload

    public init(
        service: any PhotoService,
        put: @escaping PresignedUpload.FilePut = {
            try await PresignedUpload.putFile($0, to: $1, contentType: $2)
        }
    ) {
        self.service = service
        pending = PendingImageUpload(service: service, put: put)
    }

    public func upload(
        _ request: Request, resuming checkpoint: Checkpoint? = nil,
        progress: (@Sendable (Step) -> Void)? = nil
    ) async throws
        -> Outcome
    {
        var saved = checkpoint
        do {
            if saved == nil { saved = try await uploadBytes(request, progress: progress) }
            guard var current = saved else { throw CocoaError(.fileWriteUnknown) }
            if !current.marked {
                progress?(.marking)
                try await service.markUploaded(current.outcome.imageID)
                current.marked = true
                saved = current
            }
            if !current.attached {
                progress?(.attaching)
                try await service.attachImages(
                    [current.outcome.imageID], to: request.entity, id: request.entityID)
                current.attached = true
                saved = current
            }
            if request.makeCover {
                progress?(.ordering)
                let existing = try await service.imageIDs(entity: request.entity, id: request.entityID)
                    .filter { $0 != current.outcome.imageID }
                try await service.setImageOrder(
                    [current.outcome.imageID] + existing, entity: request.entity, id: request.entityID)
            }
            progress?(.done)
            return current.outcome
        } catch { throw Failure(checkpoint: saved, underlying: error) }
    }

    /// Reuses bytes already in Cubby. Existing images are attached directly: there is no
    /// presign, PUT, or mark step because the stored image is already finalized.
    public func attachExisting(
        _ imageID: ImageCode,
        entity: EntityKey,
        entityID: String,
        makeCover: Bool = false,
        progress: (@Sendable (Step) -> Void)? = nil
    ) async throws {
        progress?(.attaching)
        try await service.attachImages([imageID], to: entity, id: entityID)
        if makeCover {
            progress?(.ordering)
            let existing = try await service.imageIDs(entity: entity, id: entityID).filter { $0 != imageID }
            try await service.setImageOrder([imageID] + existing, entity: entity, id: entityID)
        }
        progress?(.done)
    }

    private func uploadBytes(_ request: Request, progress: (@Sendable (Step) -> Void)?) async throws
        -> Checkpoint
    {
        progress?(.encoding)
        let photo = try prepare(request)
        let result = try await pending.upload(
            photo, entity: request.entity
        ) { phase in
            switch phase {
            case .presigning: progress?(.presigning)
            case .uploading: progress?(.uploading)
            }
        }

        return Checkpoint(
            outcome: Outcome(
                imageID: result.imageID, url: result.url, byteCount: photo.file.size))
    }

    private func prepare(_ request: Request) throws -> PreparedPhoto {
        if let preparedPhoto = request.preparedPhoto { return preparedPhoto }
        if let file = request.file { return try PreparedPhoto.prepare(file: file) }
        guard let image = request.image else { throw CocoaError(.fileReadUnknown) }
        // CGImage input means the caller deliberately produced edited pixels. Encode every pixel;
        // the former 2048px upload cap is intentionally absent.
        let data = try ImageEncoding.encode(image, as: request.format)
        let file = try PhotoFile.materialize(
            data,
            filename: "\(request.filenameBase).\(request.format.fileExtension)",
            contentType: request.format.contentType)
        return try PreparedPhoto.prepare(file: file, sourceFingerprint: request.sourceFingerprint)
    }
}
