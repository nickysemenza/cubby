import CubbyAPISupport
import Foundation

/// Text/date/classifier evidence scoring for one photo's local analysis against one catalog row.
/// Candidate ranking (a manually chosen catalog), deterministic routing (automatic assignment),
/// and type suggestion (the "Suggested: …" chip) all walk this same weighted-max formula; keeping
/// it here means a weight tuning change cannot drift between call sites.
public enum PhotoEvidenceScorer {
    // Recognized OCR text scores near 1:1 with its own Vision confidence — the least ambiguous of
    // the three signals.
    private static let textWeight = 0.96
    // A same-day temporal-field match is slightly less certain than exact recognized text.
    private static let temporalWeight = 0.88
    // The Vision classifier only nudges an otherwise-supported score; it never carries a match by
    // itself.
    private static let classifierWeight = 0.08
    // Below this length, recognized text is noise (stray glyphs, single characters).
    private static let minimumRecognizedTextLength = 3

    public struct Score: Codable, Sendable {
        public let text: Double
        public let classifier: Double
        public let date: Double
        public let identity: Double

        public init(text: Double, classifier: Double, date: Double, identity: Double) {
            self.text = text
            self.classifier = classifier
            self.date = date
            self.identity = identity
        }

        public var combined: Double {
            min(1, max(text, date, identity) + classifier * PhotoEvidenceScorer.classifierWeight)
        }
    }

    /// Per-entity-type policy verdict for one analysis. The classifier match is modeled as two
    /// optional fields rather than a tuple so the type can be `Codable` (for the CLI's JSON dump).
    public struct PolicyMatch: Codable, Sendable {
        public let classifierIdentifier: String?
        public let classifierConfidence: Double?
        public let meetsMinimumScore: Bool
        public let minimumScore: Double

        public init(
            classifierIdentifier: String?, classifierConfidence: Double?, meetsMinimumScore: Bool,
            minimumScore: Double
        ) {
            self.classifierIdentifier = classifierIdentifier
            self.classifierConfidence = classifierConfidence
            self.meetsMinimumScore = meetsMinimumScore
            self.minimumScore = minimumScore
        }
    }

    /// The best of `analysis`'s classifications that names one of `policy`'s labels: the label
    /// that matched and its confidence.
    public static func classifierMatch(
        _ analysis: PhotoLocalAnalysis, policy: PhotoRoutingPolicy
    ) -> (identifier: String, confidence: Double)? {
        analysis.classifications
            .filter { classification in
                let identifier = classification.identifier.lowercased()
                return policy.classifierLabels.contains { identifier.contains($0.lowercased()) }
            }
            .max { $0.confidence < $1.confidence }
            .map { (identifier: $0.identifier, confidence: $0.confidence) }
    }

    /// A policy's declared candidate fields, read off `row.raw` — the one place `candidateFields`
    /// is read. Used both for text-evidence matching (`searchableText`, folded into one lowercased
    /// string) and for a candidate's display description (kept as separate values so the display
    /// format can differ from the matching format).
    public static func candidateFieldValues(_ row: EntityRow, policy: PhotoRoutingPolicy?) -> [String] {
        policy?.candidateFields.compactMap { row.raw[$0]?.stringValue } ?? []
    }

    /// Title plus the policy's declared candidate fields, space-joined. Case-preserving; callers
    /// lowercase it to match against already-lowercased recognized text.
    public static func searchableText(_ row: EntityRow, policy: PhotoRoutingPolicy?) -> String {
        ([row.title] + candidateFieldValues(row, policy: policy)).joined(separator: " ")
    }

    /// Weighted evidence score for one row against one analysis. `identity` is 1 when the caller
    /// already knows the row is the right one by some non-text signal (a visual match, an
    /// authoritative owner) and 0 otherwise — callers compute it themselves since what counts as
    /// "identity" differs between candidate ranking and deterministic routing.
    public static func score(
        analysis: PhotoLocalAnalysis, row: EntityRow, policy: PhotoRoutingPolicy?, identity: Double
    ) -> Score {
        let searchable = searchableText(row, policy: policy).lowercased()
        let textScore = analysis.recognizedText.reduce(0.0) { score, text in
            let recognized = text.text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard recognized.count >= minimumRecognizedTextLength, searchable.contains(recognized)
            else { return score }
            return max(score, textWeight * text.confidence)
        }
        let classifierScore =
            policy.flatMap { classifierMatch(analysis, policy: $0)?.confidence } ?? 0
        let dateScore: Double = {
            guard let policy, let day = analysis.capturedAt.map({ PlainDate($0).rawValue }) else {
                return 0
            }
            let matches = policy.temporalFields.contains { field in
                row.raw[field]?.stringValue?.hasPrefix(day) == true
            }
            return matches ? temporalWeight : 0
        }()
        return Score(text: textScore, classifier: classifierScore, date: dateScore, identity: identity)
    }

    /// Per-entity-type policy verdicts for one analysis — what `suggestedSource` picks the max of,
    /// and what the CLI's `photo analyze --json` dumps under `routing`.
    public static func policyMatches(_ analysis: PhotoLocalAnalysis) -> [EntityKey: PolicyMatch] {
        PhotoImportCatalog.routingPolicies.mapValues { policy in
            let match = classifierMatch(analysis, policy: policy)
            return PolicyMatch(
                classifierIdentifier: match?.identifier,
                classifierConfidence: match?.confidence,
                meetsMinimumScore: (match?.confidence ?? 0) >= policy.minimumScore,
                minimumScore: policy.minimumScore)
        }
    }
}
