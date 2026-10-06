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
    /// Runs the row's commands (a run's approve, apply, dismiss); nil where none are offered.
    var model: ReportSlotModel?

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
                extras
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

    /// Toned status chips, lines, the raw block and commands a row carries beyond its title.
    @ViewBuilder private var extras: some View {
        if !row.statuses.isEmpty {
            HStack(spacing: FieldGuideTokens.Space.xs) {
                ForEach(Array(row.statuses.enumerated()), id: \.offset) { _, status in
                    StatusChip(text: status.label, tone: status.tone?.chipTone ?? .neutral)
                }
            }
        }
        ForEach(Array(row.lines.enumerated()), id: \.offset) { _, line in
            Text(line.text).font(.caption).foregroundStyle(line.tone?.color ?? Color.primary)
                .textSelection(.enabled)
        }
        if let label = row.detailLabel, let text = row.detailText {
            DisclosureGroup(label) {
                Text(text).font(.caption.monospaced()).textSelection(.enabled)
            }
            .font(.caption)
        }
        if let label = row.externalLinkLabel, let url = row.externalLinkURL {
            Link(label, destination: url).font(.fieldGuideLabel).frame(minHeight: 44)
        }
        if let model, !row.commands.isEmpty {
            ReportCommandBar(commands: row.commands, model: model)
        }
    }
}

/// The commands the server offers on a row or a whole block. One with a declared confirmation
/// asks first; one with inputs opens a form for them first; the rest act on the tap. Nothing is
/// sent from a label: the model runs the exact request the server composed, plus only what the
/// person entered.
struct ReportCommandBar: View {
    let commands: [ReportCommand]
    let model: ReportSlotModel
    @State private var confirming: ReportCommand?
    @State private var draft: ReportCommandDraft?

    var body: some View {
        // Server-worded commands ("Approve import proposal") can be wider than half a phone
        // row: stack them rather than wrapping a label mid-word.
        ViewThatFits(in: .horizontal) {
            HStack { commandButtons }
            VStack(alignment: .leading) { commandButtons }
        }
        .confirmationDialog(
            confirming?.label ?? "", isPresented: confirmingBinding, titleVisibility: .visible,
            presenting: confirming
        ) { command in
            Button(command.label) { Task { await model.run(command, confirmed: true) } }
        } message: { command in
            Text(command.confirm ?? "")
        }
        .sheet(item: $draft) { _ in
            if let binding = Binding($draft) {
                ReportCommandFormSheet(draft: binding, model: model)
                    .nativeSheet(.editor)
            }
        }
    }

    @ViewBuilder private var commandButtons: some View {
        ForEach(commands) { command in
            Button(command.label) { start(command) }
                .buttonStyle(.borderless)
                .fontWeight(command.prominent ? .semibold : .regular)
                .lineLimit(1)
                .disabled(model.busyActionID != nil)
                .accessibilityIdentifier("report.command.\(command.id)")
        }
    }

    private var confirmingBinding: Binding<Bool> {
        Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })
    }

    private func start(_ command: ReportCommand) {
        if !(command.inputs ?? []).isEmpty {
            draft = ReportCommandDraft(command: command)
        } else if command.confirm == nil {
            Task { await model.run(command, confirmed: false) }
        } else {
            confirming = command
        }
    }
}

/// A command's inputs being filled in; each presentation starts from the server's starting values.
struct ReportCommandDraft: Identifiable {
    let id = UUID()
    let command: ReportCommand
    var form: ReportCommandForm

    init(command: ReportCommand) {
        self.command = command
        form = ReportCommandForm(command: command)
    }
}

/// The inputs a command asks for (a number, a record from the picker, one of a few options). Run
/// stays unavailable until every input has a usable answer, and asks the command's confirmation
/// first when it declares one.
struct ReportCommandFormSheet: View {
    @Binding var draft: ReportCommandDraft
    let model: ReportSlotModel
    @Environment(\.dismiss) private var dismiss
    @State private var picking: ReportCommandForm.Field?
    @State private var confirming = false

    var body: some View {
        NavigationStack {
            Form {
                ForEach(draft.form.fields) { field in
                    switch field.kind {
                    case .number:
                        TextField(
                            field.label,
                            text: Binding(
                                get: { draft.form.numberText(field.key) },
                                set: { draft.form.setNumberText(field.key, $0) })
                        )
                        #if os(iOS)
                            .keyboardType(.decimalPad)
                        #endif
                        .accessibilityIdentifier("report.input.\(field.key)")
                    case .record:
                        Button {
                            picking = field
                        } label: {
                            LabeledContent(field.label) {
                                Text(draft.form.title(field.key) ?? "Choose…")
                                    .foregroundStyle(
                                        draft.form.text(field.key) == nil
                                            ? Color.secondary : FieldGuideTokens.graphite
                                    )
                                    .lineLimit(1)
                            }
                            .frame(minHeight: FieldGuideTokens.touchTarget)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("report.input.\(field.key)")
                    case .choice(let options):
                        Picker(
                            field.label,
                            selection: Binding(
                                get: { draft.form.text(field.key) },
                                set: { draft.form.setChoice(field.key, $0) })
                        ) {
                            ForEach(options) { option in
                                Text(option.label).tag(Optional(option.value))
                            }
                        }
                        .accessibilityIdentifier("report.input.\(field.key)")
                    }
                }
                if !draft.form.isComplete {
                    Text("Still needed: \(draft.form.missing.joined(separator: ", "))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error = model.actionError {
                    Text(error).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
                }
            }
            .navigationTitle(draft.command.label)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(draft.command.label) {
                        if draft.command.confirm == nil { run() } else { confirming = true }
                    }
                    .disabled(!draft.form.isComplete || model.busyActionID != nil)
                    .accessibilityIdentifier("report.input.run")
                }
            }
            .confirmationDialog(
                draft.command.label, isPresented: $confirming, titleVisibility: .visible
            ) {
                Button(draft.command.label) { run() }
            } message: {
                Text(draft.command.confirm ?? "")
            }
            .sheet(item: $picking) { field in
                if case .record(let entity) = field.kind, let target = EntityKey(rawValue: entity) {
                    EntityPickerSheet(
                        target: target, selected: [draft.form.text(field.key)].compactMap { $0 }
                    ) {
                        picks in
                        guard let picked = picks.first else { return }
                        draft.form.setRecord(field.key, id: picked.id, title: picked.title)
                    }
                }
            }
        }
    }

    private func run() {
        let command = draft.command
        let form = draft.form
        Task {
            if await model.run(command, confirmed: true, form: form) != nil { dismiss() }
        }
    }
}

extension ReportPresentation.Tone {
    fileprivate var chipTone: StatusChip.Tone {
        switch self {
        case .positive: .positive
        case .warning: .warning
        case .destructive: .destructive
        case .muted: .neutral
        }
    }
}

/// A `records` report block: the server's rows and the slot's declared verbs, which the one
/// generic hero-action runner executes from their plans. Nothing here is per entity: the server
/// says which rows and which verbs; the plans say which operations.
struct RecordsBlockView: View {
    let records: ReportPresentation.Records
    let host: ReportHost?
    /// Runs row commands and shows their outcome; nil where the slot has none.
    var model: ReportSlotModel?

    @Environment(AppModel.self) private var appModel
    @State private var action: HeroActionModel?
    @State private var staged: StagedEdit?
    @State private var reviewing: AIReviewRequest?
    @State private var notice: String?
    @State private var busy = false
    // Finance verbs (`records.verbs`): checked rows, and the flows they open.
    @State private var selection: Set<String> = []
    @State private var statementMatch: StatementMatchSession?
    @State private var receiving: ReceivingModel?
    @State private var splitting: ExpenseSplitSession?
    @State private var linkingExpenses: PurchaseExpenseLinkSession?
    @State private var linkingProducts: PurchaseProductLinkSession?
    @State private var isSearching = false
    @State private var startedRun: String?
    @State private var verbError: String?
    // The answers to the block's choices (a prepared import's per-line decisions).
    @State private var answers = ReportChoiceAnswers()

    /// Exactly the finance verbs `native-coverage.ts` marks `implemented`
    /// (`NativeCoverageViewPathTests` asserts it); `verbButton` runs each.
    static let handledVerbs: Set<SectionActionID> = [
        .searchCharges, .matchStatement, .receiveExpense, .splitExpense, .linkExpenses, .linkProducts,
    ]

    private var offersSelection: Bool {
        records.verbs.contains { Self.handledVerbs.contains($0.verb) && $0.actsOnSelection }
    }

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
            if let title = records.title, !records.rows.isEmpty { Eyebrow(title) }
            ForEach(plans(records.actions, scope: .section), id: \.0) { id, plan in
                actionButton(id, plan, itemID: nil)
            }
            if records.rows.isEmpty, !records.empty.isEmpty {
                Text(records.empty).foregroundStyle(.secondary)
            }
            ForEach(records.rows) { row in
                HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
                    if offersSelection, let key = row.key {
                        Button {
                            selection = records.toggled(selection, key)
                        } label: {
                            Image(systemName: selection.contains(key) ? "checkmark.circle.fill" : "circle")
                        }
                        .buttonStyle(.borderless)
                        .disabled(row.disabledReason != nil)
                        .accessibilityLabel("Select \(row.title)")
                        .accessibilityAddTraits(selection.contains(key) ? .isSelected : [])
                    }
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        RecordRowView(row: row, large: records.largeThumbnails, model: model)
                        if let choice = row.choice {
                            ReportChoiceView(
                                choice: choice, answers: $answers, disabled: model?.busyActionID != nil)
                        }
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
            if let footer = records.footer {
                Divider()
                Text(footer).font(.subheadline).foregroundStyle(.secondary)
            }
            if let model, !records.commands.isEmpty {
                ReportCommandBar(commands: records.commands, model: model)
            }
            if let form = records.form, let model {
                ReportFormFooterView(
                    form: form, rowChoices: records.rowChoices, answers: $answers, model: model)
            }
            verbs
        }
        // A fresh read (a run claimed a charge) drops any checked row the server now refuses.
        .onChange(of: records) { _, fresh in selection = fresh.allowed(selection) }
        .sheet(item: $statementMatch) { session in
            StatementMatchSheet(session: session) {
                appModel.recordEntityMutation(keys: [.financialTransaction, .purchase])
            }
            .nativeSheet(.editor)
        }
        .sheet(item: $receiving) { model in
            ReceiveExpenseSheet(model: model)
        }
        .sheet(item: $splitting) { session in
            SplitExpenseSheet(session: session) { splitSaved() }
                .environment(appModel)
                .nativeSheet(.editor)
        }
        .sheet(item: $linkingExpenses) { session in
            LinkExpensesSheet(session: session) { attachSaved() }
                .environment(appModel)
                .nativeSheet(.editor)
        }
        .sheet(item: $linkingProducts) { session in
            LinkProductsSheet(session: session) { attachSaved() }
                .environment(appModel)
                .nativeSheet(.editor)
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
        .sheet(item: $reviewing) { request in
            AIReviewSheet(review: request.review)
                .nativeSheet(.preview)
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

    @ViewBuilder private var verbs: some View {
        ForEach(records.verbs.filter { Self.handledVerbs.contains($0.verb) }) { verb in
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                verbButton(verb)
                if let reason = verb.disabledReason {
                    Text(reason).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        if let verbError {
            Text(verbError).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
        }
        if let startedRun {
            NavigationLink(value: Route.entityDetail(.run, id: startedRun)) {
                Label("View charge search", systemImage: "arrow.up.right.square")
            }
        }
        let unsupported = records.verbs.compactMap { verb -> String? in
            if case .unsupported(let reason) = SectionActionRunner.coverage(of: verb.verb) { return reason }
            return nil
        }
        if let host, !unsupported.isEmpty {
            ForEach(unsupported, id: \.self) { reason in
                Text(reason).font(.caption).foregroundStyle(.secondary)
            }
            Link("Open on web", destination: appModel.webURL(for: host.entity, id: host.row.id))
                .font(.caption)
        }
    }

    @ViewBuilder
    private func verbButton(_ verb: ReportPresentation.Records.Verb) -> some View {
        switch verb.verb {
        case .searchCharges:
            Button {
                Task { await searchCharges() }
            } label: {
                Text(isSearching ? "Starting search…" : "\(verb.label) (\(selection.count))")
            }
            .disabled(selection.isEmpty || isSearching || verb.disabledReason != nil)
            .accessibilityIdentifier("section.searchCharges")
        case .matchStatement:
            Button(verb.label) {
                verbError = nil
                if let host {
                    statementMatch = StatementMatchSession(purchaseID: host.row.id, client: appModel.client)
                }
            }
            .disabled(verb.disabledReason != nil || host == nil)
            .accessibilityIdentifier("section.matchStatement")
        case .receiveExpense:
            let productID = host?.row.raw["productId"]?.stringValue
            Button {
                guard let host, let productID else { return }
                receiving = ReceivingModel(
                    expenseID: host.row.id, productID: ProductCode(productID), service: appModel.client)
            } label: {
                Label("Receive into Inventory", systemImage: "tray.and.arrow.down")
            }
            .disabled(verb.disabledReason != nil || productID == nil)
            .accessibilityIdentifier("receive.open.\(host?.row.id ?? "")")
        case .splitExpense:
            Button(verb.label) {
                open {
                    try $0.splitSession(expenseID: $1, records: records)
                } assign: {
                    splitting = $0
                }
            }
            .disabled(verb.disabledReason != nil || host == nil)
            .accessibilityIdentifier("section.splitExpense")
        case .linkExpenses:
            Button(verb.label) {
                open {
                    try $0.expenseLinkSession(purchaseID: $1, records: records)
                } assign: {
                    linkingExpenses = $0
                }
            }
            .disabled(verb.disabledReason != nil || host == nil)
            .accessibilityIdentifier("section.linkExpenses")
        case .linkProducts:
            Button(verb.label) {
                open {
                    try $0.productLinkSession(purchaseID: $1, records: records)
                } assign: {
                    linkingProducts = $0
                }
            }
            .disabled(verb.disabledReason != nil || host == nil)
            .accessibilityIdentifier("section.linkProducts")
        }
    }

    /// Opens a verb's session on the record this report belongs to. The runner throws, sending
    /// nothing, unless the server offers the verb available.
    private func open<Session>(
        _ make: (SectionActionRunner, String) throws -> Session, assign: (Session) -> Void
    ) {
        guard let host else { return }
        verbError = nil
        do {
            assign(try make(SectionActionRunner(client: appModel.client), host.row.id))
        } catch let error as SectionActionError {
            verbError =
                switch error {
                case .unavailable(let reason), .refusedSelection(let reason), .unsupported(let reason):
                    reason
                case .nothingSelected: "Check at least one row first."
                }
        } catch {
            verbError = error.userMessage
        }
    }

    /// The parts replaced the expense, so leave its screen for the purchase they were filed under.
    private func splitSaved() {
        appModel.recordEntityMutation(keys: [.expense, .purchase, .product])
        if let purchaseID = host?.row.raw["purchaseId"]?.stringValue {
            appModel.navigator.replaceCurrentRecord(
                with: RecordSelection(key: .purchase, id: purchaseID))
        } else {
            host?.onChanged()
        }
    }

    private func attachSaved() {
        appModel.recordEntityMutation(keys: [.purchase, .expense, .product])
        host?.onChanged()
    }

    private func searchCharges() async {
        guard let host else { return }
        isSearching = true
        verbError = nil
        defer { isSearching = false }
        do {
            startedRun = try await SectionActionRunner(client: appModel.client).searchCharges(
                vendorAccountID: host.row.id, records: records, selection: selection)
            selection = []
            appModel.recordEntityMutation(keys: [.vendorAccount, .run])
        } catch let error as SectionActionError {
            verbError =
                switch error {
                case .unavailable(let reason), .refusedSelection(let reason), .unsupported(let reason):
                    reason
                case .nothingSelected: "Check at least one charge first."
                }
        } catch {
            Diagnostics.report(error, context: "Start charge search")
            verbError = error.userMessage
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
        case .review(let review):
            appModel.recordEntityMutation(keys: review.changed)
            host?.onChanged()
            reviewing = AIReviewRequest(review: review)
        case .editor:
            // Only hero verbs open a create editor; no records verb has such a plan.
            break
        }
    }
}

/// A review waiting to be read; each analysis is its own presentation.
private struct AIReviewRequest: Identifiable {
    let id = UUID()
    let review: HeroActionReview
}
