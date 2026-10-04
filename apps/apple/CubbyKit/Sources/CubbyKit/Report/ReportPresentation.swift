import CubbyAPI
import Foundation

/// A detail slot the server composes a report for (`entityReport.get`); the raw value is the
/// manifest's slot id, so `ReportSlot(rawValue: slot.rawValue)` maps a declared slot.

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

    /// A record-bearing row: the server's words, a thumbnail, short badges, an instant the
    /// client prints in its own locale, and the record the row opens.
    public struct RecordRow: Hashable, Sendable, Identifiable {
        public var id: Int
        public let entity: EntityKey?
        public let recordID: String?
        public let title: String
        public let subtitle: String?
        public let trailing: String?
        public let imageURL: URL?
        public let badges: [String]
        public let at: Date?
        /// The list of other records this row summarises, opened from the trailing figure.
        public let listLink: ListLink?
        /// Verbs offered on this row only; the server decides when one applies.
        public let actions: [CollectionActionID]
        /// What a checked row names when it is not the opened record (a statement charge).
        public let key: String?
        /// Why the row cannot be checked; nil when it can.
        public let disabledReason: String?
        /// Toned status chips (a run's approvals, findings and operations).
        public let statuses: [Status]
        /// Lines under the title, each with its own tone.
        public let lines: [Line]
        /// Raw material kept out of the way (an operation's arguments).
        public let detailLabel: String?
        public let detailText: String?
        /// Commands on this row; each runs an existing operation after its declared confirmation.
        public let commands: [ReportCommand]
    }

    public struct Status: Hashable, Sendable {
        public let label: String
        public let tone: Tone?
    }

    public struct Line: Hashable, Sendable {
        public let text: String
        public let tone: Tone?
    }

    public struct ListLink: Hashable, Sendable {
        public let entity: EntityKey
        public let filters: [String: String]

        /// The list's filter state: each declared URL key mapped to its wire parameter.
        public var filterState: EntityFilterState {
            var state = EntityFilterState()
            for (urlKey, value) in filters {
                guard
                    let name = EntityCatalog[entity].filters.first(where: { $0.urlKey == urlKey })?.wire.names
                        .first
                else { continue }
                state.set(.single(value), for: name)
            }
            return state
        }
    }

    /// Rows that are records of their own, with the verbs the slot offers (`CollectionActionID`).
    public struct Records: Hashable, Sendable {
        public let title: String?
        public let rows: [RecordRow]
        public let empty: String
        public let actions: [CollectionActionID]
        /// Large for evidence photos that must stay legible (a package label).
        public let largeThumbnails: Bool
        /// One line under the rows, such as a total.
        public let footer: String?
        /// Finance verbs with the server's word on each (`SectionActionID`).
        public let verbs: [Verb]

        public struct Verb: Hashable, Sendable, Identifiable {
            public var id: String { verb.rawValue }
            public let verb: SectionActionID
            public let label: String
            /// `true` acts on the checked rows.
            public let actsOnSelection: Bool
            public let disabledReason: String?
        }

        public func verb(_ verb: SectionActionID) -> Verb? {
            verbs.first { $0.verb == verb }
        }

        /// These rows with `more` stacked after them (a later page).
        public func adding(_ more: [RecordRow]) -> Records {
            Records(
                title: title,
                rows: rows
                    + more.enumerated().map { offset, row in
                        var next = row
                        next.id = rows.count + offset
                        return next
                    },
                empty: empty, actions: actions,
                largeThumbnails: largeThumbnails, footer: footer, verbs: verbs)
        }

        /// The checked keys the server still allows.
        public func allowed(_ selection: Set<String>) -> Set<String> {
            Set(rows.filter { $0.disabledReason == nil }.compactMap(\.key).filter(selection.contains))
        }

        /// `selection` with `key` flipped; a row the server refused is left alone.
        public func toggled(_ selection: Set<String>, _ key: String) -> Set<String> {
            guard let row = rows.first(where: { $0.key == key }), row.disabledReason == nil
            else { return selection }
            var next = selection
            if next.contains(key) { next.remove(key) } else { next.insert(key) }
            return next
        }
    }

    public enum Block: Hashable, Sendable {
        case records(Records)
        case stats(title: String?, figures: [Figure])
        case chart(Chart)
        case table(Table)
        case schedule(Schedule)
        case note(String, tone: Tone?, strong: Bool)
    }

    public private(set) var blocks: [Block]
    /// The record is still moving; clients poll while true.
    public let live: Bool
    /// The record's status as of this read.
    public let status: String?
    /// More of the same report; pass it back as the next request's cursor.
    public let nextCursor: String?

    public init(_ report: EntityReportOut) {
        blocks = report.blocks.map(Self.block)
        live = report.live ?? false
        status = report.status
        nextCursor = report.nextCursor
    }

    private init(blocks: [Block], live: Bool, status: String?, nextCursor: String?) {
        self.blocks = blocks
        self.live = live
        self.status = status
        self.nextCursor = nextCursor
    }

    /// The report with `page` (the next cursor's read) stacked under it: records blocks with the
    /// same title gain the page's rows, and everything else stays as the first page had it.
    public func appending(_ page: ReportPresentation) -> ReportPresentation {
        var merged = blocks
        for case .records(let more) in page.blocks {
            if let index = merged.firstIndex(where: {
                if case .records(let existing) = $0 { existing.title == more.title } else { false }
            }), case .records(let existing) = merged[index] {
                merged[index] = .records(existing.adding(more.rows))
            } else {
                merged.append(.records(more))
            }
        }
        return ReportPresentation(
            blocks: merged, live: page.live, status: page.status, nextCursor: page.nextCursor)
    }

    private static func block(_ block: Components.Schemas.ReportBlock) -> Block {
        switch block {
        case .stats(let stats):
            return .stats(
                title: stats.title,
                figures: stats.figures.map {
                    Figure(
                        label: $0.label,
                        text: $0.format == .text
                            ? ($0.text ?? "—") : text($0.value, money: $0.format == .money),
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
            return .note(
                note.text, tone: note.tone.flatMap { Tone(rawValue: $0.rawValue) },
                strong: note.strong ?? false)
        case .records(let records):
            return .records(
                Records(
                    title: records.title,
                    rows: records.rows.enumerated().map { index, row in
                        RecordRow(
                            id: index, entity: row.entity.flatMap(EntityKey.init(rawValue:)),
                            recordID: row.id, title: row.title, subtitle: row.subtitle,
                            trailing: row.trailing, imageURL: row.imageUrl.flatMap(URL.init(string:)),
                            badges: row.badges ?? [], at: row.at.flatMap(instant),
                            listLink: row.listLink.flatMap { link in
                                EntityKey(rawValue: link.entity).map {
                                    ListLink(entity: $0, filters: link.filters.additionalProperties)
                                }
                            },
                            actions: (row.actions ?? []).compactMap {
                                CollectionActionID(rawValue: $0.rawValue)
                            },
                            key: row.key, disabledReason: row.disabledReason,
                            statuses: (row.statuses ?? []).map {
                                Status(label: $0.label, tone: $0.tone.flatMap { Tone(rawValue: $0.rawValue) })
                            },
                            lines: (row.lines ?? []).map {
                                Line(text: $0.text, tone: $0.tone.flatMap { Tone(rawValue: $0.rawValue) })
                            },
                            detailLabel: row.detail?.label, detailText: row.detail?.text,
                            commands: row.commands ?? [])
                    },
                    empty: records.empty,
                    actions: (records.actions ?? []).compactMap { CollectionActionID(rawValue: $0.rawValue) },
                    largeThumbnails: records.thumbnail == .large, footer: records.footer,
                    verbs: (records.verbs ?? []).compactMap { verb in
                        SectionActionID(rawValue: verb.id.rawValue).map {
                            Records.Verb(
                                verb: $0, label: verb.label, actsOnSelection: verb.scope == .selection,
                                disabledReason: verb.disabledReason)
                        }
                    })
            )
        }
    }

    /// Money is whole USD at the server's precision; a missing figure is a dash, never zero.
    private static func text(_ value: Double?, money: Bool) -> String {
        guard let value else { return "—" }
        return money ? value.usd : String(Int(value.rounded()))
    }

    /// An ISO-8601 instant with or without fractional seconds.
    private static func instant(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return withFraction.date(from: text) ?? plain.date(from: text)
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
