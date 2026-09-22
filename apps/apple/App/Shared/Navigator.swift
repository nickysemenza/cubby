import CubbyKit
import SwiftUI

/// Owns the top-level selection and one navigation path per section, so deep links, intents,
/// and Spotlight can move the app without knowing which shell (tabs or split view) is showing.
///
/// A link is consumed, not observed: applying it mutates the section and path once, so a
/// relaunch does not re-navigate.
@Observable
final class Navigator {
    var section: AppSection = .today
    var paths: [AppSection: [Route]] = [:]
    var browseKey: EntityKey?
    var selectedRecords: [AppSection: RecordSelection] = [:]
    var graphWorkspace: GraphWorkspaceSession?

    func openGraph(root: EntityRef? = nil) {
        #if os(macOS)
            section = .graph
            paths[.graph] = root.map { [.graph($0)] } ?? []
        #else
            paths[section, default: []].append(.graph(root))
        #endif
    }

    var macDestination: SidebarDestination {
        get {
            if section == .browse, let browseKey { return .entity(browseKey) }
            return .section(section)
        }
        set {
            guard newValue != macDestination else { return }
            switch newValue {
            case .section(let section):
                self.section = section
                if section == .browse {
                    browseKey = nil
                    selectedRecords[.browse] = nil
                    paths[.browse] = []
                }
            case .entity(let key):
                section = .browse
                if browseKey != key { selectedRecords[.browse] = nil }
                if browseKey != key { paths[.browse] = [] }
                browseKey = key
            }
        }
    }

    func selectRecord(_ record: RecordSelection?, in section: AppSection) {
        selectedRecords[section] = record
        paths[section] = []
    }

    func openRecord(_ record: RecordSelection) {
        #if os(macOS)
            if section == .browse || section == .search {
                if selectedRecords[section] == nil {
                    selectRecord(record, in: section)
                } else {
                    paths[section, default: []].append(.entityDetail(record.key, id: record.id))
                }
            } else {
                paths[section, default: []].append(.entityDetail(record.key, id: record.id))
            }
        #else
            paths[section, default: []].append(.entityDetail(record.key, id: record.id))
        #endif
    }

    /// Replaces a detail whose mutation coalesced it into another record, so Back never exposes
    /// the deleted source. macOS can host the current detail in the split selection or a push.
    func replaceCurrentRecord(with record: RecordSelection) {
        #if os(macOS)
            if (section == .browse || section == .search),
                (paths[section] ?? []).isEmpty
            {
                selectedRecords[section] = record
                return
            }
        #endif
        var path = paths[section] ?? []
        if path.last != nil {
            path[path.index(before: path.endIndex)] = .entityDetail(record.key, id: record.id)
        } else {
            path.append(.entityDetail(record.key, id: record.id))
        }
        paths[section] = path
    }
    /// Set by a `capture?location=` link; `CaptureView` takes it once its locations have loaded.
    var pendingCaptureLocation: LocationCode?
    /// A code found while looking something up elsewhere (Search's scan sheet), destined for
    /// Capture's manual-entry field. `CaptureView` only ever loads this into the text field — it
    /// never submits it, so stock never changes without an explicit tap.
    var pendingCaptureCode: String?
    /// A query typed or spoken elsewhere (an intent's fallback), for `SearchView` to prefill.
    var pendingSearchQuery: String?
    /// Bumped by `CubbyCommands`' ⌘F so `SearchView` can pull keyboard focus to its search field
    /// without this class needing a `FocusState` of its own (see that view's `.searchFocused`).
    var focusSearchRequest = 0
    /// Set the first time a deep link, Spotlight continuation, or Handoff activity opens a
    /// destination this launch. `RootSplitView`'s persisted-section restore checks this so a link
    /// that arrives either before or after the restore still wins — see that view's doc comment.
    private(set) var launchLinkApplied = false

    func path(for section: AppSection) -> Binding<[Route]> {
        Binding(
            get: { self.paths[section] ?? [] },
            set: { self.paths[section] = $0 }
        )
    }

    func open(_ link: CubbyLink) {
        launchLinkApplied = true
        switch link {
        case .entity(let key, let id):
            section = .browse
            #if os(macOS)
                browseKey = key
                selectRecord(RecordSelection(key: key, id: id), in: .browse)
            #else
                paths[.browse] = [.entityDetail(key, id: id)]
            #endif
        case .capture(let location):
            section = .capture
            paths[.capture] = []
            pendingCaptureLocation = location
        case .audit(let location):
            section = .capture
            paths[.capture] = [.audit(locationID: location)]
        case .photos:
            section = .photos
        case .identify:
            openIdentify()
        case .today:
            section = .today
            paths[.today] = []
        case .search:
            section = .search
            paths[.search] = []
        case .dev:
            openDev()
        case .activity(let run):
            openActivity(run.map { .serverRun($0) })
        }
    }

    /// Pushes Dev onto whatever section is currently showing on iOS, since it no longer has its
    /// own tab (`AppSection.tabs` excludes it there); on macOS, where it stays a sidebar row,
    /// selects it directly instead.
    func openDev() {
        #if os(iOS)
            paths[section, default: []].append(.dev)
        #else
            section = .dev
            paths[.dev] = []
        #endif
    }

    /// Opens a `BackgroundActivity`'s destination: a server run deep-links into Activity's list, a
    /// device-local activity opens its own detail, and `.photos` moves to the Photos tab. `nil` —
    /// no specific activity, or several running at once with no single target — lands on the
    /// Activity list itself, same as `.serverRun`/`.localActivity` with an empty path.
    func openActivity(_ link: BackgroundActivity.Link?) {
        switch link {
        case .serverRun(let id):
            section = .activity
            paths[.activity] = [.activityDetail(id)]
        case .localActivity(let id):
            section = .activity
            paths[.activity] = [.localActivity(id)]
        case .photos:
            section = .photos
        case nil:
            section = .activity
            paths[.activity] = []
        }
    }

    /// Opens Identify as part of Capture's navigation stack. Keeping the parent route in Capture
    /// makes the workflow consistent across tabs, sidebar selection, and deep-link entry points.
    func openIdentify() {
        section = .capture
        paths[.capture] = [.identify]
    }

    /// Opens an entity on top of the section the user is already in, so a result found from the
    /// Search tab reads as a push there rather than a jump to Browse. Non-entity links (capture,
    /// audit, today, search) still move sections.
    func openInPlace(_ link: CubbyLink) {
        if case .entity(let key, let id) = link {
            openRecord(RecordSelection(key: key, id: id))
        } else {
            open(link)
        }
    }

    func takeCaptureLocation() -> LocationCode? {
        defer { pendingCaptureLocation = nil }
        return pendingCaptureLocation
    }

    func takeCaptureCode() -> String? {
        defer { pendingCaptureCode = nil }
        return pendingCaptureCode
    }

    func takeSearchQuery() -> String? {
        defer { pendingSearchQuery = nil }
        return pendingSearchQuery
    }
}

struct RecordSelection: Hashable {
    let key: EntityKey
    let id: String
}

enum SidebarDestination: Hashable {
    case section(AppSection)
    case entity(EntityKey)
}
