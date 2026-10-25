import Foundation
import Testing

@testable import CubbyKit

/// `job.queue` and `job.runRollups` as Activity groups them. Synthetic ids throughout.
@Suite("Household queue overview")
struct HouseholdQueueOverviewTests {
    private func queue(_ json: String) throws -> JobQueueOutput {
        try JSONDecoder.cubby().decode(JobQueueOutput.self, from: Data(json.utf8))
    }

    private func job(
        id: String, key: String, kind: String, lane: String, waitingOn: String
    ) -> String {
        """
        {"id":"\(id)","key":"\(key)","kind":"\(kind)","state":"running","generation":1,\
        "attempts":0,"maxAttempts":5,"priority":0,"waitReason":null,"waitUntil":null,\
        "availableAt":"2099-01-01T00:00:00.000Z","leaseExpiresAt":null,"error":null,"cursor":null,\
        "subject":null,"createdAt":"2099-01-01T00:00:00.000Z","updatedAt":"2099-01-01T00:00:00.000Z",\
        "ahead":null,"lane":"\(lane)","waitingOn":\(waitingOn),"runId":null}
        """
    }

    private func leased(executor: String, expiresAt: String, expired: Bool) -> String {
        #"{"reason":"leased","lane":"apple_device","executor":"\#(executor)","leaseExpiresAt":"\#(expiresAt)","expired":\#(expired)}"#
    }

    private func overview(
        runRows: [EntityRow] = [], rollups: JobRunRollupsOutput? = nil
    ) throws -> HouseholdQueueOverview {
        let counts = try queue(
            #"""
            {"total":64,"leases":[],"jobs":[],"counts":[
              {"lane":"frontier_ai","reason":"waiting_funding","count":40},
              {"lane":"apple_device","reason":"leased","count":3},
              {"lane":"apple_device","reason":"waiting_device","count":14},
              {"lane":"frontier_ai","reason":"due","count":7},
              {"lane":"server","reason":"due","count":9},
              {"lane":"apple_device","reason":"backing_off","count":0}
            ]}
            """#)
        let leasedJobs = [
            job(
                id: "00000000-0000-4000-8000-000000000001", key: "image-processing:image-job-mine",
                kind: "image.device", lane: "apple_device",
                waitingOn: leased(
                    executor: "Kitchen Mac", expiresAt: "2099-01-01T00:02:00.000Z", expired: false)),
            // Same display name as this device, but not one of its claims: another install.
            job(
                id: "00000000-0000-4000-8000-000000000002", key: "image-processing:image-job-twin",
                kind: "image.device", lane: "apple_device",
                waitingOn: leased(
                    executor: "Kitchen Mac", expiresAt: "2099-01-01T00:00:30.000Z", expired: true)),
            job(
                id: "00000000-0000-4000-8000-000000000003", key: "image-processing:image-job-hall",
                kind: "image.device", lane: "apple_device",
                waitingOn: leased(
                    executor: "Hall phone", expiresAt: "2099-01-01T00:01:00.000Z", expired: false)),
        ]
        let leased = try queue(
            #"{"total":3,"leases":[],"counts":[],"jobs":[\#(leasedJobs.joined(separator: ","))]}"#)
        let waitingJobs = [
            job(
                id: "00000000-0000-4000-8000-000000000004", key: "ai:evaluation:1", kind: "ai.evaluation",
                lane: "frontier_ai",
                waitingOn:
                    #"{"reason":"waiting_funding","lane":"frontier_ai","until":"2099-01-02T00:00:00.000Z"}"#),
            job(
                id: "00000000-0000-4000-8000-000000000005", key: "image-processing:image-job-cloud",
                kind: "image.cloud", lane: "frontier_ai",
                waitingOn:
                    #"{"reason":"backing_off","lane":"frontier_ai","until":"2099-01-01T06:00:00.000Z","attempts":6,"lastError":"Synthetic provider error","cause":null}"#
            ),
        ]
        let waiting = try queue(
            #"{"total":2,"leases":[],"counts":[],"jobs":[\#(waitingJobs.joined(separator: ","))]}"#)
        return HouseholdQueueOverview.make(
            counts: counts, leased: leased, waiting: waiting, runRows: runRows,
            runsNeedingAttention: runRows.count, rollups: rollups)
    }

    @Test func groupsCountsByLaneThenReasonInServerOrder() throws {
        let overview = try overview()
        #expect(overview.appleCounts.map(\.reason) == ["waiting_device", "leased"])
        #expect(overview.appleCounts.map(\.count) == [14, 3])
        #expect(overview.leasedCount == 3)
        #expect(overview.frontierCounts.map(\.reason) == ["due", "waiting_funding"])
        // The funding window's reopening comes from a listed waiting Job.
        #expect(
            overview.frontierCounts.last?.until == Date(timeIntervalSince1970: 4_070_995_200))
        #expect(overview.frontierCounts.first?.until == nil)
        #expect(overview.backingOff.map(\.attempts) == [6])
        #expect(overview.backingOff.first?.lastError == "Synthetic provider error")
        #expect(overview.backingOff.first?.until == Date(timeIntervalSince1970: 4_070_930_400))
    }

    /// Regression: "mine" matched `lastExecutor` to this device's name, so another install with
    /// the same name read as this device. It now matches this worker's live claims.
    @Test func marksThisDevicesLeasesByItsClaimsNotItsName() throws {
        let overview = try overview()
        #expect(overview.leases.map(\.imageJobID) == ["image-job-twin", "image-job-hall", "image-job-mine"])
        let split = overview.leases(claimedImageJobIDs: ["image-job-mine"])
        #expect(split.mine.map(\.imageJobID) == ["image-job-mine"])
        #expect(split.others.map(\.imageJobID) == ["image-job-twin", "image-job-hall"])
        #expect(split.others.first?.executor == "Kitchen Mac")
        #expect(split.others.first?.expired == true)
        #expect(split.others.last?.expired == false)
        #expect(overview.leases(claimedImageJobIDs: []).mine.isEmpty)
    }

    @Test func imageJobIDComesOnlyFromImageProcessingKeys() {
        #expect(HouseholdQueueOverview.imageJobID(fromJobKey: "image-processing:abc") == "abc")
        #expect(HouseholdQueueOverview.imageJobID(fromJobKey: "image-processing:") == nil)
        #expect(HouseholdQueueOverview.imageJobID(fromJobKey: "ai:evaluation:abc") == nil)
    }

    @Test func runsCarryTheirRollups() throws {
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"id":"RUN-SYN1"}"#.utf8))
        let rows = [
            EntityRow(id: "RUN-SYN1", title: "Synthetic photo batch", subtitle: nil, imageURL: nil, raw: raw),
            EntityRow(id: "RUN-SYN2", title: "Synthetic import", subtitle: nil, imageURL: nil, raw: raw),
        ]
        let rollups = try JSONDecoder.cubby().decode(
            JobRunRollupsOutput.self,
            from: Data(
                #"{"rollups":[{"runId":"RUN-SYN1","counts":{"leased":1,"waiting_funding":12,"due":0},"waitingForFunding":true,"lastProgressAt":"2099-01-01T00:00:00.000Z","stalled":true,"stallMinutes":15}]}"#
                    .utf8))
        let overview = try overview(runRows: rows, rollups: rollups)
        #expect(overview.runsNeedingAttention == 2)
        let first = try #require(overview.runs.first)
        #expect(first.counts.map(\.reason) == ["waiting_funding", "leased"])
        #expect(first.counts.map(\.count) == [12, 1])
        #expect(first.stalled)
        #expect(first.stallMinutes == 15)
        #expect(first.waitingForFunding)
        // A Run without a rollup still lists, with nothing claimed about its Jobs.
        #expect(overview.runs.last == .init(id: "RUN-SYN2", title: "Synthetic import"))
    }
}
