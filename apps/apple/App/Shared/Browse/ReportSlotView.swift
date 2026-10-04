import Charts
import CubbyKit
import SwiftUI

/// A detail slot drawn from the server's `entityReport.get` blocks: the one generic path for the
/// project budget, contribution, analytics and schedule, a location's contents valuation, and a
/// meal's composition. The server owns every figure; this loads and draws.
struct ReportDetailSlot: View {
    private enum Phase {
        case loading
        case failed(String)
        case loaded(ReportPresentation)
    }

    let slot: ReportSlot
    let id: String
    /// The record the slot belongs to; a `records` block's verbs act on it.
    var host: ReportHost?
    @Environment(AppModel.self) private var appModel
    @State private var phase: Phase = .loading

    var body: some View {
        Group {
            switch phase {
            case .loading:
                LoadingIndicator(label: "Loading")
            case .failed(let message):
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                    Text(message).foregroundStyle(.secondary)
                    Button("Retry") { Task { await load() } }
                }
            case .loaded(let report):
                ReportBlocksView(report: report, host: host)
            }
        }
        .task(id: "\(id):\(appModel.entityMutationRevision)") { await load() }
    }

    private func load() async {
        do {
            let report = try await appModel.client.entityReport(slot: slot, id: id)
            guard !Task.isCancelled else { return }
            phase = .loaded(ReportPresentation(report))
        } catch {
            guard !Task.isCancelled else { return }
            Diagnostics.report(error, context: "report.\(slot.rawValue)")
            phase = .failed(error.userMessage)
        }
    }
}

struct ReportBlocksView: View {
    let report: ReportPresentation
    var host: ReportHost?

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
            ForEach(Array(report.blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .stats(let title, let figures): ReportStatsView(title: title, figures: figures)
                case .chart(let chart): ReportChartView(chart: chart)
                case .table(let table): ReportTableView(table: table)
                case .schedule(let schedule): ReportScheduleView(schedule: schedule)
                case .records(let records): RecordsBlockView(records: records, host: host)
                case .note(let text):
                    Text(text).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension ReportPresentation.Tone {
    var color: Color {
        switch self {
        case .positive: FieldGuideTokens.positive
        case .warning: FieldGuideTokens.warning
        case .destructive: FieldGuideTokens.destructive
        case .muted: FieldGuideTokens.graphiteSecondary
        }
    }
}

private func routeTarget(_ ref: ReportPresentation.Ref?) -> Route? {
    guard let ref, let key = EntityKey(rawValue: ref.entity) else { return nil }
    return .entityDetail(key, id: ref.id)
}

// MARK: - Stats

private struct ReportStatsView: View {
    let title: String?
    let figures: [ReportPresentation.Figure]

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            if let title { Eyebrow(title) }
            ForEach(figures) { figure in
                LabeledContent(figure.label) {
                    Text(figure.text)
                        .font(.fieldGuideData)
                        .foregroundStyle(figure.tone?.color ?? FieldGuideTokens.graphite)
                }
            }
        }
    }
}

// MARK: - Chart

private struct ReportChartView: View {
    let chart: ReportPresentation.Chart

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            if let title = chart.title { Eyebrow(title) }
            switch chart.mark {
            case .stack: stack
            case .line: line
            case .bar: bars
            }
            if let caption = chart.caption {
                Text(caption).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    /// One segmented bar against the estimate marker.
    private var stack: some View {
        Chart {
            ForEach(chart.bars) { bar in
                BarMark(x: .value("Amount", bar.value))
                    .foregroundStyle(bar.tone?.color ?? FieldGuideTokens.interaction)
                    .accessibilityLabel(bar.label)
                    .accessibilityValue(bar.text)
            }
            if let marker = chart.marker {
                RuleMark(x: .value("Estimate", marker))
                    .foregroundStyle(.secondary)
                    .annotation(position: .top, alignment: .trailing) {
                        Text("Estimate").font(.caption2).foregroundStyle(.secondary)
                    }
            }
        }
        .chartXScale(domain: 0...max(chart.scaleMax, 1))
        .chartXAxis(.hidden)
        .frame(height: 44)
    }

    private var line: some View {
        Chart(chart.bars) { bar in
            LineMark(x: .value("Month", bar.label), y: .value("Amount", bar.value))
            PointMark(x: .value("Month", bar.label), y: .value("Amount", bar.value))
                .accessibilityLabel(bar.label)
                .accessibilityValue(bar.text)
        }
        .foregroundStyle(FieldGuideTokens.interaction)
        .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
        .frame(height: 160)
    }

    private var bars: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Chart(chart.bars) { bar in
                BarMark(x: .value("Amount", bar.value), y: .value("Label", bar.label))
                    .foregroundStyle(bar.tone?.color ?? FieldGuideTokens.interaction)
                    .accessibilityLabel(bar.label)
                    .accessibilityValue(bar.text)
            }
            .chartXAxis(.hidden)
            .frame(height: CGFloat(max(chart.bars.count, 1)) * 28)
            // A bar cannot be a link, so records the bars name are listed beneath it.
            ForEach(chart.bars.filter { $0.ref != nil }) { bar in
                if let route = routeTarget(bar.ref) {
                    NavigationLink(value: route) {
                        LabeledContent(bar.label) { Text(bar.text).font(.fieldGuideData) }
                    }
                }
            }
        }
    }
}

// MARK: - Table

private struct ReportTableView: View {
    let table: ReportPresentation.Table

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            if let title = table.title { Eyebrow(title) }
            if table.rows.isEmpty {
                if let empty = table.empty {
                    Text(empty).font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                ForEach(table.rows) { row in
                    if let route = routeTarget(row.ref) {
                        NavigationLink(value: route) { cells(row) }
                    } else {
                        cells(row)
                    }
                }
            }
            if table.truncated {
                Text("Showing the first rows only.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func cells(_ row: ReportPresentation.Table.Row) -> some View {
        LabeledContent {
            Text(row.cells.dropFirst().joined(separator: " · "))
                .font(.fieldGuideData)
                .multilineTextAlignment(.trailing)
        } label: {
            Text(row.cells.first ?? "")
        }
    }
}

// MARK: - Schedule

/// Dated spans on one shared axis, a row per project or task. Collapse is the viewer's own state;
/// which rows exist, their order and their dates all come from the server.
private struct ReportScheduleView: View {
    let schedule: ReportPresentation.Schedule
    @State private var collapsed: Set<String> = []

    private static let rowHeight: CGFloat = 36
    private static let labelWidth: CGFloat = 156

    var body: some View {
        let rows = schedule.visibleRows(collapsed: collapsed)
        let names = Dictionary(uniqueKeysWithValues: schedule.rows.map { ($0.id, $0.name) })
        VStack(alignment: .leading, spacing: 0) {
            Text(
                "\(schedule.rows.count) activities · \(schedule.rows.filter { $0.segments.isEmpty }.count) without dates"
            )
            .font(.caption).foregroundStyle(.secondary)
            .padding(.bottom, FieldGuideTokens.Space.sm)
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(rows) { row in
                        HStack(spacing: FieldGuideTokens.Space.sm) {
                            label(row)
                                .frame(width: Self.labelWidth, alignment: .leading)
                            timeline(row)
                                .frame(width: 320, height: Self.rowHeight)
                        }
                        .frame(height: Self.rowHeight)
                        .accessibilityElement(children: .combine)
                        .accessibilityHint(dependencies(row, names: names))
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
    }

    private func label(_ row: ReportPresentation.Schedule.Row) -> some View {
        HStack(spacing: FieldGuideTokens.Space.xs) {
            Color.clear.frame(width: CGFloat(row.depth) * 10, height: 1)
            if row.expandable {
                Button {
                    if collapsed.contains(row.id) {
                        collapsed.remove(row.id)
                    } else {
                        collapsed.insert(row.id)
                    }
                } label: {
                    Image(systemName: collapsed.contains(row.id) ? "chevron.right" : "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    collapsed.contains(row.id) ? "Expand \(row.name)" : "Collapse \(row.name)")
            } else {
                Color.clear.frame(width: 20, height: 1)
            }
            VStack(alignment: .leading, spacing: 0) {
                if let key = EntityKey(rawValue: row.entity) {
                    NavigationLink(value: Route.entityDetail(key, id: row.id)) {
                        Text(row.name).font(.footnote).lineLimit(1)
                    }
                } else {
                    Text(row.name).font(.footnote).lineLimit(1)
                }
                Text(row.noDateLabel ?? row.metaShort).font(.caption2).foregroundStyle(.secondary).lineLimit(
                    1)
            }
        }
    }

    private func timeline(_ row: ReportPresentation.Schedule.Row) -> some View {
        GeometryReader { proxy in
            if let domain = schedule.domain {
                let span = max(domain.upperBound.timeIntervalSince(domain.lowerBound), 86_400)
                let x = { (date: Date) in
                    CGFloat(date.timeIntervalSince(domain.lowerBound) / span) * (proxy.size.width - 8) + 4
                }
                ForEach(row.segments) { segment in
                    if let end = segment.end {
                        Capsule()
                            .fill(FieldGuideTokens.planViolet)
                            .frame(width: max(x(end) - x(segment.start), 6), height: 10)
                            .position(
                                x: (x(segment.start) + max(x(end), x(segment.start) + 6)) / 2,
                                y: proxy.size.height / 2)
                    } else {
                        Image(systemName: "diamond.fill")
                            .font(.caption2)
                            .foregroundStyle(FieldGuideTokens.planViolet)
                            .position(x: x(segment.start), y: proxy.size.height / 2)
                    }
                }
            }
        }
    }

    private func dependencies(_ row: ReportPresentation.Schedule.Row, names: [String: String]) -> String {
        func list(_ title: String, _ ids: [String]) -> String? {
            ids.isEmpty ? nil : "\(title) " + ids.map { names[$0] ?? $0 }.joined(separator: ", ")
        }
        return [list("Blocked by", row.blockedByIDs), list("Blocking", row.blockingIDs)]
            .compactMap { $0 }.joined(separator: ". ")
    }
}
