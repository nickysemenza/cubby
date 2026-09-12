// swift-tools-version: 6.0
// Throwaway package whose only job is to build the swift-openapi-generator CLI
// at a pinned version. It is deliberately NOT a dependency of CubbyKit: the
// SwiftPM build plugin would need interactive trust in Xcode and would re-parse
// the 2.9 MB spec on every clean build. `scripts/generate-openapi.sh` runs it.
import PackageDescription
let package = Package(
    name: "generator",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.13.1"),
    ],
    targets: []
)
