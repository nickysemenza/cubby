import CubbyKit

/// The native implementation boundary for manifest-declared presentation names.
///
/// Status and handoff are not decided here: they are read from the generated
/// `native-coverage.json`, declared once in `packages/schemas/src/native-coverage.ts`, which the
/// generator refuses to build unless every renderer, slot, and hero action is classified. A
/// `handoff` is intentional: callers draw one `OpenOnWebButton` row where the surface stood (and
/// a record More item) instead of silently dropping a field or slot. To change a status, edit
/// that declaration (and implement the native view path for `implemented`; the generated
/// per-status id enums make the compiler enforce both).
enum NativePresentationCoverage {
    typealias Status = NativeCoverageStatus

    private static var coverage: NativeCoverageManifest { .shared }

    /// An id the bundled coverage does not classify (unreachable while the manifest and coverage
    /// ship together): hand off to the record's page.
    private static func unknown(_ reason: String) -> Status {
        .handoff(NativeWebHandoff(label: "Open on web", reason: reason))
    }

    static func control(_ renderer: ControlRendererID) -> Status {
        coverage.control[renderer.rawValue]
            ?? unknown("No native control for \(renderer.rawValue); edit it on web.")
    }

    static func list(_ renderer: ListRendererID) -> Status {
        coverage.list[renderer.rawValue] ?? unknown("This computed figure is available on web.")
    }

    static func detail(_ renderer: DetailRendererID) -> Status {
        coverage.detail[renderer.rawValue] ?? unknown("This structured detail is available on web.")
    }

    static func heroAction(_ action: EntityHeroActionID) -> Status {
        coverage.heroAction[action.rawValue] ?? unknown("This action is available on web.")
    }

    /// Detail slots are entity-qualified, so an unqualified id or a newly copied slot cannot
    /// accidentally select the wrong entity's implementation.
    static func detailSlot(_ id: String) -> Status {
        coverage.detailSlot[id] ?? unknown("Unknown native detail slot.")
    }

    static func listSlot(_ id: String) -> Status {
        coverage.listSlot[id] ?? unknown("Unknown native list slot.")
    }

    /// A report `records` block's verb: `implemented` ones run natively, the rest draw a web row.
    static func sectionAction(_ action: SectionActionID) -> Status {
        coverage.sectionAction[action.rawValue] ?? unknown("This action is available on web.")
    }

    static func listViews(for descriptor: EntityDescriptor) -> [ListView] {
        descriptor.presentation.listViews.filter {
            guard case .slot(let id, _, _) = $0 else { return true }
            switch listSlot(id) {
            case .implemented, .generic: return true
            case .ownedElsewhere, .handoff: return false
            }
        }
    }

    static func controlHandoff(_ field: FieldDescriptor, entity: EntityKey) -> NativeWebHandoff? {
        if field.controlRenderer == .structuredField {
            return coverage.structuredField["\(entity.rawValue).\(field.key)"]?.handoff
        }
        return field.controlRenderer.flatMap { control($0).handoff }
    }

    static func detailHandoff(_ field: FieldDescriptor) -> NativeWebHandoff? {
        field.detailRenderer.flatMap { detail($0).handoff }
    }

    static func heroActionHandoff(_ action: EntityHeroActionID) -> NativeWebHandoff? {
        heroAction(action).handoff
    }

    /// Every handoff a record's detail screen draws, in declaration order: detail fields, the
    /// slots that apply to this row, then hero actions. The More menu lists each once.
    static func recordHandoffs(_ descriptor: EntityDescriptor, row: EntityRow) -> [NativeWebHandoff] {
        let fields = descriptor.fields.filter(\.showInDetail).compactMap(detailHandoff)
        let slots = descriptor.presentation.detailSections.compactMap { section -> NativeWebHandoff? in
            guard case .slot = section.kind else { return nil }
            return DetailSlotRegistry.handoff(slot: section.id, row: row)
        }
        let controls = descriptor.fields.compactMap { controlHandoff($0, entity: descriptor.key) }
        let actions = descriptor.presentation.heroActions.compactMap(heroActionHandoff)
        var seen = Set<String>()
        return (fields + controls + slots + actions).filter { seen.insert($0.label).inserted }
    }
}
