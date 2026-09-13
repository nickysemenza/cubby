import CubbyKit
import Foundation

#if os(iOS)
    import UIKit
#elseif os(macOS)
    import AppKit
#endif

extension AppModel {
    /// The web URL for any entity by its shortcode id (`PRD-…`, `LOC-…`, …). The web's
    /// `/$shortcode` route redirects to that entity's detail page, so this is the one URL
    /// Handoff, `ShareLink`, and "Copy link" all share — no per-entity-kind path building.
    func webURL(for id: String) -> URL {
        baseURL.appending(path: id)
    }
}

/// One cross-platform string-to-pasteboard call, so "Copy link"/"Copy shortcode" on
/// `EntityDetailView` and `EntityListView` share a single implementation.
enum Clipboard {
    static func copy(_ string: String) {
        #if os(iOS)
            UIPasteboard.general.string = string
        #elseif os(macOS)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(string, forType: .string)
        #endif
    }
}
