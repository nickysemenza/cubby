import Foundation
import Testing

@testable import CubbyKit

// The generic snapshot must retain frozen finding fingerprints and raw errors, reject malformed
// required metadata, and never let a later refresh replace the review that owns an approval.
@Suite("Run snapshot")
struct RunSnapshotTests {
    private func snapshot(_ fingerprint: String = "reviewed") throws -> RunSnapshot {
        try RunSnapshot([
            "runId": "RUN-2345", "purpose": "photo_inventory", "status": "running",
            "findings": [
                [
                    "id": "finding-1",
                    "proposedFix": ["reviewSnapshot": ["fingerprint": .string(fingerprint)]],
                ]
            ],
            "operations": [["error": "SQLSTATE 23505: synthetic failure"]],
            "futureEvidence": ["keep": true],
        ])
    }

    @Test func frozenDocumentRetainsEvidenceAndRequiresTheShownFingerprint() throws {
        let frozen = RunReviewDocument(runID: "RUN-2345", snapshot: try snapshot(), review: nil)
        let restored = try JSONDecoder.cubby().decode(
            RunReviewDocument.self, from: JSONEncoder.cubby().encode(frozen))
        #expect(restored.snapshot?.raw["futureEvidence"] == ["keep": true])
        #expect(restored.snapshot?.operationErrors == ["SQLSTATE 23505: synthetic failure"])
        let input = try restored.findingInput(
            runID: "RUN-2345", id: "finding-1", apply: true, reviewedFingerprint: "reviewed")
        #expect(input.reviewedFingerprint == "reviewed")
        #expect(throws: (any Error).self) {
            try restored.findingInput(
                runID: "RUN-2345", id: "finding-1", apply: true, reviewedFingerprint: "refreshed")
        }
        #expect(throws: (any Error).self) {
            try restored.findingInput(
                runID: "RUN-3456", id: "finding-1", apply: false, reviewedFingerprint: nil)
        }
        #expect(throws: (any Error).self) {
            try restored.findingInput(
                runID: "RUN-2345", id: "absent", apply: false, reviewedFingerprint: nil)
        }
    }

    @Test func malformedMetadataAndSuccessorKeepDiagnostics() throws {
        var raw = try #require(snapshot().raw.objectValue)
        raw["status"] = 42
        do {
            _ = try RunSnapshot(.object(raw))
            Issue.record("Malformed status must fail")
        } catch {
            #expect(String(describing: error).contains("status"))
            #expect(String(describing: error).contains("42"))
        }
        #expect(try RunSnapshot.successorID(in: ["successor": nil]) == nil)
        #expect(try RunSnapshot.successorID(in: ["successor": ["publicId": "RUN-3456"]]) == "RUN-3456")
        #expect(throws: (any Error).self) {
            try RunSnapshot.successorID(in: ["successor": ["publicId": 42]])
        }
    }

    @Test func photoApprovalKeepsOnlySelectedFrozenRevisions() throws {
        func group(_ key: String) -> PhotoGroupProposal {
            .init(
                groupKey: key, steps: [], state: .proposed, images: [], skip: [],
                product: .create(.init(kind: .create, create: .init(name: "Fixture garment"))),
                evidence: "Synthetic review", missingImageCount: 0, updatedAt: "2026-10-01T12:00:00Z")
        }
        var blocked = group("blocked")
        blocked.blockedReason = "Review the identity conflict"
        let review = PhotoRunReviewResponse(
            review: .init(
                runId: "RUN-2345", runStatus: .running,
                proposals: [group("selected"), group("other"), blocked],
                unassignedImageIds: []),
            images: [],
            lifecycle: .init(
                processor: .cubby, phase: .readyForReview, plannedImageCount: 0,
                openBatchCount: 0, finalizedImageCount: 0, describedImageCount: 0,
                failedImageIds: [], skippedImageCount: 0, proposedGroupCount: 3,
                committedGroupCount: 0, dispatchError: nil))
        let document = RunReviewDocument(runID: "RUN-2345", snapshot: try snapshot(), review: review)
        let selected = try document.photoGroups(runID: "RUN-2345", keys: ["selected"])
        #expect(selected.map(\.groupKey) == ["selected"])
        #expect(selected.first?.updatedAt == "2026-10-01T12:00:00Z")
        #expect(throws: (any Error).self) {
            try document.photoGroups(runID: "RUN-2345", keys: ["selected", "selected"])
        }
        #expect(throws: (any Error).self) {
            try document.photoGroups(runID: "RUN-2345", keys: ["blocked"])
        }
    }

    @Test @MainActor func newerRefreshOwnsTheSnapshot() async throws {
        let session = RunReviewSession()
        let gate = Gate()
        let old = try snapshot("old")
        let latest = try snapshot("latest")
        let first = Task {
            await session.refresh(
                runID: "RUN-2345",
                loadSnapshot: {
                    await gate.hold(); return old
                },
                loadReview: { nil })
        }
        await gate.arrivals()
        await session.refresh(runID: "RUN-2345", loadSnapshot: { latest }, loadReview: { nil })
        gate.open()
        await first.value
        #expect(session.snapshot?.raw == latest.raw)
    }

    @Test @MainActor func malformedRefreshRetainsTheReviewAndShowsRawDiagnostics() async throws {
        let old = try snapshot()
        let session = RunReviewSession(snapshot: old)
        var malformed = try #require(old.raw.objectValue)
        malformed["status"] = 42
        await session.refresh(
            runID: "RUN-2345", loadSnapshot: { try RunSnapshot(.object(malformed)) },
            loadReview: { nil })
        #expect(session.snapshot?.raw == old.raw)
        let message = try #require(session.error)
        #expect(message.contains("status"))
        #expect(message.contains("42"))
    }

    @Test @MainActor func cancelledRefreshRetainsTheFrozenReview() async throws {
        let old = try snapshot("reviewed")
        let next = try snapshot("unseen")
        let session = RunReviewSession(snapshot: old)
        let gate = Gate()
        let refresh = Task {
            await session.refresh(
                runID: "RUN-2345",
                loadSnapshot: {
                    await gate.hold(); return next
                }, loadReview: { nil })
        }
        await gate.arrivals()
        refresh.cancel()
        gate.open()
        await refresh.value
        #expect(session.snapshot?.raw == old.raw)
        #expect(session.error == nil)
    }
}
