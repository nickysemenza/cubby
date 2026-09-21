import CoreGraphics
import Foundation
import ImageIO
import Testing

@testable import CubbyKit

/// Synthetic images: a flat colour and a two-tone split. Different enough that the identical
/// image must rank first, which is all the closed-set matcher promises.
private func image(_ fill: (CGContext, Int) -> Void, size: Int = 96) -> CGImage {
    let context = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    fill(context, size)
    return context.makeImage()!
}

private let red = image { ctx, size in
    ctx.setFillColor(CGColor(red: 0.9, green: 0.1, blue: 0.1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
}

private let split = image { ctx, size in
    ctx.setFillColor(CGColor(red: 0.1, green: 0.2, blue: 0.9, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: size / 2, height: size))
    ctx.setFillColor(CGColor(red: 0.95, green: 0.95, blue: 0.2, alpha: 1))
    ctx.fill(CGRect(x: size / 2, y: 0, width: size / 2, height: size))
}

@Suite("FeaturePrintIndex")
struct FeaturePrintIndexTests {
    @Test(.requiresVisionHardware) func identicalImageRanksFirstAndCacheRoundTrips() async throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "fp-\(UUID().uuidString)")
        let index = FeaturePrintIndex(cacheDirectory: dir)
        let url = URL(string: "https://example.invalid/cover.png")!
        try await index.add(productID: ProductCode("PRD-2345"), name: "Red", imageURL: url, image: red)
        try await index.add(productID: ProductCode("PRD-3456"), name: "Split", imageURL: url, image: split)

        let ranked = try await index.rank(split, limit: 2)
        #expect(ranked.first?.productID == ProductCode("PRD-3456"))
        #expect(ranked.first!.distance < ranked.last!.distance)
        #expect(ranked.first!.distance < 0.001)

        try await index.saveCache()
        let reloaded = FeaturePrintIndex(cacheDirectory: dir)
        #expect(try await reloaded.loadCache() == 2)
        let again = try await reloaded.rank(red, limit: 1)
        #expect(again.first?.productID == ProductCode("PRD-2345"))
        await reloaded.clear()
    }

    @Test func decodesAndDownsamplesPNGData() throws {
        let data = try #require(pngData(red))
        let decoded = try CoverImageLoader.decode(data, maxPixelSize: 32)
        #expect(decoded.width <= 32 && decoded.height <= 32)
    }
}

private func pngData(_ image: CGImage) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else {
        return nil
    }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
}
