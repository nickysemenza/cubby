import Foundation
import Observation

/// Holds the server's reviewed impact; classification and stale-review checks stay on the server.
@MainActor @Observable
public final class SpendingClassificationReviewSession {
    public private(set) var preview: SpendingClassificationReviewPreview?
    public private(set) var isBusy = false
    public private(set) var applied = false
    private var generation = UUID()

    public init(reviewed: SpendingClassificationReviewPreview? = nil) {
        preview = reviewed
    }

    public func invalidateReview() {
        generation = UUID()
        preview = nil
        applied = false
    }

    public func prepare(_ input: SpendingClassificationReviewInputRequest, client: CubbyClient) async throws {
        guard !isBusy else { return }
        let requestGeneration = generation
        isBusy = true
        preview = nil
        applied = false
        defer { isBusy = false }
        let result = try await client.previewSpendingClassification(.init(request: input))
        guard generation == requestGeneration else { throw CancellationError() }
        preview = result
    }

    public func apply(client: CubbyClient) async throws {
        guard !isBusy, let reviewed = preview else { throw ReviewRequired() }
        let requestGeneration = generation
        isBusy = true
        defer { isBusy = false }
        // Responses allow additive fields; requests use their generated closed wire schema.
        let request = try JSONDecoder.cubby().decode(
            SpendingClassificationReviewInputRequest.self,
            from: JSONEncoder.cubby().encode(reviewed.request))
        _ = try await client.applySpendingClassification(
            .init(request: request, fingerprint: reviewed.fingerprint))
        if generation == requestGeneration {
            preview = nil
            applied = true
        }
    }

    private struct ReviewRequired: LocalizedError {
        var errorDescription: String? { "Review the historical impact before applying." }
    }
}
