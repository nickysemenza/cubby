import SwiftUI
import Testing

@testable import Cubby

@Suite("Record row geometry")
@MainActor
struct RecordListRowRenderingTests {
    // A higher-priority identity column can starve the status/date rail of width,
    // turning its wrapped text into hundreds of points of blank-looking row height.
    @Test(arguments: [CGFloat(320), CGFloat(640)])
    func statusAndDateRailKeepsRowsCompact(width: CGFloat) throws {
        let row = RecordListRow(title: "Background", symbol: "arrow.triangle.2.circlepath") {
            Text("Background · AI Gateway")
        } rail: {
            Text("Completed")
            DateDisplay("2026-10-13T12:00:00Z")
        } supplement: {
            EmptyView()
        }
        .frame(width: width)
        .environment(\.dynamicTypeSize, .large)

        let renderer = ImageRenderer(content: row)
        let image = try #require(renderer.cgImage)
        #expect(image.height >= Int(FieldGuideTokens.touchTarget))
        #expect(image.height < 120)
    }

    @Test(arguments: [CGFloat(320), CGFloat(640)])
    func accessibilitySizeShowsWrappedContext(width: CGFloat) throws {
        let row = RecordListRow(title: "Workshop drill", symbol: "wrench") {
            Text(
                "Garage shelf · Upper cabinet · Household tools · Long handled garden tools · Repair supplies"
            )
        } rail: {
            Text("Available")
        } supplement: {
            EmptyView()
        }
        .frame(width: width)
        .environment(\.dynamicTypeSize, .accessibility3)

        let image = try #require(ImageRenderer(content: row).cgImage)
        #expect(image.height > 100)
    }
}
