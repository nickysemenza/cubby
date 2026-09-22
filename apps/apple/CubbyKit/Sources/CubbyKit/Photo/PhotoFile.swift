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
    /// EXIF `OffsetTimeOriginal`, converted to minutes — read at the same site as `capturedAt`
    /// (`captureDate(from:)`), so it is only ever known when `capturedAt` came from EXIF too.
    public let captureTimeZoneOffsetMinutes: Int?
    /// TIFF/EXIF camera fields (`Make`, `Model`, `LensModel`, `Software`) — only ever populated
    /// where full-resolution bytes are already on disk (`inspect(_:)` always reads real bytes;
    /// there is no separate thumbnail-only path here), matching every `PhotoFile` construction site.
    public let camera: LibraryAssetMetadata.Camera?
    /// EXIF GPS dictionary — same materialize-only caveat as `camera`.
    public let gpsLocation: LibraryAssetMetadata.Location?
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
            width: width, height: height, capturedAt: capturedAt, captureTimeZoneOffsetMinutes: nil,
            camera: nil, gpsLocation: nil, temporaryFileLease: nil)
    }

    private init(
        url: URL,
        filename: String,
        contentType: String,
        size: Int,
        width: Int,
        height: Int,
        capturedAt: Date?,
        captureTimeZoneOffsetMinutes: Int?,
        camera: LibraryAssetMetadata.Camera?,
        gpsLocation: LibraryAssetMetadata.Location?,
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
        self.captureTimeZoneOffsetMinutes = captureTimeZoneOffsetMinutes
        self.camera = (camera?.isEmpty == true) ? nil : camera
        self.gpsLocation = gpsLocation
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
            captureTimeZoneOffsetMinutes: captureTimeZoneOffsetMinutes(from: properties),
            camera: cameraMetadata(from: properties),
            gpsLocation: gpsLocation(from: properties),
            temporaryFileLease: ownsTemporaryFile ? TemporaryFileLease(url: url) : nil)
    }

    /// EXIF `OffsetTimeOriginal` (`±HH:MM`, possibly unpunctuated), in minutes east of UTC. Reads
    /// the same field `captureDate(from:)` already validates for its own parse, so the two never
    /// disagree about whether an offset was present.
    private static func captureTimeZoneOffsetMinutes(from properties: [CFString: Any]) -> Int? {
        let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
        guard let offset = exif?[kCGImagePropertyExifOffsetTimeOriginal] as? String,
            let match = offset.range(of: #"^([+-])(\d{2}):?(\d{2})$"#, options: .regularExpression)
        else { return nil }
        let digits = offset[match].dropFirst()
        let sign = offset.hasPrefix("-") ? -1 : 1
        let hours = Int(digits.prefix(2)) ?? 0
        let minutes = Int(digits.suffix(2)) ?? 0
        return sign * (hours * 60 + minutes)
    }

    /// TIFF `Make`/`Model`/`Software` plus EXIF `LensModel` — `nil` when every field is absent
    /// (most screenshots, most non-camera sources).
    private static func cameraMetadata(from properties: [CFString: Any]) -> LibraryAssetMetadata.Camera? {
        let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
        let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
        let camera = LibraryAssetMetadata.Camera(
            make: tiff?[kCGImagePropertyTIFFMake] as? String,
            model: tiff?[kCGImagePropertyTIFFModel] as? String,
            lens: exif?[kCGImagePropertyExifLensModel] as? String,
            software: tiff?[kCGImagePropertyTIFFSoftware] as? String)
        return camera.isEmpty ? nil : camera
    }

    /// EXIF GPS dictionary. `kCGImagePropertyGPSLatitude`/`Longitude` are unsigned magnitudes;
    /// `LatitudeRef`/`LongitudeRef` (`"N"`/`"S"`, `"E"`/`"W"`) carry the sign.
    /// `kCGImagePropertyGPSAltitudeRef` of `1` means below sea level.
    private static func gpsLocation(from properties: [CFString: Any]) -> LibraryAssetMetadata.Location? {
        guard let gps = properties[kCGImagePropertyGPSDictionary] as? [CFString: Any],
            let rawLatitude = gps[kCGImagePropertyGPSLatitude] as? NSNumber,
            let rawLongitude = gps[kCGImagePropertyGPSLongitude] as? NSNumber
        else { return nil }
        let latitudeSign = (gps[kCGImagePropertyGPSLatitudeRef] as? String) == "S" ? -1.0 : 1.0
        let longitudeSign = (gps[kCGImagePropertyGPSLongitudeRef] as? String) == "W" ? -1.0 : 1.0
        var altitude = (gps[kCGImagePropertyGPSAltitude] as? NSNumber)?.doubleValue
        if let ref = gps[kCGImagePropertyGPSAltitudeRef] as? NSNumber, ref.intValue == 1,
            let value = altitude
        {
            altitude = -value
        }
        return LibraryAssetMetadata.Location(
            latitude: latitudeSign * rawLatitude.doubleValue,
            longitude: longitudeSign * rawLongitude.doubleValue,
            altitude: altitude,
            horizontalAccuracy: (gps[kCGImagePropertyGPSHPositioningError] as? NSNumber)?.doubleValue)
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
