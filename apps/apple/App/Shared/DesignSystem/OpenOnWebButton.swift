import SwiftUI

/// The one control that opens a web surface in the browser: a `Link` on iOS, `openURL` on Mac
/// (the same default browser, without leaving List selection), with "Copy link" in its context
/// menu. Name it after the web surface ("Open reconciliation on web"), never a bare destination.
struct OpenOnWebButton<Content: View>: View {
    let target: WebHandoff.Target
    @ViewBuilder let content: () -> Content

    @Environment(AppModel.self) private var appModel
    #if os(macOS)
        @Environment(\.openURL) private var openURL
    #endif

    init(target: WebHandoff.Target, @ViewBuilder content: @escaping () -> Content) {
        self.target = target
        self.content = content
    }

    var body: some View {
        let url = appModel.webHandoff.url(target)
        Group {
            #if os(iOS)
                Link(destination: url, label: content)
            #else
                Button(action: { openURL(url) }, label: content)
            #endif
        }
        .accessibilityHint("Opens in your browser")
        .contextMenu {
            Button("Copy link", systemImage: "link") { Clipboard.copy(url.absoluteString) }
        }
    }
}

extension OpenOnWebButton where Content == Label<Text, Image> {
    init(target: WebHandoff.Target, label: String) {
        self.init(target: target) { Label(label, systemImage: "safari") }
    }
}
