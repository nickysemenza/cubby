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

    @Test func imageURLPrefersCoverImageUrl() {
        let object: JSONValue = [
            "id": "PRD-2345",
            "name": "Sample",
            "coverImageUrl": "https://images.example/cover.jpg",
            "images": [["status": "UPLOADED", "url": "https://images.example/other.jpg"]],
        ]
        let row = product.row(from: object)
        #expect(row?.imageURL == URL(string: "https://images.example/cover.jpg"))
    }

    /// Every payload's `images` field is now `[ImageShortcode]` (bare ids), not `[{id,url,status}]`
    /// — there is no URL left to fall back to, even when a test object still shapes `images` the
    /// old way. Only `coverImageUrl` (present on `resources.product.get`) supplies `imageURL`.
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
