import Foundation
import Observation

/// Screen state for one hero action: the form values, the server's preview of what the action
/// will do, and the confirm-then-run step. The runner owns what each verb means; this only holds
/// what the person has typed and when it is safe to submit.
@MainActor @Observable
public final class HeroActionModel: Identifiable {
    public let id = UUID()
    public let plan: HeroActionPlan
    public let entity: EntityKey
    public let row: EntityRow
    private let runner: HeroActionRunner

    public var values: [String: JSONValue]
    public private(set) var preview: HeroActionPreview?
    public private(set) var previewError: String?
    public private(set) var isRunning = false
    public private(set) var errorMessage: String?

    public init(
        plan: HeroActionPlan, entity: EntityKey, row: EntityRow, runner: HeroActionRunner,
        now: Date = Date()
    ) {
        self.plan = plan
        self.entity = entity
        self.row = row
        self.runner = runner
        var seed = HeroActionRunner.defaults(for: plan.fields, now: now)
        // A field picker starts on the row's current value.
        if case .setField(let field) = plan.kind, let current = row.raw[field] { seed[field] = current }
        values = seed
    }

    /// Fields whose `showWhen` toggle is on (or that have none).
    public var visibleFields: [HeroActionField] {
        plan.fields.filter { field in
            guard let gate = field.showWhen else { return true }
            return values[gate]?.boolValue == true
        }
    }

    /// Choices for a `shelf` field come from the server's preview, never a guess.
    public var shelfOptions: [LabeledOption] {
        guard case .discard(let preview)? = preview else { return [] }
        return preview.shelves.map { shelf in
            LabeledOption(
                value: shelf.id.rawValue,
                label: "\(shelf.location.name) — \(shelf.amount.value.formatted()) \(shelf.amount.unit)")
        }
    }

    /// The server's advisory line (a warning or a blocked delete), if any.
    public var advisory: (message: String, isDestructive: Bool)? {
        switch preview {
        case .discard(let preview)?:
            return preview.warning.map { ($0.message, $0.tone == .destructive) }
        case .deleteImpact(let impact)?:
            let blocked = impact.groups.contains {
                $0.direction == .incoming && $0.disposition?.effect == .block
            }
            return blocked ? ("Delete is blocked by connected records.", true) : nil
        case nil:
            return nil
        }
    }

    /// Whether Submit is enabled: required fields filled, and no unanswered server question
    /// (several shelves with none chosen). Other previews are advisory and never block.
    public var canSubmit: Bool {
        guard !isRunning else { return false }
        guard case .operation(let operation) = plan.kind else { return true }
        // A verb with a preview waits for its first answer, so Submit cannot race the verdict.
        if operation.preview != nil {
            guard case .discard(let preview)? = preview, !preview.needsShelfChoice else { return false }
        }
        return (try? HeroActionRunner.resolvedValues(operation.fields, values: values)) != nil
    }

    public func refreshPreview() async {
        do {
            preview = try await runner.preview(plan, on: entity, rowID: row.id, values: values)
            previewError = nil
        } catch {
            previewError = String(describing: error)
        }
    }

    /// Runs the action. `confirmed` must come from the person tapping the confirmation button.
    public func submit(confirmed: Bool) async -> HeroActionOutcome? {
        isRunning = true
        errorMessage = nil
        defer { isRunning = false }
        do {
            return try await runner.perform(plan, on: entity, row: row, values: values, confirmed: confirmed)
        } catch {
            errorMessage = String(describing: error)
            return nil
        }
    }
}
