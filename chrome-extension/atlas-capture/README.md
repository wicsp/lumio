# Lumio — Send to Atlas

A deliberately single-purpose Chrome extension: extract the current rendered page and send it to the local Lumio bridge. Lumio stores the extraction as a content-addressed Artifact, creates an Atlas Source, and enqueues `web-summary-v1`.

## Install

1. Start a normal Lumio/pi session with Atlas configured.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select this `chrome-extension/atlas-capture` directory.
4. Open a page and press **Send to Atlas**.

The bridge listens only on `127.0.0.1:43119`. Override the Lumio port with `LUMIO_WEB_CAPTURE_PORT`; if changed, update `BRIDGE_URL` and `host_permissions` in the extension as well.

The extension never receives an Atlas credential. The loopback bridge accepts only Chrome-extension origins, JSON requests, and the dedicated capture header.
