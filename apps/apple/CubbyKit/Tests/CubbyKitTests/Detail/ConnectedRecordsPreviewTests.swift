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
        #expect(item.target.imageURL == nil)
    }

    /// A cover rides on the node that names the record. The row reads that URL
    /// and does not look one up itself.
    @Test func readsTheCanonicalCoverFromTheNamedRecord() throws {
        let json = """
            {"target":{"entityKind":"image","entityId":"IMG-X3MFY","label":"IMG_0019.heic",
              "image":{"url":"https://images.example/original.heic",
                "representations":{"original":"https://images.example/original.heic",
                  "transparent":"https://images.example/cutout.png","preferred":"https://images.example/cutout.png",
                  "preferredKind":"transparent"}}},
             "shortestHops":1,
             "paths":[[{"entityKind":"meal","entityId":"MEL-2345","label":"Stir fried rice cakes"},
                       {"entityKind":"image","entityId":"IMG-X3MFY","label":"IMG_0019.heic",
                         "image":{"url":"https://images.example/cutout.png"}}]]}
            """
        let item = try JSONDecoder.cubby().decode(ConnectedRecord.self, from: Data(json.utf8))
        #expect(item.target.imageURL?.absoluteString == "https://images.example/cutout.png")
        #expect(item.paths.first?.first?.imageURL == nil)
        let event = try JSONDecoder.cubby().decode(
            DetailActivityEvent.self,
            from: Data(
                """
                {"id":"record:image:IMG-X3MFY","kind":"record","entity":"image","shortcode":"IMG-X3MFY",
                 "title":"IMG_0019.heic","date":"2026-11-10T19:36:45.000Z","allDay":false,
                 "image":{"url":"https://images.example/original.heic"}}
                """.utf8))
        #expect(event.imageURL?.absoluteString == "https://images.example/original.heic")
    }
}
