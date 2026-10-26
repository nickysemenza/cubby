import CubbyKit
import SwiftUI

/// The declaration owns order and meaning; native supplies one renderer for each summary kind.
struct DetailSummaryGrid: View {
    let descriptor: EntityDescriptor
    let row: EntityRow

    private var slots: [DetailSummarySlot] {
        Array(descriptor.presentation.summarySlots.prefix(8)).filter { slot in
            guard case .fields(let keys) = slot.kind else { return true }
            // Invalid keys must stay visible as diagnostics rather than looking inapplicable.
            if keys.contains(where: { descriptor.field($0) == nil }) { return true }
            if keys.contains(where: { key in
                descriptor.field(key).flatMap { NativePresentationCoverage.detailHandoff($0) } != nil
            }) {
                return true
            }
            if descriptor.key == .usdaFood {
                return keys.contains { key in
                    guard let value = row.raw[key] else { return false }
                    return value != .null && value.arrayValue?.isEmpty != true
                }
            }
            return FieldsSectionView(descriptor: descriptor, row: row, keys: keys, summary: true)
                .hasVisibleRows
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(slots) { slot in
                SummaryCellContainer(title: slot.title) { cell(slot) }
                    .id(slot)
                    .id("\(descriptor.key.rawValue)|\(row.id)|\(slot.id)")
                    .accessibilityIdentifier("detail.summary.\(slot.id)")
            }
        }
        .buttonStyle(.borderless)
    }

    @ViewBuilder private func cell(_ slot: DetailSummarySlot) -> some View {
        switch slot.kind {
        case .fields(let keys):
            if let missing = keys.first(where: { descriptor.field($0) == nil }) {
                Text("Unsupported summary field: \(missing)").font(.caption).textSelection(.enabled)
            } else if let handoff = keys.compactMap({ key in
                descriptor.field(key).flatMap { NativePresentationCoverage.detailHandoff($0) }
            }).first {
                OpenOnWebButton(target: handoff.target(key: descriptor.key, id: row.id), label: handoff.label)
                    .font(.caption)
            } else if descriptor.key == .usdaFood {
                USDASummaryFields(descriptor: descriptor, row: row, keys: keys)
            } else {
                FieldsSectionView(descriptor: descriptor, row: row, keys: keys, summary: true)
            }
        case .records(let viewKey):
            SummaryRecordsCell(
                source: EntityRef(entity: descriptor.key, id: row.id), viewKey: viewKey)
        case .report(let rawSlot):
            if let reportSlot = ReportSlot.allCases.first(where: { $0.rawValue == rawSlot }) {
                ReportDetailSlot(
                    slot: reportSlot, id: row.id,
                    host: ReportHost(entity: descriptor.key, row: row),
                    shownStatus: row.raw["status"]?.stringValue, compact: true)
            } else {
                Text("Unsupported summary report: \(rawSlot)").font(.caption).textSelection(.enabled)
            }
        case .chart(let viewKey):
            SummarySpendCell(source: EntityRef(entity: descriptor.key, id: row.id), viewKey: viewKey)
        }
    }
}

struct SummaryCellEmpty: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

/// Keep the loader mounted after an empty read so a mutation can make the cell applicable again.
private struct SummaryCellContainer<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    @State private var empty = false

    var body: some View {
        VStack(alignment: .leading, spacing: empty ? 0 : FieldGuideTokens.Space.sm) {
            if !empty {
                Divider()
                Text(title).font(.subheadline.weight(.semibold))
            }
            content()
        }
        .padding(.vertical, empty ? 0 : FieldGuideTokens.Space.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onPreferenceChange(SummaryCellEmpty.self) { empty = $0 }
    }
}

private struct SummaryRecordsCell: View {
    let source: EntityRef
    let viewKey: String
    @Environment(AppModel.self) private var appModel
    @State private var page: ConnectedRecordsOutput?
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            if let page, page.totalCount > 0 {
                Text("\(page.totalCount) total").font(.caption).foregroundStyle(.secondary)
                ForEach(page.items, id: \.target.entityId) { ConnectedRecordRow(item: $0) }
                if page.totalCount > page.items.count {
                    NavigationLink(value: Route.connectedRecords(source, viewKey: viewKey)) {
                        Text("\(page.totalCount - page.items.count) more")
                            .frame(minHeight: FieldGuideTokens.touchTarget)
                    }
                }
            }
            if let failure {
                InlineLoadFailure(message: failure) { await load() }
            } else if page == nil {
                LoadingIndicator(label: "Loading connected records")
            }
        }
        .preference(key: SummaryCellEmpty.self, value: page?.totalCount == 0 && failure == nil)
        .task(id: "\(source.stableKey)|\(viewKey)|\(appModel.entityMutationRevision)") { await load() }
    }

    private func load() async {
        do {
            let next = try await appModel.client.connectedRecords(source: source, viewKey: viewKey, limit: 3)
            try Task.checkCancellation()
            page = next
            failure = nil
        } catch {
            guard !Task.isCancelled else { return }
            Diagnostics.report(error, context: "detail.summary.records")
            failure = error.userMessage
        }
    }
}

private struct SummarySpendCell: View {
    let source: EntityRef
    let viewKey: String
    @Environment(AppModel.self) private var appModel
    @State private var points: MonthlyExpenseSpendOutput?
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            if let points { MonthlyExpenseSpendChart(points: points) }
            if let failure {
                InlineLoadFailure(message: failure) { await load() }
            } else if points == nil {
                LoadingIndicator(label: "Loading monthly spend")
            }
        }
        .task(id: "\(source.stableKey)|\(viewKey)|\(appModel.entityMutationRevision)") { await load() }
    }

    private func load() async {
        do {
            let next = try await appModel.client.monthlyExpenseSpend(
                .init(
                    source: EntityGraphRootInput(entityKind: source.entity, entityId: source.id),
                    viewKey: viewKey))
            try Task.checkCancellation()
            points = next
            failure = nil
        } catch {
            guard !Task.isCancelled else { return }
            Diagnostics.report(error, context: "detail.summary.chart")
            failure = error.userMessage
        }
    }
}

#Preview("Summary cells") {
    NavigationStack {
        ScrollView {
            DetailSummaryGrid(descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow)
                .padding(FieldGuideTokens.Space.md)
        }
    }
    .environment(PreviewFixtures.signedInModel())
}
