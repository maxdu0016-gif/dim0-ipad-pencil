# Build 15 recovery change — validation status

Baseline: `278c52f7`, native build 14. Working branch:
`codex/ipad-durable-pencil-save`. Both XcodeGen and EAS local metadata target build 15.

## Completed locally

- Preserved the clean baseline as a separate Git branch, a verified complete Git
  bundle, a source ZIP, pre-change local web artifacts, and existing older IPAs.
- Verified all 605 initial backed-up payload files against SHA-256 checksums.
  Subsequently recovered the signed build-14 App Store IPA from Expo, verified
  its embedded version and bundle ID, and added it to the checksum manifest (606 files).
- Verified source ZIP integrity, baseline build 14, new build 15, and the
  single-window plist setting.
- `git diff --check` passed.
- Added four native regression tests covering immediate tool-up checkpoints,
  next-contact cancellation resistance, lifecycle saves, final-callback updates,
  and the single-window configuration.

## Verified for the TestFlight update on 2026-09-05

- Source commit: `433c161a7f3f6b591733cba6163bfda6f1573988`.
- Both the rollback branch and update branch are preserved in the personal GitHub repository.
- macOS native CI passed: **13 tests, zero failures**, including all four new
  `NativePencilRecoveryTests`.
  Run: https://github.com/maxdu0016-gif/dim0-ipad-pencil/actions/runs/34003354131
- EAS production build succeeded:
  https://expo.dev/accounts/maxdus-team/projects/max/builds/0e7cf38a-05d7-4772-a461-d4dd1547f8ba
- Downloaded signed IPA verified as `com.dim0.canvas`, `1.2.0 (15)`, with multiple
  scenes disabled. Local file: `ios-native/builds/Dim0-1.2.0-build15-store.ipa`.
- Successfully uploaded to App Store Connect:
  https://expo.dev/accounts/maxdus-team/projects/max/submissions/51f5a9bc-a503-44a8-a383-3035e8de37be
- Apple processed build 15 as `VALID`, with internal testing active. Apple build ID:
  `0a4053d8-c328-43ac-a045-273006744546`.
- External group `Dim0 iPad Beta` created with ID `a5bfc049-be77-4a94-b937-7ed6442f27fe`.
  User-supplied contact details and the local-board review instructions were saved in App Store Connect.
- Build 15 added to the external group and submitted for Beta App Review:
  `WAITING_FOR_REVIEW` (review ID matches the Apple build ID above).
- Public invitation enabled with a 100-tester limit:
  https://testflight.apple.com/join/gHp1zQC1
  External installation remains gated on Apple's review approval. This link is
  an invitation URL, not a manually generated email redemption code.

## Not passed / not executed

- Existing web iPad/ink/toolbar tests: default and single-worker attempts did not
  complete. The sandbox attempt first failed on esbuild directory access; later
  runs stalled after startup and were terminated. No pass result is claimed.
- Frontend TypeScript check: did not return a result and was terminated.
- Real Apple Pencil input, forced-close recovery, and writing latency: not tested.
- The hosted web frontend was not changed by this native-only update.

## Required before calling this version ready

On an iPad test rapid short strokes,
tool-up followed immediately by background/lock, re-opening the same board,
changing board and camera, and confirming that acknowledged strokes are not
duplicated. Compare writing latency against build 14. Test interrupted saves
separately from already completed saves; a process killed before PencilKit
delivers its sample or before disk completion cannot be guaranteed recoverable.

The rollback instructions are in the workspace's
`rollback/2026-09-04-build14/README.md`. That backup contains exact source and the
verified build-14 signed IPA, but not an immutable hosted deployment. Preserve local user
data when changing installed versions.
