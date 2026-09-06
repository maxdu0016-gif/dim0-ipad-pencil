# Build 15 recovery change — validation status

Baseline: `278c52f7`, native build 14. Working branch:
`codex/ipad-durable-pencil-save`. Both XcodeGen and EAS local metadata target build 15.

## Completed locally

- Preserved the clean baseline as a separate Git branch, a verified complete Git
  bundle, a source ZIP, pre-change local web artifacts, and existing older IPAs.
- Verified all 605 backed-up payload files against SHA-256 checksums.
- Verified source ZIP integrity, baseline build 14, new build 15, and the
  single-window plist setting.
- `git diff --check` passed.
- Added four native regression tests covering immediate tool-up checkpoints,
  next-contact cancellation resistance, lifecycle saves, final-callback updates,
  and the single-window configuration.

## Not passed / not executed

- Native compilation and XCTest: not run; this Windows host has no Xcode or iPad
  simulator. The existing `ios-native-ci.yml` test target includes the new file.
- Existing web iPad/ink/toolbar tests: default and single-worker attempts did not
  complete. The sandbox attempt first failed on esbuild directory access; later
  runs stalled after startup and were terminated. No pass result is claimed.
- Frontend TypeScript check: did not return a result and was terminated.
- Real Apple Pencil input, forced-close recovery, and writing latency: not tested.
- No new IPA was built, no remote branch was pushed, and no site was deployed.

## Required before calling this version ready

Run the native XCTest scheme on macOS, then on an iPad test rapid short strokes,
tool-up followed immediately by background/lock, re-opening the same board,
changing board and camera, and confirming that acknowledged strokes are not
duplicated. Compare writing latency against build 14. Test interrupted saves
separately from already completed saves; a process killed before PencilKit
delivers its sample or before disk completion cannot be guaranteed recoverable.

The rollback instructions are in the workspace's
`rollback/2026-09-04-build14/README.md`. That backup contains exact source, not a
verified build-14 signed IPA or immutable hosted deployment. Preserve local user
data when changing installed versions.
