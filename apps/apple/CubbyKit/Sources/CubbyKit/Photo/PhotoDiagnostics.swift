import CubbyAPISupport
import Foundation

/// The six-section debug report `cubby photo analyze` prints and the in-app Diagnostics tab
/// renders. One shared shape so the CLI and the app can never disagree about what a photo's
/// local analysis produced.
public struct PhotoDiagnosticsReport: Codable, Sendable {
    public struct FileInfo: Codable, Sendable {
        public let filename: String
        public let contentType: String
        public let width: Int
        public let height: Int
        public let capturedAt: Date?
        public let aspectRatio: Double
    }

    public struct SourceFingerprintInfo: Codable, Sendable {
        public let hash: String
        public let aspectRatio: Double
    }

    /// JSON key stays `hashes` (the CLI's long-standing spelling) even though the Swift property
    /// reads as `identity` — the section is identity evidence, not just a hash dump.
    public struct Identity: Codable, Sendable {
        public let sha256: String
        public let perceptualHash: String?
        public let sourceFingerprint: SourceFingerprintInfo?
    }

    public struct FeaturePrintInfo: Codable, Sendable {
        public let revision: String
        public let bytes: Int
        /// Base64 vector data, only when the caller asked for it (`--feature-print` / a caller
        /// that wants to diff two photos' embeddings); omitted otherwise to keep the report small.
        public let data: String?
    }

    /// One entity's routing-policy verdict against this photo's analysis: the same evidence
    /// `PhotoEvidenceScorer.policyMatches` produces, plus the entity's emoji (a text fallback
    /// where an SF Symbol can't render — CLI output, notifications, share text).
    public struct RoutingVerdict: Codable, Sendable {
        public let entity: EntityKey
        public let emoji: String
        public let classifierIdentifier: String?
        public let classifierConfidence: Double?
        public let minimumScore: Double
        public let meetsMinimumScore: Bool
        public let wantedLabels: [String]
        public let candidateFields: [String]
        public let temporalFields: [String]
        public let ocrFields: [String]
    }

    public struct Semantic: Codable, Sendable {
        public let status: String
        public let decisions: [PhotoRoutingDecision]
    }

    public struct Timings: Codable, Sendable {
        public let analyzeMs: Double
        public let semanticMs: Double?
    }

    public let file: FileInfo
    public let identity: Identity
    public let classifications: [PhotoClassification]
    public let recognizedText: [PhotoRecognizedText]
    public let featurePrint: FeaturePrintInfo
    public let routing: [RoutingVerdict]
    public let suggestedSource: EntityKey?
    /// Foundation Models availability, always present regardless of whether the reranker ran
    /// (`semantic` below carries the run's outcome only when it did).
    public let semanticModel: String
    public let semantic: Semantic?
    public let timings: Timings

    private enum CodingKeys: String, CodingKey {
        case file
        case identity = "hashes"
        case classifications
        case recognizedText
        case featurePrint
        case routing
        case suggestedSource
        case semanticModel
        case semantic
        case timings
    }
}

/// Builds `PhotoDiagnosticsReport` from a completed `PhotoLocalAnalysis` — the app's Diagnostics
/// tab and the CLI's `photo analyze --json`/human report both render this same value, so a
/// routing miss looks identical wherever it's diagnosed.
public enum PhotoDiagnostics {
    /// - Parameter analyzeMs: Time the caller already spent running `LocalPhotoAnalyzer`, folded
    ///   into `timings`. Callers that haven't measured it (or don't care) can omit it.
    public static func report(
        analysis: PhotoLocalAnalysis,
        file: PhotoFile,
        includeFeaturePrintData: Bool,
        runSemantic: Bool,
        analyzeMs: Double = 0
    ) async -> PhotoDiagnosticsReport {
        let fileInfo = PhotoDiagnosticsReport.FileInfo(
            filename: file.filename, contentType: file.contentType, width: file.width,
            height: file.height, capturedAt: analysis.capturedAt, aspectRatio: file.aspectRatio)

        let identity = PhotoDiagnosticsReport.Identity(
            sha256: analysis.sha256,
            perceptualHash: analysis.perceptualHash?.hex,
            sourceFingerprint: analysis.sourceFingerprint.map {
                PhotoDiagnosticsReport.SourceFingerprintInfo(hash: $0.hash.hex, aspectRatio: $0.aspectRatio)
            })

        var featurePrintFields = PhotoDiagnosticsReport.FeaturePrintInfo(
            revision: analysis.featurePrint.revision, bytes: analysis.featurePrint.data.count,
            data: nil)
        if includeFeaturePrintData {
            featurePrintFields = PhotoDiagnosticsReport.FeaturePrintInfo(
                revision: featurePrintFields.revision, bytes: featurePrintFields.bytes,
                data: analysis.featurePrint.data.base64EncodedString())
        }

        let matches = PhotoEvidenceScorer.policyMatches(analysis)
        let routing = PhotoImportCatalog.routingPolicies
            .sorted { $0.key.rawValue < $1.key.rawValue }
            .map { key, policy -> PhotoDiagnosticsReport.RoutingVerdict in
                let match = matches[key]!
                return PhotoDiagnosticsReport.RoutingVerdict(
                    entity: key,
                    emoji: EntityCatalog[key].emoji,
                    classifierIdentifier: match.classifierIdentifier,
                    classifierConfidence: match.classifierConfidence,
                    minimumScore: match.minimumScore,
                    meetsMinimumScore: match.meetsMinimumScore,
                    wantedLabels: policy.classifierLabels,
                    candidateFields: policy.candidateFields,
                    temporalFields: policy.temporalFields,
                    ocrFields: policy.ocrFields)
            }
        // The entity whose classifier match both clears its policy's minimum score and scores
        // highest among those that do — the same verdict the app's "Suggested: …" chip surfaces.
        let suggestedSource =
            matches
            .filter { $0.value.meetsMinimumScore }
            .max { ($0.value.classifierConfidence ?? 0) < ($1.value.classifierConfidence ?? 0) }
            .map { $0.key }

        let semanticModel = String(
            describing: FoundationModelsPhotoSemanticModel().availability(for: .current))

        var semantic: PhotoDiagnosticsReport.Semantic?
        var semanticMs: Double?
        if runSemantic {
            let start = Date()
            semantic = await Self.runSemantic(analysis)
            semanticMs = Date().timeIntervalSince(start) * 1000
        }

        return PhotoDiagnosticsReport(
            file: fileInfo, identity: identity, classifications: analysis.classifications,
            recognizedText: analysis.recognizedText, featurePrint: featurePrintFields,
            routing: routing, suggestedSource: suggestedSource, semanticModel: semanticModel,
            semantic: semantic,
            timings: PhotoDiagnosticsReport.Timings(
                analyzeMs: analyzeMs, semanticMs: semanticMs))
    }

    // MARK: - Semantic reranking

    /// `rerank` only ever throws `CancellationError` (every model failure is folded into
    /// `modelStatus`); this function is deliberately non-throwing (a debug report degrades to "no
    /// semantic result" rather than aborting), so cancellation is swallowed here too — a caller
    /// that cares about cancellation (the app's generation-token check) discards the whole report.
    private static func runSemantic(_ analysis: PhotoLocalAnalysis) async -> PhotoDiagnosticsReport
        .Semantic?
    {
        let candidates = PhotoImportCatalog.routingPolicies.keys
            .sorted { $0.rawValue < $1.rawValue }
            .map { key in
                PhotoRoutingCandidate(
                    id: "type:\(key.rawValue)", routeID: "\(key.rawValue)-self",
                    description: EntityCatalog[key].plural)
            }
        let matches = PhotoEvidenceScorer.policyMatches(analysis)
        let deterministicIDs =
            matches
            .filter { $0.value.meetsMinimumScore }
            .sorted { ($0.value.classifierConfidence ?? 0) > ($1.value.classifierConfidence ?? 0) }
            .map { "type:\($0.key.rawValue)" }
        let evidence = PhotoRoutingEvidence(
            photoID: analysis.id, summary: Self.evidenceSummary(analysis),
            deterministicCandidateIDs: deterministicIDs)
        do {
            let result = try await PhotoSemanticReranker().rerank(
                evidence: [evidence], candidates: candidates)
            return PhotoDiagnosticsReport.Semantic(
                status: Self.statusName(result.modelStatus), decisions: result.decisions)
        } catch {
            return nil
        }
    }

    private static func evidenceSummary(_ analysis: PhotoLocalAnalysis) -> String {
        let classifications = analysis.classifications.prefix(3).map(\.identifier).joined(separator: ", ")
        let text = analysis.recognizedText.prefix(3).map(\.text).joined(separator: " / ")
        return
            "classifications: \(classifications.isEmpty ? "none" : classifications); text: \(text.isEmpty ? "none" : text)"
    }

    private static func statusName(_ status: PhotoSemanticModelStatus) -> String {
        switch status {
        case .used: "used"
        case .unavailable(let availability): "unavailable(\(availability))"
        case .failed(let failure): "failed(\(failure.rawValue))"
        }
    }
}
