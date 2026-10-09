import CoreGraphics
import Foundation

public struct BrowserLocalEvidence: Sendable, Hashable {
    public let url: URL
    public let kind: BrowserEvidenceKind
    public let checksum: String
    public let contentType: String

    public init(url: URL, kind: BrowserEvidenceKind, checksum: String, contentType: String) {
        self.url = url
        self.kind = kind
        self.checksum = checksum
        self.contentType = contentType
    }
}

/// The server grants this scope only for an explicit target in a targeted import run. The run
/// and target UUIDs are both required to stage immutable R2 evidence without creating an Image
/// or Document; the run's public code never reaches the bridge.
public struct BrowserEvidenceUploadScope: Sendable, Hashable {
    public let runID: String
    public let targetID: String

    public init(runID: String, targetID: String) {
        self.runID = runID
        self.targetID = targetID
    }
}

public protocol BrowserEvidenceUploading: Sendable {
    func upload(
        _ evidence: BrowserLocalEvidence, runID: String, scope: BrowserEvidenceUploadScope?
    ) async throws
        -> BrowserEvidenceReference
}

/// A PDF rendered from the screenshot of Cubby's dedicated browser window, uploaded beside the PNG.
public enum RenderedBrowserEvidencePDF {
    public static func makeFile(from image: CGImage, to url: URL) throws -> BrowserLocalEvidence {
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        var mediaBox = CGRect(x: 0, y: 0, width: width, height: height)
        guard let context = CGContext(url as CFURL, mediaBox: &mediaBox, nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        context.beginPDFPage(nil)
        context.interpolationQuality = .high
        context.draw(image, in: mediaBox)
        context.endPDFPage()
        context.closePDF()
        let data = try Data(contentsOf: url)
        return BrowserLocalEvidence(
            url: url, kind: .renderedPdf, checksum: data.sha256Hex,
            contentType: "application/pdf")
    }
}
