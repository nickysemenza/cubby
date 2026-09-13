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

    @Test func imageURLFallsBackToCoverImageUrlWhenDisplayImagesAbsent() {
        let object: JSONValue = [
            "id": "PRD-2345",
            "name": "Sample",
            "coverImageUrl": "https://images.example/cover.jpg",
            "images": [["status": "UPLOADED", "url": "https://images.example/other.jpg"]],
        ]
        let row = product.row(from: object)
        #expect(row?.imageURL == URL(string: "https://images.example/cover.jpg"))
    }

    @Test func imageURLFallsBackToCoverImageUrlWhenDisplayImagesEmpty() {
        let object: JSONValue = [
            "id": "PRD-2345",
            "name": "Sample",
            "displayImages": [],
            "coverImageUrl": "https://images.example/cover.jpg",
        ]
        let row = product.row(from: object)
        #expect(row?.imageURL == URL(string: "https://images.example/cover.jpg"))
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
    /// payloads still carry — is never read for `imageURL`; only `displayImages` and
    /// `coverImageUrl` are.
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

    @Test func subtitlePrefersManufacturerThenCategory() {
        let withManufacturer: JSONValue = [
            "id": "PRD-2345", "name": "Sample", "manufacturer": "Acme", "category": "tools",
        ]
        #expect(product.row(from: withManufacturer)?.subtitle == "Acme")

        let categoryOnly: JSONValue = ["id": "PRD-2345", "name": "Sample", "category": "tools"]
        #expect(product.row(from: categoryOnly)?.subtitle == "tools")

        let neither: JSONValue = ["id": "PRD-2345", "name": "Sample"]
        #expect(product.row(from: neither)?.subtitle == nil)
    }
}
