import CubbyAPI
import Foundation

/// A detail slot the server composes a report for (`entityReport.get`); the raw value is the
/// manifest's slot id, so `ReportSlot(rawValue: slot.rawValue)` maps a declared slot.
public typealias ReportSlot = Operations.EntityReport_get.Input.Query.SlotPayload

/// The server-composed `entityReport.get` blocks as plain values the one generic report view
/// draws. The server owns every figure, series and schedule row; this only formats a number and
/// answers view questions (a stack's scale, which schedule rows a collapse hides).
public struct ReportPresentation: Hashable, Sendable {
    public enum Tone: String, Hashable, Sendable { case positive, warning, destructive, muted }
    public enum Mark: Hashable, Sendable { case bar, stack, line }

    /// A record a bar or row links to; `entity` is the server's entity key.
    public struct Ref: Hashable, Sendable {
        public let entity: String
        public let id: String
        public init(entity: String, id: String) {
            self.entity = entity
            self.id = id
        }
    }

    public struct Figure: Hashable, Sendable, Identifiable {
        public var id: String { label }
        public let label: String
        public let text: String
        public let tone: Tone?
    }

    public struct Bar: Hashable, Sendable, Identifiable {
        public var id: String { label }
        public let label: String
        public var value: Double
        public let text: String
        public let tone: Tone?
        public let ref: Ref?
    }

    public struct Chart: Hashable, Sendable {
        public let title: String?
        public let mark: Mark
        public var bars: [Bar]
        public let marker: Double?
        public let caption: String?

        /// A stack is scaled to whichever is larger so its marker stays on the bar when spend
        /// overruns the estimate.
        public var scaleMax: Double {
            max(marker ?? 0, bars.reduce(0) { $0 + $1.value })
        }
    }

    public struct Table: Hashable, Sendable {
        public struct Row: Hashable, Sendable, Identifiable {
            public let id: String
            public let cells: [String]
            public let ref: Ref?
        }
        public let title: String?
        public let columns: [String]
        public let rows: [Row]
        public let empty: String?
        public let truncated: Bool
    }

    public struct Schedule: Hashable, Sendable {
        public struct Segment: Hashable, Sendable, Identifiable {
            public let id: String
            public let label: String
            public let start: Date
            /// Nil for a milestone (a single day).
            public let end: Date?
        }

        public struct Row: Hashable, Sendable, Identifiable {
            public let id: String
            public let entity: String
            public let name: String
            public let depth: Int
            public let expandable: Bool
            public let meta: String
            public let metaShort: String
            public let segments: [Segment]
            public let noDateLabel: String?
            public let blockedByIDs: [String]
            public let blockingIDs: [String]
        }

        /// Every row in tree order; collapse is the viewer's own state.
        public let rows: [Row]

        /// The rows left after hiding the subtrees under `collapsed` rows.
        public func visibleRows(collapsed: Set<String>) -> [Row] {
            var visible: [Row] = []
            var hiddenBelow: Int?
            for row in rows {
                if let depth = hiddenBelow, row.depth > depth { continue }
                hiddenBelow = nil
                visible.append(row)
                if row.expandable, collapsed.contains(row.id) { hiddenBelow = row.depth }
            }
            return visible
        }

        /// The dated extent of the schedule; undated rows do not stretch it.
        public var domain: ClosedRange<Date>? {
            let dates = rows.flatMap(\.segments).flatMap { [$0.start, $0.end ?? $0.start] }
            guard let first = dates.min(), let last = dates.max() else { return nil }
            return first...last
        }
    }

    public enum Block: Hashable, Sendable {
        case stats(title: String?, figures: [Figure])
        case chart(Chart)
        case table(Table)
        case schedule(Schedule)
        case note(String)
    }

    public let blocks: [Block]

    public init(_ report: EntityReportOut) {
        blocks = report.blocks.map(Self.block)
    }

    private static func block(_ block: Components.Schemas.ReportBlock) -> Block {
        switch block {
        case .stats(let stats):
            return .stats(
                title: stats.title,
                figures: stats.figures.map {
                    Figure(
                        label: $0.label, text: text($0.value, money: $0.format == .money),
                        tone: $0.tone.flatMap { Tone(rawValue: $0.rawValue) })
                })
        case .chart(let chart):
            let money = chart.format == .money
            return .chart(
                Chart(
                    title: chart.title,
                    mark: chart.mark == .stack ? .stack : chart.mark == .line ? .line : .bar,
                    bars: chart.series.map {
                        Bar(
                            label: $0.label, value: $0.value, text: text($0.value, money: money),
                            tone: $0.tone.flatMap { Tone(rawValue: $0.rawValue) },
                            ref: $0.ref.map { Ref(entity: $0.entity.rawValue, id: $0.id) })
                    },
                    marker: chart.marker, caption: chart.caption))
        case .table(let table):
            return .table(
                Table(
                    title: table.title, columns: table.columns,
                    rows: table.rows.map { row in
                        Table.Row(
                            id: row.id, cells: row.cells,
                            ref: row.ref.map { Ref(entity: $0.entity.rawValue, id: $0.id) })
                    },
                    empty: table.empty, truncated: table.truncated ?? false))
        case .schedule(let schedule):
            return .schedule(
                Schedule(
                    rows: schedule.rows.map { row in
                        Schedule.Row(
                            id: row.id, entity: row.entity.rawValue, name: row.name, depth: row.depth,
                            expandable: row.expandable, meta: row.meta, metaShort: row.metaShort,
                            segments: row.segments.compactMap { segment in
                                guard let start = day(segment.startDate) else { return nil }
                                return Schedule.Segment(
                                    id: segment.id, label: segment.label, start: start,
                                    end: segment.endDate.flatMap(day))
                            },
                            noDateLabel: row.noDateLabel, blockedByIDs: row.blockedByIds,
                            blockingIDs: row.blockingIds)
                    }))
        case .note(let note):
            return .note(note.text)
        }
    }

    /// Money is whole USD at the server's precision; a missing figure is a dash, never zero.
    private static func text(_ value: Double?, money: Bool) -> String {
        guard let value else { return "—" }
        return money ? value.usd : String(Int(value.rounded()))
    }

    /// A household calendar day (`yyyy-MM-dd`) as the start of that day in UTC.
    private static func day(_ string: String) -> Date? {
        let parts = string.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}
