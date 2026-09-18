import Foundation
import Testing

@testable import CubbyKit

private struct StubPhotoSemanticModel: PhotoSemanticModel {
    let status: PhotoSemanticModelAvailability
    let result: Result<[PhotoRoutingDecision], any Error>

    func availability(for locale: Locale) -> PhotoSemanticModelAvailability { status }

    func rank(evidence: [PhotoRoutingEvidence], candidates: [PhotoRoutingCandidate]) async throws
        -> [PhotoRoutingDecision]
    {
        try result.get()
    }
}

@Suite("Photo semantic reranking")
struct PhotoSemanticRerankerTests {
    private let candidates = [
        PhotoRoutingCandidate(id: "MEA-ABCD", routeID: "meal-self", description: "Dinner"),
        PhotoRoutingCandidate(id: "PRJ-ABCD", routeID: "project-self", description: "Patio"),
    ]
    private let evidence = [
        PhotoRoutingEvidence(
            photoID: "photo-1", summary: "Recognized dinner text",
            deterministicCandidateIDs: ["MEA-ABCD"])
    ]

    @Test(arguments: [
        PhotoSemanticModelAvailability.appleIntelligenceNotEnabled,
        .deviceNotEligible,
        .modelNotReady,
        .unsupportedLocale,
    ])
    func unavailableModelsUseTheDeterministicSuggestion(
        status: PhotoSemanticModelAvailability
    ) async throws {
        let reranker = PhotoSemanticReranker(
            model: StubPhotoSemanticModel(
                status: status,
                result: .failure(PhotoSemanticModelFailure.transient)))

        let result = try await reranker.rerank(evidence: evidence, candidates: candidates)

        #expect(result.decisions[0].candidateID == "MEA-ABCD")
        #expect(result.decisions[0].routeID == "meal-self")
        #expect(result.modelStatus == .unavailable(status))
    }

    @Test func rejectsAValidLookingRecordOutsideTheDeterministicCandidateSet() async throws {
        let invented = PhotoRoutingDecision(
            photoID: "photo-1", routeID: "project-self", candidateID: "PRJ-ABCD",
            explanation: "Choose a project")
        let reranker = PhotoSemanticReranker(
            model: StubPhotoSemanticModel(status: .available, result: .success([invented])))

        let result = try await reranker.rerank(evidence: evidence, candidates: candidates)

        #expect(result.decisions[0].candidateID == "MEA-ABCD")
        #expect(result.decisions[0].routeID == "meal-self")
        #expect(result.modelStatus == .used)
    }

    @Test func modelFailuresFallBackWithoutCloudOrImportFailure() async throws {
        let reranker = PhotoSemanticReranker(
            model: StubPhotoSemanticModel(
                status: .available,
                result: .failure(PhotoSemanticModelFailure.guardrail)))

        let result = try await reranker.rerank(evidence: evidence, candidates: candidates)

        #expect(result.decisions[0].candidateID == "MEA-ABCD")
        #expect(result.modelStatus == .failed(.guardrail))
    }

    @Test func cancellationRemainsCancellation() async {
        let reranker = PhotoSemanticReranker(
            model: StubPhotoSemanticModel(
                status: .available, result: .failure(CancellationError())))

        await #expect(throws: CancellationError.self) {
            try await reranker.rerank(evidence: evidence, candidates: candidates)
        }
    }
}
