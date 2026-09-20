import Foundation
import Testing

@testable import CubbyKit

@Suite("Purchase import evidence files")
struct NormalizedEvidencePDFTests {
    @Test("Normalized evidence has a semantic filename")
    func normalizedFilename() async throws {
        let evidence = try await NormalizedEvidencePDF.makeFile(
            NormalizedBrowserEvidence(
                sourceURL: try #require(URL(string: "https://orders.example.test/order/1")),
                capturedAt: Date(timeIntervalSince1970: 1_000), captureVersion: 1,
                readableText: "Example order"))
        defer { try? FileManager.default.removeItem(at: evidence.url) }

        #expect(evidence.url.lastPathComponent.hasPrefix("normalized-evidence-"))
        #expect(evidence.url.pathExtension == "pdf")
    }
}
