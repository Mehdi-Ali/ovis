### Added
- A headless PC can approve a phone waiting to pair by comparing digits from its terminal:
  `bun scripts/plugin.ts pair --approve` shows the digits and asks y/n.

### Changed
- Through the relay, only a phone linked to your account with drive access may start a pairing
  code or approve a waiting device, and it must pick the new device's digits out of three. Every
  connected device is told who approved each new device.
