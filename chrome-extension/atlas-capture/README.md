# Lumio — Send to Atlas

A deliberately single-purpose Chrome extension: clicking its toolbar icon extracts the current rendered page and immediately sends it to the local AtlasRunner bridge. The popup reports progress and the resulting Atlas Source/Run IDs. AtlasRunner stores the extraction as a content-addressed Artifact, creates an Atlas Source, and invokes `web.summary@1`.

## Install

1. Start AtlasRunner with `web.summary@1:summarize` configured.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select this `chrome-extension/atlas-capture` directory.
4. Open a page and click the extension icon. Sending begins immediately; use **Retry** only after a failure.

The Runner bridge listens only on `127.0.0.1:43119`. Override it with `web_capture_port` in the Runner configuration; if changed, update `BRIDGE_URL` and `host_permissions` in the extension as well.

The extension never receives an Atlas credential. The loopback bridge accepts only Chrome-extension origins, JSON requests, and the dedicated capture header.
