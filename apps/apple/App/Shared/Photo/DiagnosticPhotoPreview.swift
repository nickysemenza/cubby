import CubbyKit
import SwiftUI

/// Display-only images stay separate from fingerprint evidence: a CDN rendition is not hash input.
struct DiagnosticPhotoPreview: View {
    let photo: PhotoAttachment
    let caption: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            PhotoBatch(photos: [photo]).frame(maxWidth: 240)
            Text(caption).font(.caption).foregroundStyle(.secondary)
                .lineLimit(nil).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct DiagnosticStoredPhotoPreview: View {
    let id: ImageCode
    @Environment(AppModel.self) private var appModel
    @State private var detail: ImageWithEntity?
    @State private var error: String?
    @State private var retry = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let detail, let url = detail.imageURL {
                DiagnosticPhotoPreview(
                    photo: .init(id: id.rawValue, filename: detail.filename, source: .remote(url)),
                    caption:
                        "Cubby display rendition · \(id.rawValue). Not the original bytes used for the stored fingerprint."
                )
            } else if let error {
                VStack(alignment: .leading) {
                    Label("Image preview unavailable: \(error)", systemImage: "photo.badge.exclamationmark")
                    Button("Retry image preview") { retry += 1 }
                }
            } else {
                ProgressView("Loading \(id.rawValue) preview…")
            }
        }
        .task(id: "\(appModel.host):\(id.rawValue):\(retry)") {
            detail = nil
            error = nil
            do {
                let result = try await appModel.client.imageDetail(id)
                try Task.checkCancellation()
                detail = result
                if result.imageURL == nil { error = "No image URL is available." }
            } catch is CancellationError {
                // The containing row no longer needs the preview.
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error.localizedDescription
                Diagnostics.report(error, context: "photos.diagnosticPreview")
            }
        }
    }
}

#Preview("Diagnostic image") {
    DiagnosticPhotoPreview(
        photo: .init(
            id: "IMG-2345", filename: "Sample photo",
            source: .remote(URL(string: "https://example.invalid/photo.jpg")!)),
        caption: "Display rendition; fingerprint evidence is shown separately.")
}
