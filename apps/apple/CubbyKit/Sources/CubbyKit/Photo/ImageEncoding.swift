import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Bytes for the wire. The app always re-encodes what it captured: the presigned upload is
/// signed for an exact content type and size, and HEIC from the camera would otherwise reach
/// the server unconverted. Nothing here touches UIKit or AppKit.
public enum ImageEncoding {
    public enum Format: Sendable, Hashable {
        case jpeg(quality: Double)
        case png

        public static let jpeg = Format.jpeg(quality: 0.88)

        public var contentType: String {
            switch self {
            case .jpeg: "image/jpeg"
            case .png: "image/png"
            }
        }

        public var fileExtension: String {
            switch self {
            case .jpeg: "jpg"
            case .png: "png"
            }
        }

        var type: UTType {
            switch self {
            case .jpeg: .jpeg
            case .png: .png
            }
        }
    }

    public enum Failure: Error, Sendable {
        case cannotDraw
        case cannotEncode
    }

    /// Scales so the longer side is at most `maxPixelSize`; returns the input unchanged when it
    /// already fits. Alpha is preserved.
    public static func downscaled(_ image: CGImage, maxPixelSize: Int = 2048) throws -> CGImage {
        let longest = max(image.width, image.height)
        guard longest > maxPixelSize else { return image }
        let scale = Double(maxPixelSize) / Double(longest)
        let width = max(1, Int((Double(image.width) * scale).rounded()))
        let height = max(1, Int((Double(image.height) * scale).rounded()))
        guard
            let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else { throw Failure.cannotDraw }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else { throw Failure.cannotDraw }
        return scaled
    }

    public static func encode(_ image: CGImage, as format: Format) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, format.type.identifier as CFString, 1, nil) else {
            throw Failure.cannotEncode
        }
        var properties: [CFString: Any] = [:]
        if case .jpeg(let quality) = format {
            properties[kCGImageDestinationLossyCompressionQuality] = quality
        }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw Failure.cannotEncode }
        return data as Data
    }

    /// The pixel size of encoded bytes, read from the container without decoding the image.
    public static func pixelSize(of data: Data) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? Int,
            let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        return (width, height)
    }
}
