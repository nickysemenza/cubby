import CubbyKit
import Foundation
import SwiftUI
import Testing

@testable import Cubby

@Suite("Entity card rendering")
@MainActor
struct EntityCardRenderingTests {
    private struct Spec {
        let name: String
        let density: ListPresentationChoice
        let width: CGFloat
        let colorScheme: ColorScheme
        let dynamicTypeSize: DynamicTypeSize
    }

    private struct GridSpec {
        let name: String
        let density: ListPresentationChoice
        let width: CGFloat
        let sizeClass: UserInterfaceSizeClass
        let minimumTwoRowHeight: CGFloat
    }

    @Test func shelfSubtitleUsesDeclaredFieldsInsteadOfTheRowCaption() throws {
        let descriptor = EntityCatalog[.purchase]
        let row = try #require(
            descriptor.row(from: [
                "id": "PUR-2345", "displayName": "Synthetic purchase",
                "vendorId": "VEN-2345", "vendorName": "Synthetic supplier",
                "displayLabel": "Replacement parts",
            ]))
        let shelf = EntityShelfView(descriptor: descriptor, rows: [row])
        let facts = shelf.subtitleFacts(for: row)

        #expect(facts.map(\.id) == descriptor.presentation.shelfSubtitle)
        #expect(facts.map(\.value) == ["Synthetic supplier", "Replacement parts"])
    }

    /// Mac table columns size from the declared `display.width` bucket; an undeclared field takes
    /// `md` and the title column `lg`.
    @Test func tableColumnWidthsFollowTheDeclaredBucket() throws {
        let widths = ["xs", "sm", "md", "lg", "xl"].map { bucket in
            let width = EntityTableColumnWidth(bucket: bucket)
            return [width.min, width.ideal, width.max]
        }
        #expect(
            widths == [[48, 64, 88], [80, 104, 140], [120, 160, 240], [180, 240, 400], [240, 320, 600]])
        #expect(EntityTableColumnWidth(bucket: nil) == EntityTableColumnWidth(bucket: "md"))
        #expect(EntityTableColumnWidth.title == EntityTableColumnWidth(bucket: "lg"))

        let notes = try #require(EntityCatalog[.product].field("notes"))
        #expect(notes.width == "xl")
        #expect(EntityTableColumnWidth(notes) == EntityTableColumnWidth(bucket: "xl"))
    }

    /// A table title cell stays one line however long its title and subtitle run, and the cell
    /// frame holds the row at 20 points.
    @Test func tableTitleCellStaysOnOneLine() throws {
        func height(_ view: some View) throws -> Int {
            let renderer = ImageRenderer(
                content: view.frame(width: 180).environment(\.dynamicTypeSize, .large))
            renderer.scale = 2
            return try #require(renderer.cgImage).height
        }
        let short = EntityTableTitleCell(
            title: "Skillet", subtitle: nil, imageURL: nil, symbol: "shippingbox", emoji: nil)
        let long = EntityTableTitleCell(
            title: "Extra-Long Household Inventory Record Name for Layout Review",
            subtitle: "Pantry shelf · extended descriptive caption", imageURL: nil,
            symbol: "shippingbox", emoji: nil)
        #expect(try height(long) == height(short))
        #expect(
            try height(long.entityTableCell())
                == Int(EntityTableLayout.cellContentHeight * 2))
    }

    @Test func rendersDensityAppearanceAndAccessibilityEvidence() throws {
        let specs = [
            Spec(
                name: "cards-light", density: .cards, width: 220, colorScheme: .light,
                dynamicTypeSize: .large),
            Spec(
                name: "cards-dark", density: .cards, width: 220, colorScheme: .dark,
                dynamicTypeSize: .large),
            Spec(
                name: "compact-light", density: .compact, width: 140, colorScheme: .light,
                dynamicTypeSize: .large),
            Spec(
                name: "compact-dark", density: .compact, width: 140, colorScheme: .dark,
                dynamicTypeSize: .large),
            Spec(
                name: "cards-accessibility", density: .cards, width: 280, colorScheme: .light,
                dynamicTypeSize: .accessibility5),
            Spec(
                name: "compact-accessibility", density: .compact, width: 220,
                colorScheme: .dark, dynamicTypeSize: .accessibility5),
        ]
        for spec in specs {
            let view = EntityCard(
                title: "Extra-Long Household Inventory Record Name for Layout Review",
                subtitle: "Missing image fallback · extended descriptive caption",
                identifier: "PRD-ACCESSIBILITY-1001",
                imageURL: nil,
                symbol: "shippingbox",
                density: spec.density
            )
            .frame(width: spec.width)
            .padding(16)
            .background(FieldGuideTokens.canvas)
            .environment(\.colorScheme, spec.colorScheme)
            .environment(\.dynamicTypeSize, spec.dynamicTypeSize)

            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try #require(renderer.cgImage)
            #expect(image.width == Int((spec.width + 32) * renderer.scale))
            #expect(image.height > image.width)

            Attachment.record(image, named: "\(spec.name).png", as: .png)
        }
    }

    @Test func rendersAdaptiveGridEvidenceAtPhoneAndTabletWidths() throws {
        let specs = [
            GridSpec(
                name: "grid-320-cards", density: .cards, width: 320, sizeClass: .compact,
                minimumTwoRowHeight: 304),
            GridSpec(
                name: "grid-320-compact", density: .compact, width: 320, sizeClass: .compact,
                minimumTwoRowHeight: 192),
            GridSpec(
                name: "grid-768-cards", density: .cards, width: 768, sizeClass: .regular,
                minimumTwoRowHeight: 352),
            GridSpec(
                name: "grid-768-compact", density: .compact, width: 768, sizeClass: .regular,
                minimumTwoRowHeight: 176),
        ]
        let rows = (1...12).map { index in
            EntityRow(
                id: "PRD-GRID-\(index)",
                title: "Missing-image product \(index) with a descriptive card title",
                subtitle: index.isMultiple(of: 2) ? "Sample maker · Model \(index)" : nil,
                imageURL: nil,
                raw: .object([:]))
        }
        for spec in specs {
            let view = EntityShelfView(
                descriptor: EntityCatalog[.product], rows: rows, density: spec.density
            )
            .frame(width: spec.width)
            .fixedSize(horizontal: false, vertical: true)
            .background(FieldGuideTokens.canvas)
            .environment(PreviewFixtures.signedInModel())
            .environment(\.horizontalSizeClass, spec.sizeClass)
            .environment(\.dynamicTypeSize, .large)

            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try #require(renderer.cgImage)
            #expect(image.width == Int(spec.width * renderer.scale))
            #expect(image.height > Int(spec.minimumTwoRowHeight * renderer.scale))

            Attachment.record(image, named: "\(spec.name).png", as: .png)
        }
    }
}
