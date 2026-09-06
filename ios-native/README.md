# Dim0 for iPad

The iPad target now hosts the complete Dim0 application in a persistent native
`WKWebView`. It is the same product as the browser and desktop clients: AI chat,
notes, files, mini-apps, local boards, synced boards, presentation mode, and all
canvas node types remain available instead of being rebuilt as a reduced native
client.

Apple Pencil input is rendered immediately by a transparent native `PKCanvasView`
over the active board. Completed strokes are journaled per board in stable world
coordinates, sent to the formal web ink store in bounded batches, and removed
from the native overlay only after the web layer confirms a durable local save.
This ACK handoff prevents lost strokes and duplicate dark rendering; unconfirmed
ink is retried after reload. The toolbar's **同步手写** action flushes the pending
journal. While the pen is active, the native overlay owns board touches so a
resting palm cannot move the web camera. Erasing uses the web ink eraser, and
switching away from the pen restores touch pan/zoom.

Build 15 checkpoints the visible drawing on tool-up and again on the final
drawing callback, without waiting for the idle publish/reconciliation timers.
Resigning active and entering the background also checkpoint the current overlay,
including ink still waiting for PencilKit's final callback. Snapshot serialization
runs off the main actor and disk writes stay ordered. These recovery snapshots do
not replace the live canvas or release its finalization guard.

The native app supports one window while recovery journals are keyed by board.
Re-enable multiple scenes only after independent journal writer ownership is
implemented. The existing journal format remains readable by build 14.

Native regression coverage lives in `NativePencilRecoveryTests.swift`. Run it with
the existing `iOS native CI` workflow or the Xcode test scheme. Physical iPad
acceptance is still required: rapid Pencil bursts, immediately locking/closing
after tool-up, recovery after relaunch, and confirmation that normal writing has
no new pauses. No software checkpoint can guarantee the sample PencilKit has not
yet delivered at an abrupt process termination.

## Application URL

Release builds load the dedicated iPad frontend at
`https://dim0-ipad-pencil.pages.dev` by default. Change `Dim0AppURL` in
`ios/Info.plist` to point the shell at another hosted/self-hosted Dim0 frontend.
For an Xcode development run, the `DIM0_APP_URL` scheme environment variable
overrides the plist value, for example `http://192.168.1.20:5175`.

The shell keeps a persistent WebKit data store, so authentication, IndexedDB
local boards, preferences, and cached web assets survive app restarts. Native
file input and download/share handling keep document upload and export usable on
iPad.

## Generate and run the Xcode project

```sh
brew install xcodegen
cd ios-native
cd ios
xcodegen generate
open Dim0Native.xcodeproj
```

`ios/project.yml` is the source of truth. The generated `.xcodeproj` is ignored
and is recreated locally, by EAS, and by GitHub Actions before every build.

The bundle identifier is `com.dim0.canvas` so the existing Apple Developer
device registration and provisioning profile can be reused.
