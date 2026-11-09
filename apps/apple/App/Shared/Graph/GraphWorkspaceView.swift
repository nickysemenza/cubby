import CubbyKit
import SwiftUI

struct GraphWorkspaceView: View {
    var initialRoot: EntityRef?
    @Environment(AppModel.self) private var model
    @State private var recordTitle: String?
    var body: some View {
        HostedWorkspaceView(
            surface: .connections(entity: initialRoot?.entityKind.rawValue, id: initialRoot?.entityId),
            title: "Connections", showsDone: false, context: recordTitle
        )
        .task(id: initialRoot) {
            recordTitle = nil
            guard let initialRoot else { return }
            do {
                let row = try await model.client.row(
                    EntityCatalog[initialRoot.entityKind], id: initialRoot.entityId)
                try Task.checkCancellation()
                recordTitle = row?.title
            } catch is CancellationError {
                // A newer root owns the workspace context.
            } catch {
                Diagnostics.report(error, context: "connections.record-title")
            }
        }
        #if os(iOS)
            .toolbar(.hidden, for: .tabBar)
        #else
            .toolbar {
                ConnectionsWorkspaceLink(
                    entity: initialRoot?.entityKind.rawValue, recordID: initialRoot?.entityId,
                    title: "Open in new window", recordTitle: recordTitle)
            }
        #endif
    }
}

#Preview { NavigationStack { GraphWorkspaceView() }.environment(PreviewFixtures.signedInModel()) }
