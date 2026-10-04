import Foundation
import Testing

@testable import CubbyKit

/// The server-composed report is drawn by one generic view on native. Failure modes: a block kind
/// the decoder drops, a missing figure rendered as zero, a stacked bar scaled past its estimate
/// marker, a collapsed schedule row leaking its children, and an undated row stretching the
/// timeline's date domain.
@Suite("ReportPresentation")
struct ReportPresentationTests {
    private static let json = #"""
        {"blocks":[
          {"kind":"stats","figures":[
            {"label":"Estimate","value":1000,"format":"money"},
            {"label":"Remaining","value":null,"format":"money"},
            {"label":"Expenses","value":3,"format":"count","tone":"muted"}]},
          {"kind":"chart","mark":"stack","format":"money","marker":1000,
           "series":[{"label":"Actual","value":300,"tone":"positive"},
                     {"label":"Committed","value":50,"tone":"warning"}],
           "caption":"$300 spent of $1,000"},
          {"kind":"chart","title":"By project","mark":"bar","format":"money",
           "series":[{"label":"Fixture project","value":75,"ref":{"entity":"project","id":"PRJ-4K7M"}}]},
          {"kind":"table","title":"Funders","columns":["Party","Kind","Funded"],
           "rows":[{"id":"LPY-4K7M","cells":["Synthetic party","household","$10.00"],"ref":{"entity":"recipe","id":"RCP-4K7M"}}],
           "empty":"None"},
          {"kind":"schedule","rows":[
            {"id":"PRJ-4K7M","entity":"project","name":"Root","depth":0,"expandable":true,
             "meta":"Project","metaShort":"planning","blockedByIds":[],"blockingIds":[],
             "segments":[{"id":"a","label":"Root","startDate":"2026-09-01","endDate":"2026-09-30","variant":"range"}]},
            {"id":"PRJ-2345","entity":"project","name":"Phase","depth":1,"expandable":true,
             "meta":"Project","metaShort":"planning","blockedByIds":[],"blockingIds":["TSK-4K7M"],"segments":[]},
            {"id":"TSK-4K7M","entity":"task","name":"Leaf","depth":2,"expandable":false,
             "meta":"Task","metaShort":"todo","noDateLabel":"No due date","blockedByIds":["PRJ-2345"],"blockingIds":[],
             "segments":[]},
            {"id":"TSK-2345","entity":"task","name":"Sibling","depth":1,"expandable":false,
             "meta":"Task","metaShort":"todo","blockedByIds":[],"blockingIds":[],
             "segments":[{"id":"b","label":"Sibling","startDate":"2026-09-10","variant":"milestone"}]}]},
          {"kind":"note","text":"Spend stays whole-group."}
        ]}
        """#

    private func presentation() throws -> ReportPresentation {
        ReportPresentation(try JSONDecoder.cubby().decode(EntityReportOut.self, from: Data(Self.json.utf8)))
    }

    @Test func rendersEveryBlockKindInOrder() throws {
        let kinds = try presentation().blocks.map { block -> String in
            switch block {
            case .stats: "stats"
            case .chart: "chart"
            case .table: "table"
            case .schedule: "schedule"
            case .note: "note"
            case .records: "records"
            }
        }
        #expect(kinds == ["stats", "chart", "chart", "table", "schedule", "note"])
    }

    @Test func missingFigureIsADashNotZero() throws {
        guard case .stats(_, let figures) = try presentation().blocks[0] else {
            Issue.record("expected stats")
            return
        }
        #expect(figures.map(\.text) == ["$1,000.00", "—", "3"])
        #expect(figures[2].tone == .muted)
    }

    @Test func stackScalesToTheLargerOfEstimateAndSpend() throws {
        guard case .chart(let chart) = try presentation().blocks[1] else {
            Issue.record("expected chart")
            return
        }
        #expect(chart.mark == .stack)
        #expect(chart.scaleMax == 1000)
        var over = chart
        over.bars[0].value = 1200
        #expect(over.scaleMax == 1250)
        #expect(chart.bars.map(\.tone) == [.positive, .warning])
    }

    @Test func barLinksToItsRecord() throws {
        guard case .chart(let chart) = try presentation().blocks[2] else {
            Issue.record("expected chart")
            return
        }
        #expect(chart.bars[0].ref == ReportPresentation.Ref(entity: "project", id: "PRJ-4K7M"))
        #expect(chart.bars[0].text == "$75.00")
    }

    @Test func tableRowsKeepTheServersUniqueIDs() throws {
        guard case .table(let table) = try presentation().blocks[3] else {
            Issue.record("expected table")
            return
        }
        #expect(table.rows.map(\.id) == ["LPY-4K7M"])
    }

    @Test func scheduleHidesACollapsedSubtreeOnly() throws {
        guard case .schedule(let schedule) = try presentation().blocks[4] else {
            Issue.record("expected schedule")
            return
        }
        #expect(schedule.visibleRows(collapsed: []).map(\.name) == ["Root", "Phase", "Leaf", "Sibling"])
        #expect(schedule.visibleRows(collapsed: ["PRJ-2345"]).map(\.name) == ["Root", "Phase", "Sibling"])
        #expect(schedule.visibleRows(collapsed: ["PRJ-4K7M"]).map(\.name) == ["Root"])
    }

    @Test func scheduleDomainIgnoresUndatedRows() throws {
        guard case .schedule(let schedule) = try presentation().blocks[4] else {
            Issue.record("expected schedule")
            return
        }
        let domain = try #require(schedule.domain)
        let calendar = Calendar(identifier: .gregorian)
        #expect(calendar.dateComponents(in: .gmt, from: domain.lowerBound).day == 1)
        #expect(calendar.dateComponents(in: .gmt, from: domain.upperBound).day == 30)
        #expect(schedule.rows[2].noDateLabel == "No due date")
        #expect(schedule.rows[1].blockingIDs == ["TSK-4K7M"])
        // A milestone is a point, not a range.
        #expect(schedule.rows[3].segments[0].end == nil)
    }
}
