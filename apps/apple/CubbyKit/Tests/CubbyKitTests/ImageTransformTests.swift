import Foundation
import Testing

@testable import CubbyKit

@Suite("ImageTransform")
struct ImageTransformTests {
    @Test(
        "snaps a rendered width up to the next rung",
        arguments: [
            (16.0, 128), (64.0, 128), (65.0, 640), (320.0, 640), (321.0, 2048), (1600.0, 2048),
        ]
    )
    func snapsToRung(renderedWidth: Double, expectedRung: Int) {
        #expect(ImageTransform.transformWidth(renderedWidth: CGFloat(renderedWidth)) == expectedRung)
    }

    @Test func rewritesBucketURLExactly() throws {
        let url = try #require(URL(string: "\(SharedConstants.mediaOrigin)/products/abc.jpg"))
        let result = ImageTransform.transformed(url, renderedWidth: 64)
        #expect(
            result.absoluteString
                == "\(SharedConstants.mediaOrigin)/cdn-cgi/image/width=128,quality=80,format=auto,fit=scale-down/products/abc.jpg"
        )
    }

    @Test func leavesNonBucketHostUntouched() throws {
        let url = try #require(URL(string: "https://example.com/products/abc.jpg"))
        let result = ImageTransform.transformed(url, renderedWidth: 64)
        #expect(result == url)
    }

    @Test func leavesAlreadyTransformedURLUntouched() throws {
        let url = try #require(
            URL(
                string:
                    "\(SharedConstants.mediaOrigin)/cdn-cgi/image/width=640,quality=80,format=auto,fit=scale-down/products/abc.jpg"
            ))
        let result = ImageTransform.transformed(url, renderedWidth: 64)
        #expect(result == url)
    }

    @Test func preservesQueryString() throws {
        let url = try #require(URL(string: "\(SharedConstants.mediaOrigin)/products/abc.jpg?v=2"))
        let result = ImageTransform.transformed(url, renderedWidth: 64)
        #expect(
            result.absoluteString
                == "\(SharedConstants.mediaOrigin)/cdn-cgi/image/width=128,quality=80,format=auto,fit=scale-down/products/abc.jpg?v=2"
        )
    }

    @Test func hashSourceBoundsBothDimensionsAndPinsJPEG() throws {
        let url = try #require(URL(string: "\(SharedConstants.mediaOrigin)/products/abc.heic?v=2"))
        #expect(
            ImageTransform.hashSource(url).absoluteString
                == "\(SharedConstants.mediaOrigin)/cdn-cgi/image/width=256,height=256,quality=80,format=jpeg,fit=scale-down/products/abc.heic?v=2"
        )
    }

    /// Shared with `apps/web/src/lib/image-url.unit.test.ts`: both clients mint the same URLs so
    /// the Cloudflare edge cache is shared (`packages/shared/golden-vectors/image-url.json`).
    @Test func matchesTheSharedGoldenVectors() throws {
        struct Width: Decodable {
            let rendered: Double
            let rung: Int
        }
        struct Rewrite: Decodable {
            let `in`: String
            let width: Double
            let out: String?
        }
        struct File: Decodable {
            let rungs: [Int]
            let widths: [Width]
            let rewrites: [Rewrite]
        }
        let file = try GoldenVectors.decode(File.self, named: "image-url")
        let bucket = SharedConstants.mediaOrigin
        #expect(ImageTransform.widths == file.rungs)
        for width in file.widths {
            #expect(
                ImageTransform.transformWidth(renderedWidth: CGFloat(width.rendered)) == width.rung,
                "rendered \(width.rendered)")
        }
        for rewrite in file.rewrites {
            let input = try #require(
                URL(string: rewrite.in.replacingOccurrences(of: "{bucket}", with: bucket)))
            let expected = rewrite.out.map { $0.replacingOccurrences(of: "{bucket}", with: bucket) }
            #expect(
                ImageTransform.transformed(input, renderedWidth: CGFloat(rewrite.width)).absoluteString
                    == (expected ?? input.absoluteString),
                "input \(rewrite.in)")
        }
    }
}
