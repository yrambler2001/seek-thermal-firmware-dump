# BRANCH_NOTES — `preservation/full-flash-pipeline`

Branch of the dump-tooling monorepo (`seek-thermal-firmware-dump`) implementing the
automated **v1 full-flash preservation pipeline**: back up what the wire can read,
patch the ACTIVE boot slot in place, dump the whole 4 MiB through the widened
window, deliver a byte-clean image of the camera's ORIGINAL flash content, and put
the original bank back. Primary target Compact **1.3.0.0** (Compact 1.2.0.0 /
1.0.0.0 are the same route — the patch sites are byte-identical); the 2016 Compact
PRO in-place variant is the documented next step, not implemented here.

## Base-commit deviation (flagged on purpose)

The mission said to branch from the dump repo's default branch. `main` there predates
the whole monorepo refactor (no `packages/core`, no profiles, no emulator harness — it
is the pre-TypeScript tree), so code based on it could not build against the tree this
mission points at. The branch is therefore based on **`e53fe6c`**, the current
committed HEAD of `refactor/all-firmware-profiles` (the active development line).
The other agent's working tree, index and stashes were never touched; this branch
only shares history with their branch.

## What landed

| Milestone | Commit          | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1        | `45fe65b`       | `packages/core/src/preservation/patch.ts` (patch builder: keystream, verbatim header window, word sum, the four 2014-family sites with before-byte gates, word-142 rebalance, the ciphertext conjugation, two-tier capture verification), `windows.ts` (the 31 windows, boot-config parse, bank/mode table), `pipeline.ts` (all four phase primitives + the one-process runner), `errors.ts` (`pipeline/refused` code), core exports, `test/emulator/harness.ts` additive StartOptions (`donor`, `jedec`, `hostWaitBudget`, `flashOverride`), `test/preservation/patch.test.ts` (12 tests). |
| M2+       | (see `git log`) | The emulator-driven four-phase suite `test/preservation/pipeline.emulator.test.ts`, the CLI command `seek-fw preserve`, the README section, this file.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Result (final tree, 2026-09-24)

The emulator-driven four-phase suite is GREEN end to end (5/5 tests, two consecutive
full runs, run8 and run9), Compact 1.3.0.0 on the 2016 donor:

- P1: 31/31 windows complete (2,031,616 B backed up).
- P2: cfg[0] blank -> bank A (0x14050000, mode 7); the bank capture matched the
  builder's expected as-booted bytes BEFORE the write; commit status 0x0 in 747
  chunks (47,768 B staged); the commit server's polite-stop `.final` differs from
  the as-booted image by EXACTLY the ten enumerated bytes, all inside the bank —
  bootloader block, boot-config block, banks B/C, the region above the banks and
  the bank's erased tail all byte-identical.
- P3: the whole 4 MiB drained on one fresh arm (the drain-first order — see the
  d4 budget fact below); raw dump == the post-commit `.final`, 0 diffs,
  sha256 `0a3c89e2cd17222a6df2f8e485e40c141ce54ddd1f91932de930d366f34c8308`;
  the delivered dump (bank swapped back) == the as-booted image, 0 diffs,
  sha256 `43f959608e6a6b8ac491fdddbde6c4dd930fe70b1a6fdf2e3d9f9e5c2ee13e10` —
  which is byte-for-byte the sha FW-V1 doc 34.11 recorded for this build's
  in-place restore, independently reproduced here.
- P4: the original bank committed back (status 0x0), reset, and a fresh boot of
  the restored part re-read all 31 windows with 0 differing bytes against the
  P1 backup.

## How to run

Unit tests (run everywhere; corpus-gated parts light up when the emulator directory
carries the Compact 1.3.0.0 plaintext and the 2016 donor dump):

```sh
npm ci
npx vitest run packages/core/test/preservation/patch.test.ts
```

The emulator-driven four-phase suite (`SEEK_EMU_DIR` must point at a FW-V1 `emu`
directory whose `seekemu/cli.py` supports `--host-wait-budget`, `--donor`, `--jedec`
— the FW-V1_copy tree does; the older FW-V1 tree lacks the budget flag):

```sh
SEEK_EMU_DIR=/path/to/FW-V1_copy/emu npx vitest run packages/core/test/preservation/pipeline.emulator.test.ts
```

It asserts, against real emulator lifecycles: P1's 31 windows complete; the bank
capture equals the builder's expected as-booted bytes before anything is written;
P2's commit returns status 0x0 in 747 chunks; the commit server's `.final` differs
from the as-booted image by EXACTLY the ten enumerated bytes inside the active bank
(bootcfg, bootloader, other banks and the erased tail untouched); the P3 raw dump
equals that `.final` with 0 diffs; the delivered dump (bank swapped back) equals the
as-booted image with 0 diffs (sha256 pairs in the assert messages); P4's restore
re-reads 31 windows with 0 diffs and, when the restore server stops politely, its
`.final` equals the as-booted image over the whole 4 MiB.

Operator command shape:

```sh
seek-fw preserve plain-1.3.0.0.bin --out ./preserve-run --yes
```

## Measured facts this branch encodes (all from FW-V1 doc 34 / re-measured here)

- A blank `cfg[0]` boots bank A: the donor bootloader validates A → B → recovery in
  that fixed order; the active slot is bank A, `0x14050000`, armed by mode 7 + token.
- The 2014 builds' type-7/8/9 commit programs the staged bytes VERBATIM, writes no
  boot-config record, and erases exactly the 64 KiB block. Stage IMAGE LENGTH ONLY
  (47,768 B for 1.3.0.0 → 747 chunks of 64 B); the as-booted bank tail past the image
  is already erased, and a full 64 KiB stage would overrun the staging buffer.
- The slot is ciphertext (`plain XOR keystream(KeyB)`, seeded `[k1,k2,k3,k0]`, no
  whitening, header words 128..143 verbatim). The patch lands as
  `wire[off] ^= old_plain[off] ^ new_plain[off]` — writing new plaintext bytes into
  the capture corrupts the slot (measured in FW-V1 run 1).
- The rebalance word (142, at 0x238, inside the verbatim window) is `0x30006240` for
  this patch set; the ten-byte diff set is asserted, not assumed.
- A wire-89 reset resets the part in the middle of its own control transfer: that one
  URB is never answered, and on the gated-clock emulator it never retires, so a
  server that served a reset cannot always stop politely. The suite therefore keeps
  the commit server reset-free (its `.final` is the P2 ground truth) and teaches the
  delivery audit the reset's exact orphan shape (<= 1 unanswered transfer, a 0x41/0x59
  on the wire, no drops) — every other violation still fails the row.
- THE WIDENED WINDOW HAS A PER-ARM BYTE BUDGET. The reader descriptor's `d4` is a
  remaining-bytes counter, decremented by every served read; when it reaches 0 the
  descriptor closes and further reads stall. The patch sets the per-arm budget to the
  whole 4 MiB, which means ANYTHING consumed from an arm before the drain — the
  patch-live probe included (0x21000 B) — shortens that drain's reach by the same
  amount (measured 2026-09-24: a probe-then-drain run stalled deterministically at
  4,063,232 B, twice, on fresh servers). The P3 order is therefore DRAIN FIRST on its
  own single arm (the full-4-MiB completion is itself the liveness proof — a stock
  64 KiB window closes the descriptor long before 4 MiB), and the explicit probe runs
  afterwards on its own fresh arm. Both the library (`pipeline.ts`) and the emulator
  suite encode this order.

## Known pre-existing flake (not from this branch)

`npm run check`'s one red row — `packages/cli/test/camera.test.ts > seek-fw dump >
reads the whole flash...` timing out at its own 5 s limit under the full monorepo's
parallel vitest — reproduces on the PRISTINE base state (verified by stashing this
branch's changes and re-running: identical failure, `1 failed | 556 passed`). The
test passes in isolation (18/18). Load-sensitive timeout, untouched here.

## Deviations and deferrals

- **Base commit**: `e53fe6c`, not `main` (above).
- **Emulator for tests**: `SEEK_EMU_DIR` must point at a tree with `--host-wait-budget`
  (FW-V1_copy); the repo harness default (`FW-V1/emu`) lacks that flag, and in a
  `/tmp` worktree the harness's relative default does not resolve at all.
- **2016 in-place variant**: not implemented (the mission allowed "if it fits"). The
  2016 build needs the ks0-form staged payload (`expected_slot_a.bin` shape), its own
  patch-live probe shape (mode-2 refusal flips), and its own restore payload; the
  v1 modules are structured so `patch.ts`/`windows.ts` extend per family.
- **P4's whole-4-MiB offline proof** depends on the restore server stopping politely;
  the reset orphan can deny it, in which case the in-band 31-window verify (0 diffs)
  is the proof and the suite says so on stderr.
- **FW-V1_copy remains untouched** (read-only knowledge source); the emulator bugs or
  sharp edges found (the reset-orphan stop wedge on a gated clock) are documented
  here instead of fixed there.
