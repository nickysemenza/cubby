import Foundation

/// Whether one action is available on a record, as an entity read says. Reads carry
/// `actions: [{id, enabled, reason}]` for declared verbs and the kernel actions (`edit`,
/// `delete`, `merge`, `bulkEdit`), evaluated on the server from the declared `requires`.
public struct ActionAvailability: Codable, Sendable, Hashable {
    public let id: String
    public let enabled: Bool
    public let reason: String?

    public init(id: String, enabled: Bool, reason: String? = nil) {
        self.id = id
        self.enabled = enabled
        self.reason = reason
    }

    /// The `actions` a row carries; nil when the read has none (an older server), so placement
    /// falls back to each plan's declared requirement.
    public static func decode(from raw: JSONValue) -> [ActionAvailability]? {
        guard let items = raw["actions"]?.arrayValue else { return nil }
        return items.compactMap { item in
            guard let id = item["id"]?.stringValue, let enabled = item["enabled"]?.boolValue else {
                return nil
            }
            return ActionAvailability(id: id, enabled: enabled, reason: item["reason"]?.stringValue)
        }
    }
}

extension EntityRow {
    /// The server's per-action availability for this row, when the read carries it.
    public var actionAvailability: [ActionAvailability]? { ActionAvailability.decode(from: raw) }
}

/// One action as a surface draws it. Labels and symbols come from the plan or the kernel; the
/// surface renders and runs it (`HeroActionRunner` for `.plan`), never re-deriving placement.
public struct PlacedAction: Sendable, Hashable, Identifiable {
    public enum Kind: Sendable, Hashable {
        /// A declared verb, Delete, or a native record action (flow or web handoff).
        case plan(HeroActionPlan)
        case edit
        case select
        case bulkEdit
        case merge
        /// A `detail.quickFields` tile: opens that field's inline editor.
        case quickField(String)
        case copyLink
        case share
        case openOnWeb
        case addPhoto
        /// The trailing swipe's last button: opens the row's full action menu.
        case more
    }

    public enum Prominence: Sendable, Hashable {
        /// A `detail.quickActions` tile.
        case filled
        /// A routine verb, flow or quick field tile.
        case tonal
        case plain
    }

    public let id: String
    public let kind: Kind
    public let label: String
    public let symbol: String
    public let enabled: Bool
    /// Why the action is unavailable, shown where unavailable actions stay visible.
    public let reason: String?
    public let isDestructive: Bool
    public let prominence: Prominence
    /// The record already carries what the action would write (Done on a done task): a row
    /// command draws its completed state rather than an unavailable verb.
    public let isApplied: Bool

    public init(
        id: String, kind: Kind, label: String, symbol: String, enabled: Bool = true,
        reason: String? = nil, isDestructive: Bool = false, prominence: Prominence = .plain,
        isApplied: Bool = false
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.symbol = symbol
        self.enabled = enabled
        self.reason = reason
        self.isDestructive = isDestructive
        self.prominence = prominence
        self.isApplied = isApplied
    }

    func with(_ prominence: Prominence) -> PlacedAction {
        PlacedAction(
            id: id, kind: kind, label: label, symbol: symbol, enabled: enabled, reason: reason,
            isDestructive: isDestructive, prominence: prominence, isApplied: isApplied)
    }
}

/// Where each of a record's actions appears, from the manifest, native plans and server
/// availability (`docs/entities.md` "Native action placement"). Unavailable actions are absent
/// from swipes and context menus, and dimmed with their reason elsewhere.
public struct ActionPlacement: Sendable {
    /// List quick actions, then one-tap non-destructive verbs; at most two. Full swipe runs the first.
    public let leadingSwipe: [PlacedAction]
    /// Delete, then destructive verbs, then More. Never runs on a full swipe.
    public let trailingSwipe: [PlacedAction]
    /// Verbs and flows, Edit and Select, Copy link / Share / Open on web, destructive last.
    public let contextMenu: [[PlacedAction]]
    /// `list.rowCommand`: the row's leading control; kept while unavailable so rows stay aligned.
    public let rowCommand: PlacedAction?
    /// Up to four detail tiles: quick actions (filled), then one-tap verbs, flows, quick fields.
    public let actionBar: [PlacedAction]
    /// Detail More: verbs, create, share, web, destructive.
    public let more: [[PlacedAction]]
    /// Record handoffs drawn as an inline web row in their declared detail section.
    public let sectionHandoffs: [String: [PlacedAction]]

    public init(entity: EntityDescriptor, row: EntityRow) {
        self.init(entity: entity, raw: row.raw, availability: row.actionAvailability)
    }

    public init(entity: EntityDescriptor, raw: JSONValue, availability: [ActionAvailability]? = nil) {
        let resolver = Resolver(entity: entity, raw: raw, availability: availability)
        let presentation = entity.presentation
        let listVerbs = resolver.verbs(presentation.listActions)
        let detailVerbs = resolver.verbs(presentation.heroActions.map(\.rawValue))
        let records = HeroActionRunner.recordActions(on: entity.key, raw: raw).map {
            resolver.placed(id: $0.0, plan: $0.1)
        }
        let flows = records.filter { if case .plan(let plan) = $0.kind { plan.isFlow } else { false } }
        let handoffs = records.filter { !flows.contains($0) }
        let listDelete = presentation.listActions.contains("delete") ? resolver.delete : nil
        let detailDelete =
            presentation.heroActions.contains { $0.rawValue == "delete" } ? resolver.delete : nil

        // List row.
        let swipeOverride = presentation.listSwipe
        let swipesOff = presentation.listSwipeDisabled == true
        let leadingIDs =
            swipeOverride?.leading
            ?? unique(
                (presentation.listQuickActions ?? [])
                    + listVerbs.filter { $0.isOneTap && !$0.isDestructive }.map(\.id))
        leadingSwipe =
            swipesOff ? [] : Array(leadingIDs.compactMap(resolver.verb).filter(\.enabled).prefix(2))
        let trailingIDs =
            swipeOverride?.trailing
            ?? ((listDelete.map { [$0.id] } ?? []) + listVerbs.filter(\.isDestructive).map(\.id))
        let trailing = trailingIDs.compactMap { $0 == "delete" ? listDelete : resolver.verb($0) }.filter(
            \.enabled)
        rowCommand = presentation.listRowCommand.flatMap(resolver.verb)

        let rowVerbs = unique(listVerbs.filter { !$0.isDestructive }, presentation.listQuickActions ?? [])
        let editSelect =
            [resolver.edit].compactMap { $0 }
            + [resolver.kernel("select", .select, "Select", "checkmark.circle")]
        let destructiveRow = ([listDelete].compactMap { $0 } + listVerbs.filter(\.isDestructive))
        contextMenu = [
            (rowVerbs + flows).filter(\.enabled),
            editSelect.filter(\.enabled),
            [resolver.copyLink, resolver.share, resolver.openOnWeb],
            destructiveRow.filter(\.enabled),
        ].filter { !$0.isEmpty }
        let swiped = Set((leadingSwipe + trailing).map(\.id))
        let more = contextMenu.joined().contains { !swiped.contains($0.id) }
        trailingSwipe =
            swipesOff
            ? [] : trailing + (more ? [resolver.kernel("more", .more, "More", "ellipsis.circle")] : [])

        // Detail.
        let quick = presentation.detailQuickActionIDs.compactMap { resolver.verb($0.rawValue) }
            .filter { !$0.isDestructive }.map { $0.with(.filled) }
        let routine = detailVerbs.filter { verb in
            verb.isOneTap && !verb.isDestructive && !quick.contains { $0.id == verb.id }
        }
        let fields = (presentation.detailQuickFields ?? []).compactMap(resolver.quickField)
        actionBar = Array(
            (quick + (routine + flows + fields).map { $0.with(.tonal) }).prefix(4))
        let addPhoto =
            entity.key.acceptsImageAttach
            ? resolver.kernel("addPhoto", .addPhoto, "Add photo", "camera") : nil
        self.more = [
            detailVerbs.filter { !$0.isDestructive },
            flows + [addPhoto].compactMap { $0 },
            [resolver.copyLink, resolver.share],
            [resolver.openOnWeb] + handoffs,
            [detailDelete].compactMap { $0 } + detailVerbs.filter(\.isDestructive),
        ].filter { !$0.isEmpty }
        sectionHandoffs = Dictionary(
            grouping: handoffs,
            by: { action in
                if case .plan(let plan) = action.kind, case .handoff(let section, _) = plan.kind {
                    section
                } else {
                    ""
                }
            })
    }

    /// The selection bar for `rows`: Bulk edit, Merge (two or more), declared bulk verbs, Delete.
    /// Every action stays visible; one unavailable on any selected row is dimmed with its reason.
    public static func selectionBar(entity: EntityDescriptor, rows: [EntityRow]) -> [PlacedAction] {
        let presentation = entity.presentation
        let native = entity.key.nativeActions
        let resolvers = rows.map {
            Resolver(entity: entity, raw: $0.raw, availability: $0.actionAvailability)
        }
        let template = Resolver(entity: entity, raw: [:], availability: nil)
        // Available only when every selected row allows it; the first refusal gives the reason.
        func combined(_ make: (Resolver) -> PlacedAction?) -> PlacedAction? {
            guard let base = make(template)?.disabled(nil, enabled: true) else { return nil }
            if rows.isEmpty { return base.disabled("Select records first.") }
            let blocked = resolvers.compactMap(make).first { !$0.enabled }
            return blocked.map { base.disabled($0.reason) } ?? base
        }
        var items: [PlacedAction] = []
        if presentation.listActions.contains("bulkEdit"), native.contains(.bulkUpdate),
            let bulkEdit = combined({ $0.kernel("bulkEdit", .bulkEdit, "Bulk edit", "square.and.pencil") })
        {
            items.append(bulkEdit)
        }
        // Native runs only the merge web runs through its generic kernel dialog. A specialized
        // web flow (a reviewed preview, a domain merge operation) is handed to web instead.
        if presentation.listActions.contains("merge"), presentation.listMergeOnWeb == true {
            items.append(
                PlacedAction(
                    id: "merge", kind: .openOnWeb, label: "Merge on web", symbol: "arrow.triangle.merge"))
        } else if presentation.listActions.contains("merge"), native.contains(.merge),
            let merge = combined({ $0.kernel("merge", .merge, "Merge", "arrow.triangle.merge") })
        {
            items.append(rows.count < 2 ? merge.disabled("Select at least two records to merge.") : merge)
        }
        for id in unique(presentation.listActions) {
            guard let verb = template.verb(id), case .plan(let plan) = verb.kind, plan.bulk,
                let item = combined({ $0.verb(id) })
            else { continue }
            items.append(item)
        }
        if presentation.listActions.contains("delete"), let delete = combined({ $0.delete }) {
            items.append(delete)
        }
        return items
    }
}

/// Resolves one record's actions against plans and availability.
private struct Resolver {
    let entity: EntityDescriptor
    let raw: JSONValue
    let server: [String: ActionAvailability]?

    init(entity: EntityDescriptor, raw: JSONValue, availability: [ActionAvailability]?) {
        self.entity = entity
        self.raw = raw
        server = availability.map {
            Dictionary($0.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        }
    }

    /// The server's answer for `id`, else the plan's requirement. A preset field write the record
    /// already carries (Done on a done task) is unavailable rather than a no-op.
    func availability(_ id: String, plan: HeroActionPlan?) -> (Bool, String?) {
        if let entry = server?[id] { return (entry.enabled, entry.enabled ? nil : entry.reason) }
        guard let plan else { return (true, nil) }
        if let reason = HeroActionRunner.unmet(plan, in: raw) { return (false, reason) }
        if isApplied(plan) { return (false, nil) }
        return (true, nil)
    }

    /// A preset field write whose value the record already holds.
    func isApplied(_ plan: HeroActionPlan) -> Bool {
        guard case .setField(let field, let value?) = plan.kind else { return false }
        return raw.planValue(field)?.stringValue == value
    }

    func placed(id: String, plan: HeroActionPlan) -> PlacedAction {
        let (enabled, reason) = availability(id, plan: plan)
        return PlacedAction(
            id: id, kind: .plan(plan), label: plan.label, symbol: plan.symbol, enabled: enabled,
            reason: reason, isDestructive: plan.confirmation == .destructive, isApplied: isApplied(plan))
    }

    /// A declared verb with a native plan on this entity; nil for kernel ids and web-only verbs.
    func verb(_ id: String) -> PlacedAction? {
        guard !Self.kernelIDs.contains(id), let verb = EntityHeroActionID(rawValue: id),
            let plan = HeroActionRunner.plan(for: verb, on: entity.key)
        else { return nil }
        return placed(id: id, plan: plan)
    }

    func verbs(_ ids: [String]) -> [PlacedAction] { unique(ids).compactMap(verb) }

    var delete: PlacedAction? {
        guard let plan = HeroActionRunner.plan(for: .delete, on: entity.key) else { return nil }
        return placed(id: "delete", plan: plan)
    }

    var edit: PlacedAction? {
        guard entity.presentation.heroActions.contains(where: { $0.rawValue == "edit" }),
            entity.key.nativeActions.contains(.update)
        else { return nil }
        return kernel("edit", .edit, "Edit", "pencil")
    }

    func kernel(_ id: String, _ kind: PlacedAction.Kind, _ label: String, _ symbol: String) -> PlacedAction {
        let (enabled, reason) = availability(id, plan: nil)
        return PlacedAction(
            id: id, kind: kind, label: label, symbol: symbol, enabled: enabled, reason: reason)
    }

    func quickField(_ key: String) -> PlacedAction? {
        guard let field = entity.field(key) else { return nil }
        return PlacedAction(
            id: "field.\(key)", kind: .quickField(key), label: field.label, symbol: "pencil",
            prominence: .tonal)
    }

    var copyLink: PlacedAction {
        PlacedAction(id: "copyLink", kind: .copyLink, label: "Copy link", symbol: "link")
    }
    var share: PlacedAction {
        PlacedAction(id: "share", kind: .share, label: "Share", symbol: "square.and.arrow.up")
    }
    var openOnWeb: PlacedAction {
        PlacedAction(id: "openOnWeb", kind: .openOnWeb, label: "Open on web", symbol: "safari")
    }

    static let kernelIDs: Set<String> = ["edit", "delete", "bulkEdit", "merge"]
}

extension PlacedAction {
    fileprivate var isOneTap: Bool {
        if case .plan(let plan) = kind { return plan.runsOnTap || plan.isToggle }
        return false
    }

    fileprivate func disabled(_ reason: String?, enabled: Bool = false) -> PlacedAction {
        PlacedAction(
            id: id, kind: kind, label: label, symbol: symbol, enabled: enabled,
            reason: enabled ? nil : reason,
            isDestructive: isDestructive, prominence: prominence, isApplied: isApplied)
    }
}

extension HeroActionPlan {
    fileprivate var isFlow: Bool { if case .flow = kind { true } else { false } }
    /// A toggle has no form, so a swipe or tile runs it on one tap like a preset write.
    fileprivate var isToggle: Bool { if case .toggleField = kind { true } else { false } }
}

private func unique(_ ids: [String]) -> [String] {
    var seen = Set<String>()
    return ids.filter { seen.insert($0).inserted }
}

/// `actions` ordered with the `leading` ids first, each once.
private func unique(_ actions: [PlacedAction], _ leading: [String]) -> [PlacedAction] {
    let first = leading.compactMap { id in actions.first { $0.id == id } }
    return first + actions.filter { action in !first.contains { $0.id == action.id } }
}
