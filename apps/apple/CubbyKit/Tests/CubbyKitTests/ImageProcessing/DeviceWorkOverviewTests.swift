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

    private func row(_ id: String, device: String?, expires: String? = nil) -> EntityRow {
        var raw: [String: JSONValue] = ["id": .string(id), "runId": .string("RUN-SYN1")]
        if let device { raw["leaseDeviceId"] = .string(device) }
        if let expires { raw["leaseExpiresAt"] = .string(expires) }
        return EntityRow(id: id, title: id, subtitle: nil, imageURL: nil, raw: .object(raw))
    }

    @Test func splitsProcessingRowsByTheDeviceHoldingEachLease() throws {
        let deviceRaw = { (installation: String) -> JSONValue in
            .object(["installationId": .string(installation)])
        }
        let thisInstall = UUID(uuidString: "00000000-0000-4000-8000-0000000000aa")!
        let devices = HouseholdDevices(
            rows: [
                EntityRow(
                    id: "DEV-SYN1", title: "Synthetic Mac", subtitle: nil, imageURL: nil,
                    raw: deviceRaw("00000000-0000-4000-8000-0000000000aa")),
                // Same name, another install: never this device.
                EntityRow(
                    id: "DEV-SYN2", title: "Synthetic Mac", subtitle: nil, imageURL: nil,
                    raw: deviceRaw("00000000-0000-4000-8000-0000000000bb")),
                EntityRow(
                    id: "DEV-SYN3", title: "Another phone", subtitle: nil, imageURL: nil,
                    raw: deviceRaw("00000000-0000-4000-8000-0000000000cc")),
            ],
            installationID: thisInstall)
        #expect(devices.thisDevice == "DEV-SYN1")

        let processing = ProcessingImageJobs(
            rows: [
                row("IPR-SYN1", device: "DEV-SYN1"), row("IPR-SYN2", device: "DEV-SYN2"),
                row("IPR-SYN3", device: "DEV-SYN3"), row("IPR-SYN4", device: "DEV-SYN9"),
                row("IPR-SYN5", device: nil), row("IPR-SYN6", device: "DEV-SYN1"),
            ],
            devices: devices)
        #expect(processing.thisDevice.map(\.id) == ["IPR-SYN1", "IPR-SYN6"])
        #expect(
            processing.otherDevices.map(\.name) == [
                "Another phone", "DEV-SYN9", "Synthetic Mac", "Unknown device",
            ])
        #expect(processing.otherDevices.map(\.id) == ["DEV-SYN3", "DEV-SYN9", "DEV-SYN2", ""])
        #expect(
            processing.otherDevices.map { $0.rows.map(\.id) } == [
                ["IPR-SYN3"], ["IPR-SYN4"], ["IPR-SYN2"], ["IPR-SYN5"],
            ])
    }

    @Test func withoutThisDevicesCodeEveryRowIsAnotherDevices() {
        let processing = ProcessingImageJobs(
            rows: [row("IPR-SYN1", device: "DEV-SYN1")], devices: .init(names: [:], thisDevice: nil))
        #expect(processing.thisDevice.isEmpty)
        #expect(processing.otherDevices.map(\.id) == ["DEV-SYN1"])
    }

    @Test func leaseCountdownReadsTheLoadedExpiry() throws {
        let row = row("IPR-SYN1", device: "DEV-SYN1", expires: "2099-01-01T00:01:00.000Z")
        let expires = try #require(ProcessingImageJobs.leaseExpiresAt(of: row))
        #expect(ProcessingImageJobs.runID(of: row) == "RUN-SYN1")
        #expect(
            ProcessingImageJobs.leaseCountdown(expiresAt: expires, now: expires.addingTimeInterval(-41.5))
                == "lease ends in 42s")
        #expect(ProcessingImageJobs.leaseCountdown(expiresAt: expires, now: expires) == "renewing lease")
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
