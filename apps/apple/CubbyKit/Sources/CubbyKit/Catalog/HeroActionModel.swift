import Foundation
import Observation

/// Screen state for one hero action: the form values, the server's preview of what the action
/// will do, and the confirm-then-run step. The runner owns what each verb means and the server
/// owns the defaults and warnings; this only renders the server's answer and decides when it is
/// safe to submit.
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
    /// The (normalized) values the current `preview` was computed for. A preview is only the
    /// answer to the form as it stood then; it never vouches for later edits.
    private var previewValues: [String: JSONValue]?
    private let initialValues: [String: JSONValue]

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
        initialValues = seed
    }

    /// Fields whose `showWhen` toggle is on (or that have none).
    public var visibleFields: [HeroActionField] {
        plan.fields.filter { field in
            guard let gate = field.showWhen else { return true }
            return values[gate]?.boolValue == true
        }
    }

    private var normalizedValues: [String: JSONValue] {
        HeroActionRunner.normalizedValues(plan.fields, values: values)
    }

    /// The preview, only while it still describes the form as it stands.
    private var currentPreview: HeroActionPreview? {
        previewValues == normalizedValues ? preview : nil
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

    /// The server's advisory line (a warning or a blocked delete), if any, for the current form.
    public var advisory: (message: String, isDestructive: Bool)? {
        switch currentPreview {
        case .discard(let preview)?:
            return preview.warning.map { ($0.message, $0.tone == .destructive) }
        case .addToInventory(let preview)?:
            guard let kit = preview.kitWarning else { return nil }
            return (
                "Its parts hold \(kit.accounted.formatted()) of the \(kit.expected.formatted()) you bought. "
                    + "Adding one here counts a unit you don't own unless you have another still assembled or sealed.",
                true
            )
        case .deleteImpact(let impact)?:
            let blocked = impact.groups.contains {
                $0.direction == .incoming && $0.disposition?.effect == .block
            }
            return blocked ? ("Delete is blocked by connected records.", true) : nil
        case nil:
            return nil
        }
    }

    /// Stock already at the chosen location: the add sums into that row.
    public var existingStock: String? {
        guard case .addToInventory(let preview)? = currentPreview, let existing = preview.existingAtLocation
        else { return nil }
        return "already \(existing.value.formatted()) \(existing.unit) here — adds to that row"
    }

    /// Whether Submit is enabled: required fields filled, and the preview (if the verb has one)
    /// answers the form exactly as it stands with no unanswered server question (several shelves,
    /// none chosen). A stale, failed, or missing preview keeps Submit off.
    public var canSubmit: Bool {
        guard !isRunning else { return false }
        guard case .operation(let operation) = plan.kind else { return true }
        if operation.preview != nil {
            guard let current = currentPreview else { return false }
            if case .discard(let discard) = current, discard.needsShelfChoice { return false }
        }
        return (try? HeroActionRunner.resolvedValues(operation.fields, values: values)) != nil
    }

    public func refreshPreview() async {
        let requested = normalizedValues
        do {
            let answer = try await runner.preview(plan, on: entity, rowID: row.id, values: requested)
            preview = answer
            previewValues = requested
            previewError = nil
            if let answer { applyServerDefaults(from: answer) }
        } catch {
            // Never leave a previous answer standing for a form it was not computed for.
            preview = nil
            previewValues = nil
            previewError = String(describing: error)
        }
    }

    /// The server owns the defaults: seed the shelf and the proposed quantity/amount the first
    /// time they are known, but only where the person has not already chosen something.
    private func applyServerDefaults(from preview: HeroActionPreview) {
        func untouched(_ key: String) -> Bool { values[key] == initialValues[key] }
        switch preview {
        case .discard(let discard):
            if let shelf = discard.selectedShelf, values["inventoryEntryId"].map(isBlank) ?? true {
                values["inventoryEntryId"] = .string(shelf.id.rawValue)
            }
            if untouched("quantity") { values["quantity"] = .number(discard.defaultQuantity) }
        case .addToInventory(let add):
            if untouched("amount") {
                values["amount"] = [
                    "value": .number(add.defaultAmount.value), "unit": .string(add.defaultAmount.unit),
                ]
            }
        case .deleteImpact:
            break
        }
    }

    private func isBlank(_ value: JSONValue) -> Bool {
        value == .null || value.stringValue?.isEmpty == true
    }

    /// Starts the action. `isRunning` flips synchronously, before the work is scheduled, so a
    /// second tap in the same run-loop turn cannot start a second request. `confirmed` must come
    /// from the person tapping the confirmation button.
    public func submit(
        confirmed: Bool, onFinished: @escaping @MainActor (HeroActionOutcome) -> Void
    ) {
        guard canSubmit else { return }
        isRunning = true
        errorMessage = nil
        Task {
            defer { isRunning = false }
            do {
                let outcome = try await runner.perform(
                    plan, on: entity, row: row, values: values, confirmed: confirmed)
                onFinished(outcome)
            } catch {
                errorMessage = String(describing: error)
            }
        }
    }
}
