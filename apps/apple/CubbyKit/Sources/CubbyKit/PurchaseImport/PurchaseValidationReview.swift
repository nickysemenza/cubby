import Foundation
import Observation

/// One selectable, field-level change a purchase-validation run proposes. Read from the v2
/// `RunTarget.diff` (`validationDiff` in `packages/schemas/src/purchase-import.ts`).
public struct ValidationCorrection: Sendable, Hashable, Identifiable {
    public let id: String
    public let kind: String
    /// The Purchase or Expense shortcode the change lands on.
    public let recordText: String
    public let field: String
    public let beforeText: String
    public let afterText: String

    init?(_ raw: JSONValue) {
        guard let id = raw["id"]?.stringValue, let field = raw["field"]?.stringValue else {
            return nil
        }
        self.id = id
        self.field = field
        kind = raw["kind"]?.stringValue ?? ""
        recordText = raw["target"]?["code"]?.stringValue ?? ""
        beforeText = Self.text(raw["before"])
        afterText = Self.text(raw["after"])
    }

    /// A line added by a correction is an object; show its title and amount, not JSON.
    static func text(_ value: JSONValue?) -> String {
        switch value {
        case nil, .null: return "—"
        case .string(let string): return string
        case .bool(let bool): return bool ? "Yes" : "No"
        case .number(let number):
            return number == number.rounded() && abs(number) < 1e15
                ? String(Int(number)) : String(number)
        case .array(let items): return items.map { text($0) }.joined(separator: ", ")
        case .object(let object):
            let parts = [object["title"], object["amount"]].compactMap { $0 }.map { text($0) }
            return parts.isEmpty ? "—" : parts.joined(separator: " · ")
        }
    }
}

/// A visible difference validation will not change on its own; never selectable.
public struct ValidationNote: Sendable, Hashable, Identifiable {
    public let id: String
    public let recordText: String
    public let field: String
    public let message: String

    init?(_ raw: JSONValue) {
        guard let id = raw["id"]?.stringValue, let message = raw["message"]?.stringValue else {
            return nil
        }
        self.id = id
        self.message = message
        field = raw["field"]?.stringValue ?? ""
        recordText = raw["target"]?["code"]?.stringValue ?? ""
    }
}

/// A purchase-validation run target with a reviewable v2 diff.
public struct PurchaseValidationTarget: Sendable, Hashable, Identifiable {
    public let purchaseCode: String
    public let name: String?
    public let corrections: [ValidationCorrection]
    public let notes: [ValidationNote]
    public let rawEvidenceDrift: Bool

    public var id: String { purchaseCode }

    /// Nil unless the diff is the v2 shape; an older diff has no selectable corrections.
    public init?(purchaseCode: String, name: String?, diff: JSONValue?) {
        guard let diff, diff["version"]?.doubleValue == 2 else { return nil }
        self.purchaseCode = purchaseCode
        self.name = name
        corrections = (diff["corrections"]?.arrayValue ?? []).compactMap(ValidationCorrection.init)
        notes = (diff["notes"]?.arrayValue ?? []).compactMap(ValidationNote.init)
        rawEvidenceDrift = diff["rawEvidenceDrift"]?.boolValue ?? false
    }
}

public protocol PurchaseValidationServing: Sendable {
    func validationTargets(runID: String) async throws -> [PurchaseValidationTarget]
    func applyValidationCorrections(_ input: ApplyValidationCorrectionsInput) async throws
        -> ApplyValidationCorrectionsOut
}

extension CubbyClient: PurchaseValidationServing {
    public func validationTargets(runID: String) async throws -> [PurchaseValidationTarget] {
        let run = try await runWork(.init(runId: runID))
        return try run.targets.compactMap { target in
            guard target.targetType == .purchase, let code = target.targetShortcode else {
                return nil
            }
            return PurchaseValidationTarget(
                purchaseCode: code, name: target.targetName,
                diff: try target.diff.map { try JSONValue(encoding: $0) })
        }
    }
}

public struct ValidationStaleReason: Sendable, Hashable, Identifiable {
    public let correctionID: String?
    public let reason: String
    public var id: String { "\(correctionID ?? "-"):\(reason)" }
}

/// Review state for a validation run's corrections. Every correction starts selected; applying
/// sends exactly the selected ids under a fresh operation id, and a stale refusal is kept inline
/// with the server's raw reasons. Nothing is written until the person applies.
@MainActor @Observable
public final class PurchaseValidationReviewSession {
    public private(set) var targets: [PurchaseValidationTarget] = []
    public private(set) var busy = false
    public private(set) var error: String?
    @ObservationIgnored private let service: any PurchaseValidationServing
    private var deselected: [String: Set<String>] = [:]
    private var stale: [String: [ValidationStaleReason]] = [:]
    private var outcomes: [String: String] = [:]

    public init(service: any PurchaseValidationServing) {
        self.service = service
    }

    public func selectedIDs(for purchase: String) -> [String] {
        guard let target = targets.first(where: { $0.purchaseCode == purchase }) else { return [] }
        let off = deselected[purchase] ?? []
        return target.corrections.map(\.id).filter { !off.contains($0) }
    }

    public func isSelected(_ correction: String, purchase: String) -> Bool {
        !(deselected[purchase]?.contains(correction) ?? false)
    }

    public func toggle(_ correction: String, purchase: String) {
        if deselected[purchase, default: []].remove(correction) == nil {
            deselected[purchase, default: []].insert(correction)
        }
    }

    public func staleReasons(for purchase: String) -> [ValidationStaleReason] {
        stale[purchase] ?? []
    }

    public func outcome(for purchase: String) -> String? { outcomes[purchase] }

    public func refresh(runID: String) async {
        do {
            targets = try await service.validationTargets(runID: runID)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    public func apply(purchase: String, runID: String) async {
        let ids = selectedIDs(for: purchase)
        guard !busy, !ids.isEmpty else { return }
        busy = true
        defer { busy = false }
        error = nil
        outcomes[purchase] = nil
        stale[purchase] = nil
        do {
            // A new id per selection: the server replays a repeated operation id, so reusing one
            // would silently drop a changed selection.
            let result = try await service.applyValidationCorrections(
                .init(
                    runId: runID, purchaseId: purchase, operationId: UUID().uuidString,
                    correctionIds: ids))
            switch result {
            case .applied(let applied):
                outcomes[purchase] =
                    "Applied \(applied.applied.count) \(applied.applied.count == 1 ? "correction" : "corrections"); \(applied.remainingCorrections) remaining."
                await refresh(runID: runID)
            case .stale(let refusal):
                stale[purchase] = refusal.stale.map {
                    ValidationStaleReason(correctionID: $0.correctionId, reason: $0.reason)
                }
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
