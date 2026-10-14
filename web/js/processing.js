// Where a question about the owner's private notes may be processed. Pure, so it can be tested outside a browser.
//   mode:   "device-only" (never the cloud), "device-first" (cloud only when the device can't), "cloud"
//   status: the on-device model's availability ("available", "downloadable", "downloading", "unsupported", …)
// Returns "device", "cloud", or "limitation" (device-only, but the device can't — the owner is told, nothing is sent).
export function decideProcessing(mode, status, deviceFailed = false) {
  const deviceReady = status === "available" && !deviceFailed;
  if (mode === "device-only") return deviceReady ? "device" : "limitation";
  if (mode === "cloud") return "cloud";
  return deviceReady ? "device" : "cloud";
}

export const LIMITATION = "Your notes are set to be processed on this device only, and the on-device model can't answer right now. Download or turn it on in Settings › AI engine, or allow cloud processing there.";
