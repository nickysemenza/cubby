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

    public static func evaluate(
        distance: Int, leftAspectRatio: Double?, rightAspectRatio: Double?
    ) -> Self {
        switch distance {
        case 0...2:
            return Self(confidence: .strong, reason: .exactDistance)
        case 3...6:
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
        let found = entries.flatMap { entry -> [DedupCandidate] in
            var candidates: [DedupCandidate] = []
            if let hash = entry.perceptualHash {
                let verdict = PhotoMatchVerdict.evaluate(
                    distance: query.perceptualHash.distance(to: hash),
                    leftAspectRatio: query.aspectRatio,
                    rightAspectRatio: Self.ratio(width: entry.width, height: entry.height))
                if let confidence = verdict.candidateConfidence {
                    candidates.append(
                        DedupCandidate(
                            id: entry.id, basis: .content, confidence: confidence,
                            distance: query.perceptualHash.distance(to: hash)))
                }
            }
            if let querySource = query.sourceFingerprint, let hash = entry.perceptualHash {
                let verdict = PhotoMatchVerdict.evaluate(
                    distance: querySource.hash.distance(to: hash),
                    leftAspectRatio: querySource.aspectRatio,
                    rightAspectRatio: Self.ratio(width: entry.width, height: entry.height))
                if let confidence = verdict.candidateConfidence {
                    candidates.append(
                        DedupCandidate(
                            id: entry.id, basis: .content, confidence: confidence,
                            distance: querySource.hash.distance(to: hash)))
                }
            }
            if let querySource = query.sourceFingerprint, let source = entry.sourceFingerprint {
                let verdict = PhotoMatchVerdict.evaluate(
                    distance: querySource.hash.distance(to: source.hash),
                    leftAspectRatio: querySource.aspectRatio, rightAspectRatio: source.aspectRatio)
                if let confidence = verdict.candidateConfidence {
                    candidates.append(
                        DedupCandidate(
                            id: entry.id, basis: .source, confidence: confidence,
                            distance: querySource.hash.distance(to: source.hash)))
                }
            }
            if let source = entry.sourceFingerprint {
                let verdict = PhotoMatchVerdict.evaluate(
                    distance: query.perceptualHash.distance(to: source.hash),
                    leftAspectRatio: query.aspectRatio, rightAspectRatio: source.aspectRatio)
                if let confidence = verdict.candidateConfidence {
                    candidates.append(
                        DedupCandidate(
                            id: entry.id, basis: .source, confidence: confidence,
                            distance: query.perceptualHash.distance(to: source.hash)))
                }
            }
            return candidates
        }
        var best: [CandidateKey: DedupCandidate] = [:]
        for candidate in found {
            let key = CandidateKey(id: candidate.id, basis: candidate.basis)
            guard let current = best[key] else {
                best[key] = candidate
                continue
            }
            if candidate.confidence == .strong && current.confidence == .possible
                || candidate.confidence == current.confidence && candidate.distance < current.distance
            {
                best[key] = candidate
            }
        }
        return best.values.sorted {
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
