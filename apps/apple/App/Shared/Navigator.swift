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
    /// Set by a `capture?location=` link; `CaptureView` takes it once its locations have loaded.
    var pendingCaptureLocation: LocationCode?
    /// A code found while looking something up elsewhere (Search's scan sheet), destined for
    /// Capture's manual-entry field. `CaptureView` only ever loads this into the text field — it
    /// never submits it, so stock never changes without an explicit tap.
    var pendingCaptureCode: String?
    /// A query typed or spoken elsewhere (an intent's fallback), for `SearchView` to prefill.
    var pendingSearchQuery: String?

    func path(for section: AppSection) -> Binding<[Route]> {
        Binding(
            get: { self.paths[section] ?? [] },
            set: { self.paths[section] = $0 }
        )
    }

    func open(_ link: CubbyLink) {
        switch link {
        case .entity(let key, let id):
            section = .browse
            paths[.browse] = [.entityDetail(key, id: id)]
        case .capture(let location):
            section = .capture
            paths[.capture] = []
            pendingCaptureLocation = location
        case .audit(let location):
            section = .capture
            paths[.capture] = [.audit(locationID: location)]
        case .today:
            section = .today
            paths[.today] = []
        case .search:
            section = .search
            paths[.search] = []
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
