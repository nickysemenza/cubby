import CubbyKit

/// The native implementation boundary for manifest-declared presentation names.
///
/// Status and reason are not decided here: they are read from the generated
/// `native-coverage.json`, declared once in `packages/schemas/src/native-coverage.ts`, which the
/// generator refuses to build unless every renderer, slot, and hero action is classified. A
/// non-nil unsupported reason is intentional: callers surface one web disclosure instead of
/// silently dropping a field or slot. To change a status, edit that declaration (and implement
/// the native view path for `implemented`; `NativeCoverageViewPathTests` enforces both).
enum NativePresentationCoverage {
    typealias Status = NativeCoverageStatus

    private static var coverage: NativeCoverageManifest { .shared }

    static func control(_ renderer: ControlRendererID) -> Status {
        coverage.control[renderer.rawValue]
            ?? .unsupported("No native control for \(renderer.rawValue); edit it on web.")
    }

    static func list(_ renderer: ListRendererID) -> Status {
        coverage.list[renderer.rawValue] ?? .unsupported("This computed figure is available on web.")
    }

    static func detail(_ renderer: DetailRendererID) -> Status {
        coverage.detail[renderer.rawValue] ?? .unsupported("This structured detail is available on web.")
    }

    static func heroAction(_ action: EntityHeroActionID) -> Status {
        coverage.heroAction[action.rawValue] ?? .unsupported("This action is available on web.")
    }

    /// Detail slots are entity-qualified, so an unqualified id or a newly copied slot cannot
    /// accidentally select the wrong entity's implementation.
    static func detailSlot(_ id: String) -> Status {
        coverage.detailSlot[id] ?? .unsupported("Unknown native detail slot.")
    }

    static func listSlot(_ id: String) -> Status {
        coverage.listSlot[id] ?? .unsupported("Unknown native list slot.")
    }

    static func unsupportedControl(_ field: FieldDescriptor) -> String? {
        guard let renderer = field.controlRenderer else { return nil }
        guard case .unsupported(let reason) = control(renderer) else { return nil }
        return reason
    }

    static func unsupportedDetail(_ field: FieldDescriptor) -> String? {
        guard let renderer = field.detailRenderer else { return nil }
        guard case .unsupported(let reason) = detail(renderer) else { return nil }
        return reason
    }

    static func unsupportedSlot(_ slot: String) -> String? {
        guard case .unsupported(let reason) = detailSlot(slot) else { return nil }
        return reason
    }

    static func unsupportedHeroAction(_ action: EntityHeroActionID) -> String? {
        guard case .unsupported(let reason) = heroAction(action) else { return nil }
        return reason
    }
}
