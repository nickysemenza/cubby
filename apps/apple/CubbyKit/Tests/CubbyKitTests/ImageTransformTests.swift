import Foundation
import Testing

@testable import CubbyKit

@Suite("ImageTransform")
struct ImageTransformTests {
    @Test func widthLadderIsThreeRungs() {
        #expect(ImageTransform.widths == [128, 640, 2048])
    }

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
        let url = try #require(URL(string: "https://media.nickysemenza.com/products/abc.jpg"))
        let result = ImageTransform.transformed(url, renderedWidth: 64)
        #expect(
            result.absoluteString
                == "https://media.nickysemenza.com/cdn-cgi/image/width=128,quality=80,format=auto,fit=scale-down/products/abc.jpg"
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
                    "https://media.nickysemenza.com/cdn-cgi/image/width=640,quality=80,format=auto,fit=scale-down/products/abc.jpg"
            ))
        let result = ImageTransform.transformed(url, renderedWidth: 64)
        #expect(result == url)
    }

    @Test func preservesQueryString() throws {
        let url = try #require(URL(string: "https://media.nickysemenza.com/products/abc.jpg?v=2"))
        let result = ImageTransform.transformed(url, renderedWidth: 64)
        #expect(
            result.absoluteString
                == "https://media.nickysemenza.com/cdn-cgi/image/width=128,quality=80,format=auto,fit=scale-down/products/abc.jpg?v=2"
        )
    }

    @Test func hashSourceBoundsBothDimensionsAndPinsJPEG() throws {
        let url = try #require(URL(string: "https://media.nickysemenza.com/products/abc.heic?v=2"))
        #expect(
            ImageTransform.hashSource(url).absoluteString
                == "https://media.nickysemenza.com/cdn-cgi/image/width=256,height=256,quality=80,format=jpeg,fit=scale-down/products/abc.heic?v=2"
        )
    }
}
