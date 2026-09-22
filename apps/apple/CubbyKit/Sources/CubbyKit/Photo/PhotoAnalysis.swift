import CoreGraphics
import CryptoKit
import Foundation
import Vision

public struct PhotoClassification: Codable, Hashable, Sendable {
    public let identifier: String
    public let confidence: Double

    public init(identifier: String, confidence: Double) {
        self.identifier = identifier
        self.confidence = confidence
    }
}

public struct PhotoRecognizedText: Codable, Hashable, Sendable {
    public let text: String
    public let confidence: Double

    public init(text: String, confidence: Double) {
        self.text = text
        self.confidence = confidence
    }
}

public struct PhotoFeaturePrint: Codable, Hashable, Sendable {
    public let revision: String
    /// `FeaturePrintObservation`'s Codable representation, ready to sync as base64 JSON data.
    public let data: Data

    public init(revision: String, data: Data) {
        self.revision = revision
        self.data = data
    }
}

public struct PhotoAnalysisProvenance: Codable, Hashable, Sendable {
    public enum Source: String, Codable, Sendable {
        case camera
        case files
        case photoLibrary
        case serverLazy
    }

    public let source: Source
    public let localIdentifier: String?
    public let filename: String

    public init(source: Source, localIdentifier: String? = nil, filename: String) {
        self.source = source
        self.localIdentifier = localIdentifier
        self.filename = filename
    }
}

/// One immutable, revisioned local analysis. Suggestions are derived from this artifact and the
/// current manifest candidate catalog rather than being persisted as truth.
public struct PhotoLocalAnalysis: Codable, Hashable, Sendable, Identifiable {
    public static let currentVersion = 1

    public let id: String
    public let analysisVersion: Int
    public let analyzedAt: Date
    public let sha256: String
    public let perceptualHash: PerceptualHash64?
    public let sourceFingerprint: SourceFingerprint?
    public let capturedAt: Date?
    public let contentType: String
    public let width: Int
    public let height: Int
    public let classifications: [PhotoClassification]
    public let recognizedText: [PhotoRecognizedText]
    public let featurePrint: PhotoFeaturePrint
    public let provenance: PhotoAnalysisProvenance
    /// This asset's PhotoKit facts, when the source is the library — the photo-import commit
    /// item's `library` sibling of `analysis` is built straight from this
    /// (`LibrarySightingBuilder.reportFields(for:installationID:)`). `nil` for a file/camera import,
    /// which has no PhotoKit asset behind it.
    public let library: LibraryAssetMetadata?

    public init(
        id: String,
        analysisVersion: Int = Self.currentVersion,
        analyzedAt: Date,
        sha256: String,
        perceptualHash: PerceptualHash64? = nil,
        sourceFingerprint: SourceFingerprint? = nil,
        capturedAt: Date?,
        contentType: String,
        width: Int,
        height: Int,
        classifications: [PhotoClassification],
        recognizedText: [PhotoRecognizedText],
        featurePrint: PhotoFeaturePrint,
        provenance: PhotoAnalysisProvenance,
        library: LibraryAssetMetadata? = nil
    ) {
        self.id = id
        self.analysisVersion = analysisVersion
        self.analyzedAt = analyzedAt
        self.sha256 = sha256
        self.perceptualHash = perceptualHash
        self.sourceFingerprint = sourceFingerprint
        self.capturedAt = capturedAt
        self.contentType = contentType
        self.width = width
        self.height = height
        self.classifications = classifications
        self.recognizedText = recognizedText
        self.featurePrint = featurePrint
        self.provenance = provenance
        self.library = library
    }
}

public struct PhotoAnalysisInput: Sendable {
    public let id: String
    public let file: PhotoFile
    public let provenance: PhotoAnalysisProvenance
    /// Built once per selection by the caller (`PhotoImportManifest.prepareIfNeeded`), which
    /// batches the expensive `cloudIdentifierMappings` lookup itself — this type only carries the
    /// already-resolved result through to `LocalPhotoAnalyzer`.
    public let library: LibraryAssetMetadata?

    public init(
        id: String, file: PhotoFile, provenance: PhotoAnalysisProvenance,
        library: LibraryAssetMetadata? = nil
    ) {
        self.id = id
        self.file = file
        self.provenance = provenance
        self.library = library
    }
}

/// Vision analysis stays outside MainActor, uses a bounded thumbnail, and preserves input order
/// across a concurrently analyzed batch.
public struct LocalPhotoAnalyzer: Sendable {
    public struct Limits: Sendable, Hashable {
        public let maximumConcurrentImages: Int
        public let maximumClassifications: Int
        public let maximumRecognizedText: Int
        public let maximumAnalysisPixels: Int

        public init(
            maximumConcurrentImages: Int = 4,
            maximumClassifications: Int = 12,
            maximumRecognizedText: Int = 32,
            maximumAnalysisPixels: Int = 2_048
        ) {
            self.maximumConcurrentImages = max(1, maximumConcurrentImages)
            self.maximumClassifications = max(1, maximumClassifications)
            self.maximumRecognizedText = max(1, maximumRecognizedText)
            self.maximumAnalysisPixels = max(256, maximumAnalysisPixels)
        }
    }

    public let limits: Limits

    public init(limits: Limits = Limits()) {
        self.limits = limits
    }

    @concurrent public func analyze(_ input: PhotoAnalysisInput) async throws -> PhotoLocalAnalysis {
        try Task.checkCancellation()
        let image = try input.file.thumbnail(maxPixelSize: limits.maximumAnalysisPixels)
        async let classifications = classifyIfAvailable(image)
        async let recognizedText = recognizeTextIfAvailable(image)
        async let featurePrint = makeFeaturePrintIfAvailable(image)
        async let sha256 = hash(input.file.url)
        async let perceptualHashTask = try? PerceptualHash64.compute(fileURL: input.file.url)
        let perceptualHash = await perceptualHashTask
        let result = try await PhotoLocalAnalysis(
            id: input.id,
            analyzedAt: Date(),
            sha256: sha256,
            perceptualHash: perceptualHash,
            sourceFingerprint: perceptualHash.map {
                SourceFingerprint(hash: $0, aspectRatio: input.file.aspectRatio)
            },
            capturedAt: input.file.capturedAt,
            contentType: input.file.contentType,
            width: input.file.width,
            height: input.file.height,
            classifications: classifications,
            recognizedText: recognizedText,
            featurePrint: featurePrint,
            provenance: input.provenance,
            library: input.library)
        try Task.checkCancellation()
        return result
    }

    public func analyze(
        _ inputs: [PhotoAnalysisInput],
        progress: (@Sendable (_ completed: Int, _ total: Int) -> Void)? = nil
    ) async throws -> [PhotoLocalAnalysis] {
        guard !inputs.isEmpty else { return [] }
        return try await withThrowingTaskGroup(
            of: (Int, PhotoLocalAnalysis).self,
            returning: [PhotoLocalAnalysis].self
        ) { group in
            var next = 0
            var ordered = Array<PhotoLocalAnalysis?>(repeating: nil, count: inputs.count)

            func enqueue() {
                guard next < inputs.count else { return }
                let index = next
                let input = inputs[index]
                next += 1
                group.addTask { (index, try await analyze(input)) }
            }

            for _ in 0..<min(limits.maximumConcurrentImages, inputs.count) { enqueue() }
            var completed = 0
            for try await (index, analysis) in group {
                ordered[index] = analysis
                completed += 1
                progress?(completed, inputs.count)
                try Task.checkCancellation()
                enqueue()
            }
            return ordered.compactMap { $0 }
        }
    }

    @concurrent private func classify(_ image: CGImage) async throws -> [PhotoClassification] {
        var request = ClassifyImageRequest(.revision2)
        request.cropAndScaleAction = .scaleToFit
        return try await request.perform(on: image)
            .prefix(limits.maximumClassifications)
            .map { PhotoClassification(identifier: $0.identifier, confidence: Double($0.confidence)) }
    }

    @concurrent private func classifyIfAvailable(_ image: CGImage) async throws
        -> [PhotoClassification]
    {
        do {
            return try await classify(image)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return []
        }
    }

    @concurrent private func recognizeText(_ image: CGImage) async throws -> [PhotoRecognizedText] {
        var request = RecognizeTextRequest(.revision3)
        request.recognitionLevel = .accurate
        request.automaticallyDetectsLanguage = true
        request.usesLanguageCorrection = true
        return try await request.perform(on: image)
            .prefix(limits.maximumRecognizedText)
            .compactMap { observation in
                guard let candidate = observation.topCandidates(1).first else { return nil }
                return PhotoRecognizedText(
                    text: candidate.string.trimmingCharacters(in: .whitespacesAndNewlines),
                    confidence: Double(candidate.confidence))
            }
            .filter { !$0.text.isEmpty }
    }

    @concurrent private func recognizeTextIfAvailable(_ image: CGImage) async throws
        -> [PhotoRecognizedText]
    {
        do {
            return try await recognizeText(image)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return []
        }
    }

    @concurrent private func makeFeaturePrint(_ image: CGImage) async throws -> PhotoFeaturePrint {
        var request = GenerateImageFeaturePrintRequest(.revision2)
        request.cropAndScaleAction = .scaleToFill
        let observation = try await request.perform(on: image)
        return PhotoFeaturePrint(
            revision: "vision-feature-print-2", data: try JSONEncoder().encode(observation))
    }

    @concurrent private func makeFeaturePrintIfAvailable(_ image: CGImage) async throws
        -> PhotoFeaturePrint
    {
        do {
            return try await makeFeaturePrint(image)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            return PhotoFeaturePrint(revision: "unavailable", data: Data("unavailable".utf8))
        }
    }

    @concurrent private func hash(_ url: URL) async throws -> String {
        let digest = SHA256.hash(data: try Data(contentsOf: url, options: .mappedIfSafe))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
