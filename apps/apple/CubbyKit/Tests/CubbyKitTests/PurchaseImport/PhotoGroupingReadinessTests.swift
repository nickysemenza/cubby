import Foundation
import Testing

@testable import CubbyKit

@Suite("Photo grouping readiness")
struct PhotoGroupingReadinessTests {
    // Regression (server RUN-6KHAT): a skipped description counted as described, so grouping
    // auto-started on a photo with no description. Skipped and failed both hold grouping, even
    // when the Run already stopped for review, until the member continues without them.
    @Test func groupingReadinessHoldsForSkippedAndFailedDescriptions() {
        func image(_ id: String, _ describe: ImageProcessingJobState) -> PhotoRunImage {
            PhotoRunImage(
                id: ImageCode(id), position: nil, capturedAt: nil, capturedAtOffsetMinutes: nil,
                targetState: .pending, skipReason: nil, originalUrl: "synthetic://\(id)",
                cutoutUrl: nil, cutout: nil, describe: describe, cloudDescriptionMissing: false,
                describeStartedAt: nil, describeCompletedAt: nil,
                describeAttemptMs: nil, describeWaitingMs: nil, localAnalysisReady: true,
                cutoutReason: nil, describeReason: nil, description: nil, recognizedText: nil,
                deviceWorkState: nil, deviceWorkError: nil, deviceWorkAttempts: 0)
        }
        let ready = image("IMG-2345", .ready)
        let skipped = image("IMG-2346", .skipped)
        let failed = image("IMG-2347", .failed)

        #expect(
            PhotoGroupingReadiness(images: [ready, skipped], runStatus: .running)
                == .descriptionsMissing([skipped.id]))
        #expect(
            PhotoGroupingReadiness(
                images: [ready, skipped, failed], runStatus: .needsReview)
                == .descriptionsMissing([skipped.id, failed.id]))
        // Still processing elsewhere: no answer is asked for yet.
        #expect(
            PhotoGroupingReadiness(
                images: [skipped, image("IMG-2348", .leased)], runStatus: .running) == .processing)
        // Continued without: an excluded photo no longer holds grouping.
        var excluded = skipped
        excluded.targetState = .skipped
        #expect(
            PhotoGroupingReadiness(images: [ready, excluded], runStatus: .running)
                == .readyToStart)
    }
}
