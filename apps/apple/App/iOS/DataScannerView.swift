import AVFoundation
import SwiftUI
import Vision
import VisionKit

/// The camera slot on iOS: VisionKit's data scanner when the device supports it, otherwise a
/// short explanation (the simulator has no camera, so `isSupported` is false there).
struct ScannerSlot: View {
    let onRead: (String) -> Void
    @State private var authorized = AVCaptureDevice.authorizationStatus(for: .video) == .authorized

    var body: some View {
        if DataScannerViewController.isSupported {
            if authorized {
                DataScannerView(onRead: onRead)
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
        if !controller.isScanning { try? controller.startScanning() }
    }

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onRead: onRead) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onRead: (String) -> Void

        init(onRead: @escaping (String) -> Void) {
            self.onRead = onRead
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
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue {
                onRead(payload)
            }
        }
    }
}
