import CoreGraphics
import Foundation
import ImageIO

/// Fetches product cover images (public R2 URLs, no credentials) and decodes them into
/// `CGImage`s at a bounded size. Feature prints do not need full resolution, and the covers can
/// be several megapixels.
public struct CoverImageLoader: Sendable {
    public static let maxPixelSize = 512

    private let session: URLSession

    public init(session: URLSession = .cubbyShared) {
        self.session = session
    }

    public func load(_ url: URL) async throws -> CGImage {
        let (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw CoverImageError.http(http.statusCode)
        }
        return try Self.decode(data)
    }

    /// Decodes and downsamples in one ImageIO pass; works on iOS and macOS alike.
    public static func decode(_ data: Data, maxPixelSize: Int = maxPixelSize) throws -> CGImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            throw CoverImageError.undecodable
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw CoverImageError.undecodable
        }
        return image
    }

    public static func decode(contentsOf url: URL) throws -> CGImage {
        try decode(try Data(contentsOf: url))
    }
}

public enum CoverImageError: Error, Sendable, Equatable {
    case http(Int)
    case undecodable
}
