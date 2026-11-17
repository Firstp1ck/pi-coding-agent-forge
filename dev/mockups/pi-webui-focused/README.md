# Pi Web UI compact workspace mockup

Interactive visual prototype of the [overhaul design contract](../../../pi-package-webui/docs/overhaul/feature-destinations.md), preserving Pi's visual identity with less interface chrome.

Open `dist/index.html` in a browser. Try All tools: browse categories, search for “voice” or “reflog”, and pin a tool with its star. The session and composer menus offer actions for their current context. Toggle the session list from the navigation rail for more conversation space.

You can also switch sessions with a draft, inspect Project and Activity, change the theme in Settings, and send or stop a simulated response. The layout adapts to phone widths. See [the design decisions and verification](DESIGN.md).

All sessions, responses, files, approvals, and runner output are simulated. Feature detail choices preview their intended location. Preferences and pins affect only this page visit. Attachments show local filenames and are never uploaded. The prototype has no connection to Pi, Git, providers, or the real Web UI.
