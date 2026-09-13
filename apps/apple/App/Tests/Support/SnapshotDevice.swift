import SnapshotTesting
import UIKit

/// Shared device/trait config for every view snapshot in this target, so all references were
/// recorded under (and are compared against) the exact same simulator+appearance — see
/// SnapshotTesting's README warning that references and comparisons must use the same simulator.
enum SnapshotDevice {
    static let layout: SwiftUISnapshotLayout = .device(config: .iPhone13)
    static let traits = UITraitCollection(userInterfaceStyle: .light)
}
