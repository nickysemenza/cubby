import CubbyAPISupport
import CubbyKit
import SwiftUI

/// Runs a list row's placed actions (`ActionPlacement`): swipes, context menu, row command and
/// the swipe's More. Declared verbs, flows and handoffs go to the shared `RecordActionPresenter`,
/// which owns forms, confirmations, native flows and web handoffs for list and detail alike; this
/// runner adds only the row's kernel actions (Edit, Select, Copy link, Open on web, More). The
/// list refreshes from the recorded mutation.
@MainActor @Observable
final class EntityRowActionRunner {
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

    /// The plan router for the list's entity, made on first use.
    private(set) var actions: RecordActionPresenter?
    var more: MoreMenu?
    var editing: EditingRecord?
    var flowRoute: Route?

    var busy: Bool { actions?.isBusy ?? false }

    func run(
        _ action: PlacedAction, key: EntityKey, row: EntityRow, appModel: AppModel,
        openURL: OpenURLAction, select: (EntityRow) -> Void
    ) {
        guard action.enabled else { return }
        switch action.kind {
        case .plan(let plan):
            presenter(for: key).start(plan, row: row, appModel: appModel) { _, _ in }
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

    private func presenter(for key: EntityKey) -> RecordActionPresenter {
        if let actions, actions.entity == key { return actions }
        let presenter = RecordActionPresenter(
            entity: key, showsNotice: false, navigate: { [weak self] in self?.flowRoute = $0 })
        actions = presenter
        return presenter
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

/// A row command's glyph: the verb in ink when it can run, the filled check once the record
/// already carries its write (a done task), and the same verb dimmed while unavailable, so an
/// unavailable command never reads as done. Every state keeps the 44-point slot.
struct RowCommandGlyph: View {
    let action: PlacedAction

    var body: some View {
        Group {
            if action.isApplied {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.secondary)
            } else {
                Image(systemName: action.symbol)
                    .foregroundStyle(action.enabled ? FieldGuideTokens.interaction : Color.secondary)
                    .opacity(action.enabled ? 1 : 0.4)
            }
        }
        .font(.title3)
        .frame(width: FieldGuideTokens.touchTarget, height: FieldGuideTokens.touchTarget)
        .contentShape(Rectangle())
    }

    /// The spoken reason an unavailable command cannot run; nothing when it can, or once applied.
    static func hint(_ action: PlacedAction) -> String {
        guard !action.enabled, !action.isApplied else { return "" }
        return ["\(action.label) unavailable", action.reason].compactMap { $0 }.joined(separator: ": ")
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
            RowCommandGlyph(action: action)
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
            .recordActionPresentation(runner.actions, onFinished: { _, _ in })
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
    }
}
