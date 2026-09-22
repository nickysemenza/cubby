import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

public struct PhotoFile: Sendable, Hashable {
    public static let maximumByteCount = 50 * 1024 * 1024

    public enum Failure: Error, Sendable, Equatable {
        case unreadable
        case unsupportedContentType(String?)
        case tooLarge(actual: Int, maximum: Int)
        case cannotMaterialize
        case cannotDecode
    }

    public let url: URL
    public let filename: String
    public let contentType: String
    public let size: Int
    public let width: Int
    public let height: Int
    public let capturedAt: Date?
    private let temporaryFileLease: TemporaryFileLease?

    public var dimensions: CGSize { CGSize(width: width, height: height) }
    public var aspectRatio: Double { Double(max(width, height)) / Double(min(width, height)) }

    public init(
        url: URL,
        filename: String,
        contentType: String,
        size: Int,
        width: Int,
        height: Int,
        capturedAt: Date? = nil
    ) throws {
        try self.init(
            url: url, filename: filename, contentType: contentType, size: size,
            width: width, height: height, capturedAt: capturedAt, temporaryFileLease: nil)
    }

    private init(
        url: URL,
        filename: String,
        contentType: String,
        size: Int,
        width: Int,
        height: Int,
        capturedAt: Date?,
        temporaryFileLease: TemporaryFileLease?
    ) throws {
        guard size <= Self.maximumByteCount else {
            throw Failure.tooLarge(actual: size, maximum: Self.maximumByteCount)
        }
        guard Self.supportedMIMETypes.contains(contentType.lowercased()) else {
            throw Failure.unsupportedContentType(contentType)
        }
        guard size >= 0, width > 0, height > 0 else { throw Failure.unreadable }
        self.url = url
        self.filename = filename
        self.contentType = contentType.lowercased()
        self.size = size
        self.width = width
        self.height = height
        self.capturedAt = capturedAt
        self.temporaryFileLease = temporaryFileLease
    }

    public static func importing(_ url: URL, filename: String? = nil) throws -> Self {
        try inspect(url, filename: filename ?? url.lastPathComponent, capturedAt: nil)
    }

    public static func materialize(
        _ data: Data,
        filename: String,
        contentType: String? = nil,
        capturedAt: Date? = nil
    ) throws -> Self {
        guard data.count <= maximumByteCount else {
            throw Failure.tooLarge(actual: data.count, maximum: maximumByteCount)
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CubbyPhotos", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(UUID().uuidString + "-" + safeFilename(filename))
        do {
            try data.write(to: destination, options: .atomic)
            return try inspect(
                destination, filename: filename, declaredContentType: contentType, capturedAt: capturedAt,
                ownsTemporaryFile: true)
        } catch let failure as Failure {
            try? FileManager.default.removeItem(at: destination)
            throw failure
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw Failure.cannotMaterialize
        }
    }

    public static func materialize(
        data: Data,
        filename: String,
        contentType: String? = nil,
        capturedAt: Date? = nil
    ) throws -> Self {
        try materialize(
            data, filename: filename, contentType: contentType, capturedAt: capturedAt)
    }

    public static func materialize(
        from sourceURL: URL,
        filename: String? = nil,
        capturedAt: Date? = nil
    ) throws -> Self {
        let source = try importing(sourceURL, filename: filename)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("CubbyPhotos", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(
            UUID().uuidString + "-" + safeFilename(source.filename))
        do {
            try FileManager.default.copyItem(at: sourceURL, to: destination)
            return try inspect(
                destination, filename: source.filename, declaredContentType: source.contentType,
                capturedAt: capturedAt ?? source.capturedAt, ownsTemporaryFile: true)
        } catch let failure as Failure {
            try? FileManager.default.removeItem(at: destination)
            throw failure
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw Failure.cannotMaterialize
        }
    }

    public static func capture(
        data: Data,
        filename: String = "capture.jpg",
        contentType: String = "image/jpeg",
        capturedAt: Date? = nil
    ) throws -> Self {
        try materialize(
            data, filename: filename, contentType: contentType, capturedAt: capturedAt ?? Date())
    }

    public func thumbnail(maxPixelSize: Int = 256) throws -> CGImage {
        guard maxPixelSize > 0, let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            throw Failure.cannotDecode
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw Failure.cannotDecode
        }
        return image
    }

    /// The full-resolution bytes' content hash, independent of any Vision analysis — a bulk import
    /// run stages and finalizes photos before analysis runs (`PhotoImportRunUploader`), so it needs
    /// this without paying for classification/OCR/feature-print work per photo.
    public func sha256() throws -> String {
        let digest = SHA256.hash(data: try Data(contentsOf: url, options: .mappedIfSafe))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Deliberate full-resolution edit support. Picker previews and hashing use `thumbnail` so
    /// normal library browsing never expands a large photograph into a full bitmap.
    public func decodeFullResolution() throws -> CGImage {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            throw Failure.cannotDecode
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(width, height),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { throw Failure.cannotDecode }
        return image
    }

    private static let supportedMIMETypes: Set<String> = [
        "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
    ]

    private static func inspect(
        _ url: URL,
        filename: String,
        declaredContentType: String? = nil,
        capturedAt: Date?,
        ownsTemporaryFile: Bool = false
    ) throws -> Self {
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]), let size = values.fileSize,
            let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let typeIdentifier = CGImageSourceGetType(source) as String?,
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let rawWidth = properties[kCGImagePropertyPixelWidth] as? Int,
            let rawHeight = properties[kCGImagePropertyPixelHeight] as? Int
        else { throw Failure.unreadable }
        guard size <= maximumByteCount else {
            throw Failure.tooLarge(actual: size, maximum: maximumByteCount)
        }

        let detected = UTType(typeIdentifier)?.preferredMIMEType?.lowercased()
        let contentType = detected ?? declaredContentType?.lowercased()
        guard let contentType, supportedMIMETypes.contains(contentType),
            detected == nil || supportedMIMETypes.contains(detected!)
        else { throw Failure.unsupportedContentType(declaredContentType ?? detected) }

        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        let swapsDimensions = (5...8).contains(orientation)
        let date = capturedAt ?? captureDate(from: properties)
        return try Self(
            url: url,
            filename: filename.isEmpty ? "photo" : filename,
            contentType: contentType,
            size: size,
            width: swapsDimensions ? rawHeight : rawWidth,
            height: swapsDimensions ? rawWidth : rawHeight,
            capturedAt: date,
            temporaryFileLease: ownsTemporaryFile ? TemporaryFileLease(url: url) : nil)
    }

    private static func captureDate(from properties: [CFString: Any]) -> Date? {
        let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
        let value = exif?[kCGImagePropertyExifDateTimeOriginal] as? String
        guard let value else { return nil }
        if let offset = exif?[kCGImagePropertyExifOffsetTimeOriginal] as? String,
            offset.range(of: #"^[+-]\d{2}:?\d{2}$"#, options: .regularExpression) != nil
        {
            let colonOffset =
                offset.contains(":")
                ? offset
                : String(offset.prefix(3)) + ":" + String(offset.suffix(2))
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy:MM:dd HH:mm:ssXXXXX"
            if let date = formatter.date(from: value + colonOffset) { return date }
        }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
        return formatter.date(from: value)
    }

    private static func safeFilename(_ filename: String) -> String {
        URL(fileURLWithPath: filename).lastPathComponent.replacingOccurrences(of: "/", with: "-")
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.url == rhs.url
            && lhs.filename == rhs.filename
            && lhs.contentType == rhs.contentType
            && lhs.size == rhs.size
            && lhs.width == rhs.width
            && lhs.height == rhs.height
            && lhs.capturedAt == rhs.capturedAt
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(url)
        hasher.combine(filename)
        hasher.combine(contentType)
        hasher.combine(size)
        hasher.combine(width)
        hasher.combine(height)
        hasher.combine(capturedAt)
    }
}

/// Shared by value-type copies of one app-created temporary photo.
private final class TemporaryFileLease: Sendable {
    let url: URL

    init(url: URL) {
        self.url = url
    }

    deinit {
        try? FileManager.default.removeItem(at: url)
    }
}

public struct PreparedPhoto: Sendable, Hashable {
    public let file: PhotoFile
    public let perceptualHash: PerceptualHash64
    public let sourceFingerprint: SourceFingerprint

    public init(
        file: PhotoFile,
        perceptualHash: PerceptualHash64,
        sourceFingerprint: SourceFingerprint
    ) {
        self.file = file
        self.perceptualHash = perceptualHash
        self.sourceFingerprint = sourceFingerprint
    }

    public static func prepare(
        file: PhotoFile,
        sourceFingerprint: SourceFingerprint? = nil
    ) throws -> Self {
        let hash = try PerceptualHash64.compute(fileURL: file.url)
        return Self(
            file: file,
            perceptualHash: hash,
            sourceFingerprint: sourceFingerprint
                ?? SourceFingerprint(hash: hash, aspectRatio: file.aspectRatio))
    }

    public var hashQuery: HashQuery {
        HashQuery(
            perceptualHash: perceptualHash,
            aspectRatio: file.aspectRatio,
            sourceFingerprint: sourceFingerprint)
    }
}

extension PhotoFile.Failure: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .tooLarge(let actual, let maximum):
            "This photo is \(ByteCountFormatter.string(fromByteCount: Int64(actual), countStyle: .file)). The per-file limit is \(maximum / 1024 / 1024) MiB. Choose another file; Cubby will not shrink it."
        case .unsupportedContentType(let type):
            "This file's format (\(type ?? "unknown")) is not supported. Choose a JPEG, HEIC, HEIF, PNG, WebP, or GIF image."
        case .unreadable:
            "This photo could not be read. Choose the file again."
        case .cannotMaterialize:
            "Cubby could not prepare the full-quality photo file. Check available storage and try again."
        case .cannotDecode:
            "This photo could not be decoded at its original resolution. Choose another image or try again."
        }
    }
}
