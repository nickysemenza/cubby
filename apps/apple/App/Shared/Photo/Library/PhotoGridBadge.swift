import CubbyKit
import Foundation
import Observation
import SwiftUI

/// The small ownership label shown in the Photos grid.
///
/// Selection order is rendered by the cell before this label. Ownership is
/// deliberately a display-only concern: it never changes the selected photo
/// or the importer destination.
enum PhotoGridBadge {
    static func owners(for directOwnerShortcodes: [String]) -> [String] {
        Set(directOwnerShortcodes.filter { !$0.isEmpty }).sorted()
    }

    /// Only the entity-type prefix ("GDE" for "GDE-7AP4"): the full code crowded a ~100pt grid
    /// tile, and the detail sheet lists (and links) every full owner code. The accessibility
    /// description below still reads the full codes.
    static func text(for directOwnerShortcodes: [String]) -> String? {
        let owners = owners(for: directOwnerShortcodes)
        guard let primary = owners.first.map(prefix) else { return nil }
        return owners.count == 1 ? primary : "\(primary)+\(owners.count - 1)"
    }

    static func prefix(_ shortcode: String) -> String {
        shortcode.split(separator: "-", maxSplits: 1).first.map(String.init) ?? shortcode
    }

    static func accessibilityDescription(for directOwnerShortcodes: [String]) -> String? {
        let owners = owners(for: directOwnerShortcodes)
        guard !owners.isEmpty else { return nil }
        return "Owned by \(owners.joined(separator: ", "))"
    }

    static func possibleText(for directOwnerShortcodes: [String]) -> String? {
        text(for: directOwnerShortcodes).map { "\($0)?" }
    }
}

/// The match result for one grid photo. Ownership is intentionally separate: a match can exist
/// without a direct owner, and a possible match's owner remains a review hint rather than proof.
enum PhotoGridMatchState: String, Equatable, Sendable {
    case unchecked
    case checking
    case strong
    case possible
    case unmatched
    case unavailable
}

/// Everything a grid cell needs to render its badge and accessibility status, derived once
/// store-side per `localIdentifier` instead of read live from `PhotoMatchStore`'s dictionaries.
/// Observation tracks whole-property access on an `@Observable` class, not dictionary keys, so a
/// cell reading `photoMatches.candidates`/`directOwnersByImageID` directly re-renders on every
/// scan batch touching *any* asset, not just its own. `PhotoMatchStore` publishes this into a
/// per-id `PhotoGridCellStateBox` instead, so a cell observing only its own box's `state`
/// re-renders solely when its own status changes.
struct PhotoGridCellState: Equatable, Sendable {
    var matchState: PhotoGridMatchState
    var ownerBadgeText: String?
    var accessibilityStatus: String
    /// A partial server index must not be presented as a complete negative result in diagnostics.
    var indexIsComplete: Bool
    /// The server failure is retained for inspector context even when cached positive candidates
    /// still give the grid a useful strong/possible state.
    var serverError: String? = nil
    /// On-device classification status (B3/B4): drives the grid cell's 6pt dot. Defaulted so
    /// existing call sites that predate the classification sweep still compile unchanged.
    var analysis: PhotoAnalysisStatus = .pending
    /// Developer overlays layer 1: how long the on-device classifier took, and its top label —
    /// published per-id from the same store box as `analysis`, never a new whole-store read.
    var classifyMs: Double?
    var topLabel: String?

    // Compatibility projections for the grid while its root view adopts `matchState`.
    var badgeText: String? { ownerBadgeText }
    var represented: Bool { matchState == .strong }
    var possibleMatch: Bool { matchState == .possible }
    var known: Bool { [.strong, .possible, .unmatched].contains(matchState) }

    /// Pending registration distinguishes "still checking" from a completed empty result. A
    /// server failure preserves cached positive evidence but makes a stale negative unavailable.
    static func derive(
        storedCandidates: [DedupCandidate],
        strongDirectOwnerShortcodes: [String],
        possibleDirectOwnerShortcodes: [String] = [],
        hasKnownResult: Bool,
        isPending: Bool,
        indexIsComplete: Bool,
        serverError: String?,
        analysis: PhotoAnalysisStatus = .pending,
        classifyMs: Double? = nil,
        topLabel: String? = nil
    ) -> PhotoGridCellState {
        let matchState: PhotoGridMatchState
        if storedCandidates.contains(where: { $0.confidence == .strong }) {
            matchState = .strong
        } else if !storedCandidates.isEmpty {
            matchState = .possible
        } else if serverError != nil {
            matchState = .unavailable
        } else if hasKnownResult {
            matchState = .unmatched
        } else if isPending {
            matchState = .checking
        } else {
            matchState = .unchecked
        }
        let ownerBadgeText: String?
        switch matchState {
        case .strong:
            ownerBadgeText = PhotoGridBadge.text(for: strongDirectOwnerShortcodes)
        case .possible:
            ownerBadgeText = PhotoGridBadge.possibleText(for: possibleDirectOwnerShortcodes)
        case .unchecked, .checking, .unmatched, .unavailable:
            ownerBadgeText = nil
        }
        let status: String
        switch matchState {
        case .unchecked: status = "Not checked"
        case .checking: status = "Checking Cubby match"
        case .strong:
            status = PhotoGridBadge.accessibilityDescription(for: strongDirectOwnerShortcodes) ?? "In Cubby"
        case .possible:
            let owners = PhotoGridBadge.owners(for: possibleDirectOwnerShortcodes)
            let base =
                if owners.isEmpty {
                    "Possible Cubby match"
                } else {
                    "Possible Cubby match with \(owners.joined(separator: ", "))"
                }
            status = serverError.map { "\(base). Match refresh failed: \($0)" } ?? base
        case .unmatched:
            status = indexIsComplete ? "No match found" : "No match found; Cubby index is incomplete"
        case .unavailable:
            status =
                serverError.map { "Match unavailable. \($0)" }
                ?? "Match unavailable"
        }
        return PhotoGridCellState(
            matchState: matchState, ownerBadgeText: ownerBadgeText, accessibilityStatus: status,
            indexIsComplete: indexIsComplete, serverError: serverError, analysis: analysis,
            classifyMs: classifyMs, topLabel: topLabel)
    }
}

/// The grid dot's tint: the first `PhotoImportCatalog.categories` entry a photo's hits contain,
/// colored by its *index* into the token ramp — never by category key, so no category name is a
/// Swift literal here.
enum PhotoCategoryTint {
    static func color(for categories: [String]) -> Color? {
        guard
            let index = PhotoImportCatalog.categories.firstIndex(where: { categories.contains($0.key) })
        else { return nil }
        return PorcelainTokens.chartRamp[index % PorcelainTokens.chartRamp.count]
    }
}

/// A per-id reference so a grid cell can observe one asset's state in isolation. Kept out of
/// `PhotoMatchStore`'s own `@Observable` storage (which is `@ObservationIgnored` there) so
/// mutating one box never invalidates a view that merely looked up a *different* id.
@Observable
final class PhotoGridCellStateBox {
    var state: PhotoGridCellState
    init(state: PhotoGridCellState) { self.state = state }
}
