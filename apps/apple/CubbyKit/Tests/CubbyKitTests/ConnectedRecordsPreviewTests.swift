import Foundation
import Testing

@testable import CubbyKit

@Suite("ConnectedRecordsPreview")
struct ConnectedRecordsPreviewTests {
    /// The preview carries no per-view hop range; each row's own `shortestHops` is its label.
    @Test func decodesViewsAndPaths() throws {
        let json = """
            {"views":[
              {"viewKey":"recipes","evidence":false,"title":"Recipes","targetEntity":"recipe","totalCount":4,
               "items":[{"target":{"entityKind":"recipe","entityId":"RCP-2345","label":"Synthetic soup"},
                 "shortestHops":2,
                 "paths":[[{"entityKind":"product","entityId":"PRD-4K7M","label":"Synthetic oat milk"},
                           {"entityKind":"ingredient","entityId":"ING-2345","label":"Synthetic oat milk"},
                           {"entityKind":"recipe","entityId":"RCP-2345","label":"Synthetic soup"}]]}]},
              {"viewKey":"projects","evidence":false,"title":"Projects","targetEntity":"project","totalCount":0,"items":[]},
              {"viewKey":"tasks","evidence":false,"title":"Tasks","targetEntity":"task","totalCount":0,"items":[]}
            ]}
            """
        let preview = try JSONDecoder.cubby().decode(
            ConnectedRecordsPreviewOutput.self, from: Data(json.utf8))
        let item = try #require(preview.views.first?.items.first)
        #expect(ConnectedPathPresentation.hopLabel(item.shortestHops) == "2 hops")
        #expect(ConnectedPathPresentation.hopLabel(1) == "1 hop")
        let path = try #require(item.paths.first)
        #expect(ConnectedPathPresentation.intermediates(path).map(\.entityId) == ["ING-2345"])
        #expect(ConnectedPathPresentation.intermediates(Array(path.prefix(2))).isEmpty)
    }
}
