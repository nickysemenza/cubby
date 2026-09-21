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

    /// USDA foods use numeric FDC ids rather than Cubby shortcodes, so their canonical web route
    /// needs the entity path. Every shortcode-backed entity keeps the root redirect above.
    func webURL(for key: EntityKey, id: String) -> URL {
        if key == .usdaFood {
            return baseURL.appending(path: "usda").appending(path: id)
        }
        return webURL(for: id)
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
