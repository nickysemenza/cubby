import Foundation

/// The presign-then-PUT step shared by every pending-image upload path: `image.uploadImage`
/// presigns a PUT for exactly these bytes, then the bytes go up (no auth header — see
/// `PresignedUpload`). This is only that middle step. Callers own everything on either side of
/// it: encoding/subject-lifting choices, whether `markUploaded` runs at all (only `PhotoUploader`
/// calls it — a garden entry's create/update finalizes its whole pending batch atomically, per
/// `PhotoService.markUploaded`'s doc comment), attach/cover ordering, checkpoints, and
/// batch/partial-failure semantics.
public struct PendingImageUpload: Sendable {
    /// The two sub-steps this type performs, for callers that report progress at that
    /// granularity. `PhotoUploader` surfaces both; `PendingImageUploader` only cares about
    /// `.uploading` (it never reported presigning separately).
    public enum Phase: Sendable, Equatable {
        case presigning, uploading
    }

    /// What the caller needs after the bytes land: the id to reference the pending image by, and
    /// the URL it's readable at (a standalone upload uses this before the image is even attached,
    /// e.g. to index a product photo for Identify).
    public struct Result: Sendable, Hashable {
        public let imageID: ImageCode
        public let url: URL
    }

    private let service: any PhotoService
    private let put: PresignedUpload.FilePut

    public init(
        service: any PhotoService,
        put: @escaping PresignedUpload.FilePut = {
            try await PresignedUpload.putFile($0, to: $1, contentType: $2)
        }
    ) {
        self.service = service
        self.put = put
    }

    public func upload(
        _ photo: PreparedPhoto,
        entity: EntityKey?,
        progress: (@Sendable (Phase) -> Void)? = nil
    ) async throws -> Result {
        progress?(.presigning)
        let file = photo.file
        // PUT receives only a URL; retain its temporary-file owner across the async transfer.
        defer { withExtendedLifetime(file) {} }
        let upload = try await service.createUpload(
            ImageUploadRequest(
                filename: file.filename,
                size: file.size,
                contentType: file.contentType,
                entity: entity,
                perceptualHash: photo.perceptualHash,
                sourceFingerprint: photo.sourceFingerprint,
                width: file.width,
                height: file.height))
        progress?(.uploading)
        try await put(file.url, upload.uploadUrl, file.contentType)
        return Result(imageID: upload.imageId, url: upload.url)
    }
}
