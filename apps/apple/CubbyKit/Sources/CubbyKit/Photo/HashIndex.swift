import CubbyAPI
import Foundation

public struct ImageHashEntry: Sendable, Hashable, Codable {
    public let id: ImageCode
    public let perceptualHash: PerceptualHash64?
    public let sourceFingerprint: SourceFingerprint?
    public let width: Int?
    public let height: Int?
    /// Direct owners are returned with the hash index so a grid can render
    /// ownership without issuing one request per cell.
    public let directOwnerShortcodes: [String]

    public init(
        id: ImageCode,
        perceptualHash: PerceptualHash64? = nil,
        sourceFingerprint: SourceFingerprint? = nil,
        width: Int? = nil,
        height: Int? = nil,
        directOwnerShortcodes: [String] = []
    ) {
        self.id = id
        self.perceptualHash = perceptualHash
        self.sourceFingerprint = sourceFingerprint
        self.width = width
        self.height = height
        self.directOwnerShortcodes = directOwnerShortcodes
    }

    private enum CodingKeys: String, CodingKey {
        case id, perceptualHash, sourceFingerprint, width, height, directOwnerShortcodes
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(ImageCode.self, forKey: .id)
        perceptualHash = try container.decodeIfPresent(
            PerceptualHash64.self, forKey: .perceptualHash)
        sourceFingerprint = try container.decodeIfPresent(
            SourceFingerprint.self, forKey: .sourceFingerprint)
        width = try container.decodeIfPresent(Int.self, forKey: .width)
        height = try container.decodeIfPresent(Int.self, forKey: .height)
        directOwnerShortcodes =
            try container.decodeIfPresent(
                [String].self, forKey: .directOwnerShortcodes) ?? []
    }

    /// One `image.hashIndex` row, its hex hashes parsed.
    public init(_ item: ImageHashIndexItem) throws {
        try self.init(
            id: item.id,
            perceptualHash: item.perceptualHash.map { try PerceptualHash64(hex: $0) },
            sourceFingerprint: item.sourceFingerprint.map {
                try SourceFingerprint(hash: PerceptualHash64(hex: $0.hash), aspectRatio: $0.aspectRatio)
            },
            width: item.width,
            height: item.height,
            directOwnerShortcodes: item.directOwnerShortcodes)
    }

    /// A process-stable FNV-1a digest of exactly the fields `HashIndex.candidates(for:)` reads, so
    /// a persisted match result can tell which index entries changed since it was computed.
    /// `Hasher` is seeded per process and cannot be stored; owners are excluded because they never
    /// change a match.
    public var matchDigest: UInt64 {
        var digest: UInt64 = 0xcbf2_9ce4_8422_2325
        func mix(_ value: UInt64) {
            for shift in stride(from: 0, to: 64, by: 8) {
                digest ^= (value >> UInt64(shift)) & 0xff
                digest = digest &* 0x100_0000_01b3
            }
        }
        // A presence marker before each optional keeps "missing" distinct from a zero value.
        mix(perceptualHash == nil ? 0 : 1)
        mix(perceptualHash?.value ?? 0)
        mix(sourceFingerprint == nil ? 0 : 1)
        mix(sourceFingerprint?.hash.value ?? 0)
        mix(sourceFingerprint?.aspectRatio.bitPattern ?? 0)
        mix(width.map { UInt64(bitPattern: Int64($0)) } ?? UInt64.max)
        mix(height.map { UInt64(bitPattern: Int64($0)) } ?? UInt64.max)
        return digest
    }
}

/// A hash computed on-device for an image the server could not hash itself.
public struct ImageHashUpdate: Sendable, Hashable {
    public let id: ImageCode
    public let perceptualHash: PerceptualHash64
    public init(id: ImageCode, perceptualHash: PerceptualHash64) {
        self.id = id
        self.perceptualHash = perceptualHash
    }
}

public struct HashQuery: Codable, Sendable, Hashable {
    public let perceptualHash: PerceptualHash64
    public let aspectRatio: Double
    public let sourceFingerprint: SourceFingerprint?

    public init(
        perceptualHash: PerceptualHash64,
        aspectRatio: Double,
        sourceFingerprint: SourceFingerprint? = nil
    ) {
        self.perceptualHash = perceptualHash
        self.aspectRatio = aspectRatio > 0 ? max(aspectRatio, 1 / aspectRatio) : aspectRatio
        self.sourceFingerprint = sourceFingerprint
    }
}

public struct DedupCandidate: Codable, Sendable, Hashable {
    public enum Basis: String, Codable, Sendable, Hashable { case content, source }
    public enum Confidence: String, Codable, Sendable, Hashable { case strong, possible }

    public let id: ImageCode
    public let basis: Basis
    public let confidence: Confidence
    public let distance: Int

    public init(id: ImageCode, basis: Basis, confidence: Confidence, distance: Int) {
        self.id = id
        self.basis = basis
        self.confidence = confidence
        self.distance = distance
    }
}

/// The shared decision contract for every perceptual-hash comparison. Its thresholds deliberately
/// match the server-index matcher: 0...2 is strong; 3...6 is strong only within 2% aspect-ratio
/// agreement; larger distances are rejected.
public struct PhotoMatchVerdict: Codable, Sendable, Hashable, Equatable {
    public enum Confidence: String, Codable, Sendable, Hashable { case strong, possible, rejected }
    public enum Reason: String, Codable, Sendable, Hashable {
        case exactDistance
        case aspectRatiosAgree
        case missingAspectRatio
        case aspectRatiosDiffer
        case distanceTooLarge
    }

    public let confidence: Confidence
    public let reason: Reason

    public var candidateConfidence: DedupCandidate.Confidence? {
        switch confidence {
        case .strong: .strong
        case .possible: .possible
        case .rejected: nil
        }
    }

    public init(confidence: Confidence, reason: Reason) {
        self.confidence = confidence
        self.reason = reason
    }

    /// Every distance above this is `.rejected` regardless of aspect ratio, which lets
    /// `HashIndex.candidates(for:)` skip the verdict for the overwhelming majority of pairs.
    public static let maxCandidateDistance = 6

    public static func evaluate(
        distance: Int, leftAspectRatio: Double?, rightAspectRatio: Double?
    ) -> Self {
        switch distance {
        case 0...2:
            return Self(confidence: .strong, reason: .exactDistance)
        case 3...maxCandidateDistance:
            guard let leftAspectRatio, let rightAspectRatio else {
                return Self(confidence: .possible, reason: .missingAspectRatio)
            }
            let denominator = max(abs(leftAspectRatio), abs(rightAspectRatio))
            let agrees =
                denominator > 0
                && abs(leftAspectRatio - rightAspectRatio) / denominator <= 0.02
            return agrees
                ? Self(confidence: .strong, reason: .aspectRatiosAgree)
                : Self(confidence: .possible, reason: .aspectRatiosDiffer)
        default:
            return Self(confidence: .rejected, reason: .distanceTooLarge)
        }
    }
}

public struct HashIndex: Sendable {
    public static let algorithmRevision = PerceptualHash64.algorithmRevision

    public enum Failure: Error, Sendable, Equatable { case unsupportedRevision(Int) }

    private let entries: [ImageHashEntry]

    public init(
        entries: [ImageHashEntry],
        algorithmRevision: Int = PerceptualHash64.algorithmRevision
    ) throws {
        guard algorithmRevision == Self.algorithmRevision else {
            throw Failure.unsupportedRevision(algorithmRevision)
        }
        self.entries = entries
    }

    public func candidates(for query: HashQuery) -> [DedupCandidate] {
        // Called once per library photo against every index entry (~90k x ~6k pairs on a large
        // library), so a pair beyond `maxCandidateDistance` is rejected before any verdict,
        // ratio, or allocation. Pairs are considered in the original order, so ties keep the
        // same first-seen winner.
        var best: [CandidateKey: DedupCandidate] = [:]
        func consider(
            _ lhs: PerceptualHash64, _ lhsRatio: Double?, _ rhs: PerceptualHash64,
            _ rhsRatio: @autoclosure () -> Double?, id: ImageCode, basis: DedupCandidate.Basis
        ) {
            let distance = lhs.distance(to: rhs)
            guard distance <= PhotoMatchVerdict.maxCandidateDistance else { return }
            let verdict = PhotoMatchVerdict.evaluate(
                distance: distance, leftAspectRatio: lhsRatio, rightAspectRatio: rhsRatio())
            guard let confidence = verdict.candidateConfidence else { return }
            let candidate = DedupCandidate(id: id, basis: basis, confidence: confidence, distance: distance)
            let key = CandidateKey(id: id, basis: basis)
            guard let current = best[key] else {
                best[key] = candidate
                return
            }
            if candidate.confidence == .strong && current.confidence == .possible
                || candidate.confidence == current.confidence && candidate.distance < current.distance
            {
                best[key] = candidate
            }
        }
        let querySource = query.sourceFingerprint
        for entry in entries {
            if let hash = entry.perceptualHash {
                consider(
                    query.perceptualHash, query.aspectRatio, hash,
                    Self.ratio(width: entry.width, height: entry.height), id: entry.id, basis: .content)
                if let querySource {
                    consider(
                        querySource.hash, querySource.aspectRatio, hash,
                        Self.ratio(width: entry.width, height: entry.height), id: entry.id, basis: .content)
                }
            }
            if let source = entry.sourceFingerprint {
                if let querySource {
                    consider(
                        querySource.hash, querySource.aspectRatio, source.hash, source.aspectRatio,
                        id: entry.id, basis: .source)
                }
                consider(
                    query.perceptualHash, query.aspectRatio, source.hash, source.aspectRatio,
                    id: entry.id, basis: .source)
            }
        }
        return Self.ranked(best.values)
    }

    /// The one candidate order every matcher result uses — strong first, then closest, then a
    /// stable id/basis tiebreak — shared with `PhotoMatchDelta` so a delta-updated result is
    /// indistinguishable from a full match.
    public static func ranked(_ candidates: some Sequence<DedupCandidate>) -> [DedupCandidate] {
        candidates.sorted {
            if $0.confidence != $1.confidence { return $0.confidence == .strong }
            if $0.distance != $1.distance { return $0.distance < $1.distance }
            if $0.id != $1.id { return $0.id.rawValue < $1.id.rawValue }
            return $0.basis == .content && $1.basis == .source
        }
    }

    private struct CandidateKey: Hashable {
        let id: ImageCode
        let basis: DedupCandidate.Basis
    }

    public static func ratio(width: Int?, height: Int?) -> Double? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        return Double(max(width, height)) / Double(min(width, height))
    }
}
