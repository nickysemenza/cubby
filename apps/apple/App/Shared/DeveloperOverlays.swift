import CubbyKit
import SwiftUI

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// The one switch behind all seven developer-overlay layers (analysis timings, score breakdowns,
/// route decisions, ids, and request timing). `RootView` sets this from
/// `@AppStorage("developerOverlays")`; every layer reads it as `@Environment(\.developerOverlays)`
/// rather than its own `@AppStorage`, so toggling in `DevView` updates every open screen at once.
private struct DeveloperOverlaysKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var developerOverlays: Bool {
        get { self[DeveloperOverlaysKey.self] }
        set { self[DeveloperOverlaysKey.self] = newValue }
    }
}

/// A developer-overlay caption: monospaced, secondary, and never reserving its own layout space
/// beyond an ordinary caption line — overlays never shift the surrounding content
/// (`apps/apple/DESIGN.md` § Developer overlays).
struct DevOverlayText: View {
    let text: String
    /// Drawn over a photo: secondary text on arbitrary image content is unreadable, so it gets
    /// white text on a dark rounded plate instead (a plate, not a capsule, so two lines sit well).
    let overMedia: Bool

    init(_ text: String, overMedia: Bool = false) {
        self.text = text
        self.overMedia = overMedia
    }

    var body: some View {
        if overMedia {
            // One `Text` per line, so each line truncates on its own instead of a long label
            // wrapping mid-word into the next.
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(text.split(separator: "\n").enumerated()), id: \.offset) { _, line in
                    Text(line).lineLimit(1).minimumScaleFactor(0.6)
                }
            }
            .font(.porcelainCode)
            .foregroundStyle(.white)
            .padding(.horizontal, 3)
            .padding(.vertical, 2)
            .background(.black.opacity(0.6), in: .rect(cornerRadius: 5))
        } else {
            Text(text)
                .font(.porcelainCode)
                .foregroundStyle(.secondary)
        }
    }
}

/// Layer 7: a "Copy diagnostics" toolbar item on every screen that carries an overlay layer.
/// Snapshot only on demand: reading a library-wide payload in `body` subscribes this button to
/// every photo's state and repeatedly encodes the entire library while it is being scanned.
struct CopyDiagnosticsButton<Payload: Encodable>: View {
    let payload: () -> Payload?

    private var json: String? {
        guard let value = payload() else { return nil }
        let encoder = JSONEncoder.cubby()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) }
    }

    var body: some View {
        Button {
            guard let json else { return }
            Self.copy(json)
        } label: {
            Label("Copy diagnostics", systemImage: "doc.on.clipboard")
        }
        .accessibilityIdentifier("dev.copyDiagnostics")
    }

    private static func copy(_ string: String) {
        #if os(macOS)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(string, forType: .string)
        #else
            UIPasteboard.general.string = string
        #endif
    }
}

/// Layer 6: `RootView`'s bottom strip, one line naming the last request `CubbyAuthMiddleware`
/// observed through `AppModel.requestTrace`.
struct RequestTraceStrip: View {
    let entry: RequestTrace.Entry

    var body: some View {
        DevOverlayText("\(entry.operationID) · \(Int(entry.ms))ms · \(entry.status)")
            .padding(.horizontal, PorcelainTokens.Space.md)
            .padding(.vertical, PorcelainTokens.Space.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
    }
}

/// Layer 3's per-row diagnostic (`PhotoEntityChooser`/`PhotoRelatedDestinationChooser`): rank
/// position, the winning `combined` score, and which evidence lane it came from.
struct PhotoChooserRowDiagnostic: Encodable {
    let id: String
    let rank: Int
    let combined: Double?
    let lane: String
}

#Preview {
    VStack(spacing: 12) {
        DevOverlayText("142ms · plant")
        CopyDiagnosticsButton { ["ok": true] }
        RequestTraceStrip(
            entry: RequestTrace.Entry(operationID: "resources.product.list", ms: 142, status: 200))
    }
    .padding()
}
