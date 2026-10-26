import Foundation
import Testing

@testable import CubbyKit

/// The server-composed report is drawn by one generic view on native. Failure modes: a block kind
/// the decoder drops, a missing figure rendered as zero, a stacked bar scaled past its estimate
/// marker, and navigable table rows losing their record links.
@Suite("ReportPresentation")
struct ReportPresentationTests {
    // Shared collection reports retain navigable cost rows, unknown figures and context links.
    @Test func collectionReportsKeepLinksAndUnknownEstimate() throws {
        let value: JSONValue = [
            "blocks": [
                ["kind": "stats", "figures": [["label": "Estimate", "value": nil, "format": "money"]]],
                [
                    "kind": "table", "columns": ["Project", "Estimate"],
                    "rows": [
                        [
                            "id": "PRJ-2345", "cells": ["Fixture renovation", "—"],
                            "ref": ["entity": "project", "id": "PRJ-2345"],
                        ]
                    ],
                ],
                [
                    "kind": "records", "empty": "No tasks",
                    "rows": [
                        [
                            "entity": "task", "id": "TSK-2345", "title": "Fixture work", "trailing": nil,
                            "lines": [
                                [
                                    "text": "Fixture renovation",
                                    "ref": ["entity": "project", "id": "PRJ-2345"],
                                ]
                            ],
                        ]
                    ],
                ],
            ]
        ]
        let report = ReportPresentation(try value.decoded() as EntityReportOut)
        guard case .stats(_, let figures) = report.blocks[0],
            case .table(let table) = report.blocks[1],
            case .records(let records) = report.blocks[2]
        else { Issue.record("Expected shared collection blocks"); return }
        #expect(figures.first?.text == "—")
        #expect(table.rows.first?.ref == .init(entity: "project", id: "PRJ-2345"))
        #expect(records.rows.first?.lines.first?.ref == .init(entity: "project", id: "PRJ-2345"))
    }

    @Test func precisionTimesAndEvidenceRemainDistinct() throws {
        let json = #"""
            {"blocks":[{"kind":"records","disclosureLabel":"Retained observations (6)","empty":"None","rows":[
              {"entity":null,"id":null,"title":"Instant","trailing":null,"time":{"kind":"instant","value":"2026-01-05T17:30:00Z"}},
              {"entity":null,"id":null,"title":"Date","trailing":null,"time":{"kind":"date","value":"2026-01-05"}},
              {"entity":null,"id":null,"title":"Local","trailing":null,"time":{"kind":"local","value":"09:30","timezone":"America/Chicago"}},
              {"entity":null,"id":null,"title":"Unknown zone","trailing":null,"time":{"kind":"local","value":"09:30","timezone":null}},
              {"entity":null,"id":null,"title":"Receipt","trailing":null,"time":{"kind":"unknown","receiptAt":"2026-01-05T18:00:00Z"},
               "lines":[{"text":"Fixture Email","ref":{"entity":"email","id":"EML-2345"}},{"text":"Carrier tracking","url":"https://example.com/tracking/fixture"}]},
              {"entity":null,"id":null,"title":"Unknown","trailing":null,"time":{"kind":"unknown"}}
            ]}]}
            """#
        let decoded = try JSONDecoder.cubby().decode(EntityReportOut.self, from: Data(json.utf8))
        guard case .records(let records) = ReportPresentation(decoded).blocks[0] else {
            Issue.record("Expected evidence records"); return
        }
        #expect(records.disclosureLabel == "Retained observations (6)")
        #expect(records.rows[0].time == .instant(DatePresentation.parse("2026-01-05T17:30:00Z")!))
        #expect(records.rows[1].time == .date("2026-01-05"))
        #expect(records.rows[2].time == .local("09:30", timezone: "America/Chicago"))
        #expect(records.rows[3].time == .local("09:30", timezone: nil))
        #expect(records.rows[4].at == nil)
        #expect(records.rows[4].time == .unknown(receiptAt: DatePresentation.parse("2026-01-05T18:00:00Z")))
        #expect(records.rows[4].lines[0].ref == .init(entity: "email", id: "EML-2345"))
        #expect(records.rows[4].lines[1].url?.absoluteString == "https://example.com/tracking/fixture")
        #expect(records.rows[5].time == .unknown(receiptAt: nil))
    }

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
          {"kind":"note","text":"Spend stays whole-group."}
        ]}
        """#

    @Test func decodesStructuredWorkWithUnknownTotal() throws {
        let json =
            #"{"blocks":[{"kind":"progress","label":"Discovering","processed":7,"total":null,"summary":"7 / unknown emails · 0 failed","detail":"Running · 12 emails/min · Total unknown"}]}"#
        let report = try JSONDecoder.cubby().decode(EntityReportOut.self, from: Data(json.utf8))
        guard case .progress(let progress) = ReportPresentation(report).blocks.first else {
            Issue.record("expected progress")
            return
        }
        #expect(progress.total == nil)
        #expect(progress.processed == 7)
        #expect(progress.summary == "7 / unknown emails · 0 failed")
    }

    private func presentation() throws -> ReportPresentation {
        ReportPresentation(try JSONDecoder.cubby().decode(EntityReportOut.self, from: Data(Self.json.utf8)))
    }

    @Test func rendersEveryBlockKindInOrder() throws {
        let kinds = try presentation().blocks.map { block -> String in
            switch block {
            case .progress: "progress"
            case .stats: "stats"
            case .chart: "chart"
            case .table: "table"
            case .note: "note"
            case .records: "records"
            case .unsupported: "unsupported"
            }
        }
        #expect(kinds == ["stats", "chart", "chart", "table", "note"])
    }

    @Test func aNamedFigureHandsItsNumberToTheClientThatActsOnIt() throws {
        let report = try JSONDecoder.cubby().decode(
            EntityReportOut.self,
            from: Data(
                #"{"blocks":[{"kind":"stats","figures":[{"id":"weightGrams","label":"Total weight","value":812,"format":"text","text":"812 g"},{"label":"Totals","value":0,"format":"text","text":"Complete"}]}]}"#
                    .utf8))
        let presentation = ReportPresentation(report)
        #expect(presentation.figureValue("weightGrams") == 812)
        // An unnamed or unknown figure is never read by number: native derives nothing from a label.
        #expect(presentation.figureValue("Totals") == nil)
        let none = ReportPresentation(
            try JSONDecoder.cubby().decode(
                EntityReportOut.self,
                from: Data(
                    #"{"blocks":[{"kind":"stats","figures":[{"id":"weightGrams","label":"Total weight","value":null,"format":"text","text":"—"}]}]}"#
                        .utf8)))
        #expect(none.figureValue("weightGrams") == nil)
    }

    @Test func recordRowsKeepTheServersWordsAmountsAndRefusals() throws {
        let report = try JSONDecoder.cubby().decode(
            EntityReportOut.self,
            from: Data(
                #"""
                {"blocks":[{"kind":"records","empty":"","actions":[],"rows":[
                  {"entity":null,"id":null,"title":"Example Hardware · 2026-03-03",
                   "trailing":"$42.50","key":"FTX-4K7M","disabledReason":null},
                  {"entity":"run","id":"RUN-4K7M","title":"Example Garden · 2026-03-04",
                   "trailing":"$12.00","key":"FTX-5N8P","disabledReason":"Already matched."}
                ]}]}
                """#.utf8))
        guard case .records(let records) = ReportPresentation(report).blocks[0] else {
            Issue.record("expected records")
            return
        }
        #expect(records.rows.compactMap(\.key) == ["FTX-4K7M", "FTX-5N8P"])
        #expect(records.rows[0].trailing == "$42.50")
        #expect(records.rows[1].entity == .run)
        #expect(records.rows[1].recordID == "RUN-4K7M")
        #expect(records.rows[1].disabledReason == "Already matched.")
    }

    @Test func aBlocksOwnCommandsAreCarriedBesideItsRows() throws {
        let report = try JSONDecoder.cubby().decode(
            EntityReportOut.self,
            from: Data(
                #"{"blocks":[{"kind":"records","rows":[],"empty":"None yet","commands":[{"id":"generate-flow:first","label":"Generate walkthrough","prominent":true,"confirm":"Uses the model.","request":{"kind":"operation","operation":"recipe.generateFlow","body":{"recipeId":"RCP-4K7M","force":false}}}]}]}"#
                    .utf8))
        guard case .records(let records) = ReportPresentation(report).blocks[0] else {
            Issue.record("expected records")
            return
        }
        #expect(records.commands.map(\.label) == ["Generate walkthrough"])
        #expect(records.commands.first?.confirm == "Uses the model.")
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
}
