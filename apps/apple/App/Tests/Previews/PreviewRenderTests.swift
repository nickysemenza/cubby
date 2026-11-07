#if os(iOS)
    import Foundation
    import SwiftUI
    import Testing
    import UIKit

    @testable import Cubby

    /// The render request `pnpm apple previews` passes through `TEST_RUNNER_*` variables.
    nonisolated private enum PreviewRenderRequest {
        static var outputDirectory: URL? {
            ProcessInfo.processInfo.environment["CUBBY_PREVIEW_RENDER_DIR"].map {
                URL(fileURLWithPath: $0, isDirectory: true)
            }
        }

        /// Optional comma-separated screen names (`product-list,task-detail`).
        static var only: Set<String>? {
            ProcessInfo.processInfo.environment["CUBBY_PREVIEW_RENDER_ONLY"].map {
                Set($0.split(separator: ",").map(String.init))
            }
        }
    }

    /// Renders every `EntityScreenPreview` in every `PreviewAppearance` to PNG for visual review
    /// (`pnpm apple previews`). It is evidence, not a regression check: the suite
    /// runs only when `CUBBY_PREVIEW_RENDER_DIR` names an output directory and asserts nothing about
    /// the pixels. The screens are hosted in a real window, because `ImageRenderer` cannot draw
    /// UIKit-backed `List`, navigation bars or toolbars. Blocked preview reads (timeline, activity,
    /// reports) settle asynchronously, so a frame is kept once two consecutive frames match; that
    /// clock wait is why this stays opt-in.
    @Suite(.serialized, .enabled(if: PreviewRenderRequest.outputDirectory != nil))
    @MainActor
    struct PreviewRenderTests {
        @Test(arguments: EntityScreenPreview.allCases)
        func render(_ screen: EntityScreenPreview) async throws {
            guard PreviewRenderRequest.only?.contains(screen.id) ?? true,
                let directory = PreviewRenderRequest.outputDirectory
            else { return }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let scene = try #require(
                UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            for appearance in PreviewAppearance.allCases {
                let model = EntityScreenPreviewModel(screen: screen)
                await model.prepare()
                let host = UIHostingController(
                    rootView: EntityScreenPreviewHost(prepared: model, appearance: appearance))
                host.traitOverrides.preferredContentSizeCategory =
                    appearance == .accessibility ? .accessibilityExtraExtraLarge : .large
                let window = UIWindow(windowScene: scene)
                // A detail renders tall so its sections and relations land in one image.
                if screen.isDetail { window.frame.size.height = 2400 }
                window.windowLevel = .alert + 1
                window.overrideUserInterfaceStyle = appearance == .dark ? .dark : .light
                window.rootViewController = host
                window.makeKeyAndVisible()
                let png = try await Self.settledPNG(of: window)
                window.isHidden = true
                let name = "\(screen.id)-\(appearance.id).png"
                try png.write(to: directory.appending(path: name))
                Attachment.record(png, named: name)
            }
        }

        private static func settledPNG(of window: UIWindow) async throws -> Data {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 2
            let renderer = UIGraphicsImageRenderer(bounds: window.bounds, format: format)
            var previous: Data?
            for _ in 0..<30 {
                try await Task.sleep(for: .milliseconds(150))
                let png = renderer.pngData { _ in
                    _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                if png == previous { return png }
                previous = png
            }
            return try #require(previous)
        }
    }
#endif
