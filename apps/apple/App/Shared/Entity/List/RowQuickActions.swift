import CubbyKit
import SwiftUI

/// Runs a row's declared quick actions (`list.quickActions`) outside its detail screen: a preset
/// write runs on the tap, anything that needs input opens the hero sheet. The list refreshes from
/// the recorded mutation; only a failure is announced.
@MainActor @Observable
final class RowQuickActionRunner {
    var sheet: HeroActionModel?
    var failure: String?
    private(set) var busy = false

    func start(_ plan: HeroActionPlan, key: EntityKey, row: EntityRow, appModel: AppModel) {
        let runner = HeroActionRunner(client: appModel.client)
        guard plan.runsOnTap else {
            sheet = HeroActionModel(plan: plan, entity: key, row: row, runner: runner)
            return
        }
        // The flag flips before the task is scheduled so a second tap cannot start a second write.
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                finish(
                    try await runner.perform(plan, on: key, row: row, values: [:], confirmed: false),
                    appModel: appModel)
            } catch {
                Diagnostics.report(error, context: "list.quickAction")
                failure = error.userMessage
            }
        }
    }

    func finish(_ outcome: HeroActionOutcome, appModel: AppModel) {
        // Quick actions are field writes and operations; none opens an editor or a review.
        if case .completed(_, let changed) = outcome { appModel.recordEntityMutation(keys: changed) }
    }
}

/// The row's quick actions as buttons, for the leading swipe and the head of the context menu.
struct RowQuickActionButtons: View {
    let key: EntityKey
    let row: EntityRow
    let runner: RowQuickActionRunner

    @Environment(AppModel.self) private var appModel

    var body: some View {
        let actions = HeroActionRunner.quickActions(
            EntityCatalog[key].presentation.listQuickActionIDs, on: key, row: row)
        ForEach(actions, id: \.0) { verb, plan in
            Button(plan.label, systemImage: plan.symbol) {
                runner.start(plan, key: key, row: row, appModel: appModel)
            }
            .tint(FieldGuideTokens.interaction)
            .disabled(runner.busy)
            .accessibilityIdentifier("browse.\(key.rawValue).quick.\(verb.rawValue).\(row.id)")
        }
    }
}

extension View {
    /// Presents a row quick-action runner's sheet and failure.
    func rowQuickActionHost(_ runner: RowQuickActionRunner) -> some View {
        modifier(RowQuickActionHost(runner: runner))
    }
}

private struct RowQuickActionHost: ViewModifier {
    @Bindable var runner: RowQuickActionRunner
    @Environment(AppModel.self) private var appModel

    func body(content: Content) -> some View {
        content
            .sheet(item: $runner.sheet) { action in
                HeroActionSheet(model: action) { outcome in runner.finish(outcome, appModel: appModel) }
                    .environment(appModel)
            }
            .alert(
                runner.failure ?? "",
                isPresented: Binding(
                    get: { runner.failure != nil }, set: { if !$0 { runner.failure = nil } })
            ) {
                Button("OK") {}
            }
    }
}
