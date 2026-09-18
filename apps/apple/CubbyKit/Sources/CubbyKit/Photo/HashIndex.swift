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

public struct HashQuery: Sendable, Hashable {
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

public struct DedupCandidate: Sendable, Hashable {
    public enum Basis: Sendable, Hashable { case content, source }
    public enum Confidence: Sendable, Hashable { case strong, possible }

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
            if let hash = entry.perceptualHash,
                let confidence = confidence(
                    distance: query.perceptualHash.distance(to: hash),
                    leftRatio: query.aspectRatio,
                    rightRatio: ratio(width: entry.width, height: entry.height))
            {
                candidates.append(
                    DedupCandidate(
                        id: entry.id, basis: .content, confidence: confidence,
                        distance: query.perceptualHash.distance(to: hash)))
            }
            if let querySource = query.sourceFingerprint, let hash = entry.perceptualHash,
                let confidence = confidence(
                    distance: querySource.hash.distance(to: hash),
                    leftRatio: querySource.aspectRatio,
                    rightRatio: ratio(width: entry.width, height: entry.height))
            {
                candidates.append(
                    DedupCandidate(
                        id: entry.id, basis: .content, confidence: confidence,
                        distance: querySource.hash.distance(to: hash)))
            }
            if let querySource = query.sourceFingerprint, let source = entry.sourceFingerprint,
                let confidence = confidence(
                    distance: querySource.hash.distance(to: source.hash),
                    leftRatio: querySource.aspectRatio, rightRatio: source.aspectRatio)
            {
                candidates.append(
                    DedupCandidate(
                        id: entry.id, basis: .source, confidence: confidence,
                        distance: querySource.hash.distance(to: source.hash)))
            }
            if let source = entry.sourceFingerprint,
                let confidence = confidence(
                    distance: query.perceptualHash.distance(to: source.hash),
                    leftRatio: query.aspectRatio, rightRatio: source.aspectRatio)
            {
                candidates.append(
                    DedupCandidate(
                        id: entry.id, basis: .source, confidence: confidence,
                        distance: query.perceptualHash.distance(to: source.hash)))
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

    private func confidence(distance: Int, leftRatio: Double?, rightRatio: Double?) -> DedupCandidate
        .Confidence?
    {
        switch distance {
        case 0...2:
            return .strong
        case 3...6:
            guard let leftRatio, let rightRatio else { return .possible }
            let denominator = max(abs(leftRatio), abs(rightRatio))
            let agrees = denominator > 0 && abs(leftRatio - rightRatio) / denominator <= 0.02
            return agrees ? .strong : .possible
        default:
            return nil
        }
    }

    private func ratio(width: Int?, height: Int?) -> Double? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        return Double(max(width, height)) / Double(min(width, height))
    }
}
