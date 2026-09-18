import CubbyKit
import Foundation
import Vision

struct PhotoVisualEvidenceCandidate: Sendable {
    let id: String
    let source: EntityKey
    let sourceID: String
}

struct PhotoVisualEvidenceMatch: Sendable, Equatable {
    let candidateID: String
    let distance: Double
}

/// Compares a selected photo with imagery reached only through manifest-declared evidence paths.
/// Display fallbacks are never read here, so a Product image borrowed for Planting presentation
/// cannot become Planting identity evidence.
struct PhotoVisualEvidenceMatcher: Sendable {
    // Visual history is a refinement, not permission to fan out across the library. A dozen
    // likely records with two recent direct images apiece keeps this bounded on cellular and
    // lets manual assignment remain immediately usable while comparison continues.
    static let maximumCandidates = 12
    static let maximumConcurrentCandidates = 4
    static let maximumEvidenceImagesPerCandidate = 2

    private let loader: CoverImageLoader

    init(loader: CoverImageLoader = CoverImageLoader()) {
        self.loader = loader
    }

    func matches(
        analyses: [String: PhotoLocalAnalysis],
        candidates: [PhotoVisualEvidenceCandidate],
        client: CubbyClient
    ) async -> [String: PhotoVisualEvidenceMatch] {
        let candidates = Array(candidates.prefix(Self.maximumCandidates))
        guard !analyses.isEmpty, !candidates.isEmpty else { return [:] }

        let distances = await withTaskGroup(
            of: (String, [String: Double]).self,
            returning: [String: [String: Double]].self
        ) { group in
            var iterator = candidates.makeIterator()
            var result: [String: [String: Double]] = [:]

            func enqueue(_ candidate: PhotoVisualEvidenceCandidate) {
                group.addTask { [loader] in
                    let values = await Self.distances(
                        analyses: analyses, candidate: candidate, client: client, loader: loader)
                    return (candidate.id, values)
                }
            }

            for _ in 0..<min(Self.maximumConcurrentCandidates, candidates.count) {
                if let candidate = iterator.next() { enqueue(candidate) }
            }
            for await (candidateID, values) in group {
                result[candidateID] = values
                if let candidate = iterator.next() { enqueue(candidate) }
            }
            return result
        }

        return analyses.keys.reduce(into: [:]) { result, photoID in
            let ranked = distances.compactMap { candidateID, values in
                values[photoID].map { (candidateID, $0) }
            }
            if let winner = Self.clearWinner(ranked) {
                result[photoID] = PhotoVisualEvidenceMatch(
                    candidateID: winner.0, distance: winner.1)
            }
        }
    }

    static func clearWinner(_ distances: [(String, Double)]) -> (String, Double)? {
        let ranked = distances.sorted { $0.1 < $1.1 }
        guard let first = ranked.first else { return nil }
        if let second = ranked.dropFirst().first {
            guard first.1 <= 0.75, second.1 - first.1 >= 0.12 else { return nil }
        } else {
            guard first.1 <= 0.55 else { return nil }
        }
        return first
    }

    private static func distances(
        analyses: [String: PhotoLocalAnalysis],
        candidate: PhotoVisualEvidenceCandidate,
        client: CubbyClient,
        loader: CoverImageLoader
    ) async -> [String: Double] {
        let evidence = PhotoImportCatalog.visualEvidence
            .filter { $0.source == candidate.source }
            .sorted { $0.priority < $1.priority }
        guard !evidence.isEmpty else { return [:] }
        let queryPrints = analyses.compactMapValues { analysis -> FeaturePrintObservation? in
            guard analysis.featurePrint.revision == "vision-feature-print-2" else { return nil }
            return try? JSONDecoder().decode(
                FeaturePrintObservation.self, from: analysis.featurePrint.data)
        }
        guard !queryPrints.isEmpty else { return [:] }

        var urls: [URL] = []
        for binding in evidence {
            guard let relationshipKey = binding.relationPath.first else { continue }
            do {
                let root = EntityRef(entity: candidate.source, id: candidate.sourceID)
                let page = try await client.relationshipPage(
                    root: root, relationshipKey: relationshipKey, offset: 0, limit: 3)
                let branch = page.branches.first {
                    $0.root == root && $0.relationshipKey == relationshipKey
                }
                for reference in branch?.items ?? [] {
                    guard reference.entity == binding.target,
                        let detail = try await client.row(
                            EntityCatalog[binding.target], id: reference.id)
                    else { continue }
                    // Graph nodes expose display imagery, which can be borrowed from another
                    // entity (for example a Meal falling back to its Recipe). Only a directly
                    // attached, uploaded gallery image is identity evidence here. `role` is the
                    // server's attachment contract; cover and logo media are never comparable.
                    urls.append(contentsOf: Self.directGalleryURLs(in: detail))
                }
            } catch is CancellationError {
                return [:]
            } catch {
                Diagnostics.report(error, context: "photos.manifest.visual-evidence")
            }
        }

        var result: [String: Double] = [:]
        for url in Array(Set(urls)).prefix(Self.maximumEvidenceImagesPerCandidate) {
            guard !Task.isCancelled, let image = try? await loader.load(url),
                let evidencePrint = try? await FeaturePrintIndex.featurePrint(of: image)
            else { continue }
            for (photoID, query) in queryPrints {
                guard let distance = try? query.distance(to: evidencePrint) else { continue }
                result[photoID] = min(result[photoID] ?? .infinity, distance)
            }
        }
        return result
    }

    static func directGalleryURLs(in row: EntityRow) -> [URL] {
        (row.raw["attachments"]?.arrayValue ?? []).compactMap { attachment in
            guard attachment["role"]?.stringValue == "attachment",
                attachment["status"]?.stringValue?.uppercased() == "UPLOADED",
                let rawURL = attachment["url"]?.stringValue,
                let url = URL(string: rawURL)
            else { return nil }
            return url
        }
    }
}
