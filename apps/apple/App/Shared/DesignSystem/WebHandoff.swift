import CubbyKit
import Foundation

#if os(iOS)
    import UIKit
#elseif os(macOS)
    import AppKit
#endif

/// The one builder of web URLs on the configured server: Handoff, `ShareLink`, "Copy link" and
/// every `OpenOnWebButton` share it.
struct WebHandoff {
    enum Target: Equatable {
        /// A record's detail page, optionally at a declared detail section (the web hash).
        case record(key: EntityKey, id: String, section: String? = nil)
        /// A web route (`/work-queue`), optionally with list query parameters; never a fragment.
        case route(path: String, query: [String: String] = [:])
    }

    let baseURL: URL

    func url(_ target: Target) -> URL {
        switch target {
        case .record(let key, let id, let section):
            // The web's `/$shortcode` route redirects to the record's detail page, so no
            // per-entity path is built. USDA foods have numeric FDC ids, not shortcodes, so their
            // canonical route names the entity.
            let page =
                key == .usdaFood
                ? baseURL.appending(path: "usda").appending(path: id) : baseURL.appending(path: id)
            guard let section else { return page }
            var components = URLComponents(url: page, resolvingAgainstBaseURL: false)
            components?.fragment = section
            return components?.url ?? page
        case .route(let path, let query):
            let page = URL(string: path, relativeTo: baseURL)?.absoluteURL ?? baseURL
            guard !query.isEmpty else { return page }
            var components = URLComponents(url: page, resolvingAgainstBaseURL: false)
            // Sorted so the same target always spells the same URL.
            components?.queryItems = query.sorted { $0.key < $1.key }.map {
                URLQueryItem(name: $0.key, value: $0.value)
            }
            return components?.url ?? page
        }
    }
}

extension AppModel {
    var webHandoff: WebHandoff { WebHandoff(baseURL: baseURL) }
}

extension NativeWebHandoff {
    /// Where this handoff opens for one record: its declared section, or the record's page.
    func target(key: EntityKey, id: String) -> WebHandoff.Target {
        .record(key: key, id: id, section: section)
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
