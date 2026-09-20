import CoreGraphics
import CoreText
import CryptoKit
import Foundation

public struct NormalizedBrowserEvidence: Sendable, Hashable {
    public let sourceURL: URL
    public let capturedAt: Date
    public let captureVersion: Int
    public let readableText: String

    public init(sourceURL: URL, capturedAt: Date, captureVersion: Int, readableText: String) {
        self.sourceURL = sourceURL
        self.capturedAt = capturedAt
        self.captureVersion = captureVersion
        self.readableText = readableText
    }
}

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

public protocol BrowserEvidenceUploading: Sendable {
    func upload(_ evidence: BrowserLocalEvidence, runID: String) async throws
        -> BrowserEvidenceReference
}

public enum NormalizedEvidencePDF {
    public enum Failure: Error, Sendable {
        case consumerCreation
        case contextCreation
        case emptyDocument
    }

    private static let page = CGRect(x: 0, y: 0, width: 612, height: 792)
    private static let content = CGRect(x: 48, y: 48, width: 516, height: 696)

    @concurrent
    public static func makeFile(_ evidence: NormalizedBrowserEvidence) async throws
        -> BrowserLocalEvidence
    {
        let data = try makeData(evidence)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "CubbyBrowserEvidence", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(UUID().uuidString + ".pdf")
        try data.write(to: url, options: .atomic)
        return BrowserLocalEvidence(
            url: url, kind: .normalizedPDF, checksum: sha256(data), contentType: "application/pdf")
    }

    public static func makeData(_ evidence: NormalizedBrowserEvidence) throws -> Data {
        let data = NSMutableData()
        guard let consumer = CGDataConsumer(data: data as CFMutableData) else {
            throw Failure.consumerCreation
        }
        var mediaBox = page
        let metadata: [CFString: Any] = [
            kCGPDFContextTitle: "Cubby normalized browser evidence",
            kCGPDFContextCreator: "Cubby",
        ]
        guard let context = CGContext(consumer: consumer, mediaBox: &mediaBox, metadata as CFDictionary)
        else { throw Failure.contextCreation }

        let header = """
            CUBBY-GENERATED EVIDENCE — NOT A VENDOR ORIGINAL
            Source: \(evidence.sourceURL.absoluteString)
            Captured: \(evidence.capturedAt.ISO8601Format())
            Capture version: \(evidence.captureVersion)

            """
        let fullText =
            header
            + String(
                evidence.readableText.prefix(BrowserBridgeProtocol.maximumReadableTextCharacters))
        guard !fullText.isEmpty else { throw Failure.emptyDocument }
        let attributed = NSMutableAttributedString(string: fullText)
        attributed.addAttributes(
            [
                NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName(
                    "Helvetica" as CFString, 10, nil),
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(
                    gray: 0.12, alpha: 1),
            ], range: NSRange(location: 0, length: attributed.length))
        let headerLength = (header as NSString).length
        attributed.addAttributes(
            [
                NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName(
                    "Helvetica-Bold" as CFString, 10, nil)
            ], range: NSRange(location: 0, length: headerLength))

        let framesetter = CTFramesetterCreateWithAttributedString(attributed)
        var location = 0
        repeat {
            context.beginPDFPage(nil)
            context.saveGState()
            context.textMatrix = .identity
            let path = CGPath(rect: content, transform: nil)
            let frame = CTFramesetterCreateFrame(
                framesetter, CFRange(location: location, length: 0), path, nil)
            CTFrameDraw(frame, context)
            let visible = CTFrameGetVisibleStringRange(frame)
            context.restoreGState()
            context.endPDFPage()
            guard visible.length > 0 else { break }
            location += visible.length
        } while location < attributed.length
        context.closePDF()
        return data as Data
    }

    public static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// A PDF rendered from Cubby's dedicated browser window. It complements the normalized text PDF
/// with the browser's actual visual layout without exposing an arbitrary page-evaluation surface.
public enum RenderedBrowserEvidencePDF {
    public static func makeFile(from image: CGImage) throws -> BrowserLocalEvidence {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "CubbyBrowserEvidence", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(UUID().uuidString + ".pdf")
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
            url: url, kind: .renderedPDF, checksum: NormalizedEvidencePDF.sha256(data),
            contentType: "application/pdf")
    }
}
