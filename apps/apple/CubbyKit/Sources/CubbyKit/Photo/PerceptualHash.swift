import CoreGraphics
import Foundation
import ImageIO

public struct PerceptualHash64: Sendable, Hashable, Codable {
    public static let algorithmRevision = 1

    public enum Failure: Error, Sendable, Equatable {
        case invalidHex
        case cannotDecode
        case cannotDraw
    }

    public let value: UInt64

    public init(value: UInt64) {
        self.value = value
    }

    public init(hex: String) throws {
        guard hex.count == 16, hex.allSatisfy(\.isHexDigit), let value = UInt64(hex, radix: 16) else {
            throw Failure.invalidHex
        }
        self.value = value
    }

    public var hex: String { String(format: "%016llx", value) }

    public func distance(to other: Self) -> Int {
        (value ^ other.value).nonzeroBitCount
    }

    public static func compute(fileURL: URL) throws -> Self {
        guard let source = CGImageSourceCreateWithURL(fileURL as CFURL, nil) else {
            throw Failure.cannotDecode
        }
        return try compute(source: source)
    }

    public static func compute(_ image: CGImage) throws -> Self {
        try computePixels(from: image)
    }

    private static func compute(source: CGImageSource) throws -> Self {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 256,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw Failure.cannotDecode
        }
        return try computePixels(from: image)
    }

    private static let sampleSize = 32
    private static let cosine: [[Double]] = (0..<8).map { frequency in
        (0..<sampleSize).map { coordinate in
            cos(Double.pi * Double(2 * coordinate + 1) * Double(frequency) / Double(2 * sampleSize))
        }
    }

    private static func computePixels(from image: CGImage) throws -> Self {
        let size = sampleSize
        var rgba = [UInt8](repeating: 255, count: size * size * 4)
        let drew = rgba.withUnsafeMutableBytes { bytes in
            guard let baseAddress = bytes.baseAddress,
                let context = CGContext(
                    data: baseAddress,
                    width: size,
                    height: size,
                    bitsPerComponent: 8,
                    bytesPerRow: size * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                )
            else { return false }

            // Transparency is deliberately composited over white so equivalent PNG and JPEG
            // renderings hash the visible photograph rather than invisible RGB under alpha.
            context.setFillColor(CGColor(gray: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: size, height: size))
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
            return true
        }
        guard drew else { throw Failure.cannotDraw }

        let gray = stride(from: 0, to: rgba.count, by: 4).map { offset in
            0.299 * Double(rgba[offset]) + 0.587 * Double(rgba[offset + 1])
                + 0.114 * Double(rgba[offset + 2])
        }
        var coefficients = [Double]()
        coefficients.reserveCapacity(64)
        for vertical in 0..<8 {
            for horizontal in 0..<8 {
                var sum = 0.0
                for y in 0..<size {
                    for x in 0..<size {
                        sum += gray[y * size + x] * cosine[horizontal][x] * cosine[vertical][y]
                    }
                }
                coefficients.append(sum)
            }
        }
        let sorted = coefficients.sorted()
        let median = (sorted[31] + sorted[32]) / 2
        let value = coefficients.enumerated().reduce(UInt64(0)) { partial, item in
            item.element > median ? partial | (UInt64(1) << UInt64(63 - item.offset)) : partial
        }
        return Self(value: value)
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        try self.init(hex: container.decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(hex)
    }
}

public struct SourceFingerprint: Sendable, Hashable, Codable {
    public let hash: PerceptualHash64
    public let aspectRatio: Double

    public init(hash: PerceptualHash64, aspectRatio: Double) {
        self.hash = hash
        self.aspectRatio = aspectRatio > 0 ? max(aspectRatio, 1 / aspectRatio) : aspectRatio
    }
}
