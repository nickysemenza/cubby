import Foundation
import Testing

@testable import CubbyKit

@Suite("CubbyLink")
struct CubbyLinkTests {
    private func link(_ string: String) -> CubbyLink? {
        URL(string: string).flatMap(CubbyLink.init(url:))
    }

    @Test func entityLinksResolveTheKindFromThePrefix() {
        #expect(link("cubby://entity/PRD-2345") == .entity(.product, id: "PRD-2345"))
        #expect(link("cubby://entity/loc-2345") == .entity(.location, id: "LOC-2345"))
        #expect(link("cubby://entity/RCP-2345") == .entity(.recipe, id: "RCP-2345"))
    }

    @Test func captureAndAuditTakeAnOptionalLocation() {
        #expect(link("cubby://capture") == .capture(location: nil))
        #expect(link("cubby://capture?location=LOC-2345") == .capture(location: LocationCode("LOC-2345")))
        #expect(link("cubby://audit?location=LOC-2345") == .audit(location: LocationCode("LOC-2345")))
        #expect(link("cubby://today") == .today)
        #expect(link("cubby://search") == .search)
    }

    @Test func rejectsWrongSchemeHostOrScope() {
        #expect(link("cubby-mobile://entity/PRD-2345") == nil)
        #expect(link("cubby://entity/XYZ-1") == nil)
        #expect(link("cubby://entity") == nil)
        #expect(link("cubby://widgets") == nil)
        // A capture scoped to a product is a malformed link, not an unscoped capture.
        #expect(link("cubby://capture?location=PRD-2345") == nil)
    }

    @Test func universalLinksResolveTheShortcodeInTheLastPathSegment() {
        // The printed label URL: bare shortcode as the whole path.
        #expect(link("https://cubby.nickysemenza.com/LOC-A3F2") == .entity(.location, id: "LOC-A3F2"))
        // A friendlier `/locations/<code>` form — only the last segment matters.
        #expect(
            link("https://cubby.nickysemenza.com/locations/LOC-A3F2") == .entity(.location, id: "LOC-A3F2"))
        // Host-agnostic: the app's configured base URL resolves the same way as the prod host.
        #expect(link("http://localhost:3000/PRD-X7K9") == .entity(.product, id: "PRD-X7K9"))
        // A real route that isn't a shortcode, and a bare host, both fail to resolve.
        #expect(link("https://cubby.nickysemenza.com/recipes") == nil)
        #expect(link("https://example.com/") == nil)
        // Labels printed before the prefix cutover carry the legacy single-letter prefix.
        #expect(link("https://cubby.nickysemenza.com/L-A3F2") == .entity(.location, id: "LOC-A3F2"))
    }

    @Test func roundTrips() throws {
        let links: [CubbyLink] = [
            .entity(.product, id: "PRD-2345"),
            .capture(location: nil),
            .capture(location: LocationCode("LOC-2345")),
            .audit(location: LocationCode("LOC-2345")),
            .today,
            .search,
        ]
        for original in links {
            #expect(CubbyLink(url: original.url) == original)
        }
        #expect(CubbyLink.entity(.product, id: "PRD-2345").url.absoluteString == "cubby://entity/PRD-2345")
    }
}
