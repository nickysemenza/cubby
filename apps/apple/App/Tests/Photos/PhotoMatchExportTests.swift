import CoreGraphics
import CubbyKit
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import Cubby

@MainActor
struct PhotoMatchExportTests {
    @Test("Diagnostic files preserve hashed pixels, source bytes, and the sharing lifetime")
    func losslessExportAndLease() async throws {
        let context = try #require(
            CGContext(
                data: nil, width: 192, height: 256, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.7, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 192, height: 256))
        context.setFillColor(CGColor(red: 0.9, green: 0.3, blue: 0.1, alpha: 1))
        context.fill(CGRect(x: 23, y: 51, width: 95, height: 120))
        let image = try #require(context.makeImage())
        let data = NSMutableData()
        let destination = try #require(
            CGImageDestinationCreateWithData(
                data, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        try #require(CGImageDestinationFinalize(destination))
        let file = try PhotoFile.materialize(data as Data, filename: "synthetic.png")
        let json = Data("{\"readOnly\":true}".utf8)
        var export: PhotoMatchExport? = try await PhotoMatchExport.prepare(
            json: json, thumbnail: image, file: file)
        let directory = try #require(export?.directory)
        let savedParent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: savedParent, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: savedParent) }
        let savedReport = savedParent.appendingPathComponent(directory.lastPathComponent)
            .appendingPathComponent("photo-match.json")
        weak var releasedExport = export
        do {
            let sharingLease = try #require(export)
            export = nil
            #expect(sharingLease.urls.count == 3)
            #expect(try Data(contentsOf: sharingLease.urls[0]) == json)
            let source = try #require(CGImageSourceCreateWithURL(sharingLease.urls[1] as CFURL, nil))
            let exportedImage = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
            #expect(exportedImage.width == image.width)
            #expect(exportedImage.height == image.height)
            #expect(try PerceptualHash64.compute(exportedImage) == PerceptualHash64.compute(image))
            #expect(try Data(contentsOf: sharingLease.urls[2]) == Data(contentsOf: file.url))
            try await sharingLease.save(in: savedParent)
            withExtendedLifetime(sharingLease) {
                #expect(FileManager.default.fileExists(atPath: directory.path))
            }
        }
        #expect(releasedExport == nil)
        #expect(!FileManager.default.fileExists(atPath: directory.path))
        #expect(try Data(contentsOf: savedReport) == json)
        #expect(FileManager.default.fileExists(atPath: file.url.path))
    }
}
