import Foundation
import Testing

@testable import CubbyKit

// The generic snapshot must retain raw errors, reject malformed required metadata, and never let
// an older or cancelled refresh replace what the Run console shows.
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

    @Test func operationErrorsPreserveEmptyStringsAndRejectOtherTypes() throws {
        var raw = try #require(snapshot().raw.objectValue)
        raw["operations"] = [["error": ""], ["error": nil], [:]]
        #expect(try RunSnapshot(.object(raw)).operationErrors == [""])
        raw["operations"] = [["error": 42]]
        #expect(throws: (any Error).self) { try RunSnapshot(.object(raw)) }
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

    }

    @Test @MainActor func newerRefreshOwnsTheSnapshot() async throws {
        let session = RunConsoleSession()
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

    @Test @MainActor func malformedRefreshRetainsTheShownRunAndRawDiagnostics() async throws {
        let old = try snapshot()
        let session = RunConsoleSession(snapshot: old)
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

    @Test @MainActor func cancelledRefreshRetainsTheShownRun() async throws {
        let old = try snapshot("reviewed")
        let next = try snapshot("unseen")
        let session = RunConsoleSession(snapshot: old)
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
