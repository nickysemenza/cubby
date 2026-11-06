import Foundation

/// Availability supplied by entity reads. An absent array uses the existing plan requirements.
public struct ActionAvailability: Codable, Sendable, Hashable {
    public let id: String
    public let enabled: Bool
    public let reason: String?

    public init(id: String, enabled: Bool, reason: String? = nil) {
        self.id = id
        self.enabled = enabled
        self.reason = reason
    }
}

public struct PlacedAction: Sendable, Hashable, Identifiable {
    public let id: String
    public let enabled: Bool
    public let reason: String?
    public let isQuickField: Bool
}

/// Shared action ordering; rendering and execution remain owned by the surface and runner.
public struct ActionPlacement: Sendable {
    public let leadingSwipe: [PlacedAction]
    public let trailingSwipe: [PlacedAction]
    public let contextMenu: [[PlacedAction]]
    public let rowCommand: PlacedAction?
    public let selectionBar: [PlacedAction]
    public let actionBar: [PlacedAction]
    public let more: [[PlacedAction]]

    public init(
        entity: EntityDescriptor, raw: JSONValue, availability: [ActionAvailability]? = nil,
        selectionCount: Int = 1
    ) {
        let presentation = entity.presentation
        let server = availability.map {
            Dictionary($0.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        }
        func action(_ id: String, quickField: Bool = false) -> PlacedAction {
            let plan = EntityHeroActionID(rawValue: id).flatMap {
                HeroActionRunner.plan(for: $0, on: entity.key)
            }
            let fallback = plan.flatMap { HeroActionRunner.unmet($0, in: raw) }
            let entry = server?[id]
            if quickField { return PlacedAction(id: id, enabled: true, reason: nil, isQuickField: true) }
            let reason = entry?.reason ?? (server == nil ? fallback : nil)
            return PlacedAction(
                id: id, enabled: entry?.enabled ?? (server == nil ? fallback == nil : false), reason: reason,
                isQuickField: quickField)
        }
        func unique(_ ids: [String]) -> [String] {
            var seen = Set<String>()
            return ids.filter { seen.insert($0).inserted }
        }
        func plan(_ id: String) -> HeroActionPlan? {
            EntityHeroActionID(rawValue: id).flatMap { HeroActionRunner.plan(for: $0, on: entity.key) }
        }
        let verbs = presentation.heroActions.map(\.rawValue).filter { $0 != "edit" && $0 != "delete" }
        let listVerbs = presentation.listActions.filter { !["bulkEdit", "merge", "delete"].contains($0) }
        let routine = verbs.filter { plan($0)?.runsOnTap == true && plan($0)?.confirmation != .destructive }
        let quick = presentation.detailQuickActionIDs.map(\.rawValue)
        let tiles = unique(quick + routine).filter { plan($0)?.confirmation != .destructive }.map {
            action($0)
        }
        actionBar = Array(
            (tiles + (presentation.detailQuickFields ?? []).map { action($0, quickField: true) }).prefix(4))
        let rowCandidates = unique(
            (presentation.listQuickActions ?? [])
                + listVerbs.filter { plan($0)?.runsOnTap == true && plan($0)?.confirmation != .destructive })
        let leading = presentation.listSwipe?.leading ?? rowCandidates
        let destructive = listVerbs.filter { plan($0)?.confirmation == .destructive }
        let trailing =
            presentation.listSwipe?.trailing
            ?? (destructive + (presentation.listActions.contains("delete") ? ["delete"] : []))
        leadingSwipe =
            presentation.listSwipeDisabled == true
            ? [] : Array(leading.map { action($0) }.filter(\.enabled).prefix(2))
        trailingSwipe =
            presentation.listSwipeDisabled == true ? [] : trailing.map { action($0) }.filter(\.enabled)
        rowCommand = presentation.listRowCommand.map { action($0) }.flatMap { $0.enabled ? $0 : nil }
        let rowMenu = listVerbs.map { action($0) }.filter {
            $0.enabled && plan($0.id)?.confirmation != .destructive
        }
        let editSelect = (["edit", "select"]).filter { id in
            id == "select" || presentation.heroActions.contains { $0.rawValue == id }
        }.map { id in
            id == "select"
                ? PlacedAction(id: id, enabled: true, reason: nil, isQuickField: false) : action(id)
        }.filter(\.enabled)
        let sharing = ["copy", "share", "openOnWeb"].map {
            PlacedAction(id: $0, enabled: true, reason: nil, isQuickField: false)
        }
        let destructiveMenu = (destructive + (presentation.listActions.contains("delete") ? ["delete"] : []))
            .map { action($0) }.filter(\.enabled)
        contextMenu = [rowMenu, editSelect, sharing, destructiveMenu].filter { !$0.isEmpty }
        selectionBar = presentation.listActions.filter { ["bulkEdit", "merge", "delete"].contains($0) }.map {
            let item = action($0)
            return $0 == "merge" && selectionCount < 2
                ? PlacedAction(
                    id: $0, enabled: false, reason: "Select at least two records.", isQuickField: false)
                : item
        }
        let moreVerbs = verbs.filter { plan($0)?.confirmation != .destructive }.map { action($0) }
        let destructiveDetail =
            (verbs.filter { plan($0)?.confirmation == .destructive }
            + (presentation.heroActions.contains { $0.rawValue == "delete" } ? ["delete"] : [])).map {
                action($0)
            }
        let create =
            presentation.heroImages
            ? [PlacedAction(id: "addPhoto", enabled: true, reason: nil, isQuickField: false)] : []
        more = [moreVerbs, create, sharing, destructiveDetail].filter { !$0.isEmpty }
    }
}
