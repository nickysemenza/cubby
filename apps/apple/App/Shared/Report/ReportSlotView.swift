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
    var compact = false

    @Environment(AppModel.self) private var appModel
    @Environment(\.reportBatchStore) private var batchStore
    @State private var model: ReportSlotModel?

    var body: some View {
        Group {
            if let model {
                ReportSlotContent(model: model, host: host, compact: compact)
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
    var compact = false
    @Environment(AppModel.self) private var appModel

    var body: some View {
        Group {
            if let presentation = model.presentation {
                if compact {
                    if !presentation.summaryIsEmpty { CompactReportBlocksView(report: presentation) }
                } else {
                    ReportBlocksView(report: presentation, host: host, model: model)
                }
                if let failure = model.failure {
                    InlineLoadFailure(message: failure) { await model.refresh() }
                }
                if model.canLoadMore {
                    Button("Load more") { Task { await model.loadMore() } }
                        .disabled(model.isLoading)
                }
                if let error = model.actionError {
                    Text(error).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
                        .textSelection(.enabled)
                }
                if let progress = model.actionProgress {
                    Text(progress).font(.caption).foregroundStyle(.secondary)
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
                    InlineLoadFailure(message: message) { await model.refresh() }
                }
            } else {
                LoadingIndicator(label: "Loading")
            }
        }
        .preference(
            key: SummaryCellEmpty.self,
            value: compact && model.presentation?.summaryIsEmpty == true && model.failure == nil
                && !model.canLoadMore
        )
        .onChange(of: model.failure) { _, failure in
            if let failure {
                Diagnostics.report(
                    NSError(domain: "Cubby.Report", code: 0, userInfo: [NSLocalizedDescriptionKey: failure]),
                    context: "detail.report")
            }
        }
        .onAppear { model.retain() }
        .onDisappear { model.release() }
        .onChange(of: model.actionNotice) { appModel.recordEntityMutation(keys: Self.written) }

    }

    /// A command can change the run and the records its fix writes (a re-parse writes a recipe
    /// line and may create an ingredient; a composition change writes a meal).
    private static let written: Set<EntityKey> = [
        .run, .purchase, .expense, .financialTransaction, .recipe, .ingredient, .meal,
    ]
}

/// Only informational projections belong in a summary. Commands and forms stay in full sections.
private struct CompactReportBlocksView: View {
    let report: ReportPresentation
    @State private var expanded = false

    // A summary leads with one useful block; caveats remain beside its figures.
    // The disclosure retains the complete informational report without its workflow controls.
    private var collapsedIndices: [Int] {
        var primary: Int?
        var notes: [Int] = []
        for (index, block) in report.blocks.enumerated() {
            switch block {
            case .note, .unsupported:
                notes.append(index)
            case .stats(_, let figures):
                if primary == nil, !figures.isEmpty { primary = index }
            case .records(let records):
                if primary == nil, !records.rows.isEmpty || (records.totalCount ?? 0) > 0 { primary = index }
            case .table(let table):
                if primary == nil, !table.rows.isEmpty { primary = index }
            case .chart(let chart):
                if primary == nil, !chart.bars.isEmpty { primary = index }
            case .progress:
                if primary == nil { primary = index }
            }
        }
        return ((primary.map { [$0] } ?? []) + notes).sorted()
    }

    private var hasMore: Bool {
        collapsedIndices.count < report.blocks.count
            || report.blocks.contains { block in
                switch block {
                case .stats(_, let figures): figures.count > 4
                case .records(let records): records.rows.count > 3
                case .table(let table): table.rows.count > 3
                default: false
                }
            }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            ForEach(expanded ? Array(report.blocks.indices) : collapsedIndices, id: \.self) { index in
                let block = report.blocks[index]
                switch block {
                case .stats(let title, let figures):
                    ReportStatsView(title: title, figures: expanded ? figures : Array(figures.prefix(4)))
                case .records(let records):
                    if let title = records.title { Text(title).font(.caption.weight(.medium)) }
                    if let count = records.totalCount {
                        let shown = expanded ? records.rows.count : min(3, records.rows.count)
                        Text(shown < count ? "\(shown) of \(count) records" : "\(count) total")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(
                        Array(records.rows.prefix(expanded ? records.rows.count : 3).enumerated()),
                        id: \.offset
                    ) { _, row in
                        RecordRowView(row: row, informational: true)
                    }
                    if let source = records.connectionSource, let key = records.connectionViewKey {
                        NavigationLink("Related records", value: Route.connectedRecords(source, viewKey: key))
                            .frame(minHeight: FieldGuideTokens.touchTarget)
                    }
                    if let link = records.listLink {
                        NavigationLink(
                            "View records", value: Route.entityList(link.entity, filters: link.filterState)
                        )
                        .frame(minHeight: FieldGuideTokens.touchTarget)
                    }
                    if let footer = records.footer { Text(footer).font(.caption).foregroundStyle(.secondary) }
                case .chart(let chart):
                    ReportChartView(chart: chart)
                case .table(let table):
                    if let title = table.title { Text(title).font(.caption).foregroundStyle(.secondary) }
                    ForEach(
                        Array(table.rows.prefix(expanded ? table.rows.count : 3).enumerated()), id: \.offset
                    ) { _, row in
                        if let route = routeTarget(row.ref) {
                            NavigationLink(value: route) { tableRow(row, columns: table.columns) }
                        } else {
                            tableRow(row, columns: table.columns)
                        }
                    }
                    if table.truncated {
                        Text("Server returned a truncated table").font(.caption).foregroundStyle(.secondary)
                    }
                case .progress(let progress):
                    Text(progress.label).font(.subheadline)
                    Text(progress.summary).font(.caption).monospacedDigit()
                    Text(progress.detail).font(.caption).foregroundStyle(.secondary)
                case .note(let text, let tone, let strong):
                    Text(text).font(strong ? .subheadline : .caption)
                        .foregroundStyle(tone?.color ?? .secondary)
                case .unsupported(let raw):
                    Text(
                        UnsupportedNativeResponse(context: "summary report block", raw: raw)
                            .localizedDescription
                    )
                    .font(.caption).textSelection(.enabled)
                }
            }
            if hasMore {
                Button(expanded ? "Show less" : "Show more") { expanded.toggle() }
                    .frame(minHeight: FieldGuideTokens.touchTarget)
            }
        }
    }

    private func tableRow(_ row: ReportPresentation.Table.Row, columns: [String]) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            ForEach(Array(row.cells.enumerated()), id: \.offset) { index, value in
                LabeledContent(index < columns.count ? columns[index] : "Value", value: value)
            }
        }
        .font(.caption)
    }
}

struct ReportBlocksView: View {
    let report: ReportPresentation
    var host: ReportHost?
    /// Runs the commands of a records block; nil where the slot has none.
    var model: ReportSlotModel?

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.md) {
            if report.blocks.isEmpty {
                Text("Empty").font(.caption).foregroundStyle(.secondary)
                Text("No items").foregroundStyle(.secondary)
                    .preference(key: DetailSectionEmpty.self, value: true)
            }
            ForEach(Array(report.blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .progress(let progress):
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        Text(progress.label).font(.subheadline.weight(.medium))
                        Text(progress.summary).font(.caption).monospacedDigit()
                        if let total = progress.total {
                            ProgressView(value: progress.processed, total: max(1, total))
                                .accessibilityLabel(progress.label)
                                .accessibilityValue(progress.summary)
                        } else {
                            ProgressView().progressViewStyle(.linear)
                                .accessibilityLabel(progress.label)
                                .accessibilityValue(progress.summary)
                        }
                        Text(progress.detail).font(.footnote).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                case .stats(let title, let figures): ReportStatsView(title: title, figures: figures)
                case .chart(let chart): ReportChartView(chart: chart)
                case .table(let table): ReportTableView(table: table)
                case .records(let records): RecordsBlockView(records: records, host: host, model: model)
                case .unsupported(let raw):
                    Text(UnsupportedNativeResponse(context: "report block", raw: raw).localizedDescription)
                        .font(.footnote).textSelection(.enabled)
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

#if DEBUG
    #Preview("Run work progress") {
        let json = #"""
            {"blocks":[
              {"kind":"progress","label":"Labelling suggestions","processed":40,"total":100,
               "summary":"40 / 100 suggestions · 2 failed","detail":"Paused · 120 suggestions/min · About 30s remaining · Using paused rate"},
              {"kind":"progress","label":"Discovering mail","processed":7,"total":null,
               "summary":"7 / unknown emails · 0 failed","detail":"Running · 12 emails/min · Total unknown"}
            ]}
            """#
        let report = try! JSONDecoder.cubby().decode(EntityReportOut.self, from: Data(json.utf8))
        ReportBlocksView(report: ReportPresentation(report)).padding()
    }
#endif

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
            if let title = table.title {
                HStack {
                    Eyebrow(title)
                    if table.rows.isEmpty { Text("Empty").font(.caption).foregroundStyle(.secondary) }
                }
            }
            if table.rows.isEmpty {
                Text(table.empty ?? "No items").font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                // The server's column headings, in the same label/value layout as the rows.
                if let first = table.columns.first {
                    LabeledContent {
                        Text(table.columns.dropFirst().joined(separator: " · "))
                    } label: {
                        Text(first)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.isHeader)
                }
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
