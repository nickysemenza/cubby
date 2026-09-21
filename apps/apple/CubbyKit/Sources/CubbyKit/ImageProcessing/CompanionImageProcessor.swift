import CoreGraphics
import CryptoKit
import Foundation

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

public struct CompanionCutoutArtifact: Sendable, Hashable {
    public let sha256: String
    public let contentType: String
    public let width: Int
    public let height: Int

    public init(sha256: String, contentType: String, width: Int, height: Int) {
        self.sha256 = sha256
        self.contentType = contentType
        self.width = width
        self.height = height
    }
}

public enum CompanionCutoutResult: Sendable, Hashable {
    case completed(CompanionCutoutArtifact)
    case noSubject
    case unsupportedFormat
}

/// Downloads immutable original bytes, verifies the server-provided digest, and uploads only the
/// derived transparent PNG. The original is never rewritten or passed through an encoder.
public struct CompanionImageProcessor: Sendable {
    public typealias Download = @Sendable (URL) async throws -> Data
    public typealias Put = PresignedUpload.Put

    public enum Failure: Error, Sendable, Equatable {
        case insecureTransferURL
        case sourceTooLarge(actual: Int, maximum: Int)
        case sourceChecksumMismatch
        case unsupportedOutputContentType(String)
    }

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
        guard Self.sha256(data) == source.sha256 else {
            throw Failure.sourceChecksumMismatch
        }

        let file: PhotoFile
        do {
            file = try PhotoFile.materialize(
                data: data, filename: source.url.lastPathComponent,
                contentType: source.contentType)
        } catch PhotoFile.Failure.unsupportedContentType {
            return .unsupportedFormat
        }
        let image = try file.decodeFullResolution()
        try Task.checkCancellation()
        let lifted = try await SubjectLift.lift(
            image, background: .transparent, cropToSubject: true)
        guard lifted.foundSubject else { return .noSubject }
        try Task.checkCancellation()

        let png = try ImageEncoding.encode(lifted.image, as: .png)
        let digest = Self.sha256(png)
        try await put(png, output.uploadURL, output.contentType)
        return .completed(
            CompanionCutoutArtifact(
                sha256: digest, contentType: output.contentType,
                width: lifted.image.width, height: lifted.image.height))
    }

    public func sourceImage(_ source: CompanionImageSource) async throws -> CGImage {
        guard Self.isSecureOrLocalDevelopment(source.url) else {
            throw Failure.insecureTransferURL
        }
        let data = try await download(source.url)
        try Task.checkCancellation()
        guard data.count <= PhotoFile.maximumByteCount else {
            throw Failure.sourceTooLarge(actual: data.count, maximum: PhotoFile.maximumByteCount)
        }
        guard Self.sha256(data) == source.sha256 else {
            throw Failure.sourceChecksumMismatch
        }
        let file = try PhotoFile.materialize(
            data: data, filename: source.url.lastPathComponent, contentType: source.contentType)
        return try file.decodeFullResolution()
    }

    private static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
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
