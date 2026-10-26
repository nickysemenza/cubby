import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Scene refresh")
struct SceneRefreshTests {
    @Test func refreshRequiresAVisibleMemberAndNoReloadInFlight() {
        let refresh = SceneRefresh()
        let member = UUID()
        refresh.refresh()
        #expect(refresh.request == 0)

        refresh.join(member)
        refresh.refresh()
        #expect(refresh.request == 1)

        refresh.begin()
        refresh.refresh()
        #expect(refresh.request == 1)
        refresh.end()
        refresh.leave(member)
        #expect(!refresh.isEnabled)
    }
}
