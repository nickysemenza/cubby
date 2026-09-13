import CubbyKit
import SnapshotTesting
import SwiftUI
import Testing

@testable import Cubby

/// Mirrors `DataScannerView.swift`'s "Shelf labels" `#Preview`: one `ShelfLabel` per `tone`, fully
/// synchronous state, no network.
@MainActor
@Suite("ShelfLabel snapshots")
struct ShelfLabelSnapshotTests {
    @Test("Tone stack")
    func toneStack() {
        let view =
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                ShelfLabel(
                    annotation: ShelfAnnotation(
                        title: "Milwaukee M18 battery", detail: "2 each expected", tone: .expected))
                ShelfLabel(
                    annotation: ShelfAnnotation(
                        title: "Milwaukee M18 battery", detail: "2 each \u{2713}", tone: .verified))
                ShelfLabel(annotation: ShelfAnnotation(title: "Not in this bin", tone: .unexpected))
                ShelfLabel(
                    annotation: ShelfAnnotation(
                        title: "012345678905", detail: "Scanning\u{2026}", tone: .pending))
            }
            .padding()
            .background(Color.black)
        assertSnapshot(
            of: view, as: .image(layout: SnapshotDevice.layout, traits: SnapshotDevice.traits))
    }
}
