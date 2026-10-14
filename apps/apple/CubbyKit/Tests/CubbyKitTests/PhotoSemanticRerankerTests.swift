import Foundation
import FoundationModels
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
    @Test("OS 27 model errors retain reranking failure categories across error types")
    func modelErrorCategories() {
        let cases: [(any Error, PhotoSemanticModelFailure)] = [
            (SystemLanguageModel.Error.assetsUnavailable(.init(debugDescription: "synthetic")), .assetsUnavailable),
            (LanguageModelSession.Error.concurrentRequests, .concurrentRequest),
            (GeneratedContent.ParsingError(rawContent: "invalid", debugDescription: "synthetic"), .decoding),
            (LanguageModelError.unsupportedGenerationGuide(.init(schemaName: nil, debugDescription: "synthetic")), .decoding),
            (LanguageModelError.contextSizeExceeded(.init(contextSize: 10, tokenCount: 20, debugDescription: "synthetic")), .contextLimit),
            (LanguageModelError.guardrailViolation(.init(debugDescription: "synthetic")), .guardrail),
            (LanguageModelError.rateLimited(.init(resetDate: nil, debugDescription: "synthetic")), .rateLimited),
            (LanguageModelError.refusal(.init(explanation: "synthetic", debugDescription: "synthetic")), .refusal),
            (LanguageModelError.unsupportedLanguageOrLocale(.init(languageCode: .init("en"), debugDescription: "synthetic")), .unsupportedLocale),
            (LanguageModelError.timeout(.init(debugDescription: "synthetic")), .transient),
        ]
        for (error, expected) in cases {
            #expect(FoundationModelsPhotoSemanticModel.failure(for: error) == expected)
        }
        #expect(FoundationModelsPhotoSemanticModel.failure(for: CancellationError()) == nil)
    }

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
