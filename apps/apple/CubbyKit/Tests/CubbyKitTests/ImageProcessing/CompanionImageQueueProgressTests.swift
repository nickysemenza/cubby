import Foundation
import Testing

@testable import CubbyKit

@Suite("Image queue session progress")
struct CompanionImageQueueProgressTests {
    @Test func baselineStaysFixedWhenTheBacklogGrows() {
        var session = CompanionImageQueueProgress(startedAt: .now)
        #expect(session.progress == nil)
        session.refresh(backlog: .init(waiting: 80, runsWaiting: 1, workingDevices: 2, etaSeconds: 240))
        session.completedCount = 20
        #expect(session.progress == 0.2)
        session.refresh(backlog: .init(waiting: 180, runsWaiting: 2, workingDevices: 2, etaSeconds: 600))
        #expect(session.waitingAtStart == 80)
        #expect(session.totalCount == 100)
        #expect(session.progress == 0.2)
        #expect(session.etaSeconds == 600)
        #expect(
            session.detail(running: 4, locale: Locale(identifier: "en_US"))
                == "4 running · 20 done · about 10 minutes at this pace")
    }

    @Test func restartStartsWithNewCountsAndBaseline() {
        var first = CompanionImageQueueProgress(startedAt: Date(timeIntervalSince1970: 100))
        first.refresh(backlog: .init(waiting: 10, runsWaiting: 1, workingDevices: 1, etaSeconds: nil))
        first.completedCount = 5
        var restarted = CompanionImageQueueProgress(startedAt: Date(timeIntervalSince1970: 200))
        restarted.refresh(backlog: .init(waiting: 30, runsWaiting: 1, workingDevices: 1, etaSeconds: nil))
        #expect(restarted.id != first.id)
        #expect(restarted.completedCount == 0)
        #expect(restarted.waitingAtStart == 30)
        #expect(restarted.progress == 0)
        #expect(restarted.detail(running: 2) == "2 running · 0 done")
    }

    @Test func emptyInitialBacklogNeverDividesByZero() {
        var session = CompanionImageQueueProgress(startedAt: .now)
        session.refresh(backlog: .init(waiting: 0, runsWaiting: 0, workingDevices: 1, etaSeconds: nil))
        #expect(session.progress == 0)
        session.completedCount = 1
        #expect(session.progress == 1)
    }
}
