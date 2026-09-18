import CoreGraphics
import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Photo import flow")
struct PhotoImportFlowTests {
    @Test func manifestKeepsUnassignedPhotosOutOfCommitUntilMoved() throws {
        let first = try selection(filename: "first.jpg")
        let second = try selection(filename: "second.jpg")
        let manifest = PhotoImportManifest(items: [first, second])

        #expect(manifest.needsDestination == [first.id, second.id])
        #expect(!manifest.canCommit)
        let option = try #require(manifest.destinationOptions.first)
        manifest.moveSelected(
            to: option,
            row: EntityRow(
                id: "PRD-2345", title: "Example", subtitle: nil, imageURL: nil,
                raw: ["id": "PRD-2345", "name": "Example"]))

        #expect(manifest.needsDestination.isEmpty)
        #expect(manifest.groups.count == 1)
        #expect(manifest.groups[0].photoIDs == [first.id, second.id])
        #expect(manifest.groups[0].title == "Example  PRD-2345")
        #expect(manifest.canCommit)
    }

    @Test func destinationsIncludeEveryManifestIngressKind() throws {
        let manifest = PhotoImportManifest(items: [try selection(filename: "first.jpg")])
        let routes = manifest.destinationOptions.map(\.route)

        #expect(!routes.isEmpty)
        #expect(routes.allSatisfy { $0.storage != nil })
        #expect(routes.contains(where: { $0.kind == "self" }))
        #expect(routes.contains(where: { $0.kind == "existingRelated" }))
        #expect(routes.contains(where: { $0.kind == "createRelated" }))
        #expect(routes.contains(where: { $0.target == .meal }))
        #expect(routes.contains(where: { $0.target == .project }))
        #expect(routes.contains(where: { $0.target == .task }))
        #expect(routes.contains(where: { $0.target == .gardenEntry }))
        #expect(
            routes.contains {
                $0.source == .recipe && $0.target == .meal && $0.kind == "existingRelated"
            })
        #expect(
            routes.contains {
                $0.source == .planting && $0.target == .gardenEntry
                    && $0.kind == "createRelated"
            })
    }

    @Test func naturalSourceTypesAreUniqueAndPlantingDefaultsToCreateRoute() throws {
        let manifest = PhotoImportManifest(items: [try selection(filename: "first.jpg")])
        let types = manifest.sourceTypeOptions

        #expect(Set(types.map(\.source)).count == types.count)
        let planting = try #require(types.first(where: { $0.source == .planting }))
        #expect(
            planting.options.first(where: { $0.route.choice == "primary" })?.id
                == "planting-new-garden-entry")
    }

    @Test func missingNullableSourceBindingRemainsEditable() throws {
        let route = try #require(
            PhotoImportCatalog.ingressRoutes.first { $0.id == "planting-new-garden-entry" })
        let binding = try #require(route.bindings.first { $0.field == "locationId" })
        let source = EntityRow(
            id: "PLT-1234", title: "Santa Rosa", subtitle: nil, imageURL: nil,
            raw: .object(["id": .string("PLT-1234"), "locationId": .null]))

        #expect(PhotoImportManifest.nonNullSourceFieldValue(binding: binding, source: source) == nil)
    }

    @Test func aSharedVisionSuggestionTakesSelectedPhotosStraightToTheirSourceType() {
        let selected = Set(["photo-1", "photo-2"])

        #expect(
            PhotoImportManifest.preferredSourceType(
                selectedIDs: selected,
                suggestions: ["photo-1": .planting, "photo-2": .planting]) == .planting)
        #expect(
            PhotoImportManifest.preferredSourceType(
                selectedIDs: selected,
                suggestions: ["photo-1": .planting, "photo-2": .meal]) == nil)
        #expect(
            PhotoImportManifest.preferredSourceType(
                selectedIDs: selected,
                suggestions: ["photo-1": .planting]) == nil)
    }

    private func selection(filename: String) throws -> PhotoSelectionItem {
        let image = try #require(
            CGContext(
                data: nil, width: 2, height: 2, bitsPerComponent: 8,
                bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage())
        let file = try PhotoFile(
            url: URL(fileURLWithPath: "/unused-\(filename)"), filename: filename,
            contentType: "image/jpeg", size: 1, width: 2, height: 2)
        return PhotoSelectionItem(file: file, preview: image)
    }
}
