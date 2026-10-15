import Testing

@testable import CubbyKit

@Suite("Photo review identity")
struct PhotoReviewPolicyTests {
    // Missing structured decisions must not turn legacy prose ambiguity into approval.
    @Test func requiresResolvedIdentityAndReceiveLocation() {
        var group = PhotoGroupProposal(
            groupKey: "shirt", state: .proposed,
            images: [.init(id: ImageCode("IMG-2345"), purpose: .item)], skip: [],
            product: .create(.init(kind: .create, create: .init(name: "Synthetic shirt"))),
            missingImageCount: 0, updatedAt: "2026-10-01T12:00:00Z")
        #expect(PhotoReviewPolicy.approvalBlocker(group: group, images: [], runStatus: .running) != nil)
        group.review = .init(
            observedName: "Synthetic shirt", unresolvedReason: "Confirm size", stockIntent: .evidence)
        #expect(
            PhotoReviewPolicy.approvalBlocker(group: group, images: [], runStatus: .running) == "Confirm size"
        )
        group.review?.unresolvedReason = nil
        #expect(PhotoReviewPolicy.approvalBlocker(group: group, images: [], runStatus: .running) == nil)
        group.review?.productChanges = .init(notes: "Synthetic label notes")
        #expect(PhotoReviewPolicy.approvalBlocker(group: group, images: [], runStatus: .running) != nil)
        group.review?.productChanges = nil
        group.review?.stockIntent = .receive
        #expect(PhotoReviewPolicy.approvalBlocker(group: group, images: [], runStatus: .running) != nil)
        group.review?.stockIntent = .historical
        #expect(PhotoReviewPolicy.effects(group: group).contains("No stock change"))
        #expect(PhotoReviewPolicy.approvalBlocker(group: group, images: [], runStatus: .running) == nil)
    }
}
