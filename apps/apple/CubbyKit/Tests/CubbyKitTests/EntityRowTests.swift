import Foundation
import Testing

@testable import CubbyKit

@Suite("EntityRow")
struct EntityRowTests {
    private let product = EntityCatalog[.product]

    @Test func nilWhenIdIsMissing() {
        let object: JSONValue = ["name": "Sample Product"]
        #expect(product.row(from: object) == nil)
    }

    @Test func titleUsesTheDescriptorsTitleField() {
        let object: JSONValue = ["id": "PRD-2345", "name": "Sample Product"]
        let row = product.row(from: object)
        #expect(row?.title == "Sample Product")
    }

    @Test func titleFallsBackToIdWhenTitleFieldIsMissing() {
        let object: JSONValue = ["id": "PRD-2345"]
        let row = product.row(from: object)
        #expect(row?.title == "PRD-2345")
    }

    @Test func titleFallsBackToIdWhenTitleFieldIsEmpty() {
        let object: JSONValue = ["id": "PRD-2345", "name": ""]
        let row = product.row(from: object)
        #expect(row?.title == "PRD-2345")
    }

    @Test func titleFallsBackToIdWhenTitleFieldIsNull() {
        let object: JSONValue = ["id": "PRD-2345", "name": nil]
        let row = product.row(from: object)
        #expect(row?.title == "PRD-2345")
    }

    @Test func titleFallsBackToIdWhenTitleFieldIsNonString() {
        let object: JSONValue = ["id": "PRD-2345", "name": 42]
        let row = product.row(from: object)
        #expect(row?.title == "PRD-2345")
    }

    @Test func imageURLPrefersDisplayImagesFirstEntry() {
        let object: JSONValue = [
            "id": "PRD-2345",
            "name": "Sample",
            "displayImages": [
                ["id": "IMG-1", "url": "https://images.example/first.jpg"],
                ["id": "IMG-2", "url": "https://images.example/second.jpg"],
            ],
            "coverImageUrl": "https://images.example/cover.jpg",
            "images": [["status": "UPLOADED", "url": "https://images.example/other.jpg"]],
        ]
        let row = product.row(from: object)
        #expect(row?.imageURL == URL(string: "https://images.example/first.jpg"))
    }

    @Test func imageURLUsesPreferredRepresentationAndFallsBackToOriginalURL() {
        let preferred: JSONValue = [
            "id": "PRD-2345",
            "name": "Sample",
            "displayImages": [
                [
                    "id": "IMG-1", "url": "https://images.example/original.heic",
                    "representations": [
                        "original": "https://images.example/original.heic",
                        "transparent": "https://images.example/cutout.png",
                        "preferred": "https://images.example/cutout.png",
                        "preferredKind": "transparent",
                    ],
                ]
            ],
        ]
        let originalOnly: JSONValue = [
            "id": "PRD-3456", "name": "Other",
            "displayImages": [
                ["id": "IMG-2", "url": "https://images.example/original.jpg"]
            ],
        ]

        #expect(
            product.row(from: preferred)?.imageURL
                == URL(string: "https://images.example/cutout.png"))
        #expect(
            product.row(from: originalOnly)?.imageURL
                == URL(string: "https://images.example/original.jpg"))
    }

    @Test func imageURLDoesNotDeriveFromLegacyCoverWhenDisplayImagesAbsent() {
        let object: JSONValue = [
            "id": "PRD-2345",
            "name": "Sample",
            "coverImageUrl": "https://images.example/cover.jpg",
            "images": [["status": "UPLOADED", "url": "https://images.example/other.jpg"]],
        ]
        let row = product.row(from: object)
        #expect(row?.imageURL == nil)
    }

    @Test func imageURLDoesNotDeriveFromLegacyCoverWhenDisplayImagesEmpty() {
        let object: JSONValue = [
            "id": "PRD-2345",
            "name": "Sample",
            "displayImages": [],
            "coverImageUrl": "https://images.example/cover.jpg",
        ]
        let row = product.row(from: object)
        #expect(row?.imageURL == nil)
    }

    @Test func imageURLNilWhenDisplayImagesEmptyAndNoCover() {
        let object: JSONValue = [
            "id": "PRD-2345",
            "name": "Sample",
            "displayImages": [],
        ]
        let row = product.row(from: object)
        #expect(row?.imageURL == nil)
    }

    /// A bare `images` array of `{status,url}` objects — the pre-`displayImages` shape some
    /// payloads still carry — is never read for `imageURL`.
    @Test func imageURLIsNilWithoutACoverRegardlessOfImages() {
        let object: JSONValue = [
            "id": "PRD-2345",
            "name": "Sample",
            "images": [
                ["status": "PENDING", "url": "https://images.example/pending.jpg"],
                ["status": "UPLOADED", "url": "https://images.example/ready.jpg"],
            ],
        ]
        let row = product.row(from: object)
        #expect(row?.imageURL == nil)
    }

    @Test func imageURLNilWhenNoCoverAndNoReadyImage() {
        let object: JSONValue = [
            "id": "PRD-2345",
            "name": "Sample",
            "images": [["status": "PENDING", "url": "https://images.example/pending.jpg"]],
        ]
        let row = product.row(from: object)
        #expect(row?.imageURL == nil)
    }

    /// `planting` and `gardenEntry` title from the server's `displayName`
    /// (`docs/terminology.md` § Garden) rather than a raw crop or kind field — both descriptors'
    /// generated `titleField` is `"displayName"` (`EntityCatalog.swift`).
    @Test(
        arguments: [
            (
                EntityKey.planting,
                [
                    "id": "PLT-2345", "ingredientId": "ING-2345",
                    "displayName": "Tomato · San Marzano",
                ] as JSONValue,
                "Tomato · San Marzano"
            ),
            (
                EntityKey.gardenEntry,
                [
                    "id": "GDE-2345", "kind": "observation",
                    "displayName": "Note · Jan 15 · Raised bed A",
                ] as JSONValue,
                "Note · Jan 15 · Raised bed A"
            ),
        ]
    )
    func rowTitlesFromDisplayName(key: EntityKey, object: JSONValue, expectedTitle: String) {
        #expect(EntityCatalog[key].row(from: object)?.title == expectedTitle)
    }

    /// A slot that needs a typed view of a row gets it from `raw`, dates included: the fixture
    /// mixes fractional and plain timestamps, which only `JSONDecoder.cubby()` accepts.
    @Test func decodesTheRawPayloadIntoATypedAlias() throws {
        let raw = try Fixtures.decode(JSONValue.self, from: "product-get.json")
        let row = try #require(product.row(from: raw))
        let detail = try row.decode(ProductDetail.self)
        #expect(detail.id == ProductCode("PRD-2345"))
        #expect(detail.name == row.title)
        #expect(detail.manufacturer == "Sample Manufacturer")
        #expect(detail.createdAt.timeIntervalSince1970 > 0)
    }

    /// Product image attachments carry their attachment purpose alongside the shared image
    /// provenance. This must remain one flattened wire object: a closed `allOf` image schema
    /// rejects the otherwise valid `purpose` key in generated Swift decoding.
    @Test func productImageAttachmentDecodesSourceAndPurposeTogether() throws {
        var payload = try #require(
            Fixtures.decode(JSONValue.self, from: "product-get.json").objectValue)
        payload["images"] = [
            [
                "id": "IMG-2345",
                "url": "https://images.example/catalog.jpg",
                "key": "products/catalog.jpg",
                "filename": "catalog.jpg",
                "size": 123,
                "contentType": "image/jpeg",
                "status": "UPLOADED",
                "source": "catalog",
                "sourcePageUrl": "https://catalog.example/products/sample",
                "sourceAssetUrl": "https://catalog.example/images/sample.jpg",
                "sourceName": "Example Catalog",
                "useOriginal": true,
                "captureAttribution": "none",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "purpose": "item",
            ]
        ]

        let row = try #require(product.row(from: .object(payload)))
        let attachment = try #require(try row.decode(ProductDetail.self).images.first)
        #expect(attachment.source == .catalog)
        #expect(attachment.purpose == .item)
    }

    @Test func imageIDsReadAttachmentsInOrder() {
        let object: JSONValue = [
            "id": "PRD-2345", "name": "Sample",
            "attachments": [
                ["id": "IMG-0002", "url": "https://images.example/b.jpg"],
                ["id": "IMG-0001", "url": "https://images.example/a.jpg"],
            ],
        ]
        #expect(product.row(from: object)?.imageIDs == [ImageCode("IMG-0002"), ImageCode("IMG-0001")])
        #expect(product.row(from: ["id": "PRD-2345"])?.imageIDs == [])
    }

    /// The subtitle is the catalog's `mobile.slot: subtitle` columns in priority order (product:
    /// manufacturer 20, category 30), not a hand-named key.
    @Test func subtitleFollowsTheCatalogSubtitleSlotPriority() {
        let withManufacturer: JSONValue = [
            "id": "PRD-2345", "name": "Sample", "manufacturer": "Acme",
            "category": [
                "id": "CAT-2224", "name": "Tools", "path": [["id": "CAT-2224", "name": "Tools"]],
                "feature": "tools",
            ],
        ]
        #expect(product.row(from: withManufacturer)?.subtitle == "Acme")

        let categoryOnly: JSONValue = [
            "id": "PRD-2345", "name": "Sample", "categoryId": "CAT-2224",
            "category": [
                "id": "CAT-2224", "name": "Tools", "path": [["id": "CAT-2224", "name": "Tools"]],
                "feature": "tools",
            ],
        ]
        #expect(product.row(from: categoryOnly)?.subtitle == "Tools")

        let neither: JSONValue = ["id": "PRD-2345", "name": "Sample"]
        #expect(product.row(from: neither)?.subtitle == nil)
    }
}
