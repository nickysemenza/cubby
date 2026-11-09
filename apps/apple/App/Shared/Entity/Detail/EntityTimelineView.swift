import CubbyKit
import SwiftUI

/// `resources.<entity>.timeline` rendered as list/form sections: lifecycle rows first (one
/// interval bar per record, dashed where the server is not confident, milestones as dots), then
/// one section per date group whose events link to the records they name. The host supplies the
/// `List`/`Form`; the same view serves a list's timeline view and a detail's timeline section.
struct EntityTimelineView: View {
    let timeline: EntityTimelineOut
    /// Section title above the first section, when the host does not label it.
    var title: String? = nil

    var body: some View {
        if let rows = timeline.rows, !rows.isEmpty {
            Section(title ?? "Lifecycles") {
                let extent = Self.extent(of: timeline)
                ForEach(rows) { row in
                    LifecycleRowView(row: row, extent: extent)
                }
            }
        }
        if !timeline.stats.isEmpty {
            Section {
                ForEach(timeline.stats, id: \.key) { stat in
                    LabeledContent(stat.label) {
                        Text(stat.value).font(.fieldGuideData)
                    }
                }
            }
        }
        if timeline.groups.isEmpty && (timeline.rows ?? []).isEmpty {
            Section(title ?? "") {
                Text("No events").foregroundStyle(.secondary)
            }
        }
        ForEach(timeline.groups, id: \.key) { group in
            Section {
                ForEach(group.events) { event in
                    if case .value(.some(let link)) = event.link, let key = EntityKey(rawValue: link.entity) {
                        NavigationLink(value: Route.entityDetail(key, id: link.id)) {
                            TimelineEventRow(event: event)
                        }
                    } else {
                        TimelineEventRow(event: event)
                    }
                }
            } header: {
                HStack {
                    if let date = group.date {
                        DateDisplay(date.rawValue)
                    } else {
                        Text("Date unknown")
                    }
                    if case .value(.some(let label)) = group.label {
                        if case .value(.some(let link)) = group.link,
                            let key = EntityKey(rawValue: link.entity)
                        {
                            NavigationLink(value: Route.entityDetail(key, id: link.id)) {
                                Text("· \(label)")
                            }
                        } else {
                            Text("· \(label)")
                        }
                    }
                }
            }
        }
        if !timeline.notes.isEmpty {
            Section {
                ForEach(timeline.notes, id: \.self) { note in
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    /// The day span every lifecycle bar is scaled against: the server's `extent`, else the rows'.
    static func extent(of timeline: EntityTimelineOut) -> ClosedRange<Date> {
        if let extent = timeline.extent, let from = extent.from.date(), let to = extent.to.date(), from <= to
        {
            return from...to
        }
        let days = (timeline.rows ?? []).flatMap { row in
            row.intervals.flatMap { [$0.start.date(), $0.end.valueIfPresent??.date()] }
                + row.markers.map { $0.date.date() }
        }.compactMap { $0 }
        let from = days.min() ?? .now
        let to = max(days.max() ?? .now, .now)
        return from...max(from, to)
    }
}

private struct TimelineEventRow: View {
    let event: EntityTimelineEvent

    private var displayKind: String {
        if event.kind.hasPrefix("field:"), case .value(.some(let label)) = event.detail {
            return label
        }
        return Self.kindLabel(event.kind)
    }

    /// Web's `KIND_LABEL` (`entity/timeline/entity-timeline.tsx`), so both clients name an event
    /// kind the same way; an unlisted `field:<name>` kind reads as its field name, anything else
    /// as its raw kind, exactly as web falls back.
    static func kindLabel(_ kind: String) -> String {
        let labels = [
            "acquired": "Acquired", "exited": "Exited", "discarded": "Discarded",
            "adjusted": "Price adjusted", "unknown": "Unknown", "linked": "Linked purchase",
            "audit:create": "Created", "audit:update": "Updated", "audit:delete": "Deleted",
        ]
        if let label = labels[kind] { return label }
        return kind.hasPrefix("field:") ? String(kind.dropFirst("field:".count)) : kind
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
            StatusChip(text: displayKind)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.label).font(.fieldGuideBody)
                if case .value(.some(let detail)) = event.detail, detail != displayKind {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: FieldGuideTokens.Space.sm)
            amount
        }
        .frame(minHeight: FieldGuideTokens.touchTarget)
    }

    /// `amount` is signed USD by contract (an Expense cost; negative is money recovered), never an
    /// inventory quantity. Same shapes as web's `Amount`: absent draws nothing, null says unknown.
    @ViewBuilder
    private var amount: some View {
        switch event.amount {
        case .absent:
            EmptyView()
        case .value(.none):
            Text("Amount unknown").font(.caption).foregroundStyle(.secondary)
        case .value(.some(let value)) where value < 0:
            Text("\(ValueFormat.currency(-value)) recovered")
                .font(.fieldGuideData)
                .foregroundStyle(FieldGuideTokens.positive)
        case .value(.some(let value)):
            Text(ValueFormat.currency(value))
                .font(.fieldGuideData)
                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
        }
    }
}

/// One record's intervals as bars on a shared day axis; `confident: false` draws dashed.
private struct LifecycleRowView: View {
    let row: EntityTimelineRow
    let extent: ClosedRange<Date>

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            HStack(spacing: FieldGuideTokens.Space.sm) {
                Thumb(url: row.imageUrl.valueIfPresent.flatMap { $0 }.flatMap(URL.init(string:)), size: 28)
                Text(row.name).font(.fieldGuideLabel).lineLimit(1)
                Spacer()
                Text(span).font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            Canvas { context, size in
                let track = Path(
                    roundedRect: CGRect(x: 0, y: size.height / 2 - 1, width: size.width, height: 2),
                    cornerRadius: 1)
                context.fill(track, with: .color(FieldGuideTokens.hairline))
                for interval in row.intervals {
                    guard let start = interval.start.date() else { continue }
                    let end = interval.end.valueIfPresent??.date() ?? .now
                    let x0 = position(start, in: size.width)
                    let x1 = max(x0 + 3, position(end, in: size.width))
                    let bar = Path(
                        roundedRect: CGRect(x: x0, y: size.height / 2 - 5, width: x1 - x0, height: 10),
                        cornerRadius: 5)
                    if interval.confident {
                        context.fill(bar, with: .color(FieldGuideTokens.interaction))
                    } else {
                        context.stroke(
                            bar, with: .color(FieldGuideTokens.interaction),
                            style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                    }
                }
                for marker in row.markers {
                    guard let day = marker.date.date() else { continue }
                    let x = position(day, in: size.width)
                    let dot = Path(ellipseIn: CGRect(x: x - 4, y: size.height / 2 - 4, width: 8, height: 8))
                    context.fill(dot, with: .color(FieldGuideTokens.graphite))
                }
            }
            .frame(height: 20)
            .accessibilityLabel("\(row.name): \(accessibilitySummary)")
        }
        .padding(.vertical, FieldGuideTokens.Space.xs)
    }

    private func position(_ date: Date, in width: CGFloat) -> CGFloat {
        let total = extent.upperBound.timeIntervalSince(extent.lowerBound)
        guard total > 0 else { return width / 2 }
        let fraction = date.timeIntervalSince(extent.lowerBound) / total
        return CGFloat(min(max(fraction, 0), 1)) * width
    }

    private var span: String {
        guard let first = row.intervals.first?.start.date() else { return "" }
        let start = first.formatted(date: .abbreviated, time: .omitted)
        guard let end = row.intervals.last?.end.valueIfPresent??.date() else { return "\(start) →" }
        return "\(start) – \(end.formatted(date: .abbreviated, time: .omitted))"
    }

    private var accessibilitySummary: String {
        row.intervals.map { interval in
            let confidence = interval.confident ? "" : ", unconfirmed"
            let start = ValueFormat.plainDate(interval.start.rawValue)
            let end = (interval.end.valueIfPresent??.rawValue).map(ValueFormat.plainDate) ?? "now"
            return "\(start) to \(end)\(confidence)"
        }.joined(separator: "; ")
    }
}

#Preview("Timeline") {
    NavigationStack {
        List {
            EntityTimelineView(timeline: PreviewFixtures.sampleTimeline, title: "Movements")
        }
        .listStyle(.plain)
        .fieldGuideScreen()
    }
}
