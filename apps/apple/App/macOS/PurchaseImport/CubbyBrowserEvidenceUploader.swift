import CubbyKit
import Foundation

actor CubbyBrowserEvidenceUploader: BrowserEvidenceUploading {
    private let client: CubbyClient

    init(client: CubbyClient) {
        self.client = client
    }

    func upload(
        _ evidence: BrowserLocalEvidence, runID: String, scope: BrowserEvidenceUploadScope?
    ) async throws
        -> BrowserEvidenceReference
    {
        if let scope {
            return try await uploadRunScoped(evidence, scope: scope)
        }
        // Account-sync commands predate explicit ImportRun targets. They retain their existing
        // operational storage path; targeted validation/enrichment always carries `scope` and
        // therefore cannot create a shared Image or Document through this fallback.
        switch evidence.kind {
        case .normalizedPdf, .renderedPdf:
            return try await uploadPDF(evidence, runID: runID)
        case .screenshot:
            return try await uploadScreenshot(evidence)
        }
    }

    private func uploadRunScoped(
        _ evidence: BrowserLocalEvidence, scope: BrowserEvidenceUploadScope
    ) async throws -> BrowserEvidenceReference {
        let byteSize = try evidence.url.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard let byteSize, byteSize > 0, byteSize <= 50 * 1024 * 1024 else {
            throw CocoaError(.fileReadTooLarge)
        }
        guard
            let contentType = InitiateImportRunEvidenceUploadInput.ContentTypePayload(
                rawValue: evidence.contentType)
        else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        let staged = try await client.initiateRunEvidenceUpload(
            InitiateImportRunEvidenceUploadInput(
                runPublicId: scope.runPublicID, targetId: scope.targetID, kind: .browserCapture,
                contentType: contentType, byteSize: byteSize, checksum: evidence.checksum,
                filename: evidence.url.lastPathComponent))
        // Presigned R2 evidence PUTs carry only their declared content type. The initiating
        // operation has already persisted immutable provenance and must not be repeated after a
        // network error by falling back to an Image or Document upload.
        guard let uploadURL = URL(string: staged.uploadUrl) else { throw URLError(.badURL) }
        try await PresignedUpload.putFile(
            evidence.url, to: uploadURL, contentType: evidence.contentType)
        return BrowserEvidenceReference(
            id: staged.evidenceId, kind: evidence.kind, checksum: evidence.checksum,
            contentType: evidence.contentType)
    }

    private func uploadPDF(_ evidence: BrowserLocalEvidence, runID: String) async throws
        -> BrowserEvidenceReference
    {
        let size = try evidence.url.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard let size else { throw CocoaError(.fileReadUnknown) }
        let upload = try await client.uploadDocument(
            filename: evidence.url.lastPathComponent, size: size, folder: Self.safeFolder(runID))
        try await PresignedUpload.putFile(
            evidence.url, to: upload.uploadUrl, contentType: evidence.contentType)
        try await client.markUploaded(upload.imageId)
        return BrowserEvidenceReference(
            id: upload.imageId.rawValue, kind: evidence.kind, checksum: evidence.checksum,
            contentType: evidence.contentType)
    }

    private func uploadScreenshot(_ evidence: BrowserLocalEvidence) async throws
        -> BrowserEvidenceReference
    {
        let file = try PhotoFile.importing(evidence.url)
        let photo = try PreparedPhoto.prepare(file: file)
        let pending = PendingImageUpload(service: client)
        let upload = try await pending.upload(photo, entity: nil)
        try await client.markUploaded(upload.imageID)
        return BrowserEvidenceReference(
            id: upload.imageID.rawValue, kind: evidence.kind, checksum: evidence.checksum,
            contentType: evidence.contentType)
    }

    private static func safeFolder(_ runID: String) -> String? {
        let safe = runID.map { character in
            character.isLetter || character.isNumber || character == "-" || character == "_"
                ? character : "-"
        }
        let value = String(safe.prefix(64))
        return value.isEmpty ? nil : value
    }
}
