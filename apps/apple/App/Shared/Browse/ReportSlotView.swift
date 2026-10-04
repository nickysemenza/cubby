import Charts
import CubbyKit
import SwiftUI

private struct ReportBatchStoreKey: EnvironmentKey {
    static let defaultValue: ReportBatchStore? = nil
}

extension EnvironmentValues {
    /// The detail screen's batched run reads; one request serves every run slot on the screen.
    var reportBatchStore: ReportBatchStore? {
        get { self[ReportBatchStoreKey.self] }
        set { self[ReportBatchStoreKey.self] = newValue }
    }
}

/// A detail slot drawn from the server's `entityReport.get` blocks: the one generic path for the
/// project, location, meal, product, image, purchase and finance slots and a run's progress,
/// approvals, findings, transcript, log, usage and changes. The server owns every figure,
/// sentence and command; this loads, polls while the server says the record is live (a run's
/// slots share one batched read), and draws.
struct ReportDetailSlot: View {
    let slot: ReportSlot
    let id: String
    /// The record the slot belongs to; a `records` block's verbs act on it.
    var host: ReportHost?
    /// The record's status as the screen shows it; a report that read another reloads the record.
    var shownStatus: String?

    @Environment(AppModel.self) private var appModel
    @Environment(\.reportBatchStore) private var batchStore
    @State private var model: ReportSlotModel?

    var body: some View {
        Group {
            if let model {
                ReportSlotContent(model: model, host: host)
                    .id("\(slot.rawValue)|\(id)")
            } else {
                LoadingIndicator(label: "Loading")
            }
        }
        .task(id: "\(slot.rawValue)|\(id)") {
            // A lazy container restarts this task when the row scrolls back in. Replacing the
            // model then would orphan it: `ReportSlotContent` keeps its identity, never fires
            // `onAppear` for the new model, and the slot stays on "Loading" forever.
            if let model, model.slot == slot, model.id == id { return }
            // A run's batched slots share one polled read through the screen's store.
            let batch =
                RunReportBatch.contains(slot)
                ? batchStore?.batch(service: appModel.client, id: id, shownStatus: shownStatus) : nil
            let next = ReportSlotModel(
                slot: slot, id: id, shownStatus: shownStatus, batch: batch, service: appModel.client)
            next.onRecordStale = { [appModel] in appModel.recordEntityMutation(keys: [.run]) }
            model = next
        }
        // The record reloaded with a new status: the model compares against it from now on, and a
        // stopped run that resumed is polled again.
        .onChange(of: shownStatus) {
            model?.shownStatus = shownStatus
            model?.restartPolling()
        }
        // A write elsewhere on this screen (a verb, an edit) re-reads what the slot shows.
        .task(id: appModel.entityMutationRevision) {
            guard appModel.entityMutationRevision > 0 else { return }
            await model?.refresh()
        }
    }
}

private struct ReportSlotContent: View {
    let model: ReportSlotModel
    let host: ReportHost?
    @Environment(AppModel.self) private var appModel

    var body: some View {
        Group {
            if let presentation = model.presentation {
                ReportBlocksView(report: presentation, host: host, model: model)
                if model.canLoadMore {
                    Button("Load more") { Task { await model.loadMore() } }
                        .disabled(model.isLoading)
                }
                if let error = model.actionError {
                    Text(error).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
                        .textSelection(.enabled)
                }
                if let notice = model.actionNotice {
                    Text(notice).font(.caption).foregroundStyle(FieldGuideTokens.positive)
                }
                if let runID = model.openedRunID {
                    NavigationLink(value: Route.entityDetail(.run, id: runID)) {
                        Label("Open the new run", systemImage: "arrow.up.right.square")
                    }
                }
            } else if let message = model.failure {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                    Text(message).foregroundStyle(.secondary)
                    Button("Retry") { Task { await model.refresh() } }
                }
            } else {
                LoadingIndicator(label: "Loading")
            }
        }
        .onAppear { model.retain() }
        .onDisappear { model.release() }
        .onChange(of: model.actionNotice) { appModel.recordEntityMutation(keys: Self.written) }
    }

    /// A command can change the run and the records its fix writes.
    private static let written: Set<EntityKey> = [.run, .purchase, .expense, .financialTransaction]
}

struct ReportBlocksView: View {
    let report: ReportPresentation
    var host: ReportHost?
    /// Runs the commands of a records block; nil where the slot has none.
    var model: ReportSlotModel?

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
            ForEach(Array(report.blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .stats(let title, let figures): ReportStatsView(title: title, figures: figures)
                case .chart(let chart): ReportChartView(chart: chart)
                case .table(let table): ReportTableView(table: table)
                case .schedule(let schedule): ReportScheduleView(schedule: schedule)
                case .records(let records): RecordsBlockView(records: records, host: host, model: model)
                case .note(let text, let tone, let strong):
                    Text(text)
                        .font(strong ? .subheadline.weight(.medium) : .footnote)
                        .foregroundStyle(tone?.color ?? (strong ? Color.primary : Color.secondary))
                        .fixedSize(horizontal: false, vertical: true)
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
                        .fixedSize(horizontal: false, vertical: true)
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
