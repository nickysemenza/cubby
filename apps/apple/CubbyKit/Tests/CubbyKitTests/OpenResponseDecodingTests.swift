import Foundation
import Testing

@testable import CubbyKit

@Suite("Open response decoding")
struct OpenResponseDecodingTests {
    /// Regression: the OpenAPI emitter used to close every output object, so the generated
    /// `init(from:)` called `ensureNoAdditionalProperties` and an installed build rejected any
    /// response the server had gained a field on. A response body must decode with a key this
    /// build has never heard of.
    @Test("a response with an unknown key still decodes")
    func unknownResponseKeyIsIgnored() throws {
        let body = """
            {
              "id": "IMG-4K7M",
              "url": "https://example.test/i/4K7M",
              "key": "images/4K7M",
              "filename": "photo.jpeg",
              "size": 1024,
              "contentType": "image/jpeg",
              "status": "UPLOADED",
              "source": "unknown",
              "useOriginal": false,
              "captureAttribution": "none",
              "createdAt": "2026-09-21T00:00:00.000Z",
              "updatedAt": "2026-09-21T00:00:00.000Z",
              "fieldFromAFutureServer": {"nested": true}
            }
            """
        let image = try JSONDecoder.cubby().decode(ImageOut.self, from: Data(body.utf8))
        #expect(image.filename == "photo.jpeg")
        #expect(image.width == nil)
    }
}
