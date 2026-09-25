import CubbyKit
import SwiftUI

/// The typed navigation spine shared by the iOS tab stacks and the macOS split view.
enum Route: Hashable {
    case activityList
    case auditHistory
    case photosLibrary
    case browseCatalog
    case photoReview(String)
    case graph(EntityRef?)
    case nutrition(day: String)
    case activityDetail(String)
    /// A device-local `BackgroundActivity`'s own detail, resolved by id against whatever is
    /// currently reporting activities (see `BackgroundActivityCenter`). "Finished" once the id is
    /// gone rather than a distinct terminal state.
    case localActivity(String)
    /// A generic list, optionally opened with filters already applied (keyed by wire name).
    case entityList(EntityKey, filters: EntityFilterState = EntityFilterState())
    case entityDetail(EntityKey, id: String)
    /// Apparel owned by one household member or guest.
    case wardrobe(ownerID: String, ownerName: String)
    /// A walk-the-shelf recount, optionally pre-scoped to a location.
    case audit(locationID: LocationCode?)
    /// The products-without-a-photo queue, optionally narrowed to a location.
    case needsPhoto(locationID: LocationCode?)
    case locationPhotoPass(scope: LocationCode?)
    /// Product-photo matching, pushed from Capture so it stays part of the capture workflow.
    case identify
    /// Dev is a pushed screen on iOS (see `AppSection.tabs`), reached via `Navigator.openDev()`.
    case dev
}

/// Stable iOS destinations. Their paths live on root sections so a deep link into a workflow
/// selects a visible tab without replacing another tab's navigation history.
enum PhoneTab: String, CaseIterable, Identifiable {
    case work, capture, library, find

    var id: String { rawValue }

    var title: String {
        switch self {
        case .work: "Work"
        case .capture: "Capture"
        case .library: "Library"
        case .find: "Find"
        }
    }

    var symbol: String {
        switch self {
        case .work: "checklist"
        case .capture: "barcode.viewfinder"
        case .library: "books.vertical"
        case .find: "magnifyingglass"
        }
    }

    var rootSection: AppSection {
        switch self {
        case .work: .today
        case .capture: .capture
        case .library: .browse
        case .find: .search
        }
    }
}

/// Top-level sections. The Mac exposes all in its sidebar; iOS maps them into `PhoneTab`.
enum AppSection: String, CaseIterable, Identifiable {
    case today, activity, capture, photos, browse, search, graph, dev

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: "Today"
        case .activity: "Activity"
        case .capture: "Capture"
        case .photos: "Photos"
        case .browse: "Browse"
        case .search: "Search"
        case .dev: "Dev"
        case .graph: "Graph"
        }
    }

    var symbol: String {
        switch self {
        case .today: "sun.horizon"
        case .activity: "clock.arrow.trianglehead.counterclockwise.rotate.90"
        case .capture: "barcode.viewfinder"
        case .photos: "photo.on.rectangle.angled"
        case .browse: "square.grid.2x2"
        case .search: "magnifyingglass"
        case .dev: "wrench.and.screwdriver"
        case .graph: "point.3.connected.trianglepath.dotted"
        }
    }

    /// Mac sidebar destinations, retained independently of the phone tabs.
    static var tabs: [AppSection] {
        #if os(iOS)
            [.today, .capture, .browse, .search]
        #else
            allCases
        #endif
    }
}

extension EnvironmentValues {
    /// Written by the shells (iOS tabs, macOS sidebar) so a shortcut on one screen can move the
    /// top-level selection. Nil where there is no shell, which is what `#Preview` sees.
    @Entry var sectionSelection: Binding<AppSection>?
}
