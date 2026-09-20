import CoreGraphics
import CubbyKit
import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// Each share session owns its directory independently of the preview or the next inspection.
/// The native sharing completion releases the lease, not dismissal of the photo preview.
nonisolated final class PhotoMatchExport: Sendable {
    let directory: URL
    let urls: [URL]

    private init(directory: URL, urls: [URL]) {
        self.directory = directory
        self.urls = urls
    }

    deinit { try? FileManager.default.removeItem(at: directory) }

    @concurrent func save(in parent: URL) async throws {
        let destination = parent.appendingPathComponent(directory.lastPathComponent, isDirectory: true)
        try FileManager.default.copyItem(at: directory, to: destination)
    }

    @concurrent static func prepare(json: Data, thumbnail: CGImage?, file: PhotoFile?) async throws
        -> PhotoMatchExport
    {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("PhotoMatch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            try Task.checkCancellation()
            let reportURL = directory.appendingPathComponent("photo-match.json")
            try json.write(to: reportURL, options: .atomic)
            var urls = [reportURL]
            if let thumbnail {
                let url = directory.appendingPathComponent("hash-thumbnail.png")
                guard
                    let destination = CGImageDestinationCreateWithURL(
                        url as CFURL, UTType.png.identifier as CFString, 1, nil)
                else { throw PhotoFile.Failure.cannotMaterialize }
                CGImageDestinationAddImage(destination, thumbnail, nil)
                guard CGImageDestinationFinalize(destination) else {
                    throw PhotoFile.Failure.cannotMaterialize
                }
                urls.append(url)
            }
            if let file {
                let url = directory.appendingPathComponent("materialized-" + file.url.lastPathComponent)
                try FileManager.default.copyItem(at: file.url, to: url)
                urls.append(url)
            }
            try Task.checkCancellation()
            return PhotoMatchExport(directory: directory, urls: urls)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }
}

#if os(macOS)
    struct PhotoMatchSaveButton: View {
        let export: PhotoMatchExport
        let onError: (Error) -> Void
        @State private var saved = false

        var body: some View {
            Button(
                saved ? "Exported — export again…" : "Export diagnostic files…",
                systemImage: "square.and.arrow.down"
            ) {
                let panel = NSOpenPanel()
                panel.canChooseDirectories = true
                panel.canChooseFiles = false
                panel.canCreateDirectories = true
                panel.prompt = "Export"
                panel.message =
                    "Export the JSON report, hash thumbnail, and materialized photo into a new folder."
                panel.begin { response in
                    guard response == .OK, let directory = panel.url else { return }
                    Task {
                        let scoped = directory.startAccessingSecurityScopedResource()
                        defer { if scoped { directory.stopAccessingSecurityScopedResource() } }
                        do {
                            try await export.save(in: directory)
                            saved = true
                        } catch { onError(error) }
                    }
                }
            }
            .accessibilityIdentifier("photos.match.export")
        }
    }

    struct PhotoMatchShareButton: NSViewRepresentable {
        let export: PhotoMatchExport
        let onError: (Error) -> Void

        func makeCoordinator() -> Coordinator { Coordinator() }

        func makeNSView(context: Context) -> NSButton {
            let button = NSButton(
                title: "Share diagnostic files…", target: context.coordinator,
                action: #selector(Coordinator.share(_:)))
            button.bezelStyle = .rounded
            button.setAccessibilityIdentifier("photos.match.share")
            return button
        }

        func updateNSView(_ button: NSButton, context: Context) {
            context.coordinator.export = export
            context.coordinator.onError = onError
        }

        final class Coordinator: NSObject, NSSharingServicePickerDelegate, NSSharingServiceDelegate {
            var export: PhotoMatchExport?
            var onError: ((Error) -> Void)?
            private var picker: NSSharingServicePicker?
            private var sharedExport: PhotoMatchExport?
            private var sharingLifetime: Coordinator?

            @objc func share(_ sender: NSButton) {
                guard let export else { return }
                sharedExport = export
                sharingLifetime = self
                let picker = NSSharingServicePicker(items: export.urls)
                self.picker = picker
                picker.delegate = self
                picker.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
            }

            func sharingServicePicker(
                _ picker: NSSharingServicePicker,
                delegateFor sharingService: NSSharingService
            ) -> (any NSSharingServiceDelegate)? {
                self
            }

            func sharingServicePicker(
                _ picker: NSSharingServicePicker,
                didChoose service: NSSharingService?
            ) {
                if service == nil { finish() }
            }

            func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) {
                finish()
            }

            func sharingService(
                _ sharingService: NSSharingService, didFailToShareItems items: [Any],
                error: Error
            ) {
                onError?(error)
                finish()
            }

            private func finish() {
                picker = nil
                sharedExport = nil
                sharingLifetime = nil
            }
        }
    }
#else
    struct PhotoMatchShareSheet: UIViewControllerRepresentable {
        let export: PhotoMatchExport
        let onError: (Error) -> Void

        func makeUIViewController(context: Context) -> UIActivityViewController {
            let controller = UIActivityViewController(activityItems: export.urls, applicationActivities: nil)
            // The activity may outlive this representable and the photo preview.
            controller.completionWithItemsHandler = { [export] _, _, _, error in
                withExtendedLifetime(export) {
                    if let error { onError(error) }
                }
            }
            return controller
        }

        func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
    }
#endif
