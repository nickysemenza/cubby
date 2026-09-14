import Foundation

/// Cloudflare Image Transformations URL rewriting — the Swift twin of
/// `apps/web/src/lib/image-url.ts`. Kept byte-for-byte in sync so native and web mint IDENTICAL
/// transform URLs and share one Cloudflare edge-cache entry (and, in the browser, one HTTP cache
/// entry) per rendered size. A pure, client-safe function: no networking, no I/O.
public enum ImageTransform {
    /// Three variants per image, ever. Every caller asks for 2x its rendered point width (retina
    /// is the primary client) and snaps UP to a rung, so a 16pt identity mark, a 40pt card, and a
    /// 64pt table cell of the same photo share one URL. Mirrors `IMAGE_WIDTHS` in image-url.ts —
    /// keep both lists identical or the two clients stop sharing cache entries.
    public static let widths: [Int] = [128, 640, 2048]

    /// The R2 bucket's public host. Mirrors `R2_PUBLIC_URL` in `apps/web/wrangler.jsonc`
    /// (`"https://media.nickysemenza.com"`). Hard-coded rather than read from a manifest at
    /// runtime — the same posture as `AppModel.productionBaseURL` hard-coding the API host: this
    /// is deployment config baked in at build time, not something negotiated per-request.
    private static let bucketHost = "media.nickysemenza.com"

    /// Transform width for a rendered width in points: 2x for retina, snapped up to the next
    /// rung, falling back to the largest rung. `displayScale` is deliberately ignored — the goal
    /// is one URL per rendered *point* size shared across every device's scale factor (and with
    /// the web client, which has no displayScale concept at all), not a per-device optimum.
    /// Mirrors `transformWidth` in image-url.ts.
    public static func transformWidth(renderedWidth: CGFloat) -> Int {
        let target = renderedWidth * 2
        return widths.first(where: { CGFloat($0) >= target }) ?? widths[widths.count - 1]
    }

    /// Rewrites a bucket image URL to request a width-bounded, auto-format variant via
    /// Cloudflare Image Transformations. Returns `url` unchanged for any non-bucket host or a
    /// path already under `/cdn-cgi/image/` (already transformed). Mirrors `transformedImageUrl`
    /// in image-url.ts, including `fit=scale-down` (never upscales a small original) and
    /// `format=auto` (negotiates AVIF/WebP per the request's Accept header).
    public static func transformed(_ url: URL, renderedWidth: CGFloat) -> URL {
        guard url.host?.lowercased() == bucketHost,
            !url.path.hasPrefix("/cdn-cgi/")
        else { return url }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        let width = transformWidth(renderedWidth: renderedWidth)
        let opts = "width=\(width),quality=80,format=auto,fit=scale-down"
        let scheme = components.scheme.map { "\($0)://" } ?? ""
        let host = components.host ?? ""
        let port = components.port.map { ":\($0)" } ?? ""
        let query = components.percentEncodedQuery.map { "?\($0)" } ?? ""
        let rewritten =
            "\(scheme)\(host)\(port)/cdn-cgi/image/\(opts)\(components.percentEncodedPath)\(query)"
        return URL(string: rewritten) ?? url
    }

    /// Stable repair source for server images missing a hash: full frame, bounded on both axes,
    /// and JPEG regardless of the caller's Accept header.
    public static func hashSource(_ url: URL) -> URL {
        guard url.host?.lowercased() == bucketHost,
            !url.path.hasPrefix("/cdn-cgi/")
        else { return url }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        let opts = "width=256,height=256,quality=80,format=jpeg,fit=scale-down"
        let scheme = components.scheme.map { "\($0)://" } ?? ""
        let host = components.host ?? ""
        let port = components.port.map { ":\($0)" } ?? ""
        let query = components.percentEncodedQuery.map { "?\($0)" } ?? ""
        return URL(
            string:
                "\(scheme)\(host)\(port)/cdn-cgi/image/\(opts)\(components.percentEncodedPath)\(query)"
        ) ?? url
    }
}
