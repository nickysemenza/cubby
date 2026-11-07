import CubbyAPISupport
import CubbyKit
import SwiftUI

#if os(macOS)
    import AppKit
#endif

// MARK: - Running a record's actions

/// Runs one record's declared actions (`HeroActionPlan`s): one-tap writes directly, forms in
/// `HeroActionSheet`, Delete and other input-free destructive verbs behind one native
/// confirmation, native flows in their own screens, and web handoffs in the browser. It is the
/// one router for plans: the detail screen, nested relation-row commands and list rows (swipes,
/// context menu, row command) all start plans here, so a verb behaves the same everywhere.
@MainActor
@Observable
final class RecordActionPresenter {
    struct Confirmation: Identifiable {
        let id = UUID()
        let plan: HeroActionPlan
        let row: EntityRow
    }

    struct EditorRequest: Identifiable {
        let id = UUID()
        let entity: EntityKey
        let prefill: [String: JSONValue]
        let context: HeroEditorContext?
    }

    let entity: EntityKey
    /// Row commands stay quiet; the detail screen confirms a write with its message.
    let showsNotice: Bool
    /// Where a native flow's screen opens; nil pushes onto the app navigator's stack. A list
    /// passes its own destination so the flow opens in the stack (or sheet) that hosts it.
    private let navigate: (@MainActor (Route) -> Void)?
    var form: HeroActionModel?
    var receiving: ReceivingModel?
    var confirmation: Confirmation?
    var editor: EditorRequest?
    var notice: String?
    private(set) var isBusy = false

    init(
        entity: EntityKey, showsNotice: Bool = true, navigate: (@MainActor (Route) -> Void)? = nil
    ) {
        self.entity = entity
        self.showsNotice = showsNotice
        self.navigate = navigate
    }

    func start(
        _ plan: HeroActionPlan, row: EntityRow, appModel: AppModel,
        onFinished: @escaping @MainActor (HeroActionPlan, HeroActionOutcome) -> Void
    ) {
        let runner = HeroActionRunner(client: appModel.client)
        switch plan.kind {
        case .delete:
            confirmation = Confirmation(plan: plan, row: row)
        case .operation(let operation)
        where plan.confirmation == .destructive && operation.fields.isEmpty && operation.preview == nil:
            confirmation = Confirmation(plan: plan, row: row)
        case .flow(let flow, let requires):
            switch flow {
            case .receiveExpense:
                // The flow's declared requirement names the linked Product it receives into.
                let path = requires?.path ?? "productId"
                guard let productID = (row.raw.recordValue(path) ?? row.raw.pathValue(path))?.stringValue
                else { return }
                receiving = ReceivingModel(
                    expenseID: row.id, productID: ProductCode(productID), service: appModel.client)
            case .locationPhotoPass:
                let route = Route.locationPhotoPass(scope: LocationCode(row.id))
                if let navigate { navigate(route) } else { appModel.navigator.push(route) }
            }
        case .handoff(let section, _):
            Self.open(appModel.webHandoff.url(.record(key: entity, id: row.id, section: section)))
        case .toggleField, .create:
            run(plan, row: row, appModel: appModel, confirmed: false, onFinished: onFinished)
        case .operation, .setField, .editField:
            // No input and nothing destructive (a preset field write, a form-less operation):
            // one explicit tap runs it. Anything else asks in the form.
            if plan.runsOnTap {
                run(plan, row: row, appModel: appModel, confirmed: false, onFinished: onFinished)
            } else {
                form = HeroActionModel(plan: plan, entity: entity, row: row, runner: runner)
            }
        }
    }

    func run(
        _ plan: HeroActionPlan, row: EntityRow, appModel: AppModel, confirmed: Bool,
        onFinished: @escaping @MainActor (HeroActionPlan, HeroActionOutcome) -> Void
    ) {
        // The flag flips before the task is scheduled so a second tap cannot start a second write.
        guard !isBusy else { return }
        isBusy = true
        let runner = HeroActionRunner(client: appModel.client)
        Task {
            defer { isBusy = false }
            do {
                let outcome = try await runner.perform(
                    plan, on: entity, row: row, values: [:], confirmed: confirmed)
                finish(plan, outcome, appModel: appModel, onFinished: onFinished)
            } catch {
                Diagnostics.report(error, context: "detail.heroAction")
                appModel.handle(error)
            }
        }
    }

    func finish(
        _ plan: HeroActionPlan, _ outcome: HeroActionOutcome, appModel: AppModel,
        onFinished: @MainActor (HeroActionPlan, HeroActionOutcome) -> Void
    ) {
        switch outcome {
        case .completed(let message, let changed):
            appModel.recordEntityMutation(keys: changed)
            if showsNotice, plan.kind != .delete { notice = message }
        case .editor(let entity, let prefill, let context):
            editor = EditorRequest(entity: entity, prefill: prefill, context: context)
        case .editRecord, .review:
            // Only a report `records` verb stages an edit or an AI review (`RecordsBlockView`
            // opens them); no record verb has such a plan.
            break
        }
        onFinished(plan, outcome)
    }

    static func open(_ url: URL) {
        #if os(iOS)
            UIApplication.shared.open(url)
        #else
            NSWorkspace.shared.open(url)
        #endif
    }
}

extension View {
    /// The sheets, confirmation and notice a `RecordActionPresenter` drives. The presenter may
    /// arrive after the host appears; the modifiers stay in place so the host keeps its identity.
    func recordActionPresentation(
        _ presenter: RecordActionPresenter?,
        onFinished: @escaping @MainActor (HeroActionPlan, HeroActionOutcome) -> Void,
        onEditorSaved: @escaping () -> Void = {}
    ) -> some View {
        modifier(
            RecordActionPresentation(
                presenter: presenter, onFinished: onFinished, onEditorSaved: onEditorSaved))
    }
}

private struct RecordActionPresentation: ViewModifier {
    let presenter: RecordActionPresenter?
    let onFinished: @MainActor (HeroActionPlan, HeroActionOutcome) -> Void
    let onEditorSaved: () -> Void
    @Environment(AppModel.self) private var appModel

    private func binding<Value>(_ path: ReferenceWritableKeyPath<RecordActionPresenter, Value?>) -> Binding<
        Value?
    > {
        Binding(get: { presenter?[keyPath: path] }, set: { presenter?[keyPath: path] = $0 })
    }

    private func isPresented<Value>(_ path: ReferenceWritableKeyPath<RecordActionPresenter, Value?>)
        -> Binding<Bool>
    {
        Binding(
            get: { presenter?[keyPath: path] != nil }, set: { if !$0 { presenter?[keyPath: path] = nil } })
    }

    func body(content: Content) -> some View {
        content
            .sheet(item: binding(\.form)) { form in
                HeroActionSheet(model: form) { outcome in
                    presenter?.finish(form.plan, outcome, appModel: appModel, onFinished: onFinished)
                }
                .environment(appModel)
            }
            .sheet(
                item: binding(\.receiving),
                onDismiss: {
                    // The receive sheet closes itself after a write; a cancel changes nothing.
                    if let entity = presenter?.entity {
                        appModel.recordEntityMutation(keys: [entity, .product, .inventory])
                    }
                }
            ) { receiving in
                ReceiveExpenseSheet(model: receiving).environment(appModel)
            }
            .sheet(item: binding(\.editor)) { request in
                EntityEditorSheet(
                    key: request.entity, mode: .create(prefill: request.prefill), context: request.context
                ) { _ in onEditorSaved() }
                .environment(appModel)
            }
            .confirmationDialog(
                presenter?.confirmation.map { "\($0.plan.label) \($0.row.title)?" } ?? "",
                isPresented: isPresented(\.confirmation), titleVisibility: .visible,
                presenting: presenter?.confirmation
            ) { confirmation in
                Button(confirmation.plan.label, role: .destructive) {
                    presenter?.run(
                        confirmation.plan, row: confirmation.row, appModel: appModel, confirmed: true,
                        onFinished: onFinished)
                }
                .accessibilityIdentifier("detail.\(confirmation.row.id).confirm")
            } message: { confirmation in
                // No undo: confirming costs one tap, and nothing can restore a deleted record.
                Text(
                    confirmation.plan.kind == .delete
                        ? "This cannot be undone." : "This records the change now.")
            }
            .alert(presenter?.notice ?? "", isPresented: isPresented(\.notice)) { Button("OK") {} }
    }
}

// MARK: - Action bar

/// Up to four tiles under the hero (`ActionPlacement.actionBar`): declared quick actions filled,
/// then routine verbs, flows and quick fields tonal. An unavailable tile stays dimmed and says why
/// when tapped. Destructive verbs never appear here.
struct DetailActionBar: View {
    let entity: EntityKey
    let actions: [PlacedAction]
    var busy = false
    let perform: (PlacedAction) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var unavailableReason: String?

    var body: some View {
        if !actions.isEmpty {
            let layout =
                dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(spacing: FieldGuideTokens.Space.sm))
                : AnyLayout(HStackLayout(spacing: FieldGuideTokens.Space.sm))
            layout {
                ForEach(actions) { action in tile(action) }
            }
            .alert(
                unavailableReason ?? "",
                isPresented: Binding(
                    get: { unavailableReason != nil }, set: { if !$0 { unavailableReason = nil } })
            ) { Button("OK") {} }
        }
    }

    /// Two or fewer tiles read as wide labelled buttons; three or four stack icon over label.
    private var stacked: Bool { actions.count > 2 && !dynamicTypeSize.isAccessibilitySize }

    @ViewBuilder
    private func tile(_ action: PlacedAction) -> some View {
        let button = Button {
            if action.enabled { perform(action) } else { unavailableReason = action.reason ?? "Unavailable" }
        } label: {
            Group {
                if stacked {
                    VStack(spacing: 2) {
                        Image(systemName: action.symbol).imageScale(.medium)
                        Text(action.label).font(.caption.weight(.medium)).lineLimit(2)
                            .multilineTextAlignment(.center)
                    }
                } else {
                    HStack(spacing: FieldGuideTokens.Space.sm) {
                        Image(systemName: action.symbol)
                        Text(action.label).lineLimit(2)
                    }
                }
            }
            .frame(maxWidth: .infinity, minHeight: stacked ? 52 : FieldGuideTokens.touchTarget)
            // The interaction ink flips to near-white in dark mode, so the filled label takes the
            // canvas colour rather than the prominent style's fixed white.
            .foregroundStyle(
                action.prominence == .filled ? AnyShapeStyle(FieldGuideTokens.canvas) : AnyShapeStyle(.tint))
        }
        .opacity(action.enabled ? 1 : 0.45)
        .disabled(busy && action.enabled)
        .accessibilityHint(action.enabled ? "" : (action.reason ?? "Unavailable"))
        .accessibilityValue(action.enabled ? "" : "Unavailable")
        .accessibilityIdentifier("detail.\(entity.rawValue).bar.\(action.id)")
        #if os(macOS)
            .help(action.reason ?? action.label)
        #endif
        if action.prominence == .filled {
            button.buttonStyle(.borderedProminent).tint(FieldGuideTokens.interaction)
        } else {
            button.buttonStyle(.bordered)
        }
    }
}

// MARK: - Menu items

/// One placed action as a menu item: dimmed with the server's reason as its subtitle when
/// unavailable, destructive role for destructive verbs.
struct PlacedActionMenuItem: View {
    let entity: EntityKey
    let action: PlacedAction
    let perform: (PlacedAction) -> Void

    var body: some View {
        Button(role: action.isDestructive ? .destructive : nil) {
            perform(action)
        } label: {
            Label {
                Text(action.label)
                if !action.enabled, let reason = action.reason { Text(reason) }
            } icon: {
                Image(systemName: action.symbol)
            }
        }
        .disabled(!action.enabled)
        .accessibilityIdentifier("detail.\(entity.rawValue).more.\(action.id)")
    }
}

// MARK: - Row command on nested relation rows

/// A related record's `list.rowCommand` beside its relation row, outside the row's link (a
/// subtask's Done). Kept, dimmed, while unavailable so rows stay aligned.
struct RelationRowCommand: View {
    let entity: EntityKey
    let row: EntityRow
    let onChanged: () -> Void

    @Environment(AppModel.self) private var appModel
    @State private var presenter: RecordActionPresenter?

    var body: some View {
        if let command = ActionPlacement(entity: EntityCatalog[entity], row: row).rowCommand,
            case .plan(let plan) = command.kind
        {
            Button {
                presenter?.start(plan, row: row, appModel: appModel) { _, _ in onChanged() }
            } label: {
                RowCommandGlyph(action: command)
            }
            .buttonStyle(.borderless)
            .disabled(!command.enabled || presenter?.isBusy == true)
            .accessibilityLabel(command.label)
            .accessibilityValue(command.isApplied ? "Done" : "")
            .accessibilityHint(RowCommandGlyph.hint(command))
            .accessibilityIdentifier("relation.command.\(entity.rawValue).\(row.id)")
            .recordActionPresentation(
                presenter, onFinished: { _, _ in onChanged() }, onEditorSaved: onChanged
            )
            .onAppear {
                if presenter == nil { presenter = RecordActionPresenter(entity: entity, showsNotice: false) }
            }
        }
    }
}

// MARK: - Mac menu commands

/// The focused record's commands for the menu bar: Edit (⌘E), Delete (⌘⌫, confirmed) and the
/// Actions menu of its placed verbs with availability.
struct RecordCommandActions {
    let title: String
    let edit: (() -> Void)?
    let delete: PlacedAction?
    let actions: [PlacedAction]
    let perform: (PlacedAction) -> Void
}

extension FocusedValues {
    @Entry var recordCommands: RecordCommandActions?
}

// MARK: - Previews

#Preview("Action bar") {
    let descriptor = EntityCatalog[.task]
    List {
        DetailActionBar(
            entity: .task,
            actions: [
                PlacedAction(
                    id: "complete", kind: .copyLink, label: "Done", symbol: "checkmark.circle",
                    prominence: .filled),
                PlacedAction(
                    id: "field.status", kind: .quickField("status"), label: "Status", symbol: "pencil",
                    prominence: .tonal),
                PlacedAction(
                    id: "field.assigneeId", kind: .quickField("assigneeId"),
                    label: descriptor.field("assigneeId")?.label ?? "Assignee", symbol: "pencil",
                    enabled: false, reason: "Assign a household member first.", prominence: .tonal),
            ]
        ) { _ in }
        .listRowBackground(Color.clear)
    }
}
