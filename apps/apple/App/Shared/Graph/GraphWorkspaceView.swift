import CubbyKit
import SwiftUI

struct GraphWorkspaceView: View {
    var initialRoot: EntityRef?
    var body: some View {
        HostedWorkspaceView(
            surface: .connections(entity: initialRoot?.entityKind.rawValue, id: initialRoot?.entityId),
            title: "Connections", showsDone: false
        )
        #if os(iOS)
            .toolbar(.hidden, for: .tabBar)
        #else
            .toolbar {
                ConnectionsWorkspaceLink(
                    entity: initialRoot?.entityKind.rawValue, recordID: initialRoot?.entityId,
                    title: "Open in new window")
            }
        #endif
    }
}

#Preview { NavigationStack { GraphWorkspaceView() }.environment(PreviewFixtures.signedInModel()) }
