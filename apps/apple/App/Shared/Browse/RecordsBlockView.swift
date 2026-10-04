import CubbyKit
import SwiftUI

/// The record a report slot belongs to, so a `records` block's verbs have something to act on.
struct ReportHost {
    let entity: EntityKey
    let row: EntityRow
    /// Runs after a verb changed the record, so the screen reloads what it shows.
    var onChanged: () -> Void = {}
}

/// One server-composed row: an optional thumbnail, the title, a worded second line, badges, the
/// trailing figure and instant. Opens the record it names.
struct RecordRowView: View {
    let row: ReportPresentation.RecordRow
    var large = false

    var body: some View {
        if let entity = row.entity, let id = row.recordID {
            NavigationLink(value: Route.entityDetail(entity, id: id)) { content }
        } else {
            content
        }
    }

    private var content: some View {
        HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
            if let url = row.imageURL {
                Thumb(
                    url: url, size: large ? 112 : 48,
                    symbol: row.entity.map { EntityCatalog[$0].sfSymbol } ?? "photo")
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                if let subtitle = row.subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.fieldGuideLabel).foregroundStyle(.secondary)
                }
                ForEach(row.badges, id: \.self) { badge in
                    Label(badge, systemImage: "exclamationmark.triangle")
                        .font(.fieldGuideLabel).foregroundStyle(.orange)
                }
            }
            Spacer(minLength: FieldGuideTokens.Space.sm)
            VStack(alignment: .trailing, spacing: 2) {
                // A trailing figure that links to a list is shown by the row's own link instead.
                if row.listLink == nil, let trailing = row.trailing, !trailing.isEmpty {
                    Text(trailing).font(.fieldGuideLabel).foregroundStyle(.secondary)
                }
                if let at = row.at {
                    Text(at.formatted(date: .abbreviated, time: .shortened))
                        .font(.fieldGuideLabel).foregroundStyle(.secondary)
                }
            }
            .multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A `records` report block: the server's rows and the slot's declared verbs, which the one
/// generic hero-action runner executes from their plans. Nothing here is per entity: the server
/// says which rows and which verbs; the plans say which operations.
struct RecordsBlockView: View {
    let records: ReportPresentation.Records
    let host: ReportHost?

    @Environment(AppModel.self) private var appModel
    @State private var action: HeroActionModel?
    @State private var staged: StagedEdit?
    @State private var notice: String?
    @State private var busy = false

    /// An update editor a verb opened with a derived value staged for review.
    private struct StagedEdit: Identifiable {
        let id = UUID()
        let entity: EntityKey
        let recordID: String
        let values: [String: JSONValue]
    }

    private func plans(
        _ actions: [CollectionActionID], scope: CollectionActionScope
    ) -> [(CollectionActionID, HeroActionPlan)] {
        guard let host else { return [] }
        return actions.compactMap { id in
            guard id.scope == scope, let plan = HeroActionRunner.plan(for: id, on: host.entity) else {
                return nil
            }
            return (id, plan)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if let title = records.title { Eyebrow(title) }
            ForEach(plans(records.actions, scope: .section), id: \.0) { id, plan in
                actionButton(id, plan, itemID: nil)
            }
            if records.rows.isEmpty {
                Text(records.empty).foregroundStyle(.secondary)
            }
            ForEach(records.rows) { row in
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    RecordRowView(row: row, large: records.largeThumbnails)
                    if let link = row.listLink, let trailing = row.trailing {
                        NavigationLink(value: Route.entityList(link.entity, filters: link.filterState)) {
                            Label(trailing, systemImage: "list.bullet").font(.fieldGuideLabel)
                        }
                    }
                    ForEach(plans(row.actions, scope: .row), id: \.0) { id, plan in
                        if let itemID = row.recordID { actionButton(id, plan, itemID: itemID) }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(item: $action) { model in
            HeroActionSheet(model: model) { outcome in finish(outcome) }
                .environment(appModel)
        }
        .sheet(item: $staged) { edit in
            EntityEditorSheet(
                key: edit.entity, mode: .update(id: edit.recordID), original: host?.row.raw,
                stagedValues: edit.values
            ) { _ in host?.onChanged() }
            .environment(appModel)
        }
        .alert(notice ?? "", isPresented: noticeBinding) { Button("OK") {} }
    }

    @ViewBuilder private func actionButton(
        _ id: CollectionActionID, _ plan: HeroActionPlan, itemID: String?
    ) -> some View {
        if let host, let reason = HeroActionRunner.unmet(plan, in: host.row.raw) {
            Label(reason, systemImage: "info.circle").font(.fieldGuideLabel).foregroundStyle(.secondary)
        } else {
            Button(plan.label, systemImage: plan.symbol) { start(plan, itemID: itemID) }
                // Several tappable things share one list row: each must take only its own tap.
                .buttonStyle(.borderless)
                .disabled(busy)
                .accessibilityIdentifier("report.\(id.rawValue)")
        }
    }

    private var noticeBinding: Binding<Bool> {
        Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
    }

    private func start(_ plan: HeroActionPlan, itemID: String?) {
        guard let host else { return }
        let runner = HeroActionRunner(client: appModel.client)
        guard plan.runsOnTap else {
            action = HeroActionModel(
                plan: plan, entity: host.entity, row: host.row, itemID: itemID, runner: runner)
            return
        }
        // No form and nothing destructive: one explicit tap runs it. The flag flips before the
        // task is scheduled so a second tap cannot start a second request.
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                finish(
                    try await runner.perform(
                        plan, on: host.entity, row: host.row, itemID: itemID, values: [:], confirmed: false))
            } catch {
                Diagnostics.report(error, context: "report.recordsAction")
                notice = error.userMessage
            }
        }
    }

    private func finish(_ outcome: HeroActionOutcome) {
        switch outcome {
        case .completed(let message, let changed):
            appModel.recordEntityMutation(keys: changed)
            notice = message
            host?.onChanged()
        case .editRecord(let entity, let id, let values):
            staged = StagedEdit(entity: entity, recordID: id, values: values)
        case .editor:
            // Only hero verbs open a create editor; no records verb has such a plan.
            break
        }
    }
}
