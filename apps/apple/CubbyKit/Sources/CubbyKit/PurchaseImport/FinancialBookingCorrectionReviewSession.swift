import Foundation
import Observation

/// Owns the reviewed preview; the server rechecks its fingerprint before economic writes.
@MainActor @Observable
public final class FinancialBookingCorrectionReviewSession {
    public private(set) var preview: FinancialBookingCorrectionPreview?
    public private(set) var result: FinancialBookingCorrectionResult?
    public private(set) var isBusy = false
    private var generation = UUID()

    public init(reviewed: FinancialBookingCorrectionPreview? = nil) { preview = reviewed }

    public func invalidateReview(clearResult: Bool = false) {
        generation = UUID()
        preview = nil
        isBusy = false
        if clearResult { result = nil }
    }

    public func prepare(_ input: FinancialBookingCorrectionInput, client: CubbyClient) async throws {
        guard !isBusy else { return }
        let requestGeneration = generation
        isBusy = true
        preview = nil
        defer { if generation == requestGeneration { isBusy = false } }
        let reviewed = try await client.previewFinancialBookingCorrection(input)
        guard generation == requestGeneration else { throw CancellationError() }
        preview = reviewed
    }

    @discardableResult
    public func commit(client: CubbyClient) async throws -> FinancialBookingCorrectionResult {
        guard !isBusy, let reviewed = preview else { throw ReviewRequired() }
        let requestGeneration = generation
        isBusy = true
        defer { if generation == requestGeneration { isBusy = false } }
        let input = try JSONDecoder.cubby().decode(
            FinancialBookingCorrectionPreviewInput.self, from: JSONEncoder.cubby().encode(reviewed))
        let committed = try await client.commitFinancialBookingCorrection(input)
        if generation == requestGeneration {
            result = committed
            preview = nil
        }
        return committed
    }

    private struct ReviewRequired: LocalizedError {
        var errorDescription: String? { "Review this transaction before confirming." }
    }
}
