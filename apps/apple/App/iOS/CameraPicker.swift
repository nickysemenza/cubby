import SwiftUI
import UIKit

/// Wraps `UIImagePickerController`'s camera source. Only presented when
/// `isSourceTypeAvailable(.camera)` is true (never on the simulator), so `PhotosPicker` is the
/// path that always works during development. Shared by Identify and Add photo.
struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (CGImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, dismiss: dismiss)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (CGImage) -> Void
        let dismiss: DismissAction

        init(onCapture: @escaping (CGImage) -> Void, dismiss: DismissAction) {
            self.onCapture = onCapture
            self.dismiss = dismiss
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage, let cgImage = image.cgImage {
                onCapture(cgImage)
            }
            dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            dismiss()
        }
    }
}
