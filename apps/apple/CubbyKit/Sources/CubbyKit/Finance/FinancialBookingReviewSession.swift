import Foundation
import Observation

/// Owns the reviewed preview; the server rechecks its fingerprint before economic writes.
@MainActor @Observable
public final class FinancialBookingReviewSession {
    public private(set) var preview: FinancialBookingPreview?
    public private(set) var result: FinancialBookingResult?
    public private(set) var isBusy = false
    private var generation = UUID()

    public init(reviewed: FinancialBookingPreview? = nil) { preview = reviewed }

    public func invalidateReview(clearResult: Bool = false) {
        generation = UUID()
        preview = nil
        isBusy = false
        if clearResult { result = nil }
    }

    public func prepare(_ input: FinancialBookingInput, client: CubbyClient) async throws {
        guard !isBusy else { return }
        let requestGeneration = generation
        isBusy = true
        preview = nil
        defer { if generation == requestGeneration { isBusy = false } }
        let reviewed = try await client.previewFinancialBooking(input)
        guard generation == requestGeneration else { throw CancellationError() }
        preview = reviewed
    }

    @discardableResult
    public func commit(client: CubbyClient) async throws -> FinancialBookingResult {
        guard !isBusy, let reviewed = preview else { throw ReviewRequired() }
        let requestGeneration = generation
        isBusy = true
        defer { if generation == requestGeneration { isBusy = false } }
        let input = try JSONDecoder.cubby().decode(
            FinancialBookingPreviewInput.self, from: JSONEncoder.cubby().encode(reviewed))
        let committed = try await client.commitFinancialBooking(input)
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
