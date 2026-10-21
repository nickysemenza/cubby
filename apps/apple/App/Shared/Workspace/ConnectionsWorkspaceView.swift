import CubbyKit
import SwiftUI

#if os(macOS)
    import AppKit
#endif

struct ConnectionsWorkspaceSelection: Codable, Hashable {
    var entity: String? = nil
    var recordID: String? = nil
}

struct ConnectionsWorkspaceLink: View {
    var entity: String?
    var recordID: String?
    var title = "Open connections"
    #if os(macOS)
        @Environment(\.openWindow) private var openWindow
    #else
        @State private var showing = false
    #endif

    var body: some View {
        Button(title, systemImage: "arrow.up.left.and.arrow.down.right") {
            #if os(macOS)
                openWindow(
                    id: "connections",
                    value: ConnectionsWorkspaceSelection(entity: entity, recordID: recordID))
            #else
                showing = true
            #endif
        }
        #if os(iOS)
            .fullScreenCover(isPresented: $showing) {
                NavigationStack {
                    HostedWorkspaceView(
                        surface: .connections(entity: entity, id: recordID), title: "Connections")
                }
            }
        #endif
    }
}

#if os(macOS)
    struct ConnectionsWorkspaceWindow: View {
        let selection: ConnectionsWorkspaceSelection
        @Environment(AppModel.self) private var model
        @Environment(\.openWindow) private var openWindow
        var body: some View {
            Group {
                if model.phase == .signedIn {
                    workspace
                } else if model.phase == .restoring {
                    LoadingIndicator.screen(label: "Checking sign-in")
                } else {
                    ContentUnavailableView {
                        Label("Sign in to Cubby", systemImage: "person.crop.circle")
                    } actions: {
                        Button("Open Cubby") { openWindow(id: "main") }
                    }
                }
            }
            .task {
                if model.phase == .restoring { openWindow(id: "main") }
            }
        }
        private var workspace: some View {
            NavigationStack {
                HostedWorkspaceView(
                    surface: .connections(entity: selection.entity, id: selection.recordID),
                    title: "Connections"
                )
                .toolbar {
                    Button("Toggle full screen", systemImage: "arrow.up.left.and.arrow.down.right") {
                        NSApp.keyWindow?.toggleFullScreen(nil)
                    }
                }
            }
        }
    }
#endif

#Preview("Connections entry") { ConnectionsWorkspaceLink().environment(PreviewFixtures.signedInModel()) }
