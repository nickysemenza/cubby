import Foundation
import Testing

@testable import CubbyKit

/// Activity's device-work wording and grouping: the `job.deviceBacklog` banner, processing image
/// jobs split by the Device holding each lease, and the shared slot count. Synthetic codes only.
@Suite("Device work overview")
struct DeviceWorkOverviewTests {
    private let english = Locale(identifier: "en_US")

    @Test func bannerWordsTheServerFiguresWithItsEta() throws {
        let output = try JSONDecoder.cubby().decode(
            JobDeviceBacklogOutput.self,
            from: Data(
                #"{"waiting":240,"runsWaiting":2,"workingDevices":1,"claimsPerMinute":1.2,"etaSeconds":12000}"#
                    .utf8))
        let banner = DeviceBacklogBanner(output)
        #expect(banner.isShown)
        #expect(
            banner.headline(locale: english)
                == "240 images waiting for an Apple device · 1 working · about 3 hours, 20 minutes at the current pace"
        )
        #expect(banner.idleNotice(thisDeviceProcessing: false) == nil)
    }

    @Test func bannerOmitsThePaceWithoutAnEtaAndSaysNobodyIsProcessing() {
        let banner = DeviceBacklogBanner(waiting: 1, runsWaiting: 1, workingDevices: 0, etaSeconds: nil)
        #expect(banner.headline(locale: english) == "1 image waiting for an Apple device · 0 working")
        #expect(
            banner.idleNotice(thisDeviceProcessing: false)
                == "No Apple device is processing — keep Cubby open on your Mac")
        // This device is mid-command: the server's ten-minute window may not have counted it yet.
        #expect(banner.idleNotice(thisDeviceProcessing: true) == nil)
        #expect(!DeviceBacklogBanner(waiting: 0, runsWaiting: 0, workingDevices: 0, etaSeconds: nil).isShown)
    }

    @Test func slotsResolveAutomaticAndClampExplicitChoices() {
        #expect(CompanionImageConcurrency.slots(for: nil) == CompanionImageConcurrency.automatic)
        #expect(CompanionImageConcurrency.slots(for: 0) == CompanionImageConcurrency.automatic)
        #expect(CompanionImageConcurrency.slots(for: 6) == 6)
        #expect(CompanionImageConcurrency.slots(for: 99) == CompanionImageConcurrency.range.upperBound)
        let defaults = UserDefaults(suiteName: "DeviceWorkOverviewTests.\(UUID().uuidString)")!
        #expect(CompanionImageConcurrency.storedChoice(in: defaults) == nil)
        defaults.set(3, forKey: CompanionImageConcurrency.defaultsKey)
        #expect(CompanionImageConcurrency.storedChoice(in: defaults) == 3)
    }
}
