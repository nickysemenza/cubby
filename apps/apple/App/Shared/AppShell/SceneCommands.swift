import CubbyKit
import SwiftUI

/// What the File menu's record commands (Open on Web ⌥⌘O, Copy Link ⇧⌘C, New ⌘N) act on in one
/// window: the record in front of the member, else the visible list.
enum CommandTarget: Equatable {
    case record(RecordSelection)
    case list(EntityKey)

    var key: EntityKey {
        switch self {
        case .record(let record): record.key
        case .list(let key): key
        }
    }

    /// Lists open their web index (`/expenses`), which shares the manifest `basePath`; native list
    /// filters have no web query contract, so the index opens unfiltered.
    var webTarget: WebHandoff.Target {
        switch self {
        case .record(let record): .record(key: record.key, id: record.id)
        case .list(let key): .route(path: "/\(EntityCatalog[key].basePath)")
        }
    }
}

extension Navigator {
    /// A pushed record or list wins over the column selection beneath it; sections without a
    /// record column (Today, Capture, Settings) have no target until something is pushed.
    var commandTarget: CommandTarget? {
        if let top = paths[section]?.last {
            switch top {
            case .entityDetail(let key, let id): return .record(RecordSelection(key: key, id: id))
            case .entityList(let key, _, _): return .list(key)
            default: return nil
            }
        }
        switch section {
        case .activity:
            switch selectedActivity {
            case .serverRun(let id): return .record(RecordSelection(key: .run, id: id))
            case .localActivity, nil: return nil
            }
        case .browse, .search:
            if let record = selectedRecords[section] { return .record(record) }
            return section == .browse ? browseKey.map(CommandTarget.list) : nil
        default:
            return nil
        }
    }
}

/// The plain text ⌘C puts on the pasteboard for a selected row or an open record: its shortcode,
/// or the title for entities identified by an external id (USDA foods).
enum RecordCopyText {
    static func text(key: EntityKey, id: String, title: String) -> String {
        EntityCatalog[key].shortcodePrefix == nil ? title : id
    }
}

/// Creatable entities for File › New, grouped like Browse: by domain, then plural name.
enum NewRecordMenu {
    static var groups: [(domain: AppDomain, descriptors: [EntityDescriptor])] {
        AppDomain.allCases.compactMap { domain in
            let descriptors = EntityCatalog.all
                .filter { $0.key.domain == domain && $0.key.nativeActions.contains(.create) }
                .sorted { $0.singular < $1.singular }
            return descriptors.isEmpty ? nil : (domain, descriptors)
        }
    }
}

/// Published by the Mac root for its window so menu commands act on the focused scene, not on
/// whichever window last set `AppModel.active`.
struct SceneCommandActions {
    let target: CommandTarget?
    let create: (EntityKey) -> Void
}

/// Published by the visible list with a primary search, so ⌘F filters the list in front of the
/// member instead of leaving it for global Search.
struct ListSearchAction {
    let plural: String
    let focus: () -> Void
}

struct NewRecordRequest: Identifiable {
    let key: EntityKey
    var id: EntityKey { key }
}

extension FocusedValues {
    @Entry var sceneCommands: SceneCommandActions?
    @Entry var listSearch: ListSearchAction?
}
