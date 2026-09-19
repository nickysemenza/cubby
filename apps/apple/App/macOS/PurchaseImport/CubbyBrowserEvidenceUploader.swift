import CubbyKit
import Foundation

actor CubbyBrowserEvidenceUploader: BrowserEvidenceUploading {
    private let client: CubbyClient

    init(client: CubbyClient) {
        self.client = client
    }

    func upload(_ evidence: BrowserLocalEvidence, runID: String) async throws
        -> BrowserEvidenceReference
    {
        switch evidence.kind {
        case .normalizedPDF, .renderedPDF:
            return try await uploadPDF(evidence, runID: runID)
        case .screenshot:
            return try await uploadScreenshot(evidence)
        }
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
