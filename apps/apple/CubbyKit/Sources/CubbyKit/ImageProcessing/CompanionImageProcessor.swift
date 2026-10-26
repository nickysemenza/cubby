import CoreGraphics
import Foundation
import ImageIO

public struct CompanionImageSource: Sendable, Hashable {
    public let url: URL
    public let sha256: String
    public let contentType: String

    public init(url: URL, sha256: String, contentType: String) {
        self.url = url
        self.sha256 = sha256.lowercased()
        self.contentType = contentType.lowercased()
    }
}

public struct CompanionImageOutput: Sendable, Hashable {
    public let uploadURL: URL
    public let contentType: String

    public init(uploadURL: URL, contentType: String) {
        self.uploadURL = uploadURL
        self.contentType = contentType.lowercased()
    }
}

public struct CompanionImageArtifact: Sendable, Hashable {
    public let sha256: String
    public let contentType: String
    public let width: Int
    public let height: Int
    public let diagnostics: CompanionImageDiagnostics

    public init(
        sha256: String, contentType: String, width: Int, height: Int,
        diagnostics: CompanionImageDiagnostics = .init()
    ) {
        self.sha256 = sha256
        self.contentType = contentType
        self.width = width
        self.height = height
        self.diagnostics = diagnostics
    }
}

public struct CompanionImageDiagnostics: Sendable, Hashable {
    public var decodeMilliseconds: Double?
    public var processingMilliseconds: Double?
    public var uploadMilliseconds: Double?
    public var width: Int?
    public var height: Int?
    public var orientation: Int?

    public init(
        decodeMilliseconds: Double? = nil, processingMilliseconds: Double? = nil,
        uploadMilliseconds: Double? = nil, width: Int? = nil, height: Int? = nil,
        orientation: Int? = nil
    ) {
        self.decodeMilliseconds = decodeMilliseconds
        self.processingMilliseconds = processingMilliseconds
        self.uploadMilliseconds = uploadMilliseconds
        self.width = width
        self.height = height
        self.orientation = orientation
    }
}

// CGImage is immutable after creation and is safe to pass into the isolated processing task.
public struct CompanionDecodedImage: @unchecked Sendable {
    public let image: CGImage
    public let diagnostics: CompanionImageDiagnostics
}

public enum CompanionCutoutResult: Sendable, Hashable {
    case completed(CompanionImageArtifact)
    case noSubject
    case unsupportedFormat
    case alreadyTransparent
}

/// Downloads immutable original bytes, verifies the server-provided digest, and uploads only the
/// derived analysis JPEG or transparent PNG. The original is never rewritten.
public struct CompanionImageProcessor: Sendable {
    public typealias Download = @Sendable (URL) async throws -> Data
    public typealias Put = PresignedUpload.Put

    public enum Failure: Error, Sendable, Equatable {
        case insecureTransferURL
        case sourceTooLarge(actual: Int, maximum: Int)
        case sourceChecksumMismatch
        case unsupportedOutputContentType(String)
    }

    static let maximumCutoutPixelSize = 2048

    private let download: Download
    private let put: Put

    public init(
        session: URLSession = .cubbyShared,
        put: @escaping Put = { data, url, contentType in
            try await PresignedUpload.put(data, to: url, contentType: contentType)
        }
    ) {
        download = { url in
            let (data, response) = try await session.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                throw URLError(.badServerResponse)
            }
            return data
        }
        self.put = put
    }

    public init(download: @escaping Download, put: @escaping Put) {
        self.download = download
        self.put = put
    }

    public func makeTransparentCutout(
        source: CompanionImageSource, output: CompanionImageOutput
    ) async throws -> CompanionCutoutResult {
        guard Self.isSecureOrLocalDevelopment(source.url),
            Self.isSecureOrLocalDevelopment(output.uploadURL)
        else { throw Failure.insecureTransferURL }
        guard output.contentType == ImageEncoding.Format.png.contentType else {
            throw Failure.unsupportedOutputContentType(output.contentType)
        }

        let data = try await download(source.url)
        try Task.checkCancellation()
        guard data.count <= PhotoFile.maximumByteCount else {
            throw Failure.sourceTooLarge(actual: data.count, maximum: PhotoFile.maximumByteCount)
        }
        guard data.sha256Hex == source.sha256 else {
            throw Failure.sourceChecksumMismatch
        }

        let decodeStarted = ContinuousClock.now
        let file: PhotoFile
        do {
            file = try PhotoFile.materialize(
                data: data, filename: source.url.lastPathComponent,
                contentType: source.contentType)
        } catch PhotoFile.Failure.unsupportedContentType {
            return .unsupportedFormat
        }
        let image = try file.decodeFullResolution()
        if Self.isCutout(image) { return .alreadyTransparent }
        let decodeMilliseconds = Self.milliseconds(since: decodeStarted)
        let orientation = Self.orientation(in: data)
        try Task.checkCancellation()
        let processingStarted = ContinuousClock.now
        let lifted = try await SubjectLift.lift(
            image, background: .transparent, cropToSubject: true)
        guard lifted.foundSubject else { return .noSubject }
        // A padded original whose subject fills its opaque rectangle lifts to that same opaque
        // rectangle, which the server rejects as a derivative; the transparent original stands.
        guard Self.alphaCoverage(lifted.image)?.hasTransparency ?? false else {
            return .alreadyTransparent
        }
        try Task.checkCancellation()

        // The server decodes the derivative to verify transparency and rejects more than 64 MB of
        // RGBA (`image-transparency.ts`); a full-resolution 48 MP lift is ~195 MB.
        let cutout = try ImageEncoding.downscaled(
            lifted.image, maxPixelSize: Self.maximumCutoutPixelSize)
        let png = try ImageEncoding.encode(cutout, as: .png)
        let processingMilliseconds = Self.milliseconds(since: processingStarted)
        let digest = png.sha256Hex
        let uploadStarted = ContinuousClock.now
        try await put(png, output.uploadURL, output.contentType)
        let uploadMilliseconds = Self.milliseconds(since: uploadStarted)
        return .completed(
            CompanionImageArtifact(
                sha256: digest, contentType: output.contentType,
                width: cutout.width, height: cutout.height,
                diagnostics: .init(
                    decodeMilliseconds: decodeMilliseconds,
                    processingMilliseconds: processingMilliseconds,
                    uploadMilliseconds: uploadMilliseconds,
                    width: cutout.width, height: cutout.height,
                    orientation: orientation)))
    }

    /// Share of non-opaque pixels inside the visible bounds above which an original reads as a
    /// cutout. A rectangular photo padded onto a transparent canvas (vendor square listings)
    /// measures under 1% from edge anti-aliasing; a product cutout measures well above.
    static let cutoutInteriorTransparency = 0.02

    /// Cutout originals are already usable item renditions. Transparency alone is not enough:
    /// an opaque RGBA asset, or an opaque photo on transparent padding, still benefits from
    /// subject lifting.
    static func isCutout(_ image: CGImage) -> Bool {
        guard let coverage = alphaCoverage(image), coverage.hasTransparency else { return false }
        return coverage.interiorTransparency > cutoutInteriorTransparency
    }

    struct AlphaCoverage {
        var hasTransparency: Bool
        /// Fraction of pixels with alpha below 255 within the bounding box of visible pixels.
        var interiorTransparency: Double
    }

    static func alphaCoverage(_ image: CGImage) -> AlphaCoverage? {
        switch image.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast:
            return AlphaCoverage(hasTransparency: false, interiorTransparency: 0)
        default: break
        }
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        return pixels.withUnsafeMutableBytes { buffer -> AlphaCoverage? in
            guard
                let context = CGContext(
                    data: buffer.baseAddress, width: width, height: height,
                    bitsPerComponent: 8, bytesPerRow: width * 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
                        | CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return nil }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            let bytes = buffer.bindMemory(to: UInt8.self)
            var minX = width
            var maxX = -1
            var minY = height
            var maxY = -1
            var hasTransparency = false
            for y in 0..<height {
                for x in 0..<width {
                    let alpha = bytes[(y * width + x) * 4 + 3]
                    if alpha < 255 { hasTransparency = true }
                    guard alpha > 0 else { continue }
                    minX = min(minX, x)
                    maxX = max(maxX, x)
                    minY = min(minY, y)
                    maxY = max(maxY, y)
                }
            }
            guard maxX >= 0 else {
                return AlphaCoverage(hasTransparency: hasTransparency, interiorTransparency: 1)
            }
            var interior = 0
            for y in minY...maxY {
                for x in minX...maxX where bytes[(y * width + x) * 4 + 3] < 255 { interior += 1 }
            }
            let area = (maxX - minX + 1) * (maxY - minY + 1)
            return AlphaCoverage(
                hasTransparency: hasTransparency,
                interiorTransparency: Double(interior) / Double(area))
        }
    }

    /// A bounded, orientation-correct JPEG for the cloud model; no native model is involved.
    public func makeAnalysisJPEG(
        source: CompanionImageSource, output: CompanionImageOutput
    ) async throws -> CompanionImageArtifact {
        guard Self.isSecureOrLocalDevelopment(output.uploadURL) else {
            throw Failure.insecureTransferURL
        }
        guard output.contentType == ImageEncoding.Format.jpeg.contentType else {
            throw Failure.unsupportedOutputContentType(output.contentType)
        }
        let decoded = try await decodedSourceImage(source, maxPixelSize: 2048)
        try Task.checkCancellation()
        let processingStarted = ContinuousClock.now
        let jpeg = try ImageEncoding.encode(decoded.image, as: .jpeg)
        var diagnostics = decoded.diagnostics
        diagnostics.processingMilliseconds = Self.milliseconds(since: processingStarted)
        try Task.checkCancellation()
        let uploadStarted = ContinuousClock.now
        try await put(jpeg, output.uploadURL, output.contentType)
        diagnostics.uploadMilliseconds = Self.milliseconds(since: uploadStarted)
        return CompanionImageArtifact(
            sha256: jpeg.sha256Hex, contentType: output.contentType,
            width: decoded.image.width, height: decoded.image.height, diagnostics: diagnostics)
    }

    public func sourceImage(_ source: CompanionImageSource) async throws -> CGImage {
        try await decodedSourceImage(source).image
    }

    public func decodedSourceImage(_ source: CompanionImageSource, maxPixelSize: Int? = nil) async throws
        -> CompanionDecodedImage
    {
        guard Self.isSecureOrLocalDevelopment(source.url) else {
            throw Failure.insecureTransferURL
        }
        let data = try await download(source.url)
        try Task.checkCancellation()
        guard data.count <= PhotoFile.maximumByteCount else {
            throw Failure.sourceTooLarge(actual: data.count, maximum: PhotoFile.maximumByteCount)
        }
        guard data.sha256Hex == source.sha256 else {
            throw Failure.sourceChecksumMismatch
        }
        let decodeStarted = ContinuousClock.now
        let file = try PhotoFile.materialize(
            data: data, filename: source.url.lastPathComponent, contentType: source.contentType)
        let image =
            try maxPixelSize.map { try file.thumbnail(maxPixelSize: $0) } ?? file.decodeFullResolution()
        return CompanionDecodedImage(
            image: image,
            diagnostics: .init(
                decodeMilliseconds: Self.milliseconds(since: decodeStarted),
                width: image.width, height: image.height, orientation: Self.orientation(in: data)))
    }

    private static func orientation(in data: Data) -> Int? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        else { return nil }
        return (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue
    }

    private static func milliseconds(since start: ContinuousClock.Instant) -> Double {
        let components = start.duration(to: .now).components
        return Double(components.seconds) * 1_000
            + Double(components.attoseconds) / 1_000_000_000_000_000
    }

    private static func isSecureOrLocalDevelopment(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), let host = url.host()?.lowercased() else {
            return false
        }
        if scheme == "https" { return true }
        return scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
    }
}

extension CompanionImageProcessor.Failure: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .insecureTransferURL:
            "Image processing transfers require HTTPS outside local development."
        case .sourceTooLarge(let actual, let maximum):
            "The source image is \(actual) bytes; the maximum is \(maximum) bytes."
        case .sourceChecksumMismatch:
            "The source image did not match the job checksum."
        case .unsupportedOutputContentType(let contentType):
            "The requested output type \(contentType) is unsupported."
        }
    }
}
