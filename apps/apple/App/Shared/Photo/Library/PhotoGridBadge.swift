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
    static func text(for directOwnerShortcodes: [String]) -> String? {
        let owners = Set(directOwnerShortcodes.filter { !$0.isEmpty }).sorted()
        guard let primary = owners.first else { return nil }
        return owners.count == 1 ? primary : "\(primary)+\(owners.count - 1)"
    }

    static func accessibilityDescription(for directOwnerShortcodes: [String]) -> String? {
        guard let text = text(for: directOwnerShortcodes) else { return nil }
        return "Owned by \(text)"
    }
}

/// Everything a grid cell needs to render its badge and accessibility status, derived once
/// store-side per `localIdentifier` instead of read live from `PhotoMatchStore`'s dictionaries.
/// Observation tracks whole-property access on an `@Observable` class, not dictionary keys, so a
/// cell reading `photoMatches.candidates`/`directOwnersByImageID` directly re-renders on every
/// scan batch touching *any* asset, not just its own. `PhotoMatchStore` publishes this into a
/// per-id `PhotoGridCellStateBox` instead, so a cell observing only its own box's `state`
/// re-renders solely when its own status changes.
struct PhotoGridCellState: Equatable, Sendable {
    var badgeText: String?
    var represented: Bool
    var possibleMatch: Bool
    var known: Bool
    var accessibilityStatus: String
    /// On-device classification status (B3/B4): drives the grid cell's 6pt dot. Defaulted so
    /// existing call sites that predate the classification sweep still compile unchanged.
    var analysis: PhotoAnalysisStatus = .pending
    /// Developer overlays layer 1: how long the on-device classifier took, and its top label —
    /// published per-id from the same store box as `analysis`, never a new whole-store read.
    var classifyMs: Double?
    var topLabel: String?

    /// `checked` distinguishes "no match, confirmed" from "not looked at yet" once a photo has
    /// no candidates at all — both otherwise look identical (empty `storedCandidates`).
    static func derive(
        storedCandidates: [DedupCandidate],
        strongDirectOwnerShortcodes: [String],
        hasKnownResult: Bool,
        checked: Bool,
        analysis: PhotoAnalysisStatus = .pending,
        classifyMs: Double? = nil,
        topLabel: String? = nil
    ) -> PhotoGridCellState {
        let represented = storedCandidates.contains { $0.confidence == .strong }
        let possibleMatch = !represented && !storedCandidates.isEmpty
        let known = checked && hasKnownResult
        let badgeDescription = PhotoGridBadge.accessibilityDescription(for: strongDirectOwnerShortcodes)
        let status: String
        if let badgeDescription {
            status = badgeDescription
        } else if represented {
            status = "In Cubby"
        } else if possibleMatch {
            status = "Possible Cubby match"
        } else {
            status = known ? "No known match" : "Not checked"
        }
        return PhotoGridCellState(
            badgeText: PhotoGridBadge.text(for: strongDirectOwnerShortcodes),
            represented: represented, possibleMatch: possibleMatch, known: known,
            accessibilityStatus: status, analysis: analysis, classifyMs: classifyMs, topLabel: topLabel)
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
