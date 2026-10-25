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

    private func overview(
        runRows: [EntityRow] = [], rollups: JobRunRollupsOutput? = nil
    ) throws -> HouseholdQueueOverview {
        let counts = try queue(
            #"""
            {"total":64,"jobs":[],"leases":[
              {"executor":"Synthetic phone","live":0,"expired":15},
              {"executor":"Synthetic Mac","live":2,"expired":0},
              {"executor":"Synthetic tablet","live":1,"expired":2}
            ],"counts":[
              {"lane":"frontier_ai","reason":"waiting_funding","count":40},
              {"lane":"apple_device","reason":"leased","count":3},
              {"lane":"apple_device","reason":"waiting_device","count":14},
              {"lane":"frontier_ai","reason":"due","count":7},
              {"lane":"server","reason":"due","count":9},
              {"lane":"apple_device","reason":"backing_off","count":0}
            ]}
            """#)
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
            counts: counts, waiting: waiting, runRows: runRows,
            runsNeedingAttention: runRows.count, rollups: rollups)
    }

    @Test func groupsCountsByLaneThenReasonInServerOrder() throws {
        let overview = try overview()
        #expect(overview.appleCounts.map(\.reason) == ["waiting_device", "leased"])
        #expect(overview.appleCounts.map(\.count) == [14, 3])
        #expect(overview.waitingForDeviceCount == 14)
        #expect(overview.frontierCounts.map(\.reason) == ["due", "waiting_funding"])
        // The funding window's reopening comes from a listed waiting Job.
        #expect(
            overview.frontierCounts.last?.until == Date(timeIntervalSince1970: 4_070_995_200))
        #expect(overview.frontierCounts.first?.until == nil)
        #expect(overview.backingOff.map(\.attempts) == [6])
        #expect(overview.backingOff.first?.lastError == "Synthetic provider error")
        #expect(overview.backingOff.first?.until == Date(timeIntervalSince1970: 4_070_930_400))
    }

    /// An old install holding many expired leases reads as one counted row, not a row per Job.
    @Test func countsExpiredLeasesPerExecutor() throws {
        let holders = try overview().expiredLeaseHolders
        #expect(holders.map(\.executor) == ["Synthetic phone", "Synthetic tablet"])
        #expect(holders.map(\.expired) == [15, 2])
        #expect(holders.first?.expiredLabel == "15 expired leases awaiting reclaim")
    }

    /// Activity reads Runs needing attention from the manifest's saved view, so the view's
    /// purpose filter (system AI passes excluded) must reach the request.
    @Test func runsAttentionViewCarriesItsPurposeFilter() throws {
        let view = try #require(EntityCatalog[.run].presentation.savedViews.first { $0.id == "attention" })
        let purposes = view.filterState["purpose"] ?? []
        #expect(!purposes.isEmpty)
        #expect(!purposes.contains("ai_refresh"))
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
                #"{"rollups":[{"runId":"RUN-SYN1","counts":{"leased":1,"waiting_funding":12,"due":0},"expiredLeases":2,"waitingForFunding":true,"lastProgressAt":"2099-01-01T00:00:00.000Z","stalled":true,"stallMinutes":15}]}"#
                    .utf8))
        let overview = try overview(runRows: rows, rollups: rollups)
        #expect(overview.runsNeedingAttention == 2)
        let first = try #require(overview.runs.first)
        #expect(first.counts.map(\.reason) == ["waiting_funding", "leased"])
        #expect(first.counts.map(\.count) == [12, 1])
        #expect(first.stalled)
        #expect(first.stallMinutes == 15)
        #expect(first.waitingForFunding)
        #expect(first.expiredLeases == 2)
        #expect(first.expiredLeasesLabel == "2 expired leases awaiting reclaim")
        #expect(overview.runs.last?.expiredLeasesLabel == nil)
        // A Run without a rollup still lists, with nothing claimed about its Jobs.
        #expect(overview.runs.last == .init(id: "RUN-SYN2", title: "Synthetic import"))
    }
}
