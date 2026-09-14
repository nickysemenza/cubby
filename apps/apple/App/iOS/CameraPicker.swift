import SwiftUI
import UIKit

/// Wraps `UIImagePickerController`'s camera source. Only presented when
/// `isSourceTypeAvailable(.camera)` is true (never on the simulator), so `PhotosPicker` is the
/// path that always works during development. Shared by Identify and Add photo.
struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (Data) -> Void
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
        let onCapture: (Data) -> Void
        let dismiss: DismissAction

        init(onCapture: @escaping (Data) -> Void, dismiss: DismissAction) {
            self.onCapture = onCapture
            self.dismiss = dismiss
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage,
                let data = image.jpegData(compressionQuality: 1)
            else {
                let alert = UIAlertController(
                    title: "Couldn't prepare photo",
                    message: "The camera image could not be encoded. Retake the photo and try again.",
                    preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                picker.present(alert, animated: true)
                return
            }
            onCapture(data)
            dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            dismiss()
        }
    }
}
