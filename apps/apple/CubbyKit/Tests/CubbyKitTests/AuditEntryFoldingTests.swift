import Foundation
import Testing

@testable import CubbyKit

@Suite("AuditEntryFolding")
struct AuditEntryFoldingTests {
    private func audit(
        _ key: String, minute: Int, action: String = "update", id: String = "PRD-4K7M",
        user: String = "user-a", channel: String = "web", field: String = "name"
    ) throws -> AuditLogEntryOut {
        let second = 12 * 3600 - minute * 60
        let time = String(format: "2026-10-11T%02d:%02d:%02dZ", second / 3600, second / 60 % 60, second % 60)
        let json = """
            {"entryKey":"\(key)","entityKind":"product","entityId":"\(id)","canonicalEntityId":null,
             "entityName":"Synthetic oat milk","action":"\(action)",
             "changes":{"\(field)":{"from":"a","to":"b"}},"userId":"\(user)","channel":"\(channel)",
             "oauthClient":null,"device":null,"createdAt":"\(time)","user":null}
            """
        return try JSONDecoder.cubby().decode(AuditLogEntryOut.self, from: Data(json.utf8))
    }

    @Test func foldsABurstOfUpdatesBySameWriterAndCountsDistinctFields() throws {
        let groups = AuditEntryFolding.fold([
            try audit("a", minute: 0, field: "name"),
            try audit("b", minute: 2, field: "brand"),
            try audit("c", minute: 4, field: "name"),
        ])
        #expect(groups.count == 1)
        #expect(groups[0].foldSummary == "3 updates · 2 fields")
        #expect(groups[0].id == "a")
    }

    /// The window is between neighbours: a steady stream of saves nine minutes apart keeps folding.
    @Test func splitsOnGapWriterRecordOrNonUpdate() throws {
        let groups = AuditEntryFolding.fold([
            try audit("a", minute: 0),
            try audit("b", minute: 9),
            try audit("c", minute: 18),
            try audit("d", minute: 29),
            try audit("e", minute: 30, user: "user-b"),
            try audit("f", minute: 31, user: "user-b", channel: "mcp"),
            try audit("g", minute: 32, id: "PRD-2345", user: "user-b", channel: "mcp"),
            try audit(
                "h", minute: 33, action: "create", id: "PRD-2345", user: "user-b", channel: "mcp"),
        ])
        let keys = groups.map { $0.entries.map(\.entryKey) }
        #expect(keys == [["a", "b", "c"], ["d"], ["e"], ["f"], ["g"], ["h"]])
        #expect(groups[1].foldSummary == nil)
    }

    @Test func wordsChangedFields() throws {
        let change = try #require(try audit("a", minute: 0, field: "unitPrice").fieldChanges.first)
        #expect(change.label == "Unit price")
        #expect(change.from == "a")
        #expect(change.to == "b")
    }
}
