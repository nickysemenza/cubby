import Foundation
import Testing

@testable import CubbyKit

@Suite("EntityTimelineOut")
struct EntityTimelineTests {
    @Test func decodesUnknownDateWithoutInventingTimelineBounds() throws {
        let data = Data(
            #"{"groups":[{"key":"undated:EXP-2345","date":null,"events":[{"id":"EXP-2345","kind":"exited","label":"Discarded tool"}]}],"stats":[],"notes":[],"meta":{"totalCount":0,"pageIndex":0,"pageSize":200}}"#
                .utf8
        )
        let timeline = try JSONDecoder.cubby().decode(EntityTimelineOut.self, from: data)
        #expect(timeline.groups.first?.date == nil)
        #expect(timeline.groups.first?.events.first?.label == "Discarded tool")
        #expect(timeline.extent == nil)
    }

    /// The one timeline shape every entity's timeline returns: grouped events, optional lifecycle
    /// rows, stat tiles, notes and the extent. `confident: false` on an open interval must
    /// survive the decode — the lifecycle view draws it differently from a confirmed one.
    @Test func decodesGroupsRowsAndUnconfidentIntervals() throws {
        let timeline = try Fixtures.decode(EntityTimelineOut.self, from: "timeline.json")
        #expect(timeline.groups.count == 2)
        #expect(timeline.groups[0].link.valueIfPresent??.entity == "purchase")
        #expect(timeline.groups[0].events.map(\.kind) == ["purchase", "audit:update"])
        #expect(timeline.groups[0].events[0].amount == .value(12.5))
        #expect(timeline.groups[1].label == .absent)
        #expect(timeline.groups[1].events[0].amount == .value(-4))
        let row = try #require(timeline.rows?.first)
        #expect(row.intervals.map(\.confident) == [true, false])
        #expect(row.intervals[1].end == .absent)
        #expect(row.markers.first?.link.valueIfPresent??.id == "EXP-3456")
        #expect(timeline.stats.map(\.key) == ["events", "net"])
        #expect(timeline.notes.count == 1)
        #expect(timeline.extent?.from.rawValue == "2026-03-02")
    }
}
