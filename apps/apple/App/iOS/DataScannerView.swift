import AVFoundation
import CubbyKit
import SwiftUI
import Vision
import VisionKit

/// The camera slot on iOS: VisionKit's data scanner when the device supports it, otherwise a
/// short explanation (the simulator has no camera, so `isSupported` is false there).
struct ScannerSlot: View {
    let onRead: (String) -> Void
    /// Labels the camera floats over each recognized code; nil leaves the viewfinder bare.
    var annotate: ((String) -> ShelfAnnotation?)? = nil
    @State private var authorized = AVCaptureDevice.authorizationStatus(for: .video) == .authorized

    var body: some View {
        if DataScannerViewController.isSupported {
            if authorized {
                DataScannerView(onRead: onRead, annotate: annotate)
            } else {
                ContentUnavailableView {
                    Label("Camera", systemImage: "camera")
                } description: {
                    Text("Allow camera access to scan barcodes.")
                } actions: {
                    Button("Allow") {
                        Task { authorized = await AVCaptureDevice.requestAccess(for: .video) }
                    }
                }
                .task {
                    if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
                        authorized = await AVCaptureDevice.requestAccess(for: .video)
                    }
                }
            }
        } else {
            ContentUnavailableView(
                "No camera on this device",
                systemImage: "camera.metering.unknown",
                description: Text("Type or paste a code below.")
            )
        }
    }
}

/// Wraps `DataScannerViewController`. Both `recognizesMultipleItems` and
/// `isHighFrameRateTrackingEnabled` are init-only, so they are fixed in `makeUIViewController`.
///
/// `RecognizedItem` is not `Sendable` (it carries a `VNBarcodeObservation`), so the delegate
/// extracts the payload string on the main actor and hands only that string on.
struct DataScannerView: UIViewControllerRepresentable {
    let onRead: (String) -> Void
    var annotate: ((String) -> ShelfAnnotation?)? = nil

    /// Live labels are capped so a dense shelf stays readable; the rest stay highlighted only.
    static let overlayLimit = 6

    static let symbologies: [VNBarcodeSymbology] = [.ean13, .ean8, .upce, .code128, .itf14, .dataMatrix, .qr]

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: Self.symbologies)],
            qualityLevel: .balanced,
            recognizesMultipleItems: true,
            isHighFrameRateTrackingEnabled: true,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        controller.delegate = context.coordinator
        try? controller.startScanning()
        return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        context.coordinator.onRead = onRead
        context.coordinator.annotate = annotate
        // Session state moved (a row verified, a scan resolved): relabel what is in view.
        context.coordinator.relabel()
        if !controller.isScanning { try? controller.startScanning() }
    }

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
        coordinator.removeAllLabels()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onRead: onRead, annotate: annotate) }

    /// Besides forwarding payloads, keeps one hosted `ShelfLabel` per recognized item in the
    /// scanner's `overlayContainerView`, moved every frame VisionKit reports new bounds.
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onRead: (String) -> Void
        var annotate: ((String) -> ShelfAnnotation?)?
        /// The last `allItems` VisionKit reported; `recognizedItems` on the controller is an
        /// async stream, so the delegate keeps the snapshot a relabel needs.
        private var visible: [RecognizedItem] = []
        private var labels:
            [RecognizedItem.ID: (host: UIHostingController<ShelfLabel>, annotation: ShelfAnnotation)] =
                [:]

        init(onRead: @escaping (String) -> Void, annotate: ((String) -> ShelfAnnotation?)?) {
            self.onRead = onRead
            self.annotate = annotate
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            for item in addedItems {
                if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue {
                    onRead(payload)
                }
            }
            place(allItems, in: dataScanner)
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            place(allItems, in: dataScanner)
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController, didRemove removedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            visible = allItems
            for item in removedItems { remove(item.id) }
        }

        // MARK: Overlay

        /// Recompute every visible label's text against the current session state.
        func relabel() {
            guard annotate != nil else { return removeAllLabels() }
            for item in visible {
                guard let entry = labels[item.id] else { continue }
                if let fresh = annotation(for: item) {
                    if fresh != entry.annotation {
                        entry.host.rootView = ShelfLabel(annotation: fresh)
                        labels[item.id] = (entry.host, fresh)
                        entry.host.view.sizeToFit()
                    }
                } else {
                    remove(item.id)
                }
            }
        }

        func removeAllLabels() {
            for id in labels.keys { remove(id) }
        }

        private func place(_ items: [RecognizedItem], in scanner: DataScannerViewController) {
            visible = items
            guard annotate != nil else { return }
            let container = scanner.overlayContainerView
            let live = Set(items.map(\.id))
            for id in labels.keys where !live.contains(id) { remove(id) }
            var budget = DataScannerView.overlayLimit - labels.count
            for item in items {
                if let entry = labels[item.id] {
                    move(entry.host.view, to: item.bounds, in: container)
                    continue
                }
                guard budget > 0, let annotation = annotation(for: item) else { continue }
                let host = UIHostingController(rootView: ShelfLabel(annotation: annotation))
                host.view.backgroundColor = .clear
                host.view.sizeToFit()
                container.addSubview(host.view)
                labels[item.id] = (host, annotation)
                move(host.view, to: item.bounds, in: container)
                budget -= 1
            }
        }

        /// The label sits just above the code's top edge, clamped inside the viewfinder so a
        /// code at the very top still reads.
        private func move(_ view: UIView, to bounds: RecognizedItem.Bounds, in container: UIView) {
            let size = view.bounds.size
            let x = min(max(bounds.topLeft.x, 0), max(container.bounds.width - size.width, 0))
            let y = max(bounds.topLeft.y - size.height - 6, 0)
            view.frame = CGRect(origin: CGPoint(x: x, y: y), size: size)
        }

        private func remove(_ id: RecognizedItem.ID) {
            labels.removeValue(forKey: id)?.host.view.removeFromSuperview()
        }

        private func annotation(for item: RecognizedItem) -> ShelfAnnotation? {
            guard case .barcode(let barcode) = item, let payload = barcode.payloadStringValue else {
                return nil
            }
            return annotate?(payload)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue {
                onRead(payload)
            }
        }
    }
}

/// One floating label: title, an optional detail line, and a tone stripe.
struct ShelfLabel: View {
    let annotation: ShelfAnnotation

    private var tone: Color {
        switch annotation.tone {
        case .expected: PorcelainTokens.cobalt
        case .verified: PorcelainTokens.positive
        case .unexpected: PorcelainTokens.warning
        case .pending: PorcelainTokens.graphiteSecondary
        }
    }

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.sm) {
            RoundedRectangle(cornerRadius: 1).fill(tone).frame(width: 3)
            VStack(alignment: .leading, spacing: 1) {
                Text(annotation.title).font(.porcelainLabel).foregroundStyle(PorcelainTokens.graphite)
                    .lineLimit(1)
                if let detail = annotation.detail {
                    Text(detail).font(.porcelainData).foregroundStyle(tone).lineLimit(1)
                }
            }
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
        .padding(.horizontal, PorcelainTokens.Space.sm)
        .frame(maxWidth: 220, alignment: .leading)
        .background(
            PorcelainTokens.surface.opacity(0.94),
            in: RoundedRectangle(cornerRadius: PorcelainTokens.radiusChip)
        )
        .overlay(
            RoundedRectangle(cornerRadius: PorcelainTokens.radiusChip)
                .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
        )
        .fixedSize()
    }
}

#Preview("Shelf labels") {
    VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
        ShelfLabel(
            annotation: ShelfAnnotation(
                title: "Milwaukee M18 battery", detail: "2 each expected", tone: .expected))
        ShelfLabel(
            annotation: ShelfAnnotation(title: "Milwaukee M18 battery", detail: "2 each ✓", tone: .verified))
        ShelfLabel(annotation: ShelfAnnotation(title: "Not in this bin", tone: .unexpected))
        ShelfLabel(annotation: ShelfAnnotation(title: "012345678905", detail: "Scanning…", tone: .pending))
    }
    .padding()
    .background(Color.black)
}
