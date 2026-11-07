import CubbyKit
import SwiftUI

/// A list's multi-selection and the actions `ActionPlacement.selectionBar` offers on it: Bulk
/// edit, Merge (two or more), declared bulk verbs and Delete. A refused write keeps the selection
/// and shows the server's raw diagnostic; a finished one clears it and refreshes the list.
@MainActor @Observable
final class EntitySelectionController {
    struct DeleteRequest: Identifiable {
        let ids: [String]
        var id: String { ids.joined(separator: ",") }
    }

    var isSelecting = false
    var selectedIDs = Set<String>()
    var bulkEdit: EntityBulkEditModel?
    var merge: EntityMergeModel?
    var confirmingDelete: DeleteRequest?
    /// An unavailable bar action's reason, shown when the dimmed action is tapped.
    var blockedReason: String?
    var failure: String?
    private(set) var busy = false

    func begin(with id: String? = nil) {
        isSelecting = true
        if let id { selectedIDs.insert(id) }
    }

    func end() {
        isSelecting = false
        selectedIDs = []
    }

    func run(_ action: PlacedAction, descriptor: EntityDescriptor, rows: [EntityRow], appModel: AppModel) {
        guard action.enabled else {
            blockedReason = action.reason ?? "\(action.label) isn't available for this selection."
            return
        }
        let ids = rows.map(\.id)
        switch action.kind {
        case .bulkEdit:
            bulkEdit = EntityBulkEditModel(descriptor: descriptor, ids: ids, client: appModel.client)
        case .merge:
            merge = EntityMergeModel(descriptor: descriptor, ids: ids, client: appModel.client)
        case .plan(let plan):
            switch plan.kind {
            case .delete:
                confirmingDelete = DeleteRequest(ids: ids)
            case .setField(let field, let value?):
                write(descriptor: descriptor, appModel: appModel) {
                    _ = try await appModel.client.bulkUpdate(
                        descriptor, ids: ids, data: [field: .string(value)])
                }
            case .setField(let field, nil):
                let model = EntityBulkEditModel(descriptor: descriptor, ids: ids, client: appModel.client)
                model.fieldKey = field
                bulkEdit = model
            default:
                blockedReason = "\(plan.label) runs on one record at a time."
            }
        default:
            break
        }
    }

    func delete(_ request: DeleteRequest, descriptor: EntityDescriptor, appModel: AppModel) {
        write(descriptor: descriptor, appModel: appModel) {
            try await appModel.client.delete(descriptor, ids: request.ids)
        }
    }

    /// A sheet's write finished: refresh the entity's lists and leave selection.
    func finished(_ descriptor: EntityDescriptor, appModel: AppModel) {
        appModel.recordEntityMutation(keys: [descriptor.key])
        end()
    }

    private func write(
        descriptor: EntityDescriptor, appModel: AppModel, _ body: @escaping @MainActor () async throws -> Void
    ) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await body()
                finished(descriptor, appModel: appModel)
            } catch {
                Diagnostics.report(error, context: "list.selection")
                failure = error.userMessage
            }
        }
    }
}

/// The bottom bar while selecting: the count, then every selection action. An unavailable action
/// stays visible and dimmed; tapping it says why.
struct EntitySelectionBar: View {
    let descriptor: EntityDescriptor
    let rows: [EntityRow]
    let controller: EntitySelectionController

    @Environment(AppModel.self) private var appModel

    var body: some View {
        let actions = ActionPlacement.selectionBar(entity: descriptor, rows: rows)
        VStack(spacing: FieldGuideTokens.Space.xs) {
            Text(
                rows.isEmpty
                    ? "Select \(descriptor.plural.lowercased())" : "\(rows.count.formatted()) selected"
            )
            .font(.caption)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("browse.\(descriptor.key.rawValue).selection.count")
            HStack(spacing: 0) {
                ForEach(actions) { action in
                    Button {
                        controller.run(action, descriptor: descriptor, rows: rows, appModel: appModel)
                    } label: {
                        VStack(spacing: 2) {
                            Image(systemName: action.symbol).font(.body)
                            Text(action.label).font(.caption2)
                        }
                        .frame(maxWidth: .infinity, minHeight: FieldGuideTokens.touchTarget)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(
                        !action.enabled
                            ? AnyShapeStyle(.tertiary)
                            : action.isDestructive
                                ? AnyShapeStyle(FieldGuideTokens.destructive)
                                : AnyShapeStyle(FieldGuideTokens.interaction)
                    )
                    .disabled(controller.busy)
                    .accessibilityLabel(action.label)
                    .accessibilityHint(action.enabled ? "" : (action.reason ?? "Unavailable"))
                    .help(action.reason ?? action.label)
                    .accessibilityIdentifier("browse.\(descriptor.key.rawValue).selection.\(action.id)")
                }
            }
        }
        .padding(.horizontal, FieldGuideTokens.Space.md)
        .padding(.vertical, FieldGuideTokens.Space.sm)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}

extension View {
    /// Presents a selection controller's sheets, delete confirmation and messages.
    func entitySelectionHost(_ controller: EntitySelectionController, descriptor: EntityDescriptor)
        -> some View
    {
        modifier(EntitySelectionHost(controller: controller, descriptor: descriptor))
    }
}

private struct EntitySelectionHost: ViewModifier {
    @Bindable var controller: EntitySelectionController
    let descriptor: EntityDescriptor
    @Environment(AppModel.self) private var appModel

    func body(content: Content) -> some View {
        content
            .sheet(item: $controller.bulkEdit) { model in
                EntityBulkEditSheet(model: model) { controller.finished(descriptor, appModel: appModel) }
                    .environment(appModel)
            }
            .sheet(item: $controller.merge) { model in
                EntityMergeSheet(model: model) { controller.finished(descriptor, appModel: appModel) }
                    .environment(appModel)
            }
            .confirmationDialog(
                controller.confirmingDelete.map {
                    "Delete \($0.ids.count) \($0.ids.count == 1 ? descriptor.singular : descriptor.plural)?"
                } ?? "",
                isPresented: Binding(
                    get: { controller.confirmingDelete != nil },
                    set: { if !$0 { controller.confirmingDelete = nil } }),
                titleVisibility: .visible, presenting: controller.confirmingDelete
            ) { request in
                Button("Delete", role: .destructive) {
                    controller.delete(request, descriptor: descriptor, appModel: appModel)
                }
                .accessibilityIdentifier("browse.\(descriptor.key.rawValue).selection.confirm-delete")
            } message: { _ in
                Text("This can't be undone.")
            }
            .alert(
                "Unavailable",
                isPresented: Binding(
                    get: { controller.blockedReason != nil },
                    set: { if !$0 { controller.blockedReason = nil } }),
                presenting: controller.blockedReason
            ) { _ in
                Button("OK") {}
            } message: { reason in
                Text(reason)
            }
            .alert(
                "Couldn't finish",
                isPresented: Binding(
                    get: { controller.failure != nil }, set: { if !$0 { controller.failure = nil } }),
                presenting: controller.failure
            ) { _ in
                Button("OK") {}
            } message: { failure in
                Text(failure)
            }
    }
}

#Preview("Selection bar", traits: .modifier(SignedInPreview())) {
    VStack {
        Spacer()
        EntitySelectionBar(
            descriptor: EntityCatalog[.product], rows: Array(PreviewFixtures.sampleRows.prefix(2)),
            controller: EntitySelectionController())
    }
}
