import CubbyAPISupport
import CubbyKit
import SwiftUI

/// Runs a list row's placed actions (`ActionPlacement`): swipes, context menu, row command and
/// the swipe's More. Preset writes run on the tap; a destructive verb without inputs asks once in
/// a native confirmation dialog; anything else that needs input opens the hero sheet; native flows
/// and web handoffs open their own surfaces. The list refreshes from the recorded mutation.
@MainActor @Observable
final class EntityRowActionRunner {
    struct Pending: Identifiable {
        let action: PlacedAction
        let plan: HeroActionPlan
        let key: EntityKey
        let row: EntityRow
        var id: String { "\(action.id).\(row.id)" }
    }

    struct EditingRecord: Identifiable {
        let key: EntityKey
        let id: String
    }

    struct MoreMenu: Identifiable {
        let key: EntityKey
        let row: EntityRow
        let actions: [PlacedAction]
        var id: String { row.id }
    }

    var sheet: HeroActionModel?
    var confirming: Pending?
    var more: MoreMenu?
    var receiving: ReceivingModel?
    var editing: EditingRecord?
    var flowRoute: Route?
    var failure: String?
    private(set) var busy = false

    func run(
        _ action: PlacedAction, key: EntityKey, row: EntityRow, appModel: AppModel,
        openURL: OpenURLAction, select: (EntityRow) -> Void
    ) {
        guard action.enabled else { return }
        switch action.kind {
        case .plan(let plan):
            start(plan, action: action, key: key, row: row, appModel: appModel, openURL: openURL)
        case .edit: editing = EditingRecord(key: key, id: row.id)
        case .select: select(row)
        case .copyLink:
            Clipboard.copy(appModel.webHandoff.url(.record(key: key, id: row.id)).absoluteString)
        case .openOnWeb: openURL(appModel.webHandoff.url(.record(key: key, id: row.id)))
        case .more:
            more = MoreMenu(
                key: key, row: row,
                actions: ActionPlacement(entity: EntityCatalog[key], row: row).contextMenu.joined()
                    .filter { action in
                        switch action.kind {
                        case .share, .select: false
                        default: true
                        }
                    })
        case .share, .bulkEdit, .merge, .quickField, .addPhoto:
            // Share renders as a ShareLink; selection and detail kinds never reach a row.
            break
        }
    }

    private func start(
        _ plan: HeroActionPlan, action: PlacedAction, key: EntityKey, row: EntityRow, appModel: AppModel,
        openURL: OpenURLAction
    ) {
        switch plan.kind {
        case .flow(.receiveExpense, let requires):
            let path = requires?.path ?? "productId"
            guard let productID = (row.raw.recordValue(path) ?? row.raw.pathValue(path))?.stringValue else {
                return
            }
            receiving = ReceivingModel(
                expenseID: row.id, productID: ProductCode(productID), service: appModel.client)
            return
        case .flow(.locationPhotoPass, _):
            flowRoute = .locationPhotoPass(scope: LocationCode(row.id))
            return
        case .handoff(let section, _):
            openURL(appModel.webHandoff.url(.record(key: key, id: row.id, section: section)))
            return
        default: break
        }
        if plan.confirmation == .destructive, plan.fields.isEmpty {
            confirming = Pending(action: action, plan: plan, key: key, row: row)
            return
        }
        let runner = HeroActionRunner(client: appModel.client)
        if case .toggleField = plan.kind {
            perform(plan, key: key, row: row, confirmed: false, appModel: appModel)
        } else if plan.runsOnTap {
            perform(plan, key: key, row: row, confirmed: false, appModel: appModel)
        } else {
            sheet = HeroActionModel(plan: plan, entity: key, row: row, runner: runner)
        }
    }

    func confirm(_ pending: Pending, appModel: AppModel) {
        perform(pending.plan, key: pending.key, row: pending.row, confirmed: true, appModel: appModel)
    }

    private func perform(
        _ plan: HeroActionPlan, key: EntityKey, row: EntityRow, confirmed: Bool, appModel: AppModel
    ) {
        // The flag flips before the task is scheduled so a second tap cannot start a second write.
        guard !busy else { return }
        busy = true
        let runner = HeroActionRunner(client: appModel.client)
        Task {
            defer { busy = false }
            do {
                finish(
                    try await runner.perform(plan, on: key, row: row, values: [:], confirmed: confirmed),
                    appModel: appModel)
            } catch {
                Diagnostics.report(error, context: "list.rowAction")
                failure = error.userMessage
            }
        }
    }

    func finish(_ outcome: HeroActionOutcome, appModel: AppModel) {
        if case .completed(_, let changed) = outcome { appModel.recordEntityMutation(keys: changed) }
    }
}

/// One placed action as a menu or swipe item. Share is a `ShareLink`; everything else runs
/// through the row runner. Destructive items are tinted, never given the destructive role in a
/// swipe, so the row stays put until the confirmation is answered.
struct PlacedActionItem: View {
    let action: PlacedAction
    let key: EntityKey
    let row: EntityRow
    let runner: EntityRowActionRunner
    var onSelect: (EntityRow) -> Void = { _ in }
    var inSwipe = false

    @Environment(AppModel.self) private var appModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        if case .share = action.kind {
            ShareLink(item: appModel.webHandoff.url(.record(key: key, id: row.id)))
        } else {
            Button(role: action.isDestructive && !inSwipe ? .destructive : nil) {
                runner.run(action, key: key, row: row, appModel: appModel, openURL: openURL, select: onSelect)
            } label: {
                Label(action.label, systemImage: action.symbol)
            }
            .tint(tint)
            .disabled(!action.enabled || (runner.busy && isWrite))
            .accessibilityIdentifier("browse.\(key.rawValue).action.\(action.id).\(row.id)")
        }
    }

    private var isWrite: Bool { if case .plan = action.kind { true } else { false } }

    private var tint: Color {
        if action.isDestructive { return FieldGuideTokens.destructive }
        if case .more = action.kind { return Color.gray }
        return FieldGuideTokens.interaction
    }
}

/// A row's context menu groups: declared verbs, Edit and Select, copy/share/web, destructive last.
struct EntityRowContextMenu: View {
    let placement: ActionPlacement
    let key: EntityKey
    let row: EntityRow
    let runner: EntityRowActionRunner
    var onSelect: (EntityRow) -> Void = { _ in }

    var body: some View {
        ForEach(Array(placement.contextMenu.enumerated()), id: \.offset) { _, group in
            Section {
                ForEach(group) { action in
                    PlacedActionItem(action: action, key: key, row: row, runner: runner, onSelect: onSelect)
                    if case .copyLink = action.kind {
                        Button("Copy shortcode", systemImage: "number") { Clipboard.copy(row.id) }
                    }
                }
            }
        }
    }
}

/// `list.rowCommand`: a 44-point leading control beside the row's link, never inside it. It
/// stays in place while unavailable so rows keep their alignment.
struct RowCommandButton: View {
    let action: PlacedAction
    let key: EntityKey
    let row: EntityRow
    let runner: EntityRowActionRunner

    @Environment(AppModel.self) private var appModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            runner.run(action, key: key, row: row, appModel: appModel, openURL: openURL, select: { _ in })
        } label: {
            Image(systemName: action.enabled ? action.symbol : "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(action.enabled ? FieldGuideTokens.interaction : Color.secondary)
                .frame(width: FieldGuideTokens.touchTarget, height: FieldGuideTokens.touchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(!action.enabled || runner.busy)
        .help(action.reason ?? action.label)
        // The row's one combined element offers the command as a named action instead.
        .accessibilityHidden(true)
        .accessibilityIdentifier("browse.\(key.rawValue).command.\(action.id).\(row.id)")
    }
}

extension View {
    /// Presents an entity row runner's sheets, confirmation, More menu, flows and failure.
    func entityRowActionHost(_ runner: EntityRowActionRunner) -> some View {
        modifier(EntityRowActionHost(runner: runner))
    }
}

private struct EntityRowActionHost: ViewModifier {
    @Bindable var runner: EntityRowActionRunner
    @Environment(AppModel.self) private var appModel
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        content
            .sheet(item: $runner.sheet) { action in
                HeroActionSheet(model: action) { outcome in runner.finish(outcome, appModel: appModel) }
                    .environment(appModel)
            }
            .sheet(item: $runner.receiving) { model in
                ReceiveExpenseSheet(model: model).environment(appModel)
            }
            .sheet(item: $runner.editing) { record in
                EntityEditorSheet(key: record.key, mode: .update(id: record.id)) { _ in
                    appModel.recordEntityMutation(keys: [record.key])
                }
                .environment(appModel)
            }
            .navigationDestination(item: $runner.flowRoute) { route in
                RouteDestinationView(route: route)
            }
            .confirmationDialog(
                runner.confirming.map { "\($0.action.label) \($0.row.title)?" } ?? "",
                isPresented: Binding(
                    get: { runner.confirming != nil }, set: { if !$0 { runner.confirming = nil } }),
                titleVisibility: .visible, presenting: runner.confirming
            ) { pending in
                Button(pending.action.label, role: .destructive) {
                    runner.confirm(pending, appModel: appModel)
                }
                .accessibilityIdentifier("browse.confirm.\(pending.action.id)")
            } message: { pending in
                if case .delete = pending.plan.kind {
                    Text("This can't be undone.")
                }
            }
            .confirmationDialog(
                runner.more?.row.title ?? "",
                isPresented: Binding(get: { runner.more != nil }, set: { if !$0 { runner.more = nil } }),
                titleVisibility: .visible, presenting: runner.more
            ) { menu in
                ForEach(menu.actions) { action in
                    Button(action.label, role: action.isDestructive ? .destructive : nil) {
                        runner.run(
                            action, key: menu.key, row: menu.row, appModel: appModel, openURL: openURL,
                            select: { _ in })
                    }
                }
            }
            .alert(
                "Couldn't finish",
                isPresented: Binding(
                    get: { runner.failure != nil }, set: { if !$0 { runner.failure = nil } }),
                presenting: runner.failure
            ) { _ in
                Button("OK") {}
            } message: { failure in
                Text(failure)
            }
    }
}
