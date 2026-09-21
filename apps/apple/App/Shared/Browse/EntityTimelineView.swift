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
                        Text(stat.value).font(.porcelainData)
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
                    if let link = event.link, let key = EntityKey(rawValue: link.entity) {
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
                        Text(EntityFieldValue.formattedDate(date.rawValue) ?? date.rawValue)
                    } else {
                        Text("Date unknown")
                    }
                    if let label = group.label {
                        if let link = group.link, let key = EntityKey(rawValue: link.entity) {
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
        if let extent = timeline.extent, let from = extent.from.date, let to = extent.to.date, from <= to {
            return from...to
        }
        let days = (timeline.rows ?? []).flatMap { row in
            row.intervals.flatMap { [$0.start.date, $0.end?.date] } + row.markers.map { $0.date.date }
        }.compactMap { $0 }
        let from = days.min() ?? .now
        let to = max(days.max() ?? .now, .now)
        return from...max(from, to)
    }
}

private struct TimelineEventRow: View {
    let event: EntityTimelineEvent

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: PorcelainTokens.Space.sm) {
            StatusChip(text: event.kind.replacingOccurrences(of: "_", with: " ").capitalized)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.label).font(.porcelainBody)
                if let detail = event.detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
            if let amount = event.amount {
                Text(EntityFieldValue.format(amount))
                    .font(.porcelainData)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
        }
        .frame(minHeight: PorcelainTokens.touchTarget)
    }
}

/// One record's intervals as bars on a shared day axis; `confident: false` draws dashed.
private struct LifecycleRowView: View {
    let row: EntityTimelineRow
    let extent: ClosedRange<Date>

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
            HStack(spacing: PorcelainTokens.Space.sm) {
                Thumb(url: row.imageUrl.flatMap(URL.init(string:)), size: 28)
                Text(row.name).font(.porcelainLabel).lineLimit(1)
                Spacer()
                Text(span).font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            Canvas { context, size in
                let track = Path(
                    roundedRect: CGRect(x: 0, y: size.height / 2 - 1, width: size.width, height: 2),
                    cornerRadius: 1)
                context.fill(track, with: .color(PorcelainTokens.hairline))
                for interval in row.intervals {
                    guard let start = interval.start.date else { continue }
                    let end = interval.end?.date ?? .now
                    let x0 = position(start, in: size.width)
                    let x1 = max(x0 + 3, position(end, in: size.width))
                    let bar = Path(
                        roundedRect: CGRect(x: x0, y: size.height / 2 - 5, width: x1 - x0, height: 10),
                        cornerRadius: 5)
                    if interval.confident {
                        context.fill(bar, with: .color(PorcelainTokens.cobalt))
                    } else {
                        context.stroke(
                            bar, with: .color(PorcelainTokens.cobalt),
                            style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                    }
                }
                for marker in row.markers {
                    guard let day = marker.date.date else { continue }
                    let x = position(day, in: size.width)
                    let dot = Path(ellipseIn: CGRect(x: x - 4, y: size.height / 2 - 4, width: 8, height: 8))
                    context.fill(dot, with: .color(PorcelainTokens.graphite))
                }
            }
            .frame(height: 20)
            .accessibilityLabel("\(row.name): \(accessibilitySummary)")
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
    }

    private func position(_ date: Date, in width: CGFloat) -> CGFloat {
        let total = extent.upperBound.timeIntervalSince(extent.lowerBound)
        guard total > 0 else { return width / 2 }
        let fraction = date.timeIntervalSince(extent.lowerBound) / total
        return CGFloat(min(max(fraction, 0), 1)) * width
    }

    private var span: String {
        guard let first = row.intervals.first?.start.date else { return "" }
        let start = first.formatted(date: .abbreviated, time: .omitted)
        guard let end = row.intervals.last?.end?.date else { return "\(start) →" }
        return "\(start) – \(end.formatted(date: .abbreviated, time: .omitted))"
    }

    private var accessibilitySummary: String {
        row.intervals.map { interval in
            let confidence = interval.confident ? "" : ", unconfirmed"
            return "\(interval.start.rawValue) to \(interval.end?.rawValue ?? "now")\(confidence)"
        }.joined(separator: "; ")
    }
}

#Preview("Timeline") {
    NavigationStack {
        List {
            EntityTimelineView(timeline: PreviewFixtures.sampleTimeline, title: "Movements")
        }
        .listStyle(.plain)
        .porcelainScreen()
    }
}
