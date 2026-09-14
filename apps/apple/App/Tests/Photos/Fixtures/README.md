# Photo library parity fixtures

These synthetic images contain only gradients and geometric shapes. They were generated for
Cubby's PhotoKit integration tests and are dedicated to the public domain under CC0 1.0.

- `cubby-parity-landscape-3200x1800.jpg` verifies that an upload remains larger than 2048 px.
- `cubby-parity-oriented-1200x800.jpg` stores 1200x800 pixels with EXIF orientation 6.
- `cubby-parity-alpha-1024x768.png` contains translucent shapes and a transparent background.
- `cubby-parity-heic-2400x1600.heic` exercises the native HEIC path.
- `cubby-parity-edit-source-1440x960.jpg` is the only asset the edit test changes.
- `expected-edit-rendition-1440x960.jpg` is written as that asset's current Photos rendition.

The test suite identifies imported assets through the `cubby-parity-` filename prefix. Do not
use that prefix for personal images.

