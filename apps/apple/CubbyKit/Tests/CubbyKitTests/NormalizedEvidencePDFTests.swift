import Foundation
import PDFKit
import Testing

@testable import CubbyKit

@Suite("Purchase import evidence files")
struct NormalizedEvidencePDFTests {
    @Test("Normalized evidence writes a readable PDF with matching metadata")
    func normalizedFile() async throws {
        let sourceURL = try #require(URL(string: "https://orders.example.test/order/1"))
        let capturedAt = Date(timeIntervalSince1970: 1_000)
        let evidence = try await NormalizedEvidencePDF.makeFile(
            NormalizedBrowserEvidence(
                sourceURL: sourceURL,
                capturedAt: capturedAt, captureVersion: 1,
                readableText: "Example order"))
        defer { try? FileManager.default.removeItem(at: evidence.url) }

        #expect(evidence.url.lastPathComponent.hasPrefix("normalized-evidence-"))
        #expect(evidence.url.pathExtension == "pdf")
        #expect(evidence.kind == .normalizedPdf)
        #expect(evidence.contentType == "application/pdf")

        let data = try Data(contentsOf: evidence.url)
        #expect(data.starts(with: Data("%PDF".utf8)))
        #expect(evidence.checksum == NormalizedEvidencePDF.sha256(data))
        let document = try #require(PDFDocument(data: data))
        #expect(document.pageCount == 1)
        let text = try #require(document.string)
        #expect(text.contains(sourceURL.absoluteString))
        #expect(text.contains(capturedAt.ISO8601Format()))
        #expect(text.contains("Example order"))
    }
}
