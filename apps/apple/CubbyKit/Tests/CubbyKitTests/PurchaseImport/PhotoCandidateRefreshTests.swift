import Foundation
import Testing

@testable import CubbyKit

@Suite("Photo candidate refresh")
@MainActor
struct PhotoCandidateRefreshTests {
    // Proposal changes during a request must coalesce into one replacement, never publish
    // stale results, and cache only the revision that actually finished successfully.
    @Test func queuesLatestRevisionAndRetriesFailure() async throws {
        let session = RunReviewSession()
        let gate = Gate()
        let replacement = Gate()
        let stale = try JSONDecoder().decode(
            PhotoCandidateGroupResult.self,
            from: Data(
                """
                {"groupKey":"synthetic","status":"ready","error":null,"candidates":[],"rejectedCandidates":[]}
                """.utf8))
        var requests: [String] = []
        let first = session.refreshCandidates(key: "run:1") {
            requests.append("1")
            await gate.hold()
            return ["synthetic": stale]
        }
        await gate.arrivals()
        let duplicate = session.refreshCandidates(key: "run:1") {
            requests.append("duplicate")
            return [:]
        }
        let second = session.refreshCandidates(key: "run:2") {
            requests.append("2")
            return [:]
        }
        let latest = session.refreshCandidates(key: "run:3") {
            requests.append("3")
            await replacement.hold()
            return [:]
        }
        #expect(session.checkingCandidates)
        gate.open()
        await replacement.arrivals()
        #expect(session.candidateGroups.isEmpty)
        #expect(session.checkingCandidates)
        replacement.open()
        await duplicate?.value
        await first?.value
        await second?.value
        await latest?.value
        #expect(requests == ["1", "3"])
        #expect(!session.checkingCandidates)
        let cached = session.refreshCandidates(key: "run:3") {
            requests.append("cached")
            return [:]
        }
        await cached?.value
        #expect(requests == ["1", "3"])

        struct Failure: Error {}
        let failed = session.refreshCandidates(key: "run:4") { throw Failure() }
        await failed?.value
        #expect(session.candidatesError != nil)
        let retry = session.refreshCandidates(key: "run:4") {
            requests.append("retry")
            return [:]
        }
        await retry?.value
        #expect(requests == ["1", "3", "retry"])
        #expect(session.candidatesError == nil)
    }
}
