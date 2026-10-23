import Foundation
import Testing

@testable import CubbyKit

@Suite("AuditEntryFolding")
struct AuditEntryFoldingTests {
    @Test func identifierEffectsRetainEveryCommittedValueAndPrimaryChange() throws {
        func row(_ value: String, primary: Bool) -> JSONValue {
            [
                "source": "sample", "kind": "catalog_number", "externalId": .string(value),
                "url": "https://example.com/catalog", "isPrimary": .bool(primary),
            ]
        }
        let before: JSONValue = .array([row("OLD", primary: true), row("KEEP", primary: false)])
        let after: JSONValue = .array(
            [row("KEEP", primary: true)] + (0..<30).map { row("CODE-\($0)", primary: false) })
        var raw = try #require(try JSONValue(encoding: audit("a", minute: 0)).objectValue)
        raw["changes"] = ["externalIds": ["from": before, "to": after]]
        let entry = try JSONValue.object(raw).decoded(AuditLogEntryOut.self)
        let effects = entry.identifierEffects
        #expect(effects.count == 32)
        #expect(effects.joined().count > 500)
        #expect(effects.contains { $0.contains("Removed:") && $0.contains("OLD") })
        #expect(effects.contains { $0.contains("Made primary:") && $0.contains("KEEP") })
        #expect(
            effects.contains {
                $0.contains("CODE-29") && $0.contains("Secondary")
                    && $0.contains("https://example.com/catalog")
            })
        #expect(IdentifierPresentation.effects(before: nil, after: after).isEmpty)
    }

    @Test func legacyBarcodeURLChangesRemainReadableWithoutInputRepair() {
        let before: JSONValue = [
            [
                "source": "gtin", "kind": "gtin_14", "externalId": "09780306406158",
                "url": "https://example.com/old", "isPrimary": true,
            ]
        ]
        let after: JSONValue = [
            [
                "source": "gtin", "kind": "gtin_14", "externalId": "09780306406158",
                "url": "https://example.com/new", "isPrimary": true,
            ]
        ]
        let effects = IdentifierPresentation.effects(before: before, after: after)
        #expect(effects.count == 1)
        #expect(effects.first?.contains("Changed URL:") == true)
        #expect(effects.first?.contains("https://example.com/old → https://example.com/new") == true)
        #expect(effects.first?.contains("GTIN: 09780306406158") == true)
    }

    private func audit(
        _ key: String, minute: Int, action: String = "update", id: String = "PRD-4K7M",
        user: String = "user-a", channel: String = "web", field: String = "name"
    ) throws -> AuditLogEntryOut {
        let second = 12 * 3600 - minute * 60
        let time = String(format: "2026-10-11T%02d:%02d:%02dZ", second / 3600, second / 60 % 60, second % 60)
        let json = """
            {"entryKey":"\(key)","entityKind":"product","entityId":"\(id)","canonicalEntityId":null,
             "entityName":"Synthetic oat milk","displayImage":null,"action":"\(action)",
             "changes":{"\(field)":{"from":"a","to":"b"}},"references":{},"userId":"\(user)","channel":"\(channel)",
             "oauthClient":null,"device":null,"runId":null,"createdAt":"\(time)","user":null}
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
