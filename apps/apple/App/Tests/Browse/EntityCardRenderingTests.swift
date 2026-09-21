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
            .background(PorcelainTokens.canvas)
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
            .background(PorcelainTokens.canvas)
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
