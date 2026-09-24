# Testing strategy — what this repository can prove, and what it cannot yet

An investigation, written 2026-09-21, into how to test this toolkit using the firmware dumps and
the documented firmware knowledge that exist on this machine. Nothing in here is committed except
the prototype described in §7; the rest is a proposal.

**The one-sentence finding.** This repository has 404 tests and every one of them is synthetic —
the suite builds an image with this code's own cipher and packager and then checks that this code
reads it back — so it is structurally incapable of catching the only failure that actually bricks a
camera: this code's _model_ of Seek firmware drifting away from what Seek firmware _is_. Fifteen
real 4 MiB dumps across seven product families sit in a sibling directory, unused by any test.
Closing that gap is worth more than every other idea below combined, and §7 shows it done and
passing.

---

## 1. What is actually here

|                            |                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Shape                      | TypeScript monorepo, npm workspaces: `@seek-fw/core`, `@seek-fw/cli`, `@seek-fw/web`                                     |
| Tests                      | **vitest**, 29 files, **404 tests**, all passing, ~5 s                                                                   |
| Coverage                   | `@vitest/coverage-v8`, per-area thresholds (crypto/image/profiles/archive held at 95–98 %)                               |
| CI                         | `.github/workflows/ci.yml` — format, lint, typecheck, `test:coverage`, build, and a check that `docs/` matches the build |
| Lint/format                | eslint (`strictTypeChecked` + `stylisticTypeChecked`), prettier; `npm run check` runs the lot                            |
| Firmware dumps in the repo | **none, by design**                                                                                                      |

**There is no dump archive in this repository.** The dumps live at `../SEEK_DUMPS` (override with
`$SEEK_DUMPS_DIR`), and the repository already takes the view that they belong outside it —
`scripts/verify-against-legacy.mjs` reads them from exactly that location and says so in its header
comment. That convention is the right one and everything below follows it.

> **`docs/` is a build artifact.** GitHub Pages serves the web app from `docs/`, and CI fails if it
> does not match `npm run build`. No hand-written markdown may go there. This file is at the root
> for that reason.

### 1.1 The corpus, measured

15 files of exactly 4 MiB; **13 distinct by content** (two pairs are byte-identical duplicates
under different names). Everything in this table was read off the dumps, not assumed:

| family                    | footer model string     | profile detected | slots | image len       |
| ------------------------- | ----------------------- | ---------------- | ----- | --------------- |
| Compact                   | `32K_43X0_COMPACT-8HZ`  | `modern-4x`      | 3     | 42,680          |
| Compact XR                | `32K_43X0_COMPACT-8HZ`  | `modern-4x`      | 3     | 42,680          |
| Compact Pro (2019)        | `80K_4330_COMPACT-9HZ`  | `modern-4x`      | 4     | 54,840          |
| Compact Pro FF            | `80K_4330_COMPACT-18HZ` | `modern-4x`      | 3     | 44,808          |
| Nano 300                  | `80K_4320_NUGGET-27HZ`  | `modern-4x`      | 4     | 44,776          |
| Compact Pro (2016 gen) ×3 | _(no footer)_           | `compact-2016`   | 1–3   | 51,848 / 51,932 |
| HT-201                    | _(none found)_          | `generic`        | **0** | —               |

Two observations that a test should pin rather than rediscover:

- **The 2016 generation has no `"CODE"` footer and an erased boot-config block**, and it still
  boots (§6). So "a valid header with a missing footer is a brick" is a **`modern-4x` rule, not a
  family-wide one**. Any artifact linter must be profile-aware or it will condemn a working image.
  The repo already encodes the asymmetry correctly — `compact-2016` declares
  `flash: unsupported(...)` — which is exactly the kind of decision a corpus test should freeze.
- **The HT-201 is layout-compatible but crypto-incompatible.** Its boot-config block at `0x14010000`
  is intact and names the three standard slot bases, and all three slots are present and identical
  — but they are _fully_ encrypted, with no cleartext header window, so the `0xa1b2c3d4` magic
  appears nowhere in the 4 MiB and `findImages` correctly returns nothing. Its vector table at
  offset 0 is high-entropy too. This is a Seek-shaped flash with a different cipher, and it is the
  corpus's natural negative control.

### 1.2 What exists already, and what it does not prove

`scripts/verify-against-legacy.mjs` is good and should stay: it loads `legacy/index.html` into a
stub-DOM `vm`, runs both implementations over the real dumps, and requires identical keystream
state, acceptance checksum, plaintext and rebuilt bank payload. Run here it reports
**42 slots compared, 0 mismatches**.

But it is a _differential_ against a second implementation of the same model, and it is a manual
script — not a vitest target, not in CI, and it asserts no absolute value. **If both
implementations drifted the same way, it passes.** It cannot tell you that slot A of the Compact
PRO FF is supposed to be 44,808 bytes hashing to `48f0ebfd…`; it can only tell you the two agree.

---

## 2. The knowledge that converts into assertions

An independent, byte-exact reconstruction of the Compact PRO FF firmware exists at
`../FW-V1`, with `AGENTS.md`, `docs/ADDRESS_MAP.md`, `docs/EMULATOR.md`, `fidelity_ledger.md` and a
working emulator. The parts that turn into test assertions:

**Structure** — `header.length` at `0x204`; a 32-bit additive acceptance checksum over
`header.length` bytes; bank payload = image + `0xFF` pad + 64-byte `"CODE"` footer, sized
`((header.length >> 14) + 1) * 0x4000`, footer at `payload_len − 0x40`; slot bases `0x14030000` (A),
`0x14050000` (B), `0x14070000` (recovery); boot-config at `0x14010000` with `cfg[0]` selecting 0/1/2.
**`packages/core/src/image/header.ts` already implements every one of these**, correctly and with
the reasoning in comments. So these are _regression_ assertions, not new discoveries — which is
what makes them cheap.

**Crypto** — two 128-bit keys and an xorshift128 stream cipher, constants embedded in clear in the
image. Obfuscation, not security: no signature, no MAC. Decrypt-then-verify-checksum round trips are
therefore total, not probabilistic.

**Reference values (Compact PRO FF)** — all four confirmed by hand against `../SEEK_DUMPS` during
this investigation:

|                           |                                                                    |
| ------------------------- | ------------------------------------------------------------------ |
| dump sha256               | `42b8fe1232de3452bc7a92207a94ed75aa55ea0e59c0fd427224a1d7fcbbf734` |
| bootloader, first 64 KiB  | `0f69f9128db87b39ff51e89cf4a4dcfdd6b83a8bb263ffbb11950a64e55ecdbe` |
| decrypted image, 44,808 B | `48f0ebfd3f55d1dc4aee16f693eedd11c2d5cbbe88f4ca200a90c8ea1b19e735` |
| bank payload, 49,152 B    | `b612d2e4117f3e42a704fc71a693eb3f9997860ce03f0ff7a993dee24412f880` |

This is the single most valuable asset in the whole investigation: **two unrelated codebases,
written from different directions, that must agree on specific bytes.** An assertion against a
number this repository generated is a regression test. An assertion against a number another
project derived independently is a _correctness_ test.

**Dangerous-shape knowledge** — a bare image bricks the device, and a valid header with a missing
footer does **not** fall back to recovery. On `modern-4x` (see §1.1).

---

## 3. The prioritized test suite

Ranked by (damage prevented) ÷ (cost to build). Every test names its tier:
**[A]** needs nothing but the repo · **[B]** needs the dump corpus · **[C]** needs the emulator ·
**[D]** needs hardware — out of scope.

### P0 — Corpus decrypt regression **[B]** · built, see §7

**Asserts:** for every dump in the corpus, keyed by its own sha256 — detected profile and whether
detection was ambiguous; every slot's flash address, declared length, acceptance sum, whitening
constant K, key confidence, whitening evidence, SP, entry point, duplicate relationships, and the
sha256 of its decrypted plaintext.
**Draws on:** the dumps, plus the four cross-repo reference values asserted separately by name.
**Cost:** built in this investigation — one test file, one generator script, one 19 KB JSON.
**Catches:** any change to the cipher, the scanner, the header parser, the key recovery or the
profile tables that alters what real firmware decrypts to. This is the class that bricks cameras,
and nothing in the repository currently detects it.
**Degrades:** corpus absent → loud skip on stderr, exit 0.

### P0 — Flash-artifact safety linter **[A]**

**Asserts:** that everything the flash path is willing to produce is _flashable_. Given a candidate
payload: header magic and word-aligned `length` at the right offsets; acceptance sum equals the
profile's target computed over exactly `header.length` bytes; total size exactly
`((length >> 14) + 1) * 0x4000`; `"CODE"` footer present at `payload_len − 0x40` **when the profile
requires one**; pad bytes are `0xFF`. And the negative controls: a bare image, a truncated payload,
a payload with the footer zeroed, and an off-by-one `length` must each be _refused_, with the
refusal naming what is wrong.
**Draws on:** the FW-V1 brick post-mortems, and `assertBankPayload` / `buildBankPayload`, which
already exist — so this is mostly negative-control coverage of code that is already written.
**Cost:** small; one test file, no new production code.
**Catches:** the highest-consequence bug in the product. A camera whose bootloader has no USB
recovery cannot be un-bricked. The profile-awareness requirement from §1.1 is the subtle part.

### P1 — Structural invariants over the corpus **[B]**

**Asserts:** properties that must hold for _any_ dump of a given profile, without a pinned
expectation — so a newly added dump is checked the day it lands. For `modern-4x`: vector-table word
0 is an SRAM address and word 1 a `0x140xxxxx` Thumb reset vector; the boot-config block selects a
slot base that actually holds an image; every discovered slot's footer `length` agrees with its
header `length`; slots that declare the same length decrypt to the same plaintext or are reported
as distinct, never silently one-of. Unknown-profile dumps assert only that the tool declines
cleanly.
**Cost:** small–medium.
**Catches:** corpus rot (a dump silently truncated or corrupted on disk), and model drift on
firmware versions nobody pinned.

### P1 — CLI/manifest contract over a real dump **[B]**

**Asserts:** `decrypt --json` over one real dump produces a manifest whose schema and key fields are
stable — profile, per-slot records, `plainSha256`, artifact filenames including the
`-KeyA-…-KeyB-…` suffix convention. The existing CLI tests do this with a synthetic image; one real
dump pinned here catches formatting that only breaks on real-world lengths and names.
**Cost:** small. **Catches:** silent breakage of the archive contract the README documents.

### P2 — Promote `verify-against-legacy` to a real test **[B]**

**Asserts:** what it asserts today, but as a vitest file that skips loudly without the corpus,
rather than a script nobody runs. Keep it _alongside_ P0, not instead of it: it checks a different
thing (port ≡ legacy) than P0 does (port ≡ reality).
**Cost:** small — mostly moving code. **Catches:** divergence from the only implementation that has
ever driven hardware.

### P2 — Emulator boot-and-enumerate gate **[C]** · viability proven, see §6

**Asserts:** each corpus dump boots in the LPC43xx emulator, reaches USB idle, enumerates, and
reports the expected VID/PID, manufacturer, product string and per-unit serial.
**Cost:** medium — needs a Python subprocess bridge from vitest, `unicorn`, and the mask ROM.
**Catches:** what byte comparison structurally cannot — that a dump the toolkit _parses_ is a dump
that _runs_. The ceiling here is high and mostly unreached: a natural extension is to flash a
toolkit-produced payload into the emulator's copy-on-write flash and boot it, which would make the
brick-vs-boots question answerable in software, on every commit, with no camera at risk.
**Degrades:** `unicorn`, the emulator or the mask ROM absent → loud skip.

### P3 — Protocol replay against recorded transfers **[B/D]**

**Asserts:** the `BeginFirmwareUpgrade` / `GetFeaturedFirmwareData` window walk reproduces a
recorded dump session byte for byte, replayed through the existing `fake-transport.ts`.
**Cost:** medium, and it needs a recorded session that does not yet exist. **Catches:** selector-map
and chunking regressions per profile. Recording it needs hardware once; replaying it does not.

### Out of scope **[D]**

Anything that writes to a camera, anything needing WebUSB in a real browser, and the
`legacy-auth` per-unit token path. State this in the suite rather than leaving it implied — the
honest boundary is worth more than a fake test.

---

## 4. Runner and layout

**Keep vitest. Add nothing.** The repo has a working runner, strict lint, per-area coverage
thresholds and CI; a second framework would be pure cost. Everything proposed above is a vitest file
plus, where needed, a generator script under `scripts/` — the convention
`scripts/verify-against-legacy.mjs` already set.

```
packages/core/test/
  corpus.test.ts               [B] P0  the corpus decrypt regression          (built, §7)
  corpus/expectations.json         the pinned facts, keyed by dump sha256     (built, §7)
  corpus-invariants.test.ts    [B] P1  profile-wide properties, no pins
  flash-safety.test.ts         [A] P0  the artifact linter + negative controls
  legacy-parity.test.ts        [B] P2  verify-against-legacy, as a test
packages/cli/test/
  corpus-manifest.test.ts      [B] P1  --json contract over one real dump
emulator/                      [C] P2  subprocess bridge, if §6 is pursued
scripts/
  update-corpus-expectations.mjs    regenerate the pins                       (built, §7)
```

**Three rules that make the optional tiers safe:**

1. **A missing optional input is a skip, never a failure.** CI has no corpus and never will. A suite
   that goes red for a missing optional input trains people to ignore red.
2. **The skip must be loud.** Written to stderr, naming the env var that enables it. A silent skip
   is how an optional test quietly stops existing.
3. **Pin facts, not files.** Dumps stay out of the repo; a small generated table of facts goes in,
   keyed by each dump's **sha256** rather than its filename — filenames in a dump collection are ad
   hoc, get renamed, and carry spaces and unicode; the content hash is the only stable identity a
   dump has. It also means a silently corrupted dump reads as an _unknown_ dump rather than as a
   mysterious mismatch.

**Coverage thresholds:** leave them alone. Corpus tests run the same `src/` and will raise measured
coverage when present and lower it when absent — so do not let the corpus tiers become load-bearing
for a threshold, or CI (which never has the corpus) will fail.

---

## 5. What to build first

**The corpus decrypt regression (P0).** It is the only proposal that closes the structural hole
named at the top, the corpus and the reference values already exist, and it is cheap. It is built
and passing — §7.

Second: the flash-artifact safety linter (P0, tier **[A]**). It is the highest-consequence code in
the product, it needs no external input at all, and most of its machinery is already written.

---

## 6. The emulator route, evaluated honestly

`../FW-V1/emu/` is a self-contained emulator that boots a 4 MiB Seek flash dump with no hardware:
real bootloader, slot decrypt, real NXP mask ROM, USB enumeration, all 41 RPC commands, frame
streaming. It was built against **one** unit's Compact PRO FF dump, so the question is whether it
generalises. **It was tried on all 15 dumps rather than assumed.** Results:

| outcome                                           | files       | distinct dumps |
| ------------------------------------------------- | ----------- | -------------- |
| boot + enumerate, emulator exactly as committed   | **11 / 15** | 9 / 13         |
| boot + enumerate, after mapping one memory region | **14 / 15** | **12 / 13**    |
| never boots                                       | 1           | 1 (HT-201)     |

**It generalises across a whole generation, cleanly.** All eleven `modern-4x` dumps boot unmodified
— Compact, Compact XR, Compact Pro 2019, Compact Pro FF, Nano 300 — and each enumerates as _itself_,
reporting the product string and the per-unit serial read out of that dump's own flash:
`CompactPRO FF` / `1818B0Z3K6C8`, `CompactXR` / `1F1660P7U967`, `Compact` / `2229A0YZ7E28`,
`PIR324 Thermal Camera`, and so on. That is a genuinely differential, per-dump observable, and it is
exactly what turns a passive archive into an executable corpus.

**The three failures had one cause, and it was small.** The three `compact-2016` dumps all stopped
at `UC_ERR_WRITE_UNMAPPED` writing to `0x18000000` — a region the emulator does not map, because the
2016 bootloader touches it and the 2018+ one does not. Mapping it (one entry in
`seekemu/machine.py`'s map list, tested in a scratch copy) makes **all three boot and enumerate**,
reporting `PIR324 Thermal Camera`. So the boundary was one address range, not an architecture.
Worth reporting upstream to FW-V1 as a cheap generalisation; it is **not** done here, and the number
above is from a scratch copy, not from the committed emulator.

**The one genuine failure is a genuinely different device.** The HT-201 never executes an
instruction: its reset vector reads `SP=0xED1F976F PC=0xF73175E6`, which is not an LPC43xx vector
table, and §1.1 explains why — the whole flash including the bootloader is encrypted under a scheme
with no cleartext window. No amount of emulator work fixes that without the cipher.

**Conclusion:** the emulator route is real and worth pursuing at **P2**, and it should be scoped as
_"boots every dump of a known generation"_ rather than _"boots anything"_. The honest limits: it
needs `unicorn` and the LPC43xx mask ROM (silicon, captured from one part, living only in
`../FW-V1/emu/data/`), it is Python where this repo is TypeScript, and a boot-and-enumerate run
takes ~1 s per dump. None of that is disqualifying; all of it means tier **[C]**, skip-when-absent.

---

## 7. Prototype: built and passing

The P0 test is implemented, in the working tree, uncommitted.

| file                                          | role                                            |
| --------------------------------------------- | ----------------------------------------------- |
| `packages/core/test/corpus.test.ts`           | the test                                        |
| `packages/core/test/corpus/expectations.json` | 13 dumps' pinned facts, keyed by sha256, ~19 KB |
| `scripts/update-corpus-expectations.mjs`      | regenerates the above from a local corpus       |

```
$ npx vitest run --project core packages/core/test/corpus.test.ts
  Tests  68 passed (68)      627 ms

$ npm run check       # format + lint + typecheck + test
  Test Files  30 passed (30)
       Tests  472 passed (472)

$ SEEK_DUMPS_DIR=/nonexistent npx vitest run
  Test Files  29 passed | 1 skipped (30)
       Tests  404 passed | 1 skipped (407)          exit 0
```

404 → 472 with the corpus present; 404 passed + 1 loud skip and a clean exit without it. Format,
lint and typecheck all pass unchanged.

Among the 68 are two that matter more than the rest — the cross-repository oracle, asserting that
this toolkit's decrypt of the Compact PRO FF produces the 44,808-byte image whose sha256 an
independent byte-exact reconstruction project arrived at, and that the dump's first 64 KiB is the
bootloader that project reads. Those two are the difference between "this code is
self-consistent" and "this code is right".

### What is deliberately not pinned

`label` is excluded from every assertion: renaming a dump file is not a behaviour change. The
expectations file carries **no timestamp**, so a regeneration diffs only where behaviour moved. And
the generator reports `CHANGED` loudly per dump, because adding a dump to the corpus should be an
expansion — if regenerating alters an _existing_ entry, the core's behaviour changed on hardware it
used to handle, and that diff must be read rather than committed.

---

## 8. Built after §7: the emulator suites (tier **[C]**, and they exist now)

§6 evaluated the emulator route at P2 and §3 scoped it as _"boots every dump of a known
generation"_. What is in the tree now goes further, because the emulator gained two things it
did not have when §6 was written: it can serve **any** of its 51 vendored firmwares over
**USB/IP**, and it can make every byte of the emulated 4 MiB part **distinguishable** before
the firmware boots.

| file                                               | what it is                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/emulator-rpc.test.ts`          | **tier 1**, all 51: identity, wire-54 reply, command support, the EP0 ceiling, the auth-token observation, and the selector map verified against served bytes |
| `packages/core/test/emulator-roundtrip.test.ts`    | **tier 2**: the whole 4 MiB through `runDump`, decrypted, compared byte for byte with the emulator's own `--flash-out`                                        |
| `packages/core/test/emulator/usbip-client.ts`      | a dependency-free USB/IP client (control transfers only)                                                                                                      |
| `packages/core/test/emulator/webusb-over-usbip.ts` | a `WebUsbDevice` over that client — the **only** scaffolding, and the only substitution                                                                       |
| `packages/core/test/emulator/harness.ts`           | spawn/teardown, port allocation, the no-leak rule                                                                                                             |
| `packages/core/test/emulator/probe.ts`             | what is asked and what is recorded, shared by the test and the regenerator                                                                                    |
| `packages/core/test/emulator/expectations.*.json`  | the pins, generated                                                                                                                                           |
| `scripts/update-emulator-expectations.mjs`         | the regenerator                                                                                                                                               |
| `scripts/real-usbip-spotcheck.sh`                  | the same emulator through a real Linux kernel and real libusb                                                                                                 |

**No toolkit source was changed.** The adapter implements the structural `WebUsbDevice`
interface `WebUsbTransport` already declares, so the transport, `SeekDevice`, `runDump`, the
profile tables and the decrypt are the real ones. What is substituted is the **host
controller** — USB/IP instead of libusb — and nothing else.

**Until §9.9 that last sentence was not true in effect.** The adapter's `claimInterface`
sent a `SET_INTERFACE` no real host sends (`bmRequestType 0x00`). Every firmware stalled it,
and `WebUsbTransport`'s `'auto'` mode then fell back to device-recipient requests without a
word. _(Since §11 it cannot: `'auto'` falls back only when the platform refuses the claim,
says so, and the dump manifest records it; any other claim failure is an error.)_ So every emulator row in both tiers measured `0x40`/`0xC0` vendor requests, while a
real host sends `0x41`/`0xC1`. §9.9 fixes the adapter and re-measures. **No row of either
tier changes**, because every Seek firmware's vendor handler ignores the recipient bits.
Every row now asserts that it ran on the real-host path.

**Why the fill matters, in one line:** 68–96 % of a real Seek flash is erased, so without it
`0xFF` and "never transferred" are the same byte and a dump that lost a window still compares
clean over most of its length. With it, a gap is a diff at a named address.

**What it found that `profiles.test.ts` structurally could not.** The selector map is checked
by comparing the bytes each armed window serves against the emulator's own image at the
address the profile _claims_ — so "subcommand 5 exposes 0x14030000" becomes a measurement.
Across the 51: 26 firmwares confirm all 63 windows; 8 (the 2016 generation and the 1.3.0.8
Compacts) confirm 25 and refuse 38, which is exactly what `legacy-auth` describes; 16 (the
2014 Compacts) refuse all 63 because `BeginFirmwareUpgrade` stalls on every subcommand,
although `modern-4x`'s own summary says it covers the Compact line. _(Superseded 2026-09-23,
§9.10. Eleven of those sixteen were never measured — the emulator died under them — and with
bit-band support they are: **9** (0.8.0.0 … 1.3.0.0) serve 25 plain windows, one of them at
the address their own table gives rather than the one the map claims; **7** (0.3.0.1 …
0.7.0.8) reach no window. The count of rows confirming 25 at the claimed address is 9, not 8:
the 2016 generation is seven rows.)_ The auth probe makes the
observation `DeviceEvidence.authSelectorWorks` says in its own doc comment is "not made
anywhere yet": on that generation a plain arm of slot A is **refused**, the 18-byte token
arms it, and a wrong token of the same length is **refused** — so the channel is required and
the token really is compared.

**Tier 1 is reproducible, and that word is measured rather than claimed.** It was not.
Two consecutive regenerations on the same machine used to agree on **42 of 51** firmware
rows byte for byte; nine differed in twelve fields (six `commands`, three `auth`, one
`controlInBytes`, one `windows`). Every one of those is a field elapsed device time can
move, and that is exactly what was moving. **No toolkit source was involved in the bug or
in the fix** — both were on the emulator's side of the wire (FW-V1 `docs/EMULATOR.md`
§13.8, `docs/EMULATOR_CORPUS.md` §12):

- **The clock.** The emulated part has no clock; its notion of time is retired emulated
  work. While a client was thinking between two transfers the guest kept executing at a
  rate set by **host load** — measured, the same sixteen transfers gave a different cycle
  count at every completion on two consecutive runs, and half a second of host pause
  between transfers multiplied the device's elapsed time **6.6×**. `--usbip` now gates the
  clock on host activity: nothing outstanding, nothing retired.
- **The re-import.** `recover()` is close-and-reopen, a couple of hundred times per row,
  and four defects lived in that churn. The first three were fixed in FW-V1 Phase 16; the
  fourth — the next session's writer taking the old writer's `quit`, which orphaned the
  old writer and let it drop later sessions' replies — was the residual of §9.6, was
  diagnosed in §9.7 and is fixed structurally in §9.8.

**Five consecutive regenerations — one of them under deliberate CPU load, load average
10 → 161 — now produce byte-identical expectations for all 51 rows** (666.9 s, 679.7 s
loaded, 670.9 s for the last three; `0 of 51` differing between every consecutive pair).
No field is excluded from the pin, and nothing retries to make a row green.

**The residual failure mode this section used to describe is gone, and it was never the
deadline.** Alongside the rest of the suite, about one row in fifty-one used to go quiet
for minutes and read `no-answer`; this section attributed that to a slow emulator against
`WebUsbTransport`'s 5 s deadline. §9.7 measured it instead: the emulator's USB/IP server
was dropping replies it had computed in milliseconds. §9.8 has the fix, the per-row
delivery audit that now guards it, and three consecutive green `npm run check` runs.

**Runtime, stated rather than hidden** (measured 2026-09-22, §9.8). Tier 1 over all 51
takes **108 s** on its own at six concurrent emulators; its critical path is the 0.6.0.4
Compact, ~107–124 s of CPU-bound work on 127 requests the device never completes. The ~11
min this paragraph used to quote, and the "~330 s a row" it blamed on `ensureMode0()`, were
the dropped-reply defect (§9.7). Tier 2 over the 15 dumps runs alongside it, and the whole
`npm test` is **216–254 s** idle, bound by tier 2's fifteen round trips (three waves of
six, ~70–140 s each). `SEEK_EMU_TIER2=none` skips tier 2; `SEEK_EMU_WORKERS` sets the
concurrency (it is per suite _file_, so two files in flight double it).

Skips exactly as §4 rule 1 demands: `SEEK_EMU_DIR` absent → loud skip on stderr, exit 0.
With neither optional input: **445 passed | 3 skipped**, exit 0 (re-measured 2026-09-22).
With the dump corpus but no emulator: **513 passed | 2 skipped**, exit 0 (re-measured the
same day; it was 472 when this paragraph was first written).

---

## 9. Built after §8: the firmware-facts tier, and what it found (2026-09-22)

§3 ranked the test ideas by damage prevented. The one that was missing from that list turned out
to be the cheapest of all, and it caught more than any of them: **read the firmware's own command
table out of the image, and check the toolkit's opcode constants against it.**

### 9.1 The measurement

Every Seek application image carries its RPC method table — an array of 16-byte records whose first
word points at the command's name string, in wire order, with **wire id = index + 53**. That is not
inferred: FW-V1's byte-exact reconstruction of the Compact PRO FF names the structure
(`g_rpc_method_table`, and `tu025_rpc_cmds_data.c` lists all 41 rows with their addresses and wire
ids). `scripts/update-firmware-facts.mjs` finds that array in each of the 36 decrypted images in
FW-V1's corpus by the only structure it needs — consecutive 16-byte slots whose first words, minus
one unknown load base, land on NUL-terminated identifiers, starting at `GetErrorCode` — and writes
what it read to `packages/core/test/firmware/facts.json`. The images stay outside this repository;
the derived facts are committed, exactly as §3's P0 does for the dump corpus, so
`firmware-facts.test.ts` runs on a bare clone.

**36 of 36 tables recovered.** Sizes run 33 to 41 entries, and 41 is what the independent
reconstruction declares for the pilot.

### 9.2 What it says about this toolkit's `OP` table

**Right on 31 of 36 images, wrong on five, and the five matter.**

`GetErrorCode` (0x35), `SetOperationMode` (0x3C) and `GetOperationMode` (0x3D) are at those ids in
**all 36**, from 0.3.0.1 (May 2014) to 4.16.1.7 (Sep 2018) — which is why the mode handshake is safe
to send to a camera nothing is yet known about. From 0.7.0.7 onward, so are `GetFirmwareInfo`
(0x4E), `GetFeaturedFirmwareData` (0x4F), `CompleteMemoryUpgrade` (0x51), `BeginFirmwareUpgrade`
(0x52) and `SetFirmwareInfoFeatures` (0x55).

Before 0.7.0.7 they are not:

| build   | 0x4F                    | 0x50             | 0x51                      | 0x52                      |
| ------- | ----------------------- | ---------------- | ------------------------- | ------------------------- |
| 0.3.0.1 | `UploadFirmwareRowSize` | `UploadFirmware` | `VerifyFirmwareSendCRC16` | **`EnterBootloaderMode`** |
| 0.5.0.2 | `UploadFirmwareRowSize` | as expected      | as expected               | `BeginFirmwareUpgrade`    |
| 0.5.1.0 | `UploadFirmwareRowSize` | as expected      | as expected               | `BeginFirmwareUpgrade`    |
| 0.5.1.3 | `UploadFirmwareRowSize` | as expected      | as expected               | `BeginFirmwareUpgrade`    |
| 0.6.0.4 | `UploadFirmwareRowSize` | as expected      | as expected               | `BeginFirmwareUpgrade`    |

`GetFeaturedFirmwareData` is not in any of those five tables. It is the only command this toolkit
reads flash with, so on these builds **nothing can read a window, however the window is armed** —
and on 0.3.0.1 the wire id a dump arms 63 windows with is a request to leave the application. Hence
the `compact-2014` profile, which refuses `dump` and `sweep` and says which command it would
otherwise have sent.

### 9.3 And about the "per-build" unlock token

`legacy-auth` described its 16-byte token as build-specific, recovered from one PIR324 unit.
Searching every image for those exact bytes finds them **once each in 22 of the 36**, across two
product lines and three years (every 0.x and 1.x build), and in **none** of the 14 post-2018 images
— which have no token check to hold one. The 1.0.3.0 hit at raw `0xAC01` is the address FW-V1's
reconstruction of that handler names independently. One token, not one per build.

### 9.4 The harness change that made the emulator rows honest

§8 recorded a flake: one row in fifty-one wedging under `npm run check`, a different row each time,
`device stalled status IN bRequest=11` from some point on and `no-answer` thereafter (that stall
was the adapter's own malformed `SET_INTERFACE`, on every import from the first; §9.7, §9.9). The fix is
harness-side and it is a distinction rather than a tolerance. `probeTier1` now throws
`ProbeUnmeasurable` when the camera **was** answering and then answers neither `GetErrorCode` nor
`GetFirmwareInfo` through three fresh USB/IP imports, or when the emulator process has exited; the
suite discards that attempt entirely and re-measures from a **new emulator**, up to three times.
Nothing about a discarded attempt is recorded, and a stall or a device error code — the device
speaking — is still measured once and written down as it answered.

§9.7 later showed that "the camera stopped answering" was the emulator dropping replies, and that
a fresh emulator "fixed" it only by starting without an orphaned writer. Since §9.8 every attempt
— discarded ones included — is audited against the emulator's delivery ledger, so a lost reply
fails the row as an infrastructure defect instead of being re-measured into silence.

That distinction also re-classified rows that were never a flake. Eleven rows were pinned with
`no-answer` on every command; on the 2014 Compacts the emulator **dies**, with
`UC_ERR_WRITE_UNMAPPED` on a write to `0x42040204` — a Cortex-M bit-band alias, which FW-V1's own
`docs/EMULATOR_CORPUS.md` says the emulator does not model. Those rows were never a statement about
firmware, and they no longer read as one. _(2026-09-23: FW-V1 models the bit-band aliases now, and
the eleven are measured — §9.10. The emulator died during the probe's GetChipID, the second
vendor request, not in the window probe that noticed it.)_

### 9.5 The open disagreement, stated as one

> **Resolved 2026-09-23 (§9.10).** The emulator now executes these builds' own dump protocol,
> and the images win on nine of eleven: 0.8.0.0 … 1.3.0.0 serve 25 windows plainly, with the
> token accepted, as `legacy-auth` says — except that their own window table sends subcommand
> 0x0E to 0x140B0000. On 0.7.0.7 and 0.7.0.8 the names in the table are right, but
> `GetFeaturedFirmwareData` sits in the setter column, so a read cannot be dispatched. The
> text below is kept as it was written.

For the eleven 2014 Compacts from 0.7.0.7 to 1.3.0.0, **the images and the emulator disagree**, and
the images are the better evidence:

- the images say these builds have `BeginFirmwareUpgrade` at 0x52 and `GetFeaturedFirmwareData` at
  0x4F, like every later build, so the dump path should work;
- the emulator reaches no window on any of them, because it stops executing on an unmodelled
  bit-band write before the question can be asked.

Neither says what a real 2014 Compact does. Settling it needs one of those cameras, or bit-band
support in the emulator — which is FW-V1's to add, and is already on its unmodelled-MMIO queue.
Until then the toolkit treats them as ordinary `legacy-auth` cameras, which is what their own
command tables say they are, and the emulator rows for them are tracked gaps whose reason says
"not measurable", not "the firmware refused".

### 9.6 The residual, measured over four runs

`npm run check`, four consecutive runs on the same machine, same commit:

| run | result                                     | wall   |
| --- | ------------------------------------------ | ------ |
| 1   | 565 passed, 16 expected fail, **0 failed** | 326 s  |
| 2   | 565 passed, 16 expected fail, **0 failed** | ~400 s |
| 3   | 565 passed, 16 expected fail, **0 failed** | ~400 s |
| 4   | 563 passed, 16 expected fail, **2 failed** | 671 s  |

So it was **not zero**: 2 rows in 204 row-measurements (1.0 %), all four failures in the one
run that took twice as long as the others, both last-two measurements (`SetFirmwareInfoFeatures`,
`EnsureMode0`) reading `no-answer`.

**What this section concluded from that is superseded.** It read the residual as a wedged control
endpoint and proposed three client-side mitigations (reorder the probe, re-take whole blocks, and
fix a `SET_INTERFACE` "wedge" in FW-V1). §9.7 measured it instead: the emulator's USB/IP server was
**dropping replies the device had already computed**, and `SET_INTERFACE` stalls on every import
of every row from the first, so it was never a wedge signature. None of the three mitigations was
made, and none is needed; §9.8 has the fix and the measurements after it (three consecutive
green `npm run check` runs, 0 dropped replies).

### 9.7 Where the wall time goes (2026-09-22)

The question was why some emulator rows run for minutes while nothing uses any CPU. **Answer:
it is an emulator defect, not the firmware, the clock gate or the 5 s deadline.** The USB/IP
server in FW-V1 `emu/seekemu/usbip.py` leaves writer threads orphaned, and those threads **drop
replies the device has already computed.** The host then waits out its deadline for a reply
that will never arrive, and neither side is doing anything while it waits. The same mechanism
is the "one row in fifty-one" residual of §8 and §9.6. Everything below is measured at `497a6f2`
against FW-V1 `c8d56404`.

**Pre-flight (at `497a6f2`; fixed in §9.8): `npm run check` did not pass.** At the tests it
was **565 passed, 16 expected fail, 0 failed**, but one suite failed and the exit code was 1;
wall 914 s, vitest 900.3 s. The
failing suite is tier 1's `afterAll`: `1 emulator process(es) were still running at the end`.
The row behind it is the 0.3.0.1 Compact. It ran into the 900 s row timeout and, being a known
gap under `test.fails`, **the timeout was counted as its expected failure.** Only the leak
check noticed.

**How it was measured.** Three instruments:

- `ps` every 2 s over both runs;
- macOS `sample` on emulator and vitest processes while they sat idle;
- one full `vitest run` against a scratch copy of the emulator (run B: 774.9 s, exit 0, 565
  passed, 16 expected fail). That copy carried env-guarded trace points: every URB completion
  with its emulated cycle count, every gate wait over 0.5 s, every writer start and exit, and
  every item a writer discarded. The copy was deleted afterwards; nothing of it is committed.

#### The mechanism, caught in the act

The server hands out one import at a time. Each import gets a reader thread and a writer thread,
and **all writers take from one shared completion queue**, dropping any item that belongs to
another session. On teardown the reader puts a `('quit', session)` sentinel on that queue. The
toolkit's `recover()` re-imports within a millisecond of closing. If the new session's writer
reaches the queue before the old writer wakes, **the new writer takes the old writer's quit and
drops it**, as a foreign item. The old writer then lives until the emulator exits, pulling items
from the shared queue and dropping every one that is not its own. From run B, the 0.3.0.1
Compact (times in seconds since that emulator started):

```
 7.278 usbip-conn-51 QUIT 42 put
 7.279 usbip-conn-52 ATTACH session 43
 7.279 usbip-tx-43   WRITER 43 DISCARDED quit of session 42        <- writer 42 is now an orphan
 7.283 MainThread    COMPLETE sess=43 seq=2 status=0 took=2.4ms    (GetOperationMode, answered)
 7.283 usbip-tx-42   WRITER 42 DISCARDED submit of session 43 seq=2
12.282 MainThread    GATE waited 4.998 s with no URB pending; attached=True session=43
```

The device answered in 2.4 ms. The host never saw the reply and waited out `WebUsbTransport`'s
5 s deadline. A dropped `SET_INTERFACE` reply costs 30 s instead, because `transport.open()`
goes through the adapter's own URB deadline. During that wait the emulator is parked in
`Bridge._gate()`, correctly, since nothing is pending, and `sample` shows the vitest worker's
main thread in `kevent` in 1,681 of 1,731 samples.

Each lost reply makes the probe do another `recover()`, and each re-import is another chance to
orphan a writer. With k orphans alive, the live writer wins roughly one completion in k+1. So
once a process has one orphan it gets worse from there: `sample` in the pre-flight run showed
`usbip-tx-51` through `usbip-tx-58` alive in the 0.5.0.2 emulator, beside a single live
connection. A fresh emulator starts with no orphans, which is why `ProbeUnmeasurable`'s
re-measurement "fixes" the row: **every affected row was re-measured from a fresh emulator in 1
to 7 s.**

The quit-first check that `0102d307` replaced ended a writer on any quit. That bounded the
orphans, but it had its own defect. The session-first check that replaced it made an orphan
permanent.

#### The slow rows, and what each one was doing

| run        | row (entry)                        | row s | emulator CPU | cause                                                                     |
| ---------- | ---------------------------------- | ----- | ------------ | ------------------------------------------------------------------------- |
| check (A)  | Compact 0.3.0.1 image              | 900   | 8.0 s (1 %)  | 6 writers alive, 1 connection; hit the 900 s timeout                      |
| check (A)  | Compact 0.5.0.2 image              | 479   | 4.6 s (1 %)  | 8 writers alive, 1 connection; fresh re-measure 6 s                       |
| check (A)  | Compact 4.16.1.7-FF image          | 356   | 3.3 s (1 %)  | 7 writers alive, 1 connection; fresh re-measure 3 s                       |
| check (A)  | Compact 4.8.1.9 image              | 312   | 2.8 s (1 %)  | 4 writers alive, 1 connection; fresh re-measure 4 s                       |
| check (A)  | Compact PRO 1.0.3.0 `0C21A1M5KP15` | 276   | 1.8 s (1 %)  | 6 writers alive, 2 connections; fresh re-measure 1 s                      |
| traced (B) | Compact 0.5.0.2 image              | 661.3 | 0.7 s busy   | 640.1 s waiting on 49 dropped replies; 12 orphans; re-measure 7.1 s       |
| traced (B) | Mosaic 2.27.1.33-FF dump           | 658.3 | 0.9 s busy   | 645.3 s on 45 dropped replies; 15 orphans; re-measure 3.7 s               |
| traced (B) | Compact 0.3.0.1 image              | 426.6 | 0.8 s busy   | 409.8 s on 38 dropped replies; 7 orphans; re-measure 3.9 s                |
| traced (B) | Compact 4.8.1.7 image              | 353.5 | 0.7 s busy   | 340.0 s on 24 dropped replies; 10 orphans; re-measure 4 s                 |
| traced (B) | Compact 1.3.0.8-FF image           | 185.6 | 0.4 s busy   | 175.1 s on 16 dropped replies; 5 orphans; re-measure 2.5 s                |
| traced (B) | Compact 0.6.0.4 image              | 101.3 | 92.2 s busy  | **not idle**: 127 requests the device never completes, 722 ms of CPU each |

For run A the row time is the sum of that row's emulator lifetimes, first attempt plus re-measure, from the 2 s sampler, and the writer and connection counts are the `usbip-tx-*` and `usbip-conn-*` threads `sample` found in the first emulator while it idled. For run B they are vitest's
own. **A different set of rows each run, five per run, every one of them started while tier 2's
six CPU-bound emulators were running** (load average 15–22). Idle, the trigger could not be
reproduced: 21,200 close-and-reopen cycles against one emulator lost nothing, both on an idle
machine and under twelve busy loops. So the trigger rate is known only as five processes in
fifty-six per suite run.

#### The budget, by cause

Tier 1 in run B: 52 tests and 2,608 s of row time. Its file wall of 773.9 s **is** the suite's
wall; tier 2 finished at 187.2 s and every other file together took under 30 s.

| cause                                                                              | tier-1 row s     | notes                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(g) replies dropped by orphaned writers**                                        | **2,210 (85 %)** | 172 replies in 5 of 56 processes: 55 waits of ~30 s after a dropped `SET_INTERFACE` reply (1,650 s), 112 of ~5 s after a dropped vendor-RPC reply (~560 s); 5 were still being waited on when the emulator was stopped |
| (d) emulator boot                                                                  | 122              | 56 processes, including the five re-measures                                                                                                                                                                           |
| (c) CPU-bound URB service                                                          | 117              | 91.7 s of it is 0.6.0.4's 127 unanswered requests, each ended by the emulator's host-harness budget with `-ETIMEDOUT`                                                                                                  |
| host side, re-import, spawn and teardown                                           | ~159             | the remainder                                                                                                                                                                                                          |
| (a) deadlines waited out on silent refusals                                        | **0**            | no gate wait over 0.5 s that was not a dropped reply; over control transfers a refusal is a stall, answered in 1–3 ms                                                                                                  |
| (b) the `SET_INTERFACE` stall                                                      | ~0               | it stalls on **1,362 of 1,362** imports, every row, from the first. It is the baseline, not a wedge signature, and costs 1–3 ms. Gone since §9.9: the adapter no longer sends it                                       |
| (e) vitest pool queueing                                                           | 0 on row timers  | rows queued behind the stuck ones still show 3–4 s; but five stuck rows held five of six slots for up to 11 min                                                                                                        |
| (f) a gate deadlock: the host waits with nothing pending and the device needs time | **0**            | `SetOperationMode` was **never sent**. `GetOperationMode` read 0 on every row, so `ensureMode0()` never slept                                                                                                          |

Tier 2 in run B: 1,025 s of emulator life, of which **817 s is CPU-bound transfer** (80 %), 21 s
is boot and 0 replies were lost. Tier 2 never re-imports (one import per row), so it cannot
orphan a writer. It is slow for the reason §8 gives and is not part of this question.

**Hypothesis (f) was tested directly as well as by absence.** On the 0.5.0.2 Compact and the
4.18.2.0-FF Compact PRO, `SetOperationMode(1)`, then `SetOperationMode(0)`, then
`GetOperationMode` every 20 ms reads 0 on the first poll. That holds both gated and with
`--usbip-free-running`: the transition is synchronous, and nothing on this path needs device
time to pass while the host sleeps.

**The deadline was never close.** Across 892,004 answered URBs in run B (status 0 or a stall),
the device's own work per transfer was at most **94,048 emulated cycles** (p50 63,299, which is
≤ 0.5 ms of device time at 204 MHz). The slowest wall-clock reply was **68 ms** (p99.99 21.6 ms),
with twelve emulators competing for CPU. §8 and §9.6 attribute the residual to "three orders of
magnitude slower than silicon against a 5 s wall-clock deadline". That is not what happened: no
reply comes within 70× of the deadline, and **the replies that "timed out" were dequeued and dropped
by the wrong thread.**

**Without the defect**, tier 1's row time would be about 350 s. At six at once, and with the
longest clean row at 101 s, tier 1 would finish well inside tier 2's 187 s, and `npm test` would
be tier-2-bound at roughly 190 s instead of 775–900 s. That was arithmetic from run B. **Measured
after the fix (§9.8):** tier 1's row time is **347 s** on its own and 433–525 s inside the full
suite; `npm test` is tier-2-bound as predicted but at **216–254 s** idle, not 190 s, because tier
2's fifteen round trips (three waves of six, 70–140 s each) run slower alongside tier 1 than they
did in run B.

#### What this corrects in §8 and §9

- "`ensureMode0()`'s three-second settle on each of 63 arms (~330 s a row)": in the traced run
  no row sent `SetOperationMode` at all. From a fresh emulator the 2014 Compacts that answer took
  3.9–7.1 s; 0.6.0.4 took 101 s, all of it CPU. Nothing here reproduces the settle. The long
  2014 rows seen here were this defect; whether the earlier 330 s figure was too cannot be told
  after the fact.
- "`device stalled status IN bRequest=11` on every re-import from some point on": it is on
  every import from the first, on every row, healthy or not.
- "The emulator's slowness against the 5 s deadline": see above. The §9.6 residual (two rows
  whose last two commands read `no-answer`) is what this mechanism produces when the dropped
  replies land on the last measurements. That exact variant was not observed in these two runs;
  the timeout variant (run A) and five recovered rows (run B) were.

#### Fixes, ranked by value against risk (1–3 implemented in §9.8; 4 and 5 not)

1. **DONE (§9.8). Emulator: route completions per session** (FW-V1 `emu/seekemu/usbip.py`). Give each import
   its own queue for completions, unlinks and its quit, so a writer can never dequeue another
   session's item. Count dropped completions in `Bridge.summary()`, and add a self-test that
   forces the interleaving (a delay between `detach()` and the quit) and asserts zero drops and
   at most one live writer. This removes 2,210 of 2,608 s of tier-1 row time, the 900 s hang,
   and by mechanism the residual. It changes delivery only; the device's answers, the gate and
   the cycle counts are untouched, so no test measures anything different. **Low risk, highest
   value.**
2. **DONE (§9.8). Harness: make a dropped reply impossible to mistake for firmware silence.** The emulator
   already counts URBs completed; have the harness compare that with what the client received,
   and raise `ProbeUnmeasurable` naming "completed by the device, never delivered". Cheap, loud,
   changes no measurement, and guards fix 1 against regressing.
3. **DONE (§9.8). Harness: a known gap must not pass on a timeout.** `test.fails` turned run A's 900 s hang
   into a green "expected failure". Assert the gap's own condition and let any other error,
   a timeout included, fail the row. Low risk.
4. **DONE (§9.9), re-measured: 0 of 51 and 0 of 15 rows change. Harness fidelity, because it changes what is measured.**
   `UsbIpWebUsbDevice.claimInterface` sends `SET_INTERFACE` as `bmRequestType 0x00`. USB 2.0
   §9.4.10 requires `0x01`, and neither WebUSB's `claimInterface` nor `libusb_claim_interface`
   sends anything at all. It stalls on every import, so **every row in both tiers has run with
   `WebUsbTransport` fallen back to `recipient: 'device'`**. On a real camera the toolkit uses
   `interface`. The same request as `0x01` succeeds on 4.8.1.9, 0.5.0.2 and 4.18.2.0-FF. Fixing
   it is right, but it changes every vendor request's recipient, so it needs a regeneration and
   a reviewed diff. It is not a speed fix; each stall costs 1–3 ms.
5. **Not recommended now** _(looked at again in §12.5, not done)_: shortening the emulator's
   20,000-step host-harness budget that 0.6.0.4 pays 127 times. That budget is 1.32 M cycles against a worst observed answer of 94,048,
   so there is room. But the row is off the critical path once fix 1 is in, and shortening it
   changes when the emulator declares a request unanswered.

**Deliberately not proposed:** lowering `WebUsbTransport`'s 5 s (toolkit source, and not the
cause), lowering the adapter's 30 s URB deadline (it would make each dropped reply cheaper and
the defect harder to see), and any retry.

### 9.8 The fix, the delivery audit, and what a known gap asserts now (2026-09-22)

§9.7's fixes 1–3, made. Measured at this commit against FW-V1 `9bad9852` (`emu-corpus`, its
Phase 18).

#### Fix 1, in the emulator: nothing shared between sessions

Each USB/IP import is a session with **its own reply queue and its own writer thread**. A reply
goes on the queue of the session its URB arrived on or on none; the teardown's stop marker goes
on that session's queue, which no other thread reads, and the writer is joined before the session
is reported closed. A reply for a session that no longer exists is **counted as dropped, with its
reason** — never routed to another session, never silently discarded. The emulator now stops on
SIGTERM as it does on Ctrl-C and prints its **delivery ledger** as one line after joining every
writer (a real one: three imports of the Compact PRO 1.0.3.0-FF `0B14A1JULD54` dump):

```
---USBIP-SUMMARY--- {"balanced": true, "completions": {"delivered": 11, "dropped": 0,
  "produced": 11, "unresolved": 0}, "dropped_by_reason": {}, "reason": "host script complete",
  "sessions": 3, "urbs": {"answered": 11, "dropped": 0, "outstanding": 0, "submitted": 11,
  "unlinked": 0}, "writers_alive": 0, "writers_stuck": 0}
```

FW-V1's `selftest.py` forces §9.7's interleaving deterministically — the old session's writer is
held off its queue while the next session imports — and requires that the new session gets every
reply, that no writer outlives its session, and that the dropped counter is exact. Against the
pre-fix server it fails 5 runs of 5; against this one it passes 5 of 5.

#### Fix 2, in this harness: a lost reply is an infrastructure defect, never a finding

`Emulator.stop()` sends SIGTERM and waits for the process to finish its own shutdown (SIGKILL is
only a 30 s backstop, and needing it fails the audit). The USB/IP client keeps its own ledger —
`DeliveryLedger` in `emulator/usbip-client.ts`, shared by every session a row opens against one
emulator, re-imports included — and `Emulator.auditDelivery()` compares the two. A row fails with
`InfrastructureDefect` if, for **any** emulator process it started:

| rule                                                                                    | what it catches                                                             |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| the emulator printed no `---USBIP-SUMMARY---`                                           | an emulator that was killed or crashed: nobody knows what it delivered      |
| `completions.dropped > 0`                                                               | a reply the device produced and the server could not deliver                |
| the ledger does not balance (`unresolved != 0`)                                         | a reply that vanished without being counted — the shape of the original bug |
| a writer thread alive or stuck                                                          | a writer outliving its session                                              |
| server `delivered` ≠ client `repliesReceived`, or server `sessions` ≠ client `sessions` | a reply sent and never read; an import the client never saw                 |
| client `repliesUnmatched > 0`                                                           | a reply that arrived after the client had stopped waiting                   |
| on a **live** emulator: URBs outstanding, transfers abandoned, client deadlines hit     | the client gave up on a device that answers every request in < 100 ms       |

The last rule is relaxed only when the emulator **died on its own** (a Unicorn fault, which the
probe records as that row's gap): then an unanswered transfer is explained. Everything else still
applies to those rows.

_(Superseded in §15: an emulator that dies on its own is itself an infrastructure defect and
fails the row at once; it is never recorded as a gap. The relaxation now only keeps the
unanswered transfers from being listed as separate violations under the death.)_

`RowEmulators` (harness.ts) tracks every emulator a row starts, and the audit runs **before**
anything is recorded or compared, in both modes. `InfrastructureDefect` is not a
`ProbeUnmeasurable`, so the re-measure-from-a-fresh-emulator path cannot hide it — a discarded
attempt is audited too — and the regenerator does not turn it into a gap. The summary matrix ends
with a delivery line per tier, e.g.
`delivery: 51 emulator process(es) audited; 17347 repl(ies) delivered, 17347 received by the
client, 0 dropped; slowest row 122.3s`.

#### Fix 3, in this harness: a known gap asserts ITS gap, and nothing else passes

`test.fails` is gone from both tiers. It passed on any throw, so it could not tell "the gap is
still there" from "the row hung for 900 s" — which is exactly what it did on 2026-09-22 (§9.7,
pre-flight). The replacement has three parts:

1. **One measurement function for both modes.** `measureRow()` in each suite returns exactly what
   the regenerator records, gap included: a gap derived from the measurement ("the selector map
   reaches no window: …", "N/M windows read; …") or from a measurement that could not be made
   ("not measurable in 1 attempt(s) … [fault: unmapped addr=0x42040204 at PC=…]"). So the gap an
   assertion checks was computed by the code that wrote the pin.
2. **Every row is an ordinary `it.concurrent`.** A vitest timeout, a thrown error, a leaked
   emulator (the `afterAll` count) or an `InfrastructureDefect` fails a gap row exactly as it fails
   any other.
3. **`assertRecordedGap(entryId, measured, pinned)`** (suite.ts) has three outcomes: the same gap
   with the **same recorded reason** is green; **no gap any more** is red with "was a known gap …
   and is now fully measured — regenerate the expectations and promote it" (the ratchet, kept);
   a **different reason** is red and prints both. After that, a gap row's other pinned fields
   (identity, command outcomes, windows, auth) are asserted like any row's.

One consequence for reading the counts: the 16 known-gap rows used to show as "16 expected fail";
they now pass as ordinary tests, so a green run reads **581 passed** where it used to read
"565 passed, 16 expected fail".

#### The measurements

Machine: 10 cores, with a desktop session running beside the suite. "Load" is `uptime`'s
1-minute average sampled every 10 s.

| run                                                   | exit | passed / expected-fail / failed | wall (vitest) | slowest row (tier 1 / tier 2) | replies delivered = received | dropped | emulators left | peak load |
| ----------------------------------------------------- | ---- | ------------------------------- | ------------- | ----------------------------- | ---------------------------- | ------- | -------------- | --------- |
| `npm run check` 1                                     | 0    | 581 / 0 / 0                     | 269 s (254 s) | 150.6 s / 142.1 s             | 890,380                      | 0       | 0              | 153       |
| `npm run check` 2, **twelve `yes` busy loops** beside | 0    | 581 / 0 / 0                     | 577 s (550 s) | 332.4 s / 246.7 s             | 890,380                      | 0       | 0              | 378       |
| `npm run check` 3                                     | 0    | 581 / 0 / 0                     | 232 s (216 s) | 122.3 s / 106.5 s             | 890,380                      | 0       | 0              | 102       |
| `npm test` alone                                      | 0    | 581 / 0 / 0                     | 219 s         | 123.9 s / 104.1 s             | 890,380                      | 0       | 0              | —         |
| tier 1 alone (`SEEK_EMU_TIER2=none`)                  | 0    | 376 passed, 1 skipped           | 108 s         | 107.0 s / —                   | 17,347                       | 0       | 0              | —         |

- **`npm test` is 216–254 s idle**, against §9.7's arithmetic of ~190 s and the 775–900 s it
  took with the defect. It is bound by tier 2. The slowest tier-1 row, every run, is the 0.6.0.4
  Compact: CPU-bound on 127 requests the device never completes (each ends at the emulator's host
  budget and is recorded `no-answer`, as it was before). Tier 1 alone went from ~670 s to 108 s.
- Across the three checks, `npm test`, the regeneration below and the tier-1-alone run, **381
  emulator processes were audited and 0 replies were dropped**. Before the fix the residual hit 5
  of 56 processes per suite run; it did not recur.
- **Expectations unchanged.** `node scripts/update-emulator-expectations.mjs` (both tiers, 204 s):
  **0 of 51** tier-1 rows and **0 of 15** tier-2 rows differ from the pins;
  `expectations.roundtrip.json` is byte-identical. `expectations.rpc.json` differs in one line,
  its file-level `note`, which described `test.fails` and now describes the reason check.
- Without the optional inputs: `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npx vitest run` → **445
  passed | 3 skipped**, exit 0 (unchanged). With the dump corpus and no emulator: **513 passed | 2
  skipped**.

#### The negative tests, each reverted afterwards

| injected                                                                                  | result                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the emulator drops its 40th reply and **counts** it (scratch copy of `emu/`)              | exit 1; the known-gap row 0.3.0.1 **and** a supported row fail: "the emulator DROPPED 1 of 263 repl(ies) it produced: {"INJECTED …":1}" + "the client closed a session with 1 transfer(s) still unanswered" |
| the emulator discards its 40th reply and counts it **nowhere** (the original bug's shape) | exit 1: "the emulator's ledger does not balance: 1 repl(ies) neither delivered nor counted as dropped" + the abandoned transfer                                                                             |
| `SEEK_EMU_TIER1_TIMEOUT_MS=3000` on the known-gap row 0.3.0.1                             | exit 1: "Test timed out in 3000ms" on the gap row, and the `afterAll` leak check ("1 emulator process(es) were still running at the end")                                                                   |
| a supported row pinned as a gap                                                           | exit 1: "… was a known gap (…) and is now fully measured — regenerate the expectations and promote it"                                                                                                      |
| a gap's pinned reason changed (`-> stall` to `-> no-answer`)                              | exit 1: "the recorded gap CHANGED." with both reasons printed                                                                                                                                               |

#### What is still open

- ~~**§9.7 fix 4, the `SET_INTERFACE` recipient**~~: done in §9.9, with its own regeneration.
  `claimInterface` sends nothing, and every vendor request goes out with interface recipient.
  0 of 66 rows changed.
- **0.6.0.4's margin.** Its never-completed requests take at most ~0.85 s each idle and ~2.6 s
  each at load 378 (the row's time over its 127 requests), against `WebUsbTransport`'s 5 s. If
  one ever crossed it, the client would abandon the transfer and the audit would fail the row as
  infrastructure — correctly, since what the probe recorded would then be the host's deadline, not
  the device's answer — so `npm run check` would go red under that much load rather than record
  anything false. Not observed.
- The re-measure-from-a-fresh-emulator path (`PROBE_ATTEMPTS`) is kept. It can no longer hide a
  lost reply (every attempt is audited); whether it still earns its place is not settled here.
- No toolkit source (`packages/*/src`) was changed.

### 9.9 The recipient fix, and the re-measure (2026-09-22)

§9.7 fix 4, made. The toolkit is at `aa69f72` (the adapter) and `0f69282` (the regenerated
pins). FW-V1 is at `c94c61df` (`emu-corpus`, Phase 19), which also carries an emulator
defect this work exposed. **No toolkit source (`packages/*/src`) was changed.**

**What was wrong.** The emulator suites present the emulated camera to the toolkit through
`UsbIpWebUsbDevice`. Its `claimInterface()` sent `SET_INTERFACE` with `bmRequestType 0x00`.
USB 2.0 §9.4.10 defines `SET_INTERFACE` only as `00000001B`, interface recipient (Table
9-3), and a request a device does not define is answered with a STALL (§9.2.7). Every
firmware stalled it, on every import. `WebUsbTransport.open()` (`webusb.ts:170-189`)
catches any claim rejection and, under `recipient: 'auto'`, sets `recipient = 'device'`.
It reports that only through `onWarning`, which neither suite passed. So every emulator row
in both tiers ran with device-recipient vendor requests (`0x40`/`0xC0`, `wIndex` 0),
which is not the path a real host takes.

#### Ground truth: what a real host puts on the wire

The CLI's host stack is `usb` 3.1.0, which is node-usb-rs over nusb 0.2.7 and not libusb.
The web app's is Chrome's `navigator.usb`. `WebUsbTransport` calls `open()`, then
`selectConfiguration(1)` only if `configuration.configurationValue !== 1`, then
`claimInterface(0)`, and then vendor transfers with `recipient: 'interface'`, `index: 0`.
It never calls `selectAlternateInterface`.

| call                             | WebUSB spec (WICG `index.bs`)                                                                         | CLI: node-usb 3.1.0 → nusb 0.2.7                                                                                                                      | adapter before                                 | adapter now                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| `configuration`                  | `[[configurationValue]]` set from Get Configuration at detection                                      | the OS's value (sysfs `bConfigurationValue` on Linux, the IOKit interface nubs on macOS); no packet                                                   | `null` → the toolkit sent SET_CONFIGURATION(1) | the import record's value (1); no packet |
| `claimInterface(0)`              | "platform-specific steps to request exclusive control"; no control transfer                           | `USBInterfaceOpen` (macOS), `USBDEVFS_CLAIMINTERFACE` (Linux; `claimintf()` in `devio.c` only binds usbfs); no packet                                 | **`SET_INTERFACE`, bm 0x00**                   | nothing                                  |
| `selectAlternateInterface(n, a)` | "Issue a `SET_INTERFACE` control transfer"; interface must be claimed                                 | `SetAlternateInterface` (macOS), `USBDEVFS_SETINTERFACE` → `usb_set_interface()` → `USB_REQ_SET_INTERFACE`, `USB_RECIP_INTERFACE` (Linux `message.c`) | absent                                         | `SET_INTERFACE`, bm **0x01**             |
| vendor transfer, `'interface'`   | interface (low byte of `index`) must exist and be claimed, else `NotFoundError` / `InvalidStateError` | routed through the claimed interface; `invalid state` if none is                                                                                      | `0x41`/`0xC1`, unchecked                       | `0x41`/`0xC1`, checked as the spec does  |

**Measured on the real camera, read-only.** The bench Compact PRO FF runs 4.18.2.0 and was
powered through `USBSW-1` channel 2, with the J-Link left off. It was driven through
node-usb 3.1.0 and the real `WebUsbTransport` exactly as `packages/cli/src/backend.ts`
wraps it. Only GetErrorCode, GetChipID, GetOperationMode and GetFirmwareInfo were sent,
each checked against `facts.json`. macOS had configured the camera
(`kUSBCurrentConfiguration = 1`, interface 0 is vendor class 255), so no
SET_CONFIGURATION was sent. With `'auto'` the claim **succeeded, with no warning**, and the
transport stayed on `recipient: 'interface'`. The four reads answered identically as `0xC1`
and, with `'device'` forced, as `0xC0`: `00000000`, `18001800a600af001200e300`, `0000`,
`04120200`. The camera was powered off afterwards. So on a real host the fallback does not
fire, and the harness had been measuring a path users do not take.

**Measured on the emulator, 8 builds.** 0.3.0.1, 0.5.0.2, 1.3.0.8 and 4.8.1.9 Compacts;
the Compact PRO 1.0.3.0 and FF 4.18.2.0 dumps; the Mosaic FF 2.27.1.33 dump; and the Nano
300 dump. On each, the old adapter drove the transport to `recipient=device` with
`could not claim interface 0 (control 11 stalled (status -32))`. `SET_INTERFACE` as `0x00`
stalls and as `0x01` succeeds; `GET_INTERFACE` (`0x81`) returns 0. GetErrorCode,
GetOperationMode, GetFirmwareInfo and GetChipID return the same bytes as `0xC0` and as
`0xC1`, and all four stall with `wIndex = 1`. The instruments are
`scripts/recipient-fidelity/` (in FW-V1 under `tools/recipient_fidelity/` until
2026-09-23; §9.10).

#### What the adapter does now

For every call it sends exactly what the table's right-hand column says.

- `claimInterface` and `releaseInterface` are host-side state only. They check "opened,
  configured, interface exists" as the spec does; USB 2.0 §9.6.5 makes interface numbers
  `0 .. bNumInterfaces-1`.
- `configuration` comes from the USB/IP import record.
- `close()` releases every claim.
- An interface-recipient transfer to an unclaimed interface is refused before anything
  is sent.
- `bmRequestType` is built from the setup's own type and recipient.

Two guards, so the fallback cannot hide again:

1. **`assertRealHostPath`** (`webusb-over-usbip.ts`) runs after the first `open()` and at
   the end of every row, in both tiers. It throws `HarnessFidelityError` unless
   `transport.info.recipient === 'interface'` and the adapter never rejected a claim; the
   transport re-claims on every reopen, which is up to a few hundred per row. The suites rethrow it, so it is
   never recorded as a gap.
2. **The wire log.** `DeliveryLedger` counts every control transfer by
   `bmRequestType/bRequest`, and the summary matrix now ends with a line such as:
   `wire: vendor requests 15901 interface-recipient (0x41/0xC1), 0 device-recipient
(0x40/0xC0), 747 stalled; SET_CONFIGURATION sent 0; SET_INTERFACE sent 0, stalled 0
(emulator log: 0 'bRequest=11' stall(s)); standard requests stalled: none`. The
   emulator-log count is taken from the server's own `device stalled ... bRequest=11`
   notes, so the claim does not rest on the client counting itself.

**Negative test** (reverted afterwards). With the old claim restored, tier 1 on its own
exits 1. All **51 of 51** rows fail with `HarnessFidelityError: … recipient=device,
claimedInterface=false, 1 claimInterface() call(s) rejected by the adapter (last:
LIBUSB_TRANSFER_STALL: control 11 stalled (status -32))`. The wire line reads
`SET_INTERFACE sent 51, stalled 51 (emulator log: 51 'bRequest=11' stall(s))`.

#### The re-measure, and why nothing moved

`node scripts/update-emulator-expectations.mjs` (both tiers, 199 s, 392 passed, exit 0)
against the pins of `dd336c0`: **0 of 51 tier-1 rows and 0 of 15 tier-2 rows differ.** The
only change in either file is the `note` line, which now names the path the pins were
measured on. The same result came twice before the regeneration, with the fixed adapter
asserting against the old pins: one run matched 50 of 51 plus 15 of 15, and the other
matched 51 of 51 plus 15 of 15. The one row missing from the first run is the emulator
defect below, not a difference.

**No row changed, so there is no per-row before/after table.** The mechanism is in each
firmware's own dispatch. The vendor EP0 handler `usb_ctrl_xfer_handler` is registered with
the mask ROM's `RegisterClassHandler` (FW-V1 `docs/EMULATOR.md` §7.4a). It checks exactly
two things, the type and `wIndex`, and never reads the recipient bits (D4..0). That holds
in all 11 FW-V1 reconstructions that carry a `usb_core.c`:

- `targets/compact_pro_ff/src/usb_core.c:1063`:
  `(bmRequestType.B & 0x60u) != 0x40u || wIndex.W`.
- The same line in `compact_pro`, `compact_pro_4_9_2_0`, `compact_xr`, `mosaic_9hz`,
  `mosaic_ff`, `nano200` and `nano_300`.
- The same check split in two, with an "Ignoring request to non-zero interface" trace, in
  `compact_32k_1_3_0_8` and `compact_pro_9hz_2016`.
- `BM.Type != 2` then `wIndex.W != 0` in `compact_32k_0_3_0_1`.

The only other use of `bmRequestType` in each is the direction bit. Interface 0 is
`wIndex` 0 either way. So the firmware cannot tell `0xC0` from `0xC1`, and the removed
`SET_INTERFACE` stall had no lasting effect: a control-pipe STALL lasts only until the next
SETUP (USB 2.0 §8.5.3.4). The removed SET_CONFIGURATION made no difference either. The old adapter reported
`configuration: null`, so the transport sent SET_CONFIGURATION(1) once per attach, to a part
the emulator had already configured.

#### What it exposed in the emulator: a SIGTERM self-deadlock (FW-V1 `c94c61df`)

The first regeneration against the pre-fix emulator failed 2 rows, and one of the two
assert runs failed 1. None of these was a measurement: each emulator **did not stop on
SIGTERM**. §9.8's 30 s SIGKILL backstop killed it, and the audit failed the row with "the
emulator exited without printing its ---USBIP-SUMMARY--- delivery ledger". That is 3 of 198
processes, all tier 1: 0.6.0.4, 1.3.0.8 and the Nano 200 image. `sample` on the one
captured showed its main thread parked in `lock_PyThread_acquire_lock` under
`handle_signals`.

The cause was the emulator's handler. It called `Bridge.stop()`, which sets two
`threading.Event`s. Python runs the handler on the emulator thread between two bytecodes
of whatever it interrupted. When that was `_gate()` inside `work.clear()` or `work.wait()`,
the thread already held the Event's non-reentrant Condition lock, and it waited for itself.
FW-V1 now has the handler do one attribute store, and the emulator thread stops itself
holding no lock. `selftest.py` forces the interleaving with a real SIGTERM sent from inside
the lock. The pre-fix handler, run verbatim as a control, deadlocks; the fixed one returns.
The self-test count goes from 125 to 127, all pass.

Whether the adapter change raised the rate is **not established**. It was 0 in 381
processes in §9.8 and 3 in 198 here, but the stress instrument
(`scripts/recipient-fidelity/stop_stress.ts`) found 0 hangs in 200 trials at this timing
before the fix. The mechanism does not involve the client at all: the self-test reproduces
it with no socket.

#### The measurements

The toolkit was at `0f69282` and FW-V1 at `c94c61df`, on the same 10-core machine as §9.8.

| run                                  | exit | passed / failed      | wall (vitest)   | slowest row (tier 1 / tier 2) | replies delivered = received | dropped | emulators left | `bRequest=11` stalls |
| ------------------------------------ | ---- | -------------------- | --------------- | ----------------------------- | ---------------------------- | ------- | -------------- | -------------------- |
| `npm run check` 1                    | 0    | 581 / 0              | 218 s (203.7 s) | 114.3 s / 97.5 s              | 889,123                      | 0       | 0              | 0                    |
| `npm run check` 2                    | 0    | 581 / 0              | 219 s (205.3 s) | 115.3 s / 98.1 s              | 889,123                      | 0       | 0              | 0                    |
| regeneration, both tiers             | 0    | 392 / 0 (core)       | 200 s (198.9 s) | 110.3 s / 90.2 s              | 889,123                      | 0       | 0              | 0                    |
| tier 1 alone, **old claim restored** | 1    | 325 / 51 (1 skipped) | —               | 4.5 s / —                     | 281                          | 0       | 0              | 51                   |

- The slowest tier-1 row is still the 0.6.0.4 Compact, CPU-bound as in §9.8. `emulators left`
  is the `afterAll` leak check in both tiers, confirmed by an empty `pgrep -fl seek_emu.py`
  after each run.
- **Every full run's wire line reads:** tier 1 sent 15,901 vendor requests as `0x41`/`0xC1`,
  0 as `0x40`/`0xC0`, and 747 of them stalled (refusals, which are measurements). Tier 2 sent
  872,934 as `0x41`/`0xC1`, 0 as `0x40`/`0xC0`, and 3 stalled. Neither tier sent a
  SET_CONFIGURATION or a SET_INTERFACE, and no standard request stalled.
- **The reply count fell by exactly what was removed.** Tier 1 went from §9.8's 17,347 to
  16,120, down 1,227: one SET_INTERFACE per import (1,176) plus one SET_CONFIGURATION per
  attach (51). Tier 2 went from 873,033 to 873,003, down 30, which is 15 × 2.
- Without the optional inputs, `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npx vitest run`
  gives **445 passed | 3 skipped**, exit 0. With the dump corpus and no emulator it gives
  **513 passed | 2 skipped**. Both are unchanged.
- FW-V1 `emu/selftest.py`: **127 passed, 0 failed, 0 skipped** (196 s).

#### Findings in toolkit source, reported and not patched

_(All six are fixed in §11, 2026-09-23.)_

1. **`'auto'` falls back on any claim rejection, silently unless a caller passes
   `onWarning`** (`webusb.ts:170-189`). Its doc comment says the fallback is for "a driver
   holding the interface", but the `catch` does not look at the cause. A stall, a not-found
   or an unconfigured device all switch the recipient. This is what hid the harness bug for
   a whole campaign. On a real host the claim sends no packet, so only host-side causes can
   trigger it. On every Seek firmware measured the recipient does not change an answer, so
   the fallback costs nothing on the wire. Its risk is the masking.
2. **The recipient is re-decided on every `open()`** (`webusb.ts:154-191`), and
   `runDump`'s retry reopens mid-dump (`dump.ts:158-160`). A claim that fails on a reopen
   switches the recipient partway through a dump.
3. **The dump manifest cannot record either** (from code; not run). `readWindows` closes
   the transport in its `finally` (`dump.ts:226`) before `runDump` builds the manifest from
   `transportInfoOf(device.transport.info)` (`dump.ts:367`). So `claimedInterface` in a
   manifest is always `false`, and `recipient` is the last open's.
4. **Under the CLI, the host stack's own timeout is 1 s, not the transport's.** node-usb
   3.x's `controlTransferIn/Out` default their timeout to 1000 ms
   (`node_modules/usb/dist/index.js:8,22,32`), and `WebUsbTransport` never passes one
   (`webusb.ts:260,274`). So the 5 s `USB_TIMEOUT_MS` race never fires under the CLI. Also,
   `completeMemoryUpgrade`'s 20 s `USB_COMMIT_TIMEOUT_MS` sits on top of a 1 s native
   transfer that the host cancels, although `client.ts` says "the erase, program and verify
   all run inside this one transfer". Not exercised: a commit was not sent to any camera.
   Browsers apply no transfer timeout, and neither does this adapter, so the emulator
   matrix cannot see it.
5. **Under the CLI, a stall rejects instead of resolving `status: 'stall'`.** node-usb-rs
   `webusb_device.rs` `controlTransferIn` turns any nusb error, including "endpoint
   stalled", into a rejection. So `WebUsbTransport` reports a firmware refusal as
   `usb/transfer-failed` ("unplug and replug") rather than `usb/stalled`. This adapter
   models the browser, so the emulator matrix exercises the browser's stall path only.
6. **Latent:** node-usb 3.x's `configuration` getter **throws** on an unconfigured device
   (`active_configuration()` mapped to an error) instead of returning `null`. So
   `WebUsbTransport.open()`'s `dev.configuration?.configurationValue` would throw rather
   than configure the device. Not observed: macOS had configured the bench camera.

### 9.10 Bit-band support: the eleven 2014 Compacts, measured (2026-09-23)

FW-V1 `7203bb36` (`emu-corpus`, its Phase 20) models the Cortex-M4 bit-band aliases. This
repository is at `5abc7c4` (the instruments moved in, below), `f04a7d0` (one adapter fix)
and `0e1f7c6` (the regenerated pins). **No toolkit source (`packages/*/src`) was changed.**

**What was wrong.** Eleven rows, the Compact images 0.7.0.7 … 1.3.0.0, were pinned as "not
measurable … [fault: unmapped addr=0x42040204 at PC=…]". That store is one bit of GPDMA
`INTERRCLR`, written through its bit-band alias by the firmware's `dma_transfers_halt`. The
emulator mapped the peripheral window and not the alias, so it died on it. FW-V1 traced
where: FSM state 9 ("Entering SLEEP") calls `streaming_stop` on the device's own time, right
after the **first** vendor control request. The emulator therefore died during the probe's
**GetChipID**, the second vendor request, and the probe only noticed at its first window
arm, which is why every such gap names "window probe subcmd 0x01". FW-V1 now implements the
aliases as the Cortex-M4 TRM (DDI 0439B §3.7) and Generic User Guide (DUI 0553A §2.2.5)
define them. A load is one read of the target. A store is one read then one write of the
target, at the instruction's own size, through the same hooks a direct access runs
(FW-V1 `docs/EMULATOR_CORPUS.md` §13).

**The re-measure.** `node scripts/update-emulator-expectations.mjs`, both tiers, 392 passed,
exit 0. **Tier 2 is byte-identical.** In tier 1, **12 of 51 rows change**: the eleven, and
0.6.0.4, whose only change is the adapter fix below. Every other field of every other row is
unchanged. Across both regenerations the eleven rows came out the same, apart from that
serial.

All eleven are **chimeras** on the Compact 4.8.2.1 donor `2229A0YZ7E28`. They enumerate as
`289D:0010`, `Seek Thermal` / `PIR206 Thermal Camera`, with no serial. The chip id they
answer, `220029002e009d009200e000`, is the donor's. The profile is `legacy-auth`: the
registry's own `detectProfile()` scores it 0.75 on the version alone and 0.98 with what tier
1 observed, a plain arm of slot A refused and the token accepted.

| build                                                                            | windows served by a plain arm                                                                                                     | legacy-auth token                                                        | tier-1 result                                   | matches the firmware's own code                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 0.8.0.0, 0.9.0.2, 0.9.1.0, 0.10.0.0, 0.9.0.6, 0.9.0.7, 1.0.0.0, 1.2.0.0, 1.3.0.0 | **25 of 63**: 24 confirmed (1, 0x0A…0x21 except 0x0E), **0x0E misplaced to 0x140B0000**; 38 refused (2, 3, 5, 6, 8, 9, 0x22…0x41) | plain arm of slot A refused, 18-byte token accepted, wrong token refused | supported                                       | **yes** — each image's `BeginFirmwareUpgrade` table has 0x140B0000 at entry 0x0E as well as 0x0D         |
| 0.7.0.7, 0.7.0.8                                                                 | **none readable**: the arms of 1 and 0x0A…0x21 are accepted, every read stalls                                                    | the same                                                                 | known gap: "the selector map reaches no window" | **yes** — their RPC table registers `GetFeaturedFirmwareData` (0x4F) in the setter column with no getter |

**Cross-checked against each row's own method table** (`test/firmware/facts.json`) **and
the image bytes.** `facts.json` puts `BeginFirmwareUpgrade` at 0x52, `GetFeaturedFirmwareData`
at 0x4F and `SetFirmwareInfoFeatures` at 0x55 on all eleven, and records the unlock token in
each (0.7.0.7 @0xAA50 … 1.3.0.0 @0xA5B0). The measurement agrees with every one of those
names. What `facts.json` cannot say is which column an entry sits in, and that decides 0.7.0.x:

- **The window table.** Every 2014 image, 0.3.0.1 to 1.3.0.0, carries the literal run
  `0x140A0000, 0x140B0000, 0x140B0000, 0x140D0000`: entry 0x0E repeats 0x0D. In 1.3.0.0
  the handler's `tbb` loads the literal at `0x1008415C + 4n`, and entries 0x0D and 0x0E
  are `0x10084190` and `0x10084194`, both 0x140B0000. So 0x140C0000 cannot be armed through
  `BeginFirmwareUpgrade` at all on these builds. Both 1.3.0.8 images, and FW-V1's
  reconstruction of 1.3.0.8 (`targets/compact_32k_1_3_0_8/src/rpc_cmds.c`), have
  0x140C0000. None of the eleven has a reconstruction of its own; 1.3.0.8 is the nearest.
  The gate is the same code in all of them: modes 2…9 refused on the 2-byte channel, mode 2
  and modes above 0x21 refused outright, and the 18-byte form memcmp'd against the key.
- **0.7.0.7 and 0.7.0.8.** Their table's wire-0x4F record is
  `{name "GetFeaturedFirmwareData", getter 0, setter 0x10083E2D}`. From 0.8.0.0 on it is a
  getter. The handler is shaped like a reader: it walks the armed window and copies out up
  to the requested length. But a control-IN request has no getter to dispatch to. Measured
  over USB/IP with this suite's flags: arms of 1, 0x0A and 0x0B succeed with error code 0,
  and `GetFeaturedFirmwareData` then stalls at 64, 32, 16 and 8 bytes, where 0.8.0.0 serves
  data at every size. Whether the bulk transport reaches that handler was not tried. **So the
  pinned gap text's "(BeginFirmwareUpgrade -> stall)" is true but not the reason.** It is the
  command probe's plain arm of subcommand 5, which every legacy build refuses by design, and
  `windowsRefused` here means "armed, and not readable".

**The adapter fix (`f04a7d0`), and the one other row it moved.** These builds' device
descriptor names `iSerialNumber` 5, and their string table ends at index 3. So
GET_DESCRIPTOR(STRING, 5) returns the head of the configuration descriptor,
`09 02 40 00 02 01 00 80 32`. `readString()` decoded that as UTF-16 and reported the serial
`@Ă耀…`. A real host does not: Linux's `usb_get_string()` answers `-ENODATA` when byte 1 is
not `USB_DT_STRING` (`drivers/usb/core/message.c`), so no serial is exposed. The adapter now
does the same, and 0.6.0.4, the one older row with the same descriptor, moves from that
string to `null`. FW-V1's in-process host already read it as no serial.

#### The measurements

The toolkit is at `0e1f7c6` plus this section, and FW-V1 is at `7203bb36`, on the same 10-core
machine as §9.8 and §9.9.

| run                                    | exit | passed / failed | wall (vitest)   | slowest row (tier 1 / tier 2) | replies delivered = received | dropped | emulators left | SET_INTERFACE sent / stalled | `bRequest=11` stalls |
| -------------------------------------- | ---- | --------------- | --------------- | ----------------------------- | ---------------------------- | ------- | -------------- | ---------------------------- | -------------------- |
| regeneration 1, both tiers             | 0    | 392 / 0 (core)  | 187 s (186.0 s) | 103.1 s / 81.7 s              | 892,120                      | 0       | 0              | 0 / 0                        | 0                    |
| regeneration 2, both tiers, the pinned | 0    | 392 / 0 (core)  | 184 s           | 104.4 s / 82.8 s              | 892,120                      | 0       | 0              | 0 / 0                        | 0                    |
| `npm run check` 1                      | 0    | 581 / 0         | 209 s (194.7 s) | 111.2 s / 93.5 s              | 892,120                      | 0       | 0              | 0 / 0                        | 0                    |
| `npm run check` 2                      | 0    | 581 / 0         | 205 s (190.9 s) | 110.8 s / 89.6 s              | 892,120                      | 0       | 0              | 0 / 0                        | 0                    |

- The two regenerations differ only by the adapter fix (the first ran before it). The
  second is the one committed.
- Tier 1 now delivers 19,117 replies, up from §9.9's 16,120: nine rows run the whole probe
  instead of dying at their second request. Tier 2 is unchanged at 873,003.
- The wire line reads 18,887 vendor requests as `0x41`/`0xC1` and 0 as `0x40`/`0xC0` in
  tier 1, and 872,934 / 0 in tier 2. No standard request stalled.
- The slowest tier-1 row is still 0.6.0.4, CPU-bound as in §9.8. `emulators left` is the
  `afterAll` leak check, and `pgrep -fl seek_emu.py` was empty after every run.
- Without the optional inputs, `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npx vitest run`
  gives **445 passed | 3 skipped**, exit 0, unchanged.
- FW-V1 `emu/selftest.py` gives **137 passed, 0 failed, 0 skipped** (196 s), and the same from
  a copy of `emu/` outside the repository with a fresh venv (199 s).

#### Findings in toolkit source, reported and not patched

_(All four are fixed in §10, 2026-09-23.)_

1. **`legacy-auth` would write the wrong block on nine builds** (derived from the window
   measurement and `buildLegacyWindowMap()`; no dump was run on them). The map claims
   subcommand 0x0E is 0x140C0000. On 0.8.0.0 … 1.3.0.0 that arm serves 0x140B0000, so a
   dump would store 0x140B0000's bytes at 0x140C0000 and never read 0x140C0000. Nothing
   in the dump path would notice, and tier 2 cannot see it: none of these builds is a
   whole dump in the corpus.
2. **The readable range starts at 0.8.0.0, not 0.7.0.7.** `legacy-auth`'s summary says
   "Compact 0.7.0.7-1.3.0.8", and `compact-2014`'s `FIRST_READABLE_VERSION` is `'0.7.0.7'`.
   On 0.7.0.7 and 0.7.0.8 the one read the dump path uses cannot be dispatched over control.
3. **`facts.json` records names, not columns.** A check that a table entry has a getter
   where the toolkit reads, and a setter where it writes, would have caught finding 2 from
   the images alone.
4. **The derived gap text names the wrong command for 0.7.0.x** (above). Changing it
   would re-word seven pinned reasons, so it was left as it is and is recorded here.

#### The instruments moved here

`scripts/recipient-fidelity/` holds the three §9.9 instruments. FW-V1 had committed them
under a new repo-root `tools/recipient_fidelity/`. FW-V1 has had no root `tools/` since its
codegen root migration, and they import this repository's transport and harness. Their
README says why lint, format and typecheck skip the three `.ts` files: they reach into the
adapter's private session on purpose, load the toolkit by computed import, and are kept as
they were run.

---

## 10. Windows and selectors: why "25 of 63" and "31 of 31" are both true (2026-09-23)

A **window** is one 64 KiB block of the 4 MiB part that the firmware will serve over USB. A
**selector** (subcommand) is the small number `BeginFirmwareUpgrade` (wire 0x52) takes to
arm a window; `GetFeaturedFirmwareData` (0x4F) then reads it. Each build maps selectors to
blocks in its own `BeginFirmwareUpgrade` switch, and that switch — not a profile — is the
ground truth.

### 10.1 The two numbers answer two different questions

- **Tier 1's window probe** arms the _modern_ map's 63 selectors, on the _plain_ 2-byte
  channel, against every firmware. On the 2016-2017 legacy builds 25 answer: subcommand 1
  and the 24 linear windows 0x0A…0x21. 38 are refused: 2, 3, 5, 6, 8 and 9 on the plain
  channel (the handler locks modes 2…9 unless the 18-byte token is sent), and 0x22…0x41
  outright (`mode > 0x21`). The modern map has no subcommand 7 and never sends the token.
- **A dump** arms the build's own table. On Compact PRO 1.0.3.0 that is 31 windows: 3, 5,
  6, 7, 8 and 9 with the token, 1, and 0x0A…0x21 — every block from 0x14010000 to
  0x141FFFFF, 31 × 64 KiB = 2,031,616 bytes. Tier 2 read all 31 with 0 differing bytes.
  The firmware's switch has 34 modes; 0 is chosen at run time, 2 is refused outright, and 4
  is a second door onto 0x14020000, which leaves 31 distinct blocks.

So **31 is the true number of windows a dump can read on 1.0.3.0**, and 25 is a correct
count of a different thing: one foreign list, on one channel, out of a denominator (63) of
which 32 selectors do not exist on this firmware. The difference comes from the probe's
selector list, its channel and its counting — not from the firmware. The FW-V1 source it
was asked about says the same: `targets/compact_pro_9hz_2016/src/rpc_cmds.c:2590-2613` is
the gate (mode 2 refused, `mode > 0x21` refused, modes 2…9 locked on the plain channel) and
`:2615-2725` the switch; its address constants are declared at `:2442-2472`.

### 10.2 But the legacy line has four tables, not one

Each image's own switch is now decoded out of its bytes (`scripts/update-firmware-facts.mjs`,
`windowTable` in `test/firmware/facts.json`: the TBB, each case's PC-relative literal, and
the gate in the prologue):

| build                         | mode 1                      | mode 2 (0x14000000)                  | mode 0x0E  | dump windows |
| ----------------------------- | --------------------------- | ------------------------------------ | ---------- | ------------ |
| Compact 0.8.0.0               | run time, from the boot cfg | loads through the word at 0x14000000 | 0x140B0000 | 30           |
| Compact 0.9.0.2 … 1.3.0.0     | 0x14020000                  | armed with the token                 | 0x140B0000 | 31           |
| Compact 1.3.0.8 (8 Hz, 16 Hz) | 0x14020000                  | 8 Hz: token; 16 Hz: refused          | 0x140C0000 | 31           |
| Compact PRO 1.0.3.0, 1.0.3.2  | 0x14020000                  | refused outright                     | 0x140C0000 | 31           |

- **Every 2014 image gives 0x0E the address of 0x0D.** Its switch carries 0x140B0000 twice,
  so no selector arms 0x140C0000. The shared map said 0x0E was 0x140C0000, so a dump of a
  2014 Compact would have filed 0x140B0000's bytes under 0x140C0000.
- **0.8.0.0's mode 1 reads entry 4 or 5 of the bootloader's config block** (the table the
  boot record's second word points at). On the emulator's 2020 donor bootloader that entry
  is 0x14020000; on a real 2014 bootloader nobody has measured it. Mode 4 is a literal
  0x14020000 on every build, so 0.8.0.0 reads that block through 4 and the token.
- **The 2014 builds from 0.9.0.2 have no mode-2 test**, so the bootloader block is readable
  with the token; the 2016-2017 builds refuse it outright. The two 1.3.0.8 images differ
  here and both report `1.3.0.8`, so that block is not read on 1.3.0.8.
- **0.7.0.7 and 0.7.0.8 register `GetFeaturedFirmwareData` as a setter only** (`rpcHandlers`
  in `facts.json`), so a control-IN read has no handler. 0.8.0.0 is the first build with a
  getter there.

### 10.3 What changed in the toolkit

- **Each build is dumped with its own table.** `FirmwareProfile.windowPlan(version)` returns
  the build's rows, the windows to arm (one per block, at the address the row gives) and the
  gaps with reasons; `buildWindowPlan` refuses a table whose gaps and rows do not tile the
  part exactly. `planForDevice` reads the version (one `GetFirmwareInfo`, unarmed) before
  anything is armed, and `runDump`, `runSweep` and `readDeviceInfo` all use it. A version
  the profile has not decoded, or none at all, gets only the rows every decoded build agrees
  on; 0x14000000 and 0x140C0000 are then gaps that say why. _(Corrected in §11: no version
  at all is now refused, `device/version-unknown`; only a version the profile has not
  decoded gets the agreed rows. `readDeviceInfo` did not in fact use it until §11 — it read
  the version through `SetFirmwareInfoFeatures` and armed whatever the version said.)_ The manifest records the
  version and the table (`selectorTable`), and the legacy README lists the dump's own gaps.
- **0.7.0.x is refused.** `compact-2014` covers everything before 0.8.0.0, `legacy-auth` and
  `compact-2016` score it 0, the probe sends nothing after the version read, and
  `planForDevice` refuses a pre-0.8 build even under `--profile`: "firmware 0.7.0.7 predates
  the dump protocol: its RPC method table has no read handler for GetFeaturedFirmwareData
  (on 0.7.0.7 and 0.7.0.8 it is registered as a setter only …)".
- **`facts.json` records both columns** for every command of every image (`rpcHandlers`, and
  `getter`/`setter` on each toolkit opcode), and each image's window table.
  `firmware-facts.test.ts` now checks that every opcode a dump sends is in the column
  `OP_DIRECTION` sends it to on every build the toolkit would dump (29 images), that every
  refused build lacks one, and that each legacy table equals its images' own switch.
  `workflows.test.ts` checks the client against `OP_DIRECTION` over a whole dump, and dumps
  fake cameras running the 1.3.0.0 and 1.0.3.0 tables.
- **Tier 1 arms each firmware's own plan**, with the payload the dump sends, and compares the
  bytes at the address the plan files them under (`plan` in `expectations.rpc.json`). A plan
  window that serves another block's bytes fails every row, pinned or not.
- **The derived gap reason names the command that failed.** Where arms came back clean and
  every read failed, it says so and names `GetFeaturedFirmwareData`.

Two negative checks, each reverted afterwards: giving 1.3.0.0 the old shared assumption
(0x0E → 0x140C0000) fails 5 tests, among them the image-bytes comparison and both
whole-dump tests; moving the probe's version gate back to 0.7 fails 5 others.

### 10.4 Pinned results that changed

**Tier 2: none.** All 15 rows are byte-identical. The dump now sends one `GetFirmwareInfo`
first, which is why tier 2 delivers 873,018 replies instead of 873,003 (+15, one per row).

**Tier 1: every one of the 51 rows gains the new `plan` field, and 4 gap reasons change.**
No other field of any row changed.

| row              | old gap reason                                                     | new gap reason                                                                                                                                    | why                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.7.0.7, 0.7.0.8 | `63 of 63 subcommands refused (BeginFirmwareUpgrade -> stall)`     | `25 of 63 subcommands armed with error code 0 and every read of them failed (GetFeaturedFirmwareData, wire 0x4F -> stall); 38 refused at the arm` | the arms of 1 and 0x0A…0x21 succeed; the read has no getter (§10.2). The old text counted an unreadable window as refused and quoted the command probe's plain arm of 5 |
| 0.5.0.2          | the same as above                                                  | the same as 0.7.0.x                                                                                                                               | same measurement: arms succeed, reads stall (0x4F is `UploadFirmwareRowSize`, setter only, on this build)                                                               |
| 0.6.0.4          | `63 of 63 subcommands refused (BeginFirmwareUpgrade -> no-answer)` | `25 of 63 … (GetFeaturedFirmwareData, wire 0x4F -> no-answer); 38 refused at the arm`                                                             | same, and this build never answers the read rather than stalling it, as it never answered it before                                                                     |

0.3.0.1, 0.5.1.0 and 0.5.1.3 keep `63 of 63 … refused (BeginFirmwareUpgrade -> stall)`:
no arm came back clean on them, so the old wording is the right one there.

The new `plan` field, by group: 26 post-2018 rows plan 63 windows and confirm 63 (all
reused from the window probe); the 3 × 1.0.3.0, 2 × 1.0.3.2 and 2 × 1.3.0.8 rows plan 31
and confirm 31, arming 3, 5, 6, 7, 8 and 9 with the token; the eight 2014 rows 0.9.0.2 …
1.3.0.0 plan 31 and confirm 31, including subcommand 2 at 0x14000000 with the token, with
0x140C0000 a gap; 0.8.0.0 plans 30 and confirms 30, reading 0x14020000 through subcommand
4; 0.3.0.1, 0.5.0.2, 0.6.0.4, 0.7.0.7 and 0.7.0.8 plan nothing (`compact-2014`). **No plan
window is misplaced on any row.**

**One row group is a finding, pinned as measured:** 0.5.1.0 and 0.5.1.3 stall every vendor
request for a while after enumeration on the emulator — `GetFirmwareInfo` and
`GetErrorCode` included, over USB/IP and in-process — so no version is known when the plan
is made. The probe's plain arm of 5 is then "refused" too, as every request is at that
point, and `legacy-auth` wins on that refusal. The plan is the version-unknown one: 30
windows, all unread. The dump would read nothing, and nothing unsafe is sent (0x52 is
`BeginFirmwareUpgrade` on those builds). The version gate treats an unknown version as not
old, and the probe cannot tell "refused the plain arm" from "refused everything"; on a
0.3.0.1 that did not answer `GetFirmwareInfo` the gate would therefore not engage. Whether a
real 0.5.1.x camera behaves like this is not known. _(Fixed in §11.1: with no version the
probe sends nothing more and the dump, the sweep and the device read refuse; both rows now
pin that refusal.)_
`scripts/selector-tables/early_version_read.ts` reproduces it (0.5.0.2 is the control).

### 10.5 The measurements

FW-V1 is at `6ade3441` and the toolkit at `a15e8de` plus this change, on the same machine
as §9.10.

| run                                      | exit | passed / failed | wall            | slowest row (tier 1 / tier 2) | replies delivered = received (t1 / t2) | dropped | emulators left |
| ---------------------------------------- | ---- | --------------- | --------------- | ----------------------------- | -------------------------------------- | ------- | -------------- |
| regeneration, both tiers, the pinned one | 0    | 420 / 0 (core)  | 184 s           | 105.9 s / 85.1 s              | 20,001 / 873,018                       | 0       | 0              |
| `npm run check` 1                        | 0    | 609 / 0         | 198 s (183.4 s) | 104.6 s / 83.4 s              | 20,001 / 873,018                       | 0       | 0              |
| `npm run check` 2                        | 0    | 609 / 0         | 199 s (184.6 s) | 106.8 s / 85.0 s              | 20,001 / 873,018                       | 0       | 0              |

The two `npm run check` runs are consecutive, on the committed code with this section
still missing these two rows. Without the optional inputs,
`SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npx vitest run` gives **473 passed | 3 skipped**,
exit 0 (445 before; the 28 new tests are the per-build tables, the columns and the
whole-dump runs above).

The wire line reads 19,771 vendor requests as `0x41`/`0xC1` in tier 1 and 872,949 in tier
2, and 0 as `0x40`/`0xC0` in either. Tier 2's 3 stalled vendor requests are the capability
probe's plain arm of subcommand 5 on the three 1.0.3.0 dumps, which that firmware refuses by
design. No standard request stalled.

### 10.6 Still open

- ~~**The version gate cannot see a build that does not answer `GetFirmwareInfo`**~~ (§10.4,
  0.5.1.x): closed in §11.1. An unknown version is refused; a camera that is slow to answer
  is refused too, and reads once it answers.
- **1.3.0.8 8 Hz could give its bootloader block** (no mode-2 test), but the version does not
  tell it from the 16 Hz build. The build string might.
- **0.8.0.0's mode 1 on a real 2014 bootloader** is unmeasured; the plan does not use it.
- FW-V1 `targets/compact_32k_0_3_0_1/src/rpc_cmds.c` still carries the completed image's
  41-row method table and its modern `cmd_BeginFirmwareUpgrade` (`case 0xE` →
  0x140C0000), which the 0.3.0.1 image does not have; recorded in FW-V1
  `docs/ACTION_ITEMS.md`, not changed here.
- ~~The web dump view still calls the unlock token "build-specific" (§9.3 shows one token in
  22 images); not changed here.~~ Fixed in §12.2.

---

## 11. Six fixes in the toolkit's own code (2026-09-23)

§9.9 listed six defects in toolkit source and left them unpatched, and §10.4 and §10.6 left
the unknown-version gate open. This section fixes all of them. The toolkit is at `2e8492e`
(the fixes and their tests) and `b768227` (the regenerated pins). FW-V1 is at `de67189e`
and nothing in it changed except its campaign log. Every fix has a test that fails on the
old code and passes now (§11.7).

### 11.1 Before the version is known, send only what every image reads the same way

**What was wrong.** `predatesDumpProtocol(null)` is false, and it was the only gate. With
no version the probe went on to arm subcommand 5 plainly and with the token, then
subcommand 1 and a read. If every request stalled, as on the emulated 0.5.1.x, the plain
arm read as the legacy lock refusing it, and `legacy-auth` won on that alone. The dump and
the sweep then planned with the "version unknown" rows. `readDeviceInfo` never checked the
version at all. It opened with `tryFwInfo(0)`, which sends `SetFirmwareInfoFeatures` (a
setter), and then armed the boot config, the bootloader block and the slots whatever came
back. That included a 0.3.0.1 under `--profile modern-4x`, where every arm is
`EnterBootloaderMode`.

**The list, built from `test/firmware/facts.json`.** A wire id is safe before identity
when, on all 36 images, its method-table row has the same name, a getter, and nothing in
the setter column. Ten ids qualify:

| wire id | command            | wire id | command         |
| ------- | ------------------ | ------- | --------------- |
| 0x35    | GetErrorCode       | 0x41    | GetDataPage     |
| 0x36    | GetChipID          | 0x44    | GetCurrentCmd   |
| 0x39    | GetShutterPolarity | 0x47    | GetDefaultCmd   |
| 0x3D    | GetOperationMode   | 0x4D    | GetRDAC         |
| 0x3F    | GetIPMode          | 0x4E    | GetFirmwareInfo |

The toolkit needs three of them before identity: GetErrorCode, GetOperationMode and
GetFirmwareInfo. They are `SAFE_BEFORE_IDENTITY` in `ops.ts`, and they are sent as control
IN only. Everything else it sends differs somewhere. 0x52 is `EnterBootloaderMode` on
0.3.0.1. 0x4F is `UploadFirmwareRowSize` before 0.7 and a setter-only
`GetFeaturedFirmwareData` on 0.7.0.x. 0x3C and 0x55 have the same name everywhere but are
setters. `identity-gate.test.ts` derives the ten from the facts on every run, pins them, and
holds `SAFE_BEFORE_IDENTITY` to them.

**What changed.**

- `identityGate(firmware)` in `capability.ts` makes the one decision. No version gives
  `device/version-unknown`. A pre-0.8 version gives `profile/unsupported`, as before.
  Anything else may be armed.
- `probeSelectorChannel` sends nothing after an unanswered version read, so detection gets
  no channel evidence from it.
- `planForDevice` refuses an unknown version. `runDump`, `runSweep` and now
  `readDeviceInfo` all go through it. The message says why, and what to do: replug, let
  the camera start, try again.
- `readDeviceInfo` reads the version first, with the unarmed GetFirmwareInfo. Selector 0 is
  the build block, so these are the same bytes `tryFwInfo(0)` returned. It refuses as a
  dump does, and only then sends `SetFirmwareInfoFeatures` for selectors 1, 20, 17 and 10.
- `writeFirmware` refuses a `DeviceState` without a version.
- The CLI and the web app have a hint for the new code.

**Every other place that sends before the version is known**, checked:

- The CLI's `devices` sends nothing, and `decrypt` is offline.
- `info`, `flash`, `dump` and `sweep` go through the probe and the planner.
- The web app's connection test sends GetOperationMode and GetErrorCode only, and both are
  in the list.
- The web app's dump, sweep and device-info panels go through `runDump`, `runSweep` and
  `readDeviceInfo`.
- The emulator suites' own probes arm everything on purpose. They are the instrument, not
  the tool. The tool's own first contact is now measured separately (below).

**The cost, stated.** A camera that does not answer GetFirmwareInfo cannot be dumped, swept
or analysed until it does. §10.6 gave this as the reason not to do it.

**On the emulator.** Every tier-1 row now carries `gate`: the toolkit's own first contact,
as the CLI's `dump` runs it. That is `probeSelectorChannel`, then `detectProfile` over the
evidence `chooseProfileByProbe` builds, then `runDump` with its signal already aborted. A
dump that plans stops at the head of its window loop, before its first arm; a dump that
refuses throws before that. `gate` records every distinct request sent before a
GetFirmwareInfo came back with a version. Every row asserts two rules, whatever its pin
says:

1. Before identity, only control INs of `SAFE_BEFORE_IDENTITY` were sent.
2. If no version came back during the whole first contact, the dump refused with
   `device/version-unknown`.

On all 51 rows only `IN 0x4E` went out before identity. On 0.5.1.0 and 0.5.1.3 that read is
the whole of what was sent, and the dump refused. 0.6.0.4 does not answer the probe's
version read and does answer the dump's, which then refuses it as a pre-0.8 build. _(§12.3:
since the version read takes two answered reads, the probe's own version read gets
0.6.0.4's version, and compact-2014 refuses the dump.)_

**The same two rows on the old code.** I ran the new instrument against a worktree of
`ee9ca13`. The only additions were the two exports the instrument imports: the constant
list, and an `identityGate` that makes the old decision. Both rows fail rule 2. The old dump
planned (`refusal: null`), with `profile: legacy-auth`, and before identity it sent
`IN 0x4E` and `IN 0x3D`. It did **not** send 0x52 there. The probe's arm starts with
`ensureMode0()`, and 0.5.1.x stalls GetOperationMode too, which fails the arm before
BeginFirmwareUpgrade goes out. So on the emulator the old code fails on the refusal, not on
the arm. The arm itself is shown by `identity-gate.test.ts`: a camera that answers
GetOperationMode but not GetFirmwareInfo gets BeginFirmwareUpgrade from the old probe,
dump, sweep and device read.

### 11.2 The CLI honours the toolkit's own deadlines

**What was wrong.** The CLI uses `usb` 3.1.0. Its WebUSB shim declares
`const DEFAULT_TIMEOUT = 1000` and defines
`controlTransferIn = async function (setup, length, timeout = DEFAULT_TIMEOUT)` and
`controlTransferOut(setup, data, timeout = DEFAULT_TIMEOUT)`
(`node_modules/usb/dist/index.js:8`, `:22`, `:32`). It passes the value as
`nativeControlTransferIn(setup, timeout, length)`, and node-usb-rs v3.1.0 hands it to nusb
as `Duration::from_millis(timeout)` (`src/webusb_device.rs`). On macOS nusb 0.2.7 puts it
in IOKit's `completionTimeout` and `noDataTimeout`, and reports expiry as
`TransferError::Cancelled`, "transfer was cancelled". The `deviceTimeout` option in the
package's `.d.ts` is read nowhere. The transport never passed a third argument, so every
CLI transfer got 1 s. The transport's 5 s race never fired, and a flash commit was cancelled
by the host after 1 s.

**What changed.**

- `WebUsbDevice.controlTransferIn/Out` take the transport's deadline as a third argument,
  and the transport passes it on every call.
- The CLI no longer hands node-usb's device to the transport as it is. It wraps it in
  `packages/cli/src/node-usb.ts` (`fromNodeUsb`), which passes the deadline on and reports
  nusb's own expiry as `usb/timeout`, with the deadline in the message.
- In the browser, `asWebUsbDevice` drops the argument. WebUSB has no per-transfer timeout,
  so the transport's own timer is the only deadline there, as before.

**The commit deadline, worked out.** What the firmware does inside `CompleteMemoryUpgrade`
for the flash path's selector 0 is the same in all eight FW-V1 reconstructions of a
writable build: `cmd_CompleteMemoryUpgrade` (`targets/compact_pro_ff/src/rpc_cmds.c`)
calling `fw_validate_decrypt_program` and `update_write_boot_config`
(`targets/compact_pro_ff/src/update.c`). In order:

1. Sum the staged bytes and check the host's checksum.
2. Decrypt with Key A and re-encrypt with the device key.
3. Erase the slot's 64 KiB block, then read it back to check it is blank.
4. Erase the next block too, but only if the length is over 0x10000.
5. Program the image: at most 65,536 B, which is 256 pages.
6. Read the image back and compare.
7. Erase the boot-config block.
8. Program the 284-byte boot record: 2 pages.
9. Read the record back and compare.

Step 4 cannot run on this path. BeginFirmwareUpgrade caps staging at `FLASH_BLOCK_BYTES`,
and SetFeaturedFirmwareData refuses to stage past it. The bound counts step 4 anyway,
together with 128 KiB of programming. The part is a W25Q32FV: JEDEC `EF 40 16` in the
firmware's own SPIFI table, with 64 KiB blocks and 256-byte pages. Its datasheet (rev. J,
2016-06-03, §9.6 AC Electrical Characteristics, MAX column) gives tBE2 (64 KB block erase)
2,000 ms, tPP (page program) 3 ms and tW (write status register) 15 ms.

| step                                                    | count | max each |        total |
| ------------------------------------------------------- | ----: | -------: | -----------: |
| 64 KB block erases                                      |     3 | 2,000 ms |     6,000 ms |
| page programs (512 image + 2 record)                    |   514 |     3 ms |     1,542 ms |
| status-register writes (one per erase/program, assumed) |     5 |    15 ms |        75 ms |
| CPU: cipher passes, sum, read-backs (an allowance)      |       |          |       500 ms |
| **worst case**                                          |       |          | **8,117 ms** |

- The path that can actually run (2 erases, 258 pages, 4 status writes) comes to 5,334 ms
  at the maximums, and about 0.52 s at the typical values (150 ms, 0.7 ms, 10 ms).
- The deadline is **twice the 8,117 ms bound, rounded up to a whole 5 s: 20,000 ms.** That
  is the value `USB_COMMIT_TIMEOUT_MS` already had, so no timeout changed. It was right, but
  the CLI was not honouring it: the old 1 s cap was below the 5.3 s the real path can take.
- The arithmetic lives in `ops.ts` as named constants, and `protocol.test.ts` pins
  `COMMIT_WORST_CASE_MS = 8117` and `USB_COMMIT_TIMEOUT_MS >= 2 x` that.
- **The browser path:** `protocol.test.ts` also shows, with fake timers, that a commit
  taking the worst case completes, and that the transport's own timer fires at exactly
  20,000 ms and not a millisecond earlier. That test passes on the old code too: the
  browser path was already right.

**Tests.** `node-usb.test.ts` runs the REAL shim functions `usb` installs,
`UsbDevice.prototype.controlTransferIn/Out`, on top of a native layer that behaves as
node-usb-rs does. A missing timeout therefore shows up as 1000 at the native layer.

- One test pins the premise: no argument gives 1000.
- One checks that every transfer of a sequence using all three deadlines (5 s, the 1.5 s
  shrink retries, the 20 s commit) reaches the native layer with exactly the deadline the
  transport was asked for.
- One checks that no transfer of a whole dump uses 1 s.
- One checks that nusb's own expiry is reported as `usb/timeout`.

### 11.3 One recipient per session, and never a silent fallback

**Which claim failure falls back, and why only that one.** WebUSB's `claimInterface`
"perform[s] the necessary platform-specific steps to request exclusive control", and
rejects with `NetworkError` if those steps fail. Its other rejections mean something else:
`InvalidStateError` (the device is not opened or not configured), `NotFoundError` (no such
interface), `SecurityError` (a protected class). Only `NetworkError` means "another program
or a kernel driver holds the interface", and device recipient is correct for that one case
for three reasons:

1. The claim sends no packet (§9.9).
2. A device-recipient vendor request needs no claimed interface. WebUSB's validity check
   asks for a claim only for the interface and endpoint recipients, and node-usb-rs sends a
   device-recipient request on the device handle (off Windows).
3. Every Seek firmware's vendor handler checks only the type and `wIndex == 0`, never the
   recipient bits (§9.9). So `0xC0` with wIndex 0 is the same request to the camera as
   `0xC1` to interface 0.

The CLI adapter maps nusb 0.2.7's two "held by someone else" claim errors onto the same
name: "could not open interface for exclusive access" (macOS, `kIOReturnExclusiveAccess`)
and "interface is busy" (Linux, `EBUSY`).

**What changed.**

- 'auto' falls back only on that failure (`isPlatformClaimRefusal`). Any other claim failure
  is `usb/not-open`, and nothing is sent.
- A fallback is reported through `onWarning` and through `TransportInfo.recipientFallback`.
  `runDump`, `runSweep`, `readDeviceInfo` and `writeFirmware` log it as a warning even with
  no `onWarning`, and the manifest records it.
- The recipient is decided by the first `open()`. After that, a reopen that cannot re-claim
  fails ("does not switch recipient part-way through a run"), and a session that fell back
  stays on device recipient. So a dump's retry can no longer change recipient part-way.

### 11.4 The manifest records the claim that was made

`runDump` and `runSweep` take the manifest's transport record right after the version read,
while the transport is still open. Before, the record was taken after the read loop had
closed the transport, so `claimedInterface` was `false` on every manifest. The recipient
cannot change after that point (§11.3), so one snapshot describes every window. Tier 2 now
asserts `claimedInterface: true`, `recipient: interface` and `recipientFallback: null` on
all 15 dumps.

### 11.5 A stall is a refusal on the CLI too

node-usb-rs turns every nusb error into a rejection, including `TransferError::Stall`
("endpoint stalled"). A browser instead resolves `status: 'stall'`. `fromNodeUsb` turns the
stall back into the WebUSB result, so a firmware refusal is `usb/stalled` on both hosts.
Before, the CLI reported it as `usb/transfer-failed`, with "unplug and replug". Other native
failures, such as "device disconnected", stay `usb/transfer-failed`.

### 11.6 An unconfigured device on the CLI

node-usb-rs's `configuration` getter throws `configuration error: device is not configured`
(nusb's `ActiveConfigurationError` for value 0), where WebUSB returns `null`. `fromNodeUsb`
returns `null` for exactly that error, and the transport then selects configuration 1, as
in a browser. Any other getter error still throws, for example "no descriptor found for
active configuration 2".

### 11.7 The tests, and what each did on the old code

Each new test was written first and run against the unchanged source (`ee9ca13`), then
against the fix.

| fix  | test (file)                                                                                                                                                       | on `ee9ca13`                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 11 tests in `identity-gate.test.ts`                                                                                                                               | 9 fail: the probe arms, the dump, sweep and device read do not refuse, `legacy-auth` wins, the constant is missing; 2 pass (the derived list itself, and the ids it leaves out) |
| 1    | 6 tests in CLI `camera.test.ts`: `dump`, `dump --no-probe`, `dump --profile legacy-auth`, `sweep`, `info`, `info --profile modern-4x` on a camera with no version | all 6 fail: exit 0 instead of a refusal                                                                                                                                         |
| 1    | `writeFirmware` refuses a state with no version (`workflows.test.ts`)                                                                                             | fails: no refusal (the old code went on and hit the dummy payload)                                                                                                              |
| 1    | tier 1: rule 2 on 0.5.1.0 and 0.5.1.3 (worktree run, §11.1)                                                                                                       | both fail: `refusal: null`                                                                                                                                                      |
| 2    | 4 timeout tests in `node-usb.test.ts`                                                                                                                             | 3 fail (1000 ms reached the native layer; cancel reported as `transfer-failed`); the premise test passes                                                                        |
| 2    | commit arithmetic (`protocol.test.ts`)                                                                                                                            | fails: no `COMMIT_WORST_CASE_MS`                                                                                                                                                |
| 2    | browser commit timer (`protocol.test.ts`)                                                                                                                         | passes: a check, not a fix                                                                                                                                                      |
| 3, 4 | 8 tests in `transport-session.test.ts`                                                                                                                            | all 8 fail                                                                                                                                                                      |
| 3    | CLI busy claim falls back / missing interface does not (`node-usb.test.ts`)                                                                                       | both fail                                                                                                                                                                       |
| 5    | stall is `usb/stalled`, both directions (`node-usb.test.ts`)                                                                                                      | fails: `usb/transfer-failed`                                                                                                                                                    |
| 5    | another native failure stays `usb/transfer-failed` (`node-usb.test.ts`)                                                                                           | passes: a guard against matching too much                                                                                                                                       |
| 6    | unconfigured device selects configuration 1 (`node-usb.test.ts`)                                                                                                  | fails: `open()` throws                                                                                                                                                          |
| 6    | another configuration error still throws (`node-usb.test.ts`)                                                                                                     | passes: a guard against matching too much                                                                                                                                       |

Existing tests that changed, and why:

- `capability.test.ts` "survives a camera that will not answer GetFirmwareInfo" required the
  probe to arm with no version. It now requires the opposite.
- `protocol.test.ts`'s fallback test used `Error('Access denied')` to trigger the fallback.
  It now uses a `NetworkError`, and the plain error is one of the non-fallback cases in
  `transport-session.test.ts`.
- Fake cameras that never answered GetFirmwareInfo now report a version: `cameraFor` in
  `workflows.test.ts`, `cameraWithFlash` in the CLI helpers, and the web dump panel's fake.
  Their dumps used to plan for an unknown version, and that is refused now.
- On the legacy fixture that version is 1.1.0.0, an undecoded build, so the plan is still
  the agreed rows. Two assertions follow from that. The legacy dump test now expects
  `firmwareVersion: '1.1.0.0'` instead of `null`. The device-info test checks that the
  channel flag alone leaves detection ambiguous, because the version now corroborates the
  profile.

### 11.8 Pinned results that changed

**Tier 2: none.** `expectations.roundtrip.json` is byte-identical.

**Tier 1: every row gains `gate`, two rows change `plan`, and the file `note` describes the
new field.** No other field of any row changed.

| rows                                              | field  | old                                                                                    | new                                                                                                                          | why                                                                                                                            |
| ------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| all 51                                            | `gate` | absent                                                                                 | the toolkit's first contact; `sentBeforeIdentity: ["IN 0x4E"]` on every row                                                  | new measurement (§11.1)                                                                                                        |
| 26 modern, 18 legacy (0.8.0.0 … 1.3.0.8, 1.0.3.x) | `gate` | —                                                                                      | `identified: true`, profile `modern-4x` / `legacy-auth`, `refusal: null`                                                     | the version came back; the dump planned                                                                                        |
| 0.3.0.1, 0.5.0.2, 0.7.0.7, 0.7.0.8                | `gate` | —                                                                                      | profile `compact-2014`, `refusal: "profile/unsupported: Early Compact … does not support dump …"`                            | the version came back and predates the dump protocol                                                                           |
| 0.6.0.4                                           | `gate` | —                                                                                      | probe saw no version, `identified: true`, profile `generic`, `refusal: "profile/unsupported: … firmware 0.6.0.4 predates …"` | it does not answer the first version read and answers the dump's                                                               |
| 0.5.1.0, 0.5.1.3                                  | `gate` | —                                                                                      | `identified: false`, profile `generic`, `refusal: "device/version-unknown: …"`                                               | no version ever came back; refused (§11.1)                                                                                     |
| 0.5.1.0, 0.5.1.3                                  | `plan` | `legacy-auth`, dumps, 30 windows all unread, table "legacy, version unknown …", 3 gaps | `generic`, no dump, 0 windows, table "none: no plan is made without the firmware version", no gaps                           | the CLI no longer arms without a version, so detection gets no "refused plain arm", and the planner refuses an unknown version |

**One instrument mistake, caught and fixed before the pins were taken.** `gate` was first
measured at the END of each row. That was not first contact, for two reasons:

- The command probe's `SetFirmwareInfoFeatures(1)` leaves the info selector at 1, so the
  unarmed GetFirmwareInfo returned the BOOTLOADER block: `2.0.2.3` on 4.8.1.7.
- On the 4.8.1.7 and 4.16.1.7 images, and their `_trimmed` copies, a window read that late
  in a row made the emulator fault (unmapped `0x35202088` at PC `0x100078F0`). The four rows
  then read "not measurable". On a fresh emulator the same probe works, and no single
  earlier step reproduces the fault.

`gate` now runs first, as a real host's first contact does. With it first, the regeneration
changed only the fields in the table above. The fault itself is not diagnosed (§11.10).

### 11.9 The measurements

The toolkit is at `b768227` plus this section, and FW-V1 is at `de67189e`, on the same
machine as §10.5.

| run                        | exit | passed / failed        | wall            | slowest row (tier 1 / tier 2) | replies delivered = received (t1 / t2) | dropped | emulators left |
| -------------------------- | ---- | ---------------------- | --------------- | ----------------------------- | -------------------------------------- | ------- | -------------- |
| regeneration, tier 1 alone | 0    | 426 / 0 (core, 1 skip) | 97.7 s          | 96.6 s / —                    | 20,506 / —                             | 0       | 0              |
| `npm run check` 1          | 0    | 647 / 0                | 195 s (181.4 s) | 106.3 s / 83.5 s              | 20,506 / 873,018                       | 0       | 0              |
| `npm run check` 2          | 0    | 647 / 0                | 193 s (178.8 s) | 104.9 s / 82.0 s              | 20,506 / 873,018                       | 0       | 0              |

- The two `npm run check` runs are consecutive, on the committed code (`b768227`) with this
  section still missing these two rows. Both passed 647 of 647 (609 in §10.5; the 38 new
  tests are those of §11.7).
- Tier 1 delivers 20,506 replies, up from §10.5's 20,001 (+505). It sends 20,276 vendor
  requests as `0x41/0xC1` (up from 19,771) and 0 as `0x40/0xC0`, and 1,429 stalled. The
  whole increase is the new first-contact measurement.
- Tier 2 is unchanged: 873,018 replies, and 872,949 vendor requests as `0x41/0xC1`, 3 of
  them stalled.
- Neither tier sent a SET_CONFIGURATION or a SET_INTERFACE.
- Without the optional inputs, `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npx vitest run`
  gives **511 passed | 3 skipped**, exit 0. That was 473; the 38 new tests are those of
  §11.7.
- **Found in passing, not caused here** _(fixed in §12.4)_. `npm run test:coverage` (CI's test step) already
  fails at `ee9ca13`. The `profiles/**` functions threshold is 95%, and coverage is 60 of 64
  (93.75%). The four uncovered functions are in `plan.ts` (two error-message callbacks),
  `compact-2014.ts` (`windowPlan`) and `registry.ts` (`hasCapability`). At `ee9ca13`, 2
  web dump-panel tests also fail under coverage (they pass without it). After this work
  those two pass, and the four functions are unchanged. Nothing here touched them, and it is
  not fixed here.

### 11.10 Still open

- ~~**The version read trusts the info selector to be 0.**~~ Closed in §12.3. The unarmed GetFirmwareInfo returns
  whichever block the selector names, and the selector is cleared only by a read. A camera
  left with the selector set returns the bootloader's version as if it were the
  application's. That can happen if another program, or an interrupted run of this one,
  sent `SetFirmwareInfoFeatures` without the read after it. The emulator showed exactly
  this (`2.0.2.3` on 4.8.1.7, §11.8). A second unarmed read would return selector 0, and it
  stays inside `SAFE_BEFORE_IDENTITY`. Not changed here.
- ~~**The late-row emulator fault on 4.8.1.7 and 4.16.1.7** (§11.8) is not diagnosed.~~
  Diagnosed in §13.3 (2026-09-23): a `GetFirmwareInfo` record handler assembles a build-date
  string into an info-response buffer that aliases the spifilib device-handle global at
  `0x10082A0C`, so the next window read dereferences a corrupted handle and faults at
  `0x35202088`. It is not the Thumb IT-state bug (still present after FW-V1's Phase 23 fix).
  The pinned rows measure first contact gate-first and no longer reach it.
- **A camera slow to answer GetFirmwareInfo is refused**, and reads once it answers (§11.1).
  Whether a real 0.5.1.x camera behaves like the emulated one is still not known (§10.4).
- **The commit bound assumes one status-register write per erase or program.** The SPIFI
  lock command before each operation was not traced to the wire. At 15 ms each, the total
  is 75 ms of the 8,117.

---

## 12. The web app asks the camera, the version read survives a stale selector, and CI's coverage (2026-09-23)

Four changes, each with tests. The toolkit is at `447cd67` (the web app detects the camera,
and the token text), `0545094` (the version read), `2951543` (the pins it changed) and
`aae8ea0` (coverage). FW-V1 is at `653ee4f5` and nothing in it changed. **The fifth task, a
cheaper answer for unanswered requests on the emulator, is not done** (§12.5). The final
`npm run check` could not be run cleanly either: another program on the same machine was
stopping emulator processes (§12.6). A later fix, `18e0f85`, makes the device read arm only
what the firmware's plan contains (§12.8).

### 12.1 The web app asks the camera which family it is

**What was wrong.** The browser made the user pick the camera type. The dump page's "Start
dump" always meant the post-2018 map (`modern-4x`), and a separate "Dump legacy firmware"
forced `legacy-auth`. The flash page had a profile menu whose "auto" read under `modern-4x`
without asking the camera anything, which arms a 2016 camera's locked boot config on the
plain channel. The CLI had asked the camera since the probe existed; the browser never did.

**What changed.**

- Core has `identifyCamera(device)`: the USB descriptors plus `probeSelectorChannel`, scored
  by `detectProfile`. It is what the CLI's `chooseProfileByProbe` did, and the CLI now calls
  it. It also returns `gate`, `identityGate`'s verdict on the version the probe read.
- Core has `identityRefusal()`, the one wording of a closed identity gate. `planForDevice`
  throws it, and so does the web app when the probe's gate is shut, so the user reads the
  same reason whichever of the two stopped the run.
- `packages/web/src/lib/identify.ts` `chooseActingProfile()`: on `auto` it asks the camera and
  acts under `detection.best.profile`; when the gate is shut it throws the refusal before the
  run starts.
- The dump page: "Start dump" and "Dump all selectors" run on `auto`. Nothing is chosen.
- The flash page: "Read device info" on `auto` asks the camera first.
- A refusal is shown in an alert above the log (`CameraIdentity`): what the camera did not
  say, the toolkit's own message, and the hint. `device/version-unknown` keeps its hint
  (replug and retry). A build older than 0.8.0.0 now gets its own hint
  (`FIRMWARE_TOO_OLD_HINT`): no family can read it over USB, and a dump taken another way
  still decrypts. The old per-code hint told that user to pick another family, which cannot
  help.
- When the camera answered, the panel shows the version and the detection box (family,
  confidence, reasons, and the ambiguity warning).

**The hand-picked family is kept, as an expert override, and it cannot skip the gate.** The
dump page has a section "Choose the firmware family yourself" (a menu, defaulting to
`legacy-auth`, which is what the old legacy button forced), and the flash page keeps its
menu. Picking a family skips the three channel questions of the probe and nothing else:
`runDump`, `runSweep` and `readDeviceInfo` read the version through `planForDevice` and apply
`identityGate` before their first arm, whatever profile they were given. There is no path
from the page to a workflow that does not go through that.

**The read-only vocabulary said five commands; it is six.** The dump has read the running
version with `GetFirmwareInfo` since it began planning from each build's own table (§10.3),
so the dump page's opcode table and its "exactly five vendor commands" were wrong. Both now
list six, with `GetFirmwareInfo` first, and a paragraph says only the three
`SAFE_BEFORE_IDENTITY` reads go out before the version is known. The README says the same.

**Tests** (`packages/web`, against a scripted WebUSB camera in `test-fixtures.ts` that answers
like one firmware line: its version, the legacy plain-channel lock, the token check; a refusal
is a stall, as on the wire):

| test (file)                                                                   | checks                                                                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| auto dump of 4.18.2.0 (`useDumpPanel.test.tsx`)                               | acts under `modern-4x`, not forced; the first request is GetFirmwareInfo; the probe's plain arm was sent |
| auto dump of 1.0.3.0 with the lock                                            | acts under `legacy-auth` untold; token arms of 3, 5, 6, 7, 8 and 9 went out; the manifest names it       |
| auto dump and sweep of a camera with no version                               | `device/version-unknown` shown with its hint; nothing downloaded; only `SAFE_BEFORE_IDENTITY` INs sent   |
| auto dump of 0.3.0.1                                                          | `profile/unsupported`, `FIRMWARE_TOO_OLD_HINT`; the only requests are the version read                   |
| hand-picked `modern-4x` on 4.18.2.0                                           | forced, no detection, no probe arm; the version is still read first                                      |
| hand-picked `legacy-auth`, `modern-4x`, `compact-2016`, `generic`, no version | every one refused, nothing downloaded, only safe INs                                                     |
| hand-picked families on 0.3.0.1 (dump page and flash page)                    | every one refused; the only requests are the version read                                                |
| Read device info on auto, 1.0.3.0 (`useFlashPanel.test.tsx`)                  | reads under `legacy-auth` where it used to read `modern-4x`                                              |
| Read device info, no version; a device change                                 | refusal shown, nothing armed; the refusal is forgotten when the camera changes                           |
| `identifyCamera` (core `capability.test.ts`)                                  | evidence and ranking equal `detectProfile` over them; the gate and no request past the version read      |
| render and a11y tests, hints (`render-smoke`, `App`, `hints.test.ts`)         | the override is a labelled control; the refusal alert and the detection panel render; the new hint       |

### 12.2 The unlock-token text

The dump page said: "The unlock token is **build-specific**; the one built in was recovered
from a Compact PRO (PIR324) unit. On firmware with a different token the protected banks just
stall". That is false. §9.3 measured it: the same 16 bytes occur once each in 22 of the 36
corpus images (every 2014–2017 build, 0.3.0.1 to 1.3.0.8 on the Compact and 1.0.3.0 and
1.0.3.2 on the Compact PRO) and in none of the 14 later ones, which have no token check.
`firmware-facts.test.ts` asserts both counts. The page now says it is one 16-byte value, not
one per build, with those numbers. `safety-copy.test.tsx` pins the new sentences and has a
test that fails if "build-specific" (or "per-build token") appears on either page.

Searched for the same mistake: the README never made it. `legacy/index.html` makes it, and is
left alone on purpose: it is the original page, kept as the oracle for `verify:legacy`. The
README's profile table still said `legacy-auth` starts at 0.7.0.7 and `compact-2014` covers
"older than 0.7.0.7"; both now say 0.8.0.0 (§10.3).

### 12.3 The version read, and a firmware-info selector left set

**What the firmware does**, from FW-V1's reconstructed C (read, not edited):

- The selector is one u16 in RAM (`g_fw_info_selector`, 0x1000B3EE on the completed images;
  `fwinfo_index_r32k0301` on 0.3.0.1, `info_index` on 1.3.0.8). It is BSS, so it is 0 after a
  reset. Nothing in the USB stack clears it, so it survives the host closing and reopening the
  device.
- Two setters write it: `cmd_SetFirmwareInfoFeatures` (wire 0x55; bound `<= 0x19` on the
  completed images, `<= 0x17` on the 2016 build and 1.3.0.8, `<= 9` on 0.3.0.1) and
  `cmd_SetFwOpCharFeatures` (wire 0x5B, `<= 5`), which shares the cell on the completed
  images. (On 0.3.0.1 the getter reads its own cell, 0x1000EE1E, and that reconstruction's
  `cmd_SetFwOpCharFeatures` is still the completed image's, §10.6, so it says nothing there.) An out-of-range value
  is refused and leaves the cell as it was.
- `cmd_GetFirmwareInfo` switches on it and, on every path that returns data, stores
  `*out_len` and writes 0 back (e.g. `targets/compact_pro_ff/src/rpc_cmds.c:1638`, `:1900`,
  `:1908`). Every reconstruction does, in all eleven application targets: 0.3.0.1, 1.3.0.8,
  the 2016 Compact PRO, `compact_pro`, 4.9.2.0, Compact PRO FF, Compact XR, Mosaic 9 Hz and FF,
  Nano 200 and 300. The unsupported-record path clears it too, except on 0.3.0.1, whose setter
  cannot store a record its getter lacks. `cmd_GetFwOpChar` clears it as well.
- It runs while the device handles the SETUP stage
  (`targets/compact_pro_ff/src/usb_core.c:1087`), so a read the device took clears the
  selector even if its reply were lost afterwards.
- The getter's wrong-mode return (`(out_data & 0xFF000000) == 0x14000000 && mode == 1`) does
  not clear it, but `out_data` there is the address of the reply-pointer cell, which is in RAM
  (`&pCtrl->EP0Data.pData`), so that arm cannot fire over USB. A request the dispatcher
  refuses before the getter runs (no handler, "sent during FW init", the mode gate) does not
  clear it either.

So the unarmed read returns selector 0, the build block, **only if nothing set the selector
since the last read**. Another program, or an interrupted run of this one, that sent
`SetFirmwareInfoFeatures` and never read afterwards leaves the next unarmed read returning
some other record. The emulator showed it: 2.0.2.3, the bootloader's version, on 4.8.1.7
(§11.8).

**The rule now** (`readRunningFirmware`): the version comes from an answered GetFirmwareInfo
that directly follows another answered one. The first answer is never the version; it only
proves the selector is now 0. A failed read proves nothing (a stall may be the dispatcher, a
timeout may be a SETUP never taken), so it does not count. At most
`VERSION_READ_ATTEMPTS = 4` reads, and two failures in a row end it _(§18: a STALL before any
answer is now read again for a start-up window of 26 reads 20 ms apart, and those reads do not
count here)_. Only GetFirmwareInfo is sent, as a control IN, so the read stays inside `SAFE_BEFORE_IDENTITY`. When the first
answer differs from the second, the note says so ("the first read answered a different record
(2.0.2.3), which an earlier command had left the firmware-info selector on").

The cost: every version read is two transfers instead of one. A camera that never answers is
refused after two reads instead of one. _(§18: one that STALLs every read is now refused after
the 26 reads of the start-up window; one that times out, still after two.)_

**Tests** (`identity-gate.test.ts`, "a camera an earlier command left with the firmware-info
selector set"). The fake camera keeps the selector across close and open, as the firmware
does. Run against the old `readRunningFirmware` (only `VERSION_READ_ATTEMPTS` added so the
file loads), all five fail:

| test                                                               | on the old code                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| reads the application's version, not the record the selector names | `expected '2.0.2.3' to be '4.8.1.7'`                             |
| hands the probe and the planner that version too                   | `expected '2.0.2.3' to be '4.8.1.7'`                             |
| cannot open the gate on 0.3.0.1 with a stale record                | the probe sent **3 arms (0x52, EnterBootloaderMode on 0.3.0.1)** |
| counts only an ANSWERED read as clearing the selector              | `expected null to be '4.8.1.7'` (one lost read, then no retry)   |
| gives up after two failures in a row, and after the budget         | `expected '4.8.1.7' to be null` (one answer taken on trust)      |

Existing tests that pinned exactly one GetFirmwareInfo now pin two: four in
`capability.test.ts`, one in `workflows.test.ts`, two in `identity-gate.test.ts` and three in
the web tests of §12.1. None of them was loosened: each still asserts the exact request list.

**On the emulator.** Tier 1 has a new field, `staleSelector`: at the end of each row, after
the command probe's `SetFirmwareInfoFeatures(1)` has been left unread, the toolkit's own
version read runs and every answer is recorded with the version it settled on. Every row
asserts, in both modes, that this version equals the one the plan was made from earlier in
the same row with the selector at 0. The first-contact instrument (`IdentityRecorder`) now
uses the same rule as `readRunningFirmware` for "identified".

### 12.3.1 Pinned results that changed

`node scripts/update-emulator-expectations.mjs`, both tiers: exit 0, 183 s, 450 passed
(core), 51 + 15 emulator processes audited, 0 replies dropped. **Tier 2 is byte-identical.**
In `expectations.rpc.json`:

| rows    | field           | old                                                                                                     | new                                                                                                                                   | why                                                                                                                                                                                                                                 |
| ------- | --------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| file    | `note`          | described fields up to `gate`                                                                           | also describes `staleSelector`                                                                                                        | new field                                                                                                                                                                                                                           |
| all 51  | `staleSelector` | absent                                                                                                  | answers and version                                                                                                                   | new measurement                                                                                                                                                                                                                     |
| 49 rows | `staleSelector` | —                                                                                                       | first answer another record, second the plan's version: 2.0.2.3 (Compact donor), 1.2.0.0 (Compact PRO 1.0.3.x), 0.0.0.0, 220.32.3.0   | the selector was left at 1; the first read returned record 1 and cleared it                                                                                                                                                         |
| 2 rows  | `staleSelector` | —                                                                                                       | `["stall", "stall"]`, version null                                                                                                    | 0.5.1.0 and 0.5.1.3 stall every request here, SetFirmwareInfoFeatures included                                                                                                                                                      |
| 0.6.0.4 | `gate`          | `firmwareVersion: null`, profile `generic`, refusal `profile/unsupported: refusing to dump: … predates` | `firmwareVersion: "0.6.0.4"`, profile `compact-2014`, refusal `profile/unsupported: Early Compact (pre-0.8) does not support dump: …` | this build does not answer the first GetFirmwareInfo it gets. The probe's version read was that one read; now it reads on, gets two answers, and detection picks compact-2014, whose capability gate refuses before `planForDevice` |

No other field of any row changed. `sentBeforeIdentity` is `["IN 0x4E"]` on all 51 rows, as
before. Tier 1 delivers 20,756 replies (20,506 before): the extra GetFirmwareInfo reads and
the new measurement. Tier 2 delivers 873,048 (873,018 before): +2 per row, one more read in
each of the row's two version reads (the probe's and the dump's).

The second `npm run check` of §12.6 then matched all 51 tier-1 rows against these pins, so
they were reproduced once on a fresh set of emulators.

### 12.4 CI's coverage

CI's test step is `npm run test:coverage`; `npm run check` does not run coverage. It has
failed since at least `ee9ca13` (§11.9): functions in `packages/core/src/profiles/**` were 60
of 64 (93.75 %) against 95 %. The four untested functions were `registry.ts` `hasCapability`,
`compact-2014.ts` `windowPlan`, and the two address-formatting callbacks in
`buildWindowPlan`'s "holes and rows disagree" error (`plan.ts:82-83`). New tests in
`profiles.test.ts`:

- `hasCapability` gives the same answer as `requireCapability`, and as the declared
  capability, for every built-in profile and all five operations, and both answers occur.
- `compact-2014`'s `windowPlan` plans no window and declares the whole part a gap, equal to
  its declared memory map, for any version it is handed. That is the path a hand-picked
  `compact-2014` takes on a camera that passes the identity gate.
- `buildWindowPlan` plans a table that tiles the part. It refuses an authenticated row with no
  token ("subcmd 0x5 needs a token and none is set") and plans it with one. It refuses rows and
  holes that disagree and names every block on both sides, both kinds at once and each alone.

`vitest.config.ts` is unchanged: no threshold lowered, no file excluded.
`SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npm run test:coverage` exits 0, with profiles
functions at 64/64 (100 %).

### 12.5 The slowest row, Compact 0.6.0.4: looked at, not done

**Not done.** No emulator code changed, and the pins were not regenerated for it. What was
found, from reading FW-V1 `emu/seekemu/` (nothing was run for it):

- **Where the budget is.** The USB/IP server builds its host with `UsbHost(m)`
  (`cli.py:404`), whose `wait_budget` defaults to 20,000 (`usb_host.py:158`). A control IN's
  first data packet waits in `token_in(budget=None)`, which uses that budget
  (`usb_host.py:277-292`).
- **What a host step is.** `Machine._on_block` steps the host once every time 64 or more
  emulated cycles have passed (`machine.py:376-387`). Cycles are counted per basic block, and
  a WFI adds 4,096, so 20,000 steps is at least 1.28 M cycles; §9.7's "about 1.32 M" fits.
- **What the host sees when it runs out.** `token_in` raises
  `HostError('timeout on control IN bRequest=…')`. `Bridge._slice` completes the URB with
  status `ST_ETIMEDOUT` (−110) and no data (`usbip.py:735-745`). The reply is delivered, not
  dropped, so the client does not wait out its own deadline. The toolkit's transport rejects
  it, and tier 1 records `no-answer`.
- **The clock runs during those steps.** The clock is gated on host activity, so an
  unanswered request advances the device's emulated time by the whole budget. That time is
  part of the reproducible sequence the pins record.

**The risk.** The 94,048-cycle "slowest answer" (§9.7) is the slowest among answers that came
back **within** the current budget. Answers that come later were not in the sample. Some
firmwares in this corpus do answer only after more than 20,000 steps: FW-V1
`docs/ACTION_ITEMS.md` records that Compact 0.5.1.0 and 0.5.1.3 do not answer wire 54 with a
20,000-step wait and do answer with 40,000. That is measured in the in-process harness from
SET_CONFIGURATION, not per URB over USB/IP. Cutting the budget to 94,048 cycles could
therefore turn a late answer into `no-answer`, which would change a result.

A second risk follows from the gated clock. Because the budget decides how much device time
passes after each unanswered request, shortening it would move the device's clock at every
later request in the row. Anything time-dependent after that point could then change, for
example the FSM's own transition to state 9 (§9.10). Detecting an idle firmware instead is not
simple on this build: 0.6.0.4's main loop is `for (;;) { WFE; poll(); }`, which keeps running
blocks, and "no new code reached" was shown too weak on the 2014 builds (55,910 steps of new
blocks on 0.5.1.x, `docs/EMULATOR_CORPUS.md` §10.8).

Old times, measured at `c491459` before any change: `npm run check` 191 s wall (vitest
177.4 s), 647 passed, and the 0.6.0.4 row 104.2 s. The machine was not idle (load about 5).
New times: none, because nothing changed.

### 12.6 The measurements

| run                                                             | commit                 | exit | passed / failed                | wall            | notes                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ---------------------- | ---- | ------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`, baseline                                       | `c491459`              | 0    | 647 / 0                        | 191 s (177.4 s) | slowest rows 104.2 s (0.6.0.4) / 80.1 s; 0 dropped                                                                                                                                                                         |
| regeneration, both tiers                                        | `447cd67` + §12.3 code | 0    | 450 / 0 (core)                 | 183 s           | 20,756 / 873,048 replies, 0 dropped; the pins of §12.3.1                                                                                                                                                                   |
| `npm run check` 1                                               | the same               | 1    | 12 failed (6 tier 1, 6 tier 2) | 191 s           | not a result (below): emulators that exited without their delivery ledger; replies dropped as "the socket write failed" or "session closed before the device ran it"; 0.6.0.4's session gone mid-probe                     |
| `npm run check` 2                                               | the same               | 1    | 665 / 6                        | 179 s           | all 51 tier-1 rows passed against the new pins, 0 dropped; 6 tier-2 rows failed: 5 as InfrastructureDefect, "the emulator exited without printing its delivery ledger", 1 on `connect ECONNREFUSED` to its emulator's port |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npm run test:coverage` | `c491459`              | 1    | 511 / 0, 3 skipped             | 10 s            | profiles functions 60/64 (93.75 %) < 95 %                                                                                                                                                                                  |

**Why the two checks do not count.** While they ran, another program on this machine was
running a script whose command line starts with `pkill -f "seek_emu.py --usbip"`. That pattern
matches the emulators these suites start. It is the user's own session, and nothing of it was
touched. Every failure in both runs is of the kind an emulator ended from outside produces,
and the delivery audit reported each one as an infrastructure defect, as §9.8 designed it to.
None is a firmware result, and nothing from those runs was recorded. The two failed runs are
not evidence that anything here is broken, and they are not evidence that it works.

The emulator-free checks at the final commit are in §12.7.

### 12.7 Still owed, and still open

**Checks at the final commit, without the emulator** (the code at `5947229`; the commit that
adds this section changes only this file):

| check                                                                   | result                                                                      |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `npm run format:check`, `npm run lint`, `npm run typecheck`             | exit 0, exit 0, exit 0 (2 s, 6 s, 5 s)                                      |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npx vitest run`                | exit 0, 541 passed, 3 skipped (the two emulator tiers and the corpus), 10 s |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npm run test:coverage` (CI's)  | exit 0, 541 passed, 3 skipped; profiles functions 64/64 (100 %), 10 s       |
| `npm run build`, then `git status --porcelain -- docs` (CI's last step) | clean, and two consecutive builds give the same files (but see below)       |

That count was 511 at `c491459`. The 30 new tests: 16 web tests for §12.1 and §12.2
(`useDumpPanel` 8, `useFlashPanel` 4, `render-smoke` 2, `hints` 1, `safety-copy` 1), 3 core
`identifyCamera` tests, the 5 stale-selector tests of §12.3, and the 6 coverage tests of §12.4.

**One slip, caught by the build check and fixed.** `0545094` changed `readRunningFirmware`,
which the browser bundle includes, and was committed without rebuilding `docs/`, so CI's
docs check would have failed from that commit until `5947229`, which is the rebuild.

**Owed, each needing the emulator, once nothing else on the machine stops it:**

1. `npm run check` twice in a row at the final commit, exit 0 both, with pass/fail counts and
   wall times. This also re-checks the §12.3.1 pins in tier 2, which the killed runs could not.
2. `pgrep -fl seek_emu.py` empty afterwards. Today it shows the other session's emulator,
   which is not this work's to stop.
3. All of task 5 (§12.5), if it is taken up. That means the old and new 0.6.0.4 row time and
   `npm run check` time, regenerated pins identical, FW-V1 `emu/selftest.py` all passing with
   a check for the new rule and its count updated, `shasum -a 256 -c emu/data/SHA256SUMS`,
   `gmake -C codegen verify-noop`, and a dated FW-V1 campaign-log entry. None of it applies
   while `emu/` is unchanged.

**Fixed since this section was written:** `readDeviceInfo` armed a slot the plan does not
contain. It is fixed in `18e0f85`, with tests that fail on the old code (§12.8).

**Open, reported and not patched:**

- The web tests use a scripted camera, not the emulator. The browser path has never been run
  against an emulated firmware; the emulator suites drive the toolkit through the USB/IP
  adapter and `WebUsbTransport`, which is the same transport the browser uses.

### 12.8 The device read arms only what the plan contains (fixed after §12.7)

**What was wrong.** `readDeviceInfo` looked each slot up in the plan and, when the plan had no
entry, armed the slot descriptor's own subcommand. `compact-2014` plans nothing for any
version (§12.4), so a hand-picked `compact-2014` on a camera past the identity gate sent
BeginFirmwareUpgrade 7, 8 and 9. §12.7 found this by reading; a run on the fake camera now
confirms it: the new test got `[7, 8, 9]` where it expects no arm. It was not a safety hole,
because `identityGate` refuses every build older than 0.8.0.0 before any arm. But it
contradicted the plan.

**What changed** (`18e0f85`):

- **Slots: the plan's entry or nothing.** A slot with no window in the plan is not armed. Its
  reason reads "not readable on firmware 4.18.2.0: its plan (none: no read handler on this
  generation) has no window at 0x14050000, so nothing was armed for it". It counts as unread,
  so it blocks flashing like a slot whose read failed, and its `subcmd` is null.
  `SlotState.subcmd` is now the selector that was armed, taken from the plan, not the
  descriptor's label. `info --json` prints `subcmd: null` for such a slot.
- **The same pattern, twice more, both for the upgrade-target selector** (subcommand 0 on the
  post-2018 line). `confirmUpgradeTarget` in the device read armed
  `profile.boot.updateTargetSubcmd` without asking the plan, and `writeFirmware` armed that
  same profile number. The read now arms it only when the running build's table has a plain
  row for it, and records the result as `DeviceState.updateTargetSubcmd`. The write arms that
  value, and refuses without sending anything when it is null. A flash-capable profile whose
  table lacks the row also gets a `flashBlockedBy` line.
- **For that, `modern-4x`'s table gains row 0 with no address** (so does `generic`'s, which
  borrows it). Every post-2018 image switches on mode 0 and computes the block. All 14 in
  `facts.json` record mode 0 as computed, and every variant of FW-V1's
  `cmd_BeginFirmwareUpgrade.c` has `fw_op_dest = fw_update_slot_address()` there. A row with no address is never a window and never
  places a sweep's bytes, so no plan's windows, gaps or table name change. The legacy tables
  already had row 0, and their profiles name no upgrade selector (`updateTargetSubcmd: -1`).

**Looked at and left alone, on purpose:**

- `probeSelectorChannel` arms subcommands 5 (plain and 18-byte) and 1 without a plan. It runs
  before any profile is chosen, in order to choose one, so there is no plan to take them from.
  It sends nothing until `identityGate` passes.
- `runSweep` arms every subcommand in the profile's `sweepRange`. Probing selectors the plan
  does not name is the point of a sweep. It takes only placement from the plan, and
  `compact-2014` refuses it by capability, with an empty range as well.
- `runDump` arms `plan.windows` and nothing else.
- The device read's firmware-info reads (`SetFirmwareInfoFeatures` 1, 20, 17, 10) and its
  serial read (`SetRamDataFeatures(0)`, then `GetFeaturedFirmwareData`) select info and RAM
  records, not flash windows. The plan says nothing about them, and they go out only after
  the gate, as before.

**Tests.** All six fail on the old code (source reverted, tests kept):

| test (file)                                                                                        | on the old code                                                         |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| arms no slot the plan leaves out: compact-2014 picked by hand, past the gate (`workflows`)         | `4.18.2.0: expected [ 7, 8, 9 ] to deeply equal []`                     |
| reports the selector the plan armed a slot with, never a guessed one                               | `expected [ 85, 88, 89 ] to deeply equal [ 5, 8, 9 ]`                   |
| arms the upgrade-target selector only when this firmware's own table has it                        | `expected [ 3, 2, 5, 8, 9, +0 ] to not include +0`                      |
| writeFirmware refuses an analysis whose firmware's table has no upgrade-target selector            | `expected 'device/error-code' to be 'flash/refused'`: it armed 0 anyway |
| carries selector 0 in the family's table as a computed row that reads nothing (`profiles`)         | `modern-4x: expected [] to have a length of 1 but got +0`               |
| has a mode 0 on every post-2018 image, computed, as the upgrade-target row says (`firmware-facts`) | `expected undefined to be null`                                         |

The fake camera now records the subcommand of every BeginFirmwareUpgrade (`FakeCamera.arms`).
No existing assertion changed. `makeDeviceState` gained the new field.

**Pinned emulator results.** Not re-run: another session was using the emulators. They are
expected to stay the same. Neither suite calls `readDeviceInfo`, `writeFirmware` or
`runSweep`. They use the probe, `readRunningFirmware`, `identityGate`, `detectProfile`,
`runDump`, and a plan's `windows`, `unreachable` and `table`. The only plan change is a row
with no address, which leaves those three as they were. This still has to be confirmed by a
re-run.

**Checks at `18e0f85`, without the emulator:**

| check                                                           | result                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `npm run format:check`, `npm run lint`, `npm run typecheck`     | exit 0, exit 0, exit 0                                  |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npx vitest run`        | exit 0, 547 passed, 3 skipped                           |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npm run test:coverage` | exit 0, 547 passed, 3 skipped; profiles functions 100 % |
| `npm run build` twice, then `git status --porcelain -- docs`    | identical files both times; clean after the commit      |

---

## 13. Re-run against the IT-state-fixed emulator; the late-row fault, diagnosed (2026-09-23)

The emulator gained two fixes since these pins were last taken: bit-band aliases (FW-V1 Phase
20, already reflected in the §12.3.1 pins, which were made at FW-V1 `653ee4f5`) and a Unicorn
stale-Thumb-IT-state fix (FW-V1 Phase 23, `68757074`/`345c6dd9`, taken **after** those pins).
Fix 2 changes how the emulator runs every instruction after a memory hook, so every pinned
emulator result was re-checked. The toolkit is at `08f6e16`; FW-V1 is at `345c6dd9` (`emu-corpus`).

### 13.1 Every pin re-checked, and every one identical

`node scripts/update-emulator-expectations.mjs` (both tiers) against the IT-fixed emulator:
exit 0, 462 core tests, 205 s, tier 1 20,756 replies delivered = received, tier 2 873,048, 0
dropped. **`git status` was clean afterwards: `expectations.rpc.json` and
`expectations.roundtrip.json` are byte-identical to the committed pins.** Nothing the dump tool
observes moved.

That is the expected outcome, and it is not vacuous. The IT-state fix only changed rows that
reach the sensor/frame path (FW-V1 Phase 23 moved exactly four: Compact PRO 4.9.1.15 and
1.0.3.2). Both emulator suites run every firmware with `--no-sensor` and measure first contact
**gate-first**, so neither tier ever executes the frame path or the late window read the fix
was thought to bear on. No pin needed regenerating, so there is no pins commit.

### 13.2 The two `npm run check` runs, and the emulator-absent run

Both consecutive, on the committed toolkit (`08f6e16`) against FW-V1 `345c6dd9`. 10-core
machine, a desktop session beside it. `pgrep -fl seek_emu.py` was empty before, between and
after; no run was interrupted by an outside `pkill`.

| run                                                      | exit | passed / failed       | wall (vitest)   | slowest row (tier 1 / tier 2) | delivered = received (t1 / t2) | dropped | emulators left |
| -------------------------------------------------------- | ---- | --------------------- | --------------- | ----------------------------- | ------------------------------ | ------- | -------------- |
| `npm run check` 1                                        | 0    | 683 / 0               | 217 s (201.7 s) | 120.7 s (0.6.0.4) / 92.8 s    | 20,756 / 873,048               | 0       | 0              |
| `npm run check` 2                                        | 0    | 683 / 0               | 209 s (195.5 s) | 120.1 s (0.6.0.4) / 89.5 s    | 20,756 / 873,048               | 0       | 0              |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npx vitest run` | 0    | 547 passed, 3 skipped | 11 s            | —                             | —                              | —       | —              |

The wire line on each check: tier 1 sent every vendor request as `0x41/0xC1`, 0 as `0x40/0xC0`;
0 SET_CONFIGURATION, 0 SET_INTERFACE; tier 2 the same. The slowest tier-1 row is still the
0.6.0.4 Compact (§13.4).

### 13.3 The late-row fault on 4.8.1.7 and 4.16.1.7 is NOT gone — and it was never the IT bug

§11.10 left this open and FW-V1 STATE.MD named Phase 23's stale IT state a **candidate**. It is
not the cause. Re-measured the way the suite runs a row — a whole tier-1 probe, then a fresh
import and the toolkit's own first-contact probe (`probeSelectorChannel`, whose "can it serve a
window" step arms subcommand 1 and reads `GetFeaturedFirmwareData`) — against the IT-fixed
emulator (`345c6dd9`), **both rows still fault**:

- 4.8.1.7: `unmapped addr=0x35202088 at PC=0x100078F0`
- 4.16.1.7: `unmapped addr=0x35202088 at PC=0x100078F4`

A fresh emulator issuing the same single window read does not fault; the fault needs the whole
row's churn first, exactly as §11.8 recorded. So Phase 23 did not fix it, which rules the IT
state out.

**The cause, traced in the emulator (register, write and call capture at the fault).** It is a
firmware pointer corruption, not an emulator hook artifact:

1. The spifilib device handle is a persistent global at `0x10082A0C` (`*(0x10082A60)`). Its
   `[+12]` word is `0x40003000`, the SPIFI register base; it is built once at boot and used for
   every flash read. `0x10082A0C` was a valid handle for the ~13 window reads earlier in the row.
2. During the post-row first-contact probe, a `GetFirmwareInfo` record handler runs (reached
   because the command probe's `SetFirmwareInfoFeatures(1)` left a firmware-info selector set).
   Inside the USB ISR it assembles its response — a build-date string copied from the boot
   record at flash `0x140019B8` — into the firmware's info-response buffer, whose write pointer
   is at `0x10082A0A`. The copy runs through the flash-copy path
   (`0x1000729C` → `0x1000710C` → block-read `0x100078DC`) and writes the string
   (`… "Jul  5 2018" …`) over the handle: `[handle+4]` goes from `0x10082A18` to `0x3520206C`
   (the ASCII bytes `"l  5"`).
3. The very next flash window read (`BeginFirmwareUpgrade(1)` → `GetFeaturedFirmwareData`, src
   `0x14020000` → dst `0x20000000`) calls the spifilib block-read helper at `0x100078E0`, which
   loads `r3 = [handle+4] = 0x3520206C` and executes `ldr r4,[r3,#28]` → reads `0x35202088`,
   which is unmapped → `UC_ERR_READ_UNMAPPED` at `0x100078F0`.

So the firmware's info-response buffer (`~0x10082A0A`) **aliases** the spifilib handle global
(`0x10082A0C`), and there is no spifi re-init between the record read and the window read. That
aliasing is why it is "late" and non-reproducible on a fresh emulator: it needs the exact
ordering the toolkit's post-row probe produces (stale info selector → build-string record read
into that buffer → immediate window read).

**Firmware or emulator?** It is a firmware store to a firmware-computed destination, so it is
not the emulator mis-stepping a hook (contrast the IT-state and bit-band faults). But these two
entries are **donor chimeras** — the image-only 4.8.1.7 / 4.16.1.7 code on the 4.8.2.1 donor's
decrypted flash and boot record — and the build string that overflows the buffer is read from
the **donor's** boot record. Whether a native 4.8.1.7 unit's info-response buffer and spifilib
handle truly alias cannot be settled without a native (non-chimera) dump. Recorded in FW-V1
`docs/EMULATOR_CAMPAIGN_LOG.md` (Phase 24) and STATE.MD.

**It does not affect any pinned result.** Both suites measure first contact gate-first, which
never reaches this late window read, so `npm run check` is unaffected — as §13.1 confirms.

### 13.4 The slow 0.6.0.4 row: measured again, still not made faster

§12.5 left this "looked at, not done". Measured on the emulator this pass (in-process, the
FW-V1 machine driven through the same requests), and it stays not done, for a reason now backed
by measurement rather than reading:

- **The row time is unchanged**: 120.1–120.7 s (§13.2), the slowest tier-1 row, against the
  whole `npm run check` at 209–217 s. Each of its ~127 never-answered requests runs the firmware
  to the emulator's 20,000-host-step budget (`usb_host.py:158`, `cli.py:404`) — ~1.32 M emulated
  cycles — and is then recorded `no-answer` (status −110), exactly as before.
- **0.6.0.4 is not idle during those waits.** It is a tight interrupt-driven loop: an IRQ is
  delivered about every 7 host steps, and **no `WFI`/`WFE` executes at all** while the request
  is unanswered. Its complete CPU register file + NVIC pending set + USB0 register state repeat
  with a period of 7 host steps (462 cycles) from about step 800, and SRAM does not change. So
  the request provably never answers — but the task's own suggested safe rule (stop when
  "sleeping, no interrupt pending, no timer due") **never matches**, because the firmware never
  sleeps. That rule would buy nothing here.
- **A cycle-detection rule would speed it up but cannot be shown safe cheaply.** SysTick is
  enabled (reload 119,999) and stays pending-but-undelivered inside the loop, so the
  firmware-visible state only truly repeats on SysTick-period boundaries, not on the 7-step
  loop; and because the emulator clock is gated on host activity, ending a wait earlier advances
  the device's emulated time less and therefore shifts the start cycle of **every later request
  in the row** — the reproducibility hazard §12.5 named. Proving that no pin moves would need
  the full emulator change plus a clean 51-row regeneration, and no fixed shorter budget is
  acceptable (0.5.1.0 / 0.5.1.3 are the documented late-answer risk).

**Decision: left as it is**, as §12.5's option allowed. No emulator code changed, so nothing in
FW-V1's `emu/` moved and no self-test, `SHA256SUMS`, `verify-noop` or campaign-log-for-a-code-change
was owed for it.

## 14. Re-run against the wire-time emulator; 24 pins moved, every one explained (2026-09-23)

> **Corrected in §15.** This section first pinned the three Nano 300 rows as a known gap whose
> reason was the emulator faulting. That was wrong: an emulator that stops is a defect of the
> instrument, never a firmware result, so it can never be a gap. Those three pins were reverted
> (`9855f64`), a dead emulator now fails its row at once as an `InfrastructureDefect`, and the
> timing that made the emulator hit the firmware's race every time was fixed in FW-V1 (§15).

FW-V1 Phase 28 changed the emulator twice: handlers now nest by priority (`ba5662e7`), and a
USB IN transfer completes no sooner than its data bits take at 480 Mb/s (`405f3d28`, USB 2.0
sec.7.1: 64 B = 1.07 µs). The toolkit is at `f177b2f`; FW-V1 at `ff6cffcf` (`emu-corpus`; its
`emu/` is `405f3d28`). The FW-V1 agent that made the change ran `npm run check` only on
`ba5662e7` (679 / 683) and expected exactly one change on `405f3d28`: the four 4.8.1.7 /
4.16.1.7 rows' `controlInBytes["512"]`, 192 → 512. There were more.

### 14.1 The first `npm run check`: exit 1, 656 / 683

Tier 1: 26 rows failed; tier 2: 1 row failed. Regenerated with
`node scripts/update-emulator-expectations.mjs` (both tiers, 462 core tests, exit 0) and the
diff read field by field. Nothing else moved: identity, chip id, commands, windows, auth and
plan are identical on every other row, and tier 2 is identical on the other 14 dumps.

| rows                                                                                                                                                                                                      | field                   | pinned → now   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------- |
| Compact 4.8.1.7 and 4.16.1.7, image and trimmed (4)                                                                                                                                                       | `controlInBytes["512"]` | 192 → 512      |
| Compact 4.8.1.9 image and trimmed, Compact 4.8.2.1 dump, Compact PRO 4.9.1.15 (2), 4.9.2.0 (3), 4.18.2.0-FF (4), Compact XR 4.8.2.1 (2), Mosaic 10.9.1.31 (2), Mosaic 2.27.1.33-FF (2), Nano 200 (2) (20) | `controlInBytes["256"]` | 128 → 256      |
| the same 20                                                                                                                                                                                               | `controlInBytes["512"]` | 128 → 512      |
| Nano 300 44.27.3.10 dump and decrypted image (tier 1), dump (tier 2)                                                                                                                                      | the emulator faulted    | see §14.3, §15 |

### 14.2 The 24 `controlInBytes` rows: the pins recorded an emulator race

All 24 are the defect FW-V1 `405f3d28` removed. The ROM primes the next 64-byte EP0 IN packet
(`ENDPTPRIME` at `0x10401EB2`) and 39 cycles later write-1-clears the `ENDPTCOMPLETE` bit it
read before the prime (`0x104020CA`). With a zero-time transfer the emulated host completed
the new packet inside those 39 cycles, the ROM's clear wiped that completion, the next packet
was never primed, and the data stage ended short: after two packets (128 B) on these 20 rows,
after three (192 B) on 4.8.1.7 / 4.16.1.7. Traced at register level on the Compact PRO
4.18.2.0-FF dump, the row run exactly as the suite runs it (the suite's harness, FW-V1's
emulator with a tracer injected through `PYTHONPATH`), once on `ba5662e7` and once on
`405f3d28`:

- `ba5662e7`: packet 2 primed at cycle 58,930,895, retired at 58,930,934, and the ROM's clear
  at the same cycle took its completion bit; the host got 128 B and the status stage.
- `405f3d28`: each packet retires 172 cycles after its prime, after the ROM's clear at +39;
  four packets, 256 B.

The camera serves 256-byte EP0 reads (FW-V1 `docs/USB_DEVICE_READOUT.md`, "the current proven
chunk size"), so the new values are the ones a camera gives. The FW-V1 agent saw only the four
192-B rows because on `ba5662e7` the race still produced 128 on the other 20, which matched
their pins.

### 14.3 The three Nano 300 rows: a firmware race the emulator's timing now hits

On `405f3d28` the emulator dies on the Nano 300's first vendor request (`GetFirmwareInfo`,
`c1 4e … 24 00`, the 17th SETUP): unmapped read of `0x8808F3A2` at PC `0x1000436C`. The row
becomes "not measurable … the emulator process exited before the probe finished", and tier 2's
dump refuses because `GetFirmwareInfo` never answers. Traced the same way on both emulators
(addresses in the decrypted image, loaded at `0x10000000`):

- `0x1000433C` is a main-loop poll of the MFi (iAP) link's transmit ring. It checks that the
  platform (`0x1000CBF4`) is `0xF1`, loads the link context from `0x1000B3F8`, checks its
  enabled flag and whether the head transfer's 1000 ms deadline has passed, then raises BASEPRI
  (`0x10006BB0`) and **loads the context again** (`0x10004366`) without re-checking it.
- The USB ISR's first vendor control transfer calls `set_target_platform(0xF0)` (`0x10004A60`),
  which zeroes that context (`str r2, [r4, #16]` at `0x10004AA2`).
- If the SETUP arrives between the check and the BASEPRI raise, the poll resumes with context 0,
  reads `[0 + 908]` and dereferences what it finds. The emulator's address-0 alias is the boot
  flash, which gives `0x8808F382`; on silicon address 0 is remapped by `M4MEMMAP` and the word
  would differ, but the pointer is garbage either way.
- `ba5662e7`: the poll entered at cycle 34,240,073 and the SETUP arrived 11 cycles later, before
  the platform check; the check saw `0xF0` and the poll did nothing. `405f3d28`: the poll
  enters at the same cycle (it is timer-driven), but the enumeration's IN transfers now take
  their wire time and each completes a host step later, which moves the host's step grid: the
  SETUP arrives **77 cycles** after the poll's entry, inside the window, and the ISR zeroes the
  context under it (cycles 34,240,394 and 34,240,888). Every run gave the identical fault (both `npm run check`s, the regeneration,
  two traced runs): the USB/IP clock is gated, so the result is a function of the URB sequence
  alone.

This is **real firmware behaviour** in the sense that the race is in the image; a camera would
hit it only if a host's first vendor request happened to land in that window, which on silicon
is tens of cycles out of the poll's 12.5 ms period. The emulator hits it every time because its
host steps, and so its SETUP deliveries, come on a grid that the firmware's wake-ups anchor, and
the first vendor request of this sequence now falls on the poll's first instructions. Nothing in
the emulator is unphysical there (a SETUP 77 cycles after a poll starts is possible on the wire),
but a host whose SETUPs are tied to the device's own wake-ups is not a real host, and the
emulator stopping is not something a camera does. The rows are therefore **not** a gap: the
pins stay at their measured values (reverted in `9855f64`), the harness fails a dead emulator
as an `InfrastructureDefect`, and FW-V1 now delivers a SETUP on the host's microframe grid
(§15).

### 14.4 The pins commit, and the second `npm run check`

The regenerated pins were commit `795fca8`, on their own; its three Nano 300 rows were
reverted in `9855f64` (§15), its other 24 rows stand.

| run                                   | exit | passed / failed | wall (vitest) | slowest row (tier 1 / tier 2) | delivered = received (t1 / t2) | dropped |
| ------------------------------------- | ---- | --------------- | ------------- | ----------------------------- | ------------------------------ | ------- |
| `npm run check` 1 (pins of `f177b2f`) | 1    | 656 / 27        | 703.7 s       | 614.7 s (Nano 300) / 125.0 s  | 19,762 / 808,271               | 0       |
| `npm run check` 2 (pins of `795fca8`) | 0    | 683 / 0         | 720.4 s       | 617.2 s (Nano 300) / 149.8 s  | 19,762 / 808,271               | 0       |

The wire line on run 2: every vendor request `0x41/0xC1`, 0 `0x40/0xC0`; 0 SET_CONFIGURATION,
0 SET_INTERFACE. Tier 2 delivered fewer replies than §13.2 (808,271 against 873,048) because
the Nano 300 dump ended at the emulator's fault 12 s in instead of a full round trip.

Run 2 passed only because the fault was pinned, which §15 undoes. The two tier-1 Nano 300 rows
took ~615 s each — the probe met a dead emulator and every reopen sat out its 20 s — and
`npm run check` went from ~210 s to ~720 s. §15 makes the harness stop at the first sign of a
dead emulator; that is a test-harness change (the toolkit's source is untouched).

## 15. A dead emulator is an infrastructure defect, never a gap; SETUPs on the host's microframes (2026-09-23)

§14 pinned the three Nano 300 rows as a known gap whose reason was the emulator faulting. That
broke this harness's own rule: an emulator crash is a defect of the instrument, not a firmware
result. This section undoes it and fixes both halves of what caused it — the harness that took
~615 s to notice a dead emulator, and the emulator timing that hit a firmware race every time.

### 15.1 The three crash pins, reverted

Commit `9855f64` reverses exactly the two Nano 300 hunks of `795fca8` in
`expectations.rpc.json` and its one hunk in `expectations.roundtrip.json`. The rpc file now
differs from `f177b2f` only in §14's 24 `controlInBytes` rows (kept: they are correct); the
roundtrip file is identical to `f177b2f`. The crash-as-gap wording in §14 is corrected in place.

### 15.2 The harness notices a dead emulator at once

The rule (harness.ts, THE DEATH RULE): an emulator whose run ends while a row is still using it
fails that row **immediately** as an `InfrastructureDefect`. "Ends" is any of:

| signal                                                       | how it is seen                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| it printed `fault: …`                                        | the output line, while the process may still be running                                    |
| it printed `stopped: …` with no `stopping (…)` before it     | the output line: `seek_emu.py --usbip` prints `stopping (SIGTERM)` only when asked to stop |
| the process exited and this harness had not asked it to stop | the child's `exit` event (a SIGKILL, or another process's `pkill`)                         |

What happens then:

- `Emulator` aborts a `gone` signal that every adapter attached to it holds
  (`UsbIpWebUsbOptions.gone`): the live USB/IP session is closed, and every later transfer and
  every reopen throws at once with the reason. Before, `open()` retried a dead port for its full
  `REOPEN_TIMEOUT_MS` (20 s), and the tier-1 probe reopens after every command that came back
  empty — that was the ~615 s per Nano 300 row.
- `RowEmulators.guard(emu, work)` races the row's work against `Emulator.whenDead()`. On a
  death it stops and audits every emulator of the row and throws the `InfrastructureDefect`
  there and then; the abandoned work unwinds in milliseconds because its adapter was aborted.
  Both suites run their measurement under it (tier 1: `probeTier1`; tier 2: attach, profile
  probe and `runDump`).
- `auditDelivery()` lists the death as a violation ("… an emulator that stops is a defect of the
  instrument, never a firmware result"), with the emulator's own `stopped:` / `fault:` line. So a
  death the race did not see (the socket can close a moment before the line is read) still fails
  the row when it is audited, before anything is recorded or compared — in both modes, so the
  regenerator cannot turn it into a gap either.
- `stop()` gives an emulator that is already dying up to 3 s (`DEATH_GRACE_MS`, a backstop — it
  exits within milliseconds) to finish printing before it sends SIGTERM: its summary and its
  `fault:` line come after the `stopped:` line the death is noticed on, and by then `seek_emu.py`
  has put SIGTERM back to the default action, so a prompt SIGTERM cut the fault address out of the
  defect's message (seen on one of the two Nano 300 rows in the control run of §15.3).
- `measureRow` rethrows `InfrastructureDefect` (as it already did `HarnessFidelityError`) instead
  of turning it into a gap. Tier 1's `ProbeUnmeasurable` re-draw now covers only a camera that
  stopped answering while its emulator kept running; tier 2's attempts loop, which existed only
  for dead emulators, is gone (one attempt). No timeout was lengthened, no retry added, no check
  loosened; the §9.8 relaxation for a dead emulator now only keeps its unanswered transfers from
  being listed as separate violations under the death.

**The test** (`packages/core/test/emulator-failfast.test.ts`, 4 tests, ~7 s):

| case                                                                                             | measured                                                                                 |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| a stand-in emulator prints `stopped:` / `fault:` exactly as `seek_emu.py` does, then stays alive | `InfrastructureDefect` with the fault line, noticed while the process was still alive    |
| the same stand-in, stopped by the harness (prints `stopping (SIGTERM)` first)                    | no death, audit clean                                                                    |
| the stand-in stopped in order by a SIGTERM from outside                                          | `InfrastructureDefect` "… after a stop this harness did not ask for"                     |
| a **real** emulator (Compact PRO 4.18.2.0-FF dump) SIGKILLed after 20 replies of a tier-1 probe  | `InfrastructureDefect` 3 ms after the kill; the abandoned probe settled well inside 10 s |

The bound in each is half of one `REOPEN_TIMEOUT_MS` (10 s), so a row that noticed the death only
by sitting out a reopen cannot pass. Negative check, with the race in `guard()` disabled: 3 of 4
fail (two 60 s test timeouts; the real row came back as a `ProbeUnmeasurable`, the old path to a
gap, instead of an `InfrastructureDefect`).

### 15.3 The emulator's host timing: SETUPs on the host's microframe grid (FW-V1 `2e32a1a6`)

Why the race was hit every time: FW-V1's emulated host delivered a SETUP at the host step where
its script was ready, and a host step is the first basic block 64+ cycles after the last — while
the part sleeps, the first block after a WFI wake. So SETUPs landed where the firmware's own
wake-ups put them. A real host's timing is its own: a USB 2.0 host controller runs bus time in
125 µs microframes opened by SOF (USB 2.0 §5.3.3, §8.4.3 / 8.4.3.1) and schedules per microframe
(EHCI 1.0 §4.4, FRINDEX §2.3.4).

FW-V1 `2e32a1a6` holds each control transfer's SETUP until the first microframe boundary at or
after it is ready (k × 125 µs in core cycles from cycle 0 at the core clock of the moment), and
the emulator steps the host on the first basic block at or past that cycle. Only SETUPs: a
device may not NAK or STALL one (USB 2.0 §8.4.6.4), so its arrival is the host's alone. The grid
origin is cycle 0 because it involves no choice; no phase or offset was tried against the Nano
300 (FW-V1 `docs/EMULATOR.md` §19).

Result, traced through this suite (FW-V1 `instruments/usb_probes/consumer_trace`): the Nano
300's first vendor SETUP now lands at cycle 34,410,001, 169,928 cycles after the MFi-link poll's
entry (34,240,073, unchanged) and while the part sleeps. The race is not entered and the rows
measure again. **The race is still in the firmware**; a deterministic emulator cannot sample
the host/camera crystal drift that lets a real host hit it rarely. Control: with FW-V1's knob
`UsbHost(setup_on_microframe=False)` (the old timing) both tier-1 rows fail as
`InfrastructureDefect` with the fault (`0x8808F3A2` at PC `0x1000436C`) in 6.9 s and 7.5 s.

FW-V1's own gates on it: self-test 186 / 0 / 0; oracle 0 of 83,592 pixels; replay 1,077 / 1,077;
the 51-row corpus 29 `rpc` / 22 `streams`, no tier moved (its `docs/EMULATOR_CORPUS.md` §20).

### 15.4 The pins, re-taken, and two `npm run check` runs

`node scripts/update-emulator-expectations.mjs` (both tiers, exit 0, 466 core tests, 346 s)
against FW-V1 `2e32a1a6`. Two rows move, one field each; nothing else:

| row                                          | field                   | old → new | why                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nano 300 44.27.3.10 dump (tier 1)            | `controlInBytes["256"]` | 128 → 256 | the pin was taken on FW-V1 `ba5662e7` (`f177b2f`, restored by `9855f64`) and never re-measured while the row faulted. It is §14.2's zero-time EP0 race: traced at register level, each 64-byte packet now retires 172 cycles after its prime (`0x10401EB2`), after the ROM's write-1-clear at +39 |
| the same                                     | `controlInBytes["512"]` | 128 → 512 | the same                                                                                                                                                                                                                                                                                          |
| Nano 300 44.27.3.10 decrypted image (tier 1) | `controlInBytes["256"]` | 128 → 256 | the same                                                                                                                                                                                                                                                                                          |
| the same                                     | `controlInBytes["512"]` | 128 → 512 | the same                                                                                                                                                                                                                                                                                          |

The other 49 tier-1 rows and all 15 tier-2 rows equal the pins of `9855f64`;
`expectations.roundtrip.json` is byte-identical, so the Nano 300 dump round-trips 63/63 windows
with 0 differing bytes, as pinned in `f177b2f`. Pins commit `c26a2c6`, on its own.

| run                                   | exit | passed / failed | wall (`npm run check`) | vitest  | slowest row (tier 1 / tier 2) | Nano 300 tier-1 rows | delivered = received (t1 / t2) | dropped |
| ------------------------------------- | ---- | --------------- | ---------------------- | ------- | ----------------------------- | -------------------- | ------------------------------ | ------- |
| `npm run check` 1 (pins of `c26a2c6`) | 0    | 687 / 0         | 324 s                  | 305.6 s | 144.1 s (0.6.0.4) / 158.6 s   | 12.0 s, 11.2 s       | 20,756 / 873,048               | 0       |
| `npm run check` 2, right after        | 0    | 687 / 0         | 321 s                  | 301.9 s | 148.3 s (0.6.0.4) / 164.1 s   | 13.6 s, 12.8 s       | 20,756 / 873,048               | 0       |

687 = §14's 683 plus the four fail-fast tests. Tier 1: 44 supported, 7 known gaps (the seven
2014 Compacts whose selector map reaches no window — each for the firmware's own reason, none an
emulator death), 0 failed. Every vendor request went out `0x41/0xC1`; 0 SET_CONFIGURATION, 0
SET_INTERFACE. `npm run check` is back from ~720 s to ~320 s. No toolkit source
(`packages/*/src`) was changed in this section.

## 16. Re-run against the bus-timed emulator; where a tier-2 row's time goes (2026-09-23)

FW-V1 Phase 31 changed the emulator twice: `8fe53537` fast-forwards the emulated host's settle
and microframe wait (nothing the emulator computes moves), and `3e5ba1c5` gives every USB
transaction its USB 2.0 §5.11.3 bus time inside 125 µs microframes, lands IN and OUT
transfers when their last transaction ends, serves a polled endpoint when it is primed, and
counts the host's microframe grid in emulated time a core-clock change does not restart
(FW-V1 `docs/EMULATOR.md` §20). The toolkit is at `470439f`. No toolkit source and no harness
file changed in this section.

### 16.1 Every pin re-checked, and every one identical

`node scripts/update-emulator-expectations.mjs` (both tiers, exit 0, 466 core tests, 281 s)
against `3e5ba1c5`: **`expectations.rpc.json` and `expectations.roundtrip.json` are
byte-identical to the committed pins**, so there is no pins commit. Tier 1: 44 supported / 7
known-gap / 0 failed, 20,756 replies delivered = received; tier 2: 15 supported, 873,048 =
received, 0 dropped, every dump 0 differing bytes. The `controlInBytes` values that moved in
§14 / §15 stay put: each 64-byte EP0 packet now takes 2,166 ns on the wire (it was 1,067 ns of
data bits), still well clear of the ROM's 39-cycle prime-then-clear window.

### 16.2 The two `npm run check` runs

Both consecutive, on the committed toolkit against FW-V1 `3e5ba1c5`. The machine was shared
with another session the whole time (load averages 100-200), so the wall times say more about
the machine than about the suite.

| run                            | exit | passed / failed | wall  | vitest  | slowest row (tier 1 / tier 2) | delivered = received (t1 / t2) | dropped |
| ------------------------------ | ---- | --------------- | ----- | ------- | ----------------------------- | ------------------------------ | ------- |
| `npm run check` 1              | 0    | 687 / 0         | 346 s | 322.2 s | 153.4 s (0.6.0.4) / 163.4 s   | 20,756 / 873,048               | 0       |
| `npm run check` 2, right after | 0    | 687 / 0         | 300 s | 279.6 s | 143.4 s / 150.3 s             | 20,756 / 873,048               | 0       |

Every vendor request went out `0x41/0xC1`; 0 SET_CONFIGURATION, 0 SET_INTERFACE.

### 16.3 Where a tier-2 row's time goes

Measured by FW-V1 on one row (Compact PRO 4.18.2.0-FF `090BB12PR939/dump`) with a timing
wrapper around `seek_emu.py` (its §20.1): 64,783 control reads of `READ_CHUNK` = 64 bytes, one
after another. Per read, the emulator spends ~1.1 ms of CPU running the firmware's own ~415
basic blocks (the ROM's EP0 path, the vendor handler, the flash read), seven engine re-entries
and ~40 host steps, and ~0.2 ms waits on the round trip: 57 µs for its writer thread, **131 µs
for the loopback socket and this suite's Node side**, 40 µs to wake. In the tier-2 file alone
(six rows at a time) a 63-window row takes 84-94 s, 69-77 s of it emulator CPU and 13-15 s at
the gate; in `npm run check` the tier-1 file runs beside it and the same row takes 150-165 s.
The Node side was benchmarked on the harness's bare `UsbIpSession` (115 µs a round trip; the
toolkit adds ~15 µs); parsing replies synchronously in the socket's `data` event measured
112 µs and was not kept. The lever this suite owns is `READ_CHUNK`: 256 or 512 bytes would
make four to eight times fewer round trips, but it would change what tier 2 measures (the
toolkit's 64-byte default path) and the pinned `readChunk`, so it was not touched.

## 17. Re-run against the emulator whose host keeps its own time; one pin moved (2026-09-24)

FW-V1 Phase 36 (`479978fe`) changed four things the suites can see (FW-V1 `docs/EMULATOR.md`
§24): PLL1 takes the data sheet's 100 µs to lock; WWDT WARNINT resets to 0 (inert); a started
sensor raises no PIN_INT0 before its first frame; and **every pause of the emulated host is host
time**, by EHCI 1.0 and USB 2.0 - a transfer's end reaches the host at the next interrupt
threshold (8 microframes, 1 ms), a NAKed token is polled every 10 µs, the bus reset takes
100 + 50 + 10 ms and SET_ADDRESS gets its 2 ms recovery - where the host used to count them in
emulator steps (a 16-step settle before every SETUP, 256 after SET_CONFIGURATION). Through the
USB/IP bridge with the gated clock, the device's time between two URBs is now the host's
threshold wait, ~1 ms, instead of that settle. The toolkit source is `e53fe6c`'s; no toolkit
source and no harness file changed, only the pins (17.2).

### 17.1 The first `npm run check`: exit 1, 686 / 687

One test failed: Compact 1.3.0.8 (the `insecure-8hz` image, tier 1), "the toolkit's own first
contact". Its first request, GetFirmwareInfo (`IN 0x4E`), was STALLed, so the toolkit refused
(`device/version-unknown`) and sent nothing else before identity, as §11 requires. Measured in
FW-V1, in-process on the same chimera: this firmware STALLs vendor requests for ~9 ms after
SET_CONFIGURATION - GetFirmwareInfo at +1 ms .. +9 ms is refused, at +10 ms answered
(`01 03 00 08 ...`, 1.3.0.8) - and with the old pacing the 256-step settle after
SET_CONFIGURATION (~11 ms of a sleeping part) had always outlasted it. A host that asks within
~9 ms of configuring the camera meets the same refusal; the toolkit's own message says what to do.
_(§18: no longer. The version read now waits out a bounded start-up window, and 1.3.0.8 is
identified again.)_

### 17.2 The pins, re-taken

`node scripts/update-emulator-expectations.mjs` (both tiers, exit 0, 466 core tests, 208 s):
**one row, one field** (commit `0f58218`, pins only):

| row                                           | field  | old                                                                                     | new                                                                                                                                                                    | why                                                                                                                                             |
| --------------------------------------------- | ------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Compact 1.3.0.8 `insecure-8hz` image (tier 1) | `gate` | `firmwareVersion` "1.3.0.8", `identified` true, `profile` "legacy-auth", `refusal` null | `firmwareVersion` null, `identified` false, `profile` "generic", `refusal` "device/version-unknown: ... GetFirmwareInfo did not answer (control IN 0x4e -> stall) ..." | the firmware's ~9 ms post-configuration refusal, now reached because the emulated host no longer waits 256 steps after SET_CONFIGURATION (17.1) |

`sentBeforeIdentity` stays `["IN 0x4E"]`, and the rest of the row - the selector map, the stale
selector read, auth - measures as before (those sessions come later, after the firmware has
started). Tier 1 44 supported / 7 known-gap / 0 failed, 20,752 replies delivered = received (was
20,756); tier 2 15 supported, 873,049 = received (was 873,048), 0 dropped, every dump 0 differing
bytes; 0.6.0.4 still arms 25 of 63 subcommands.
`expectations.roundtrip.json` is byte-identical.

### 17.3 The second `npm run check`

On the committed pins, run alone: **exit 0, 687 / 687**, 222 s wall (vitest 206.8 s); tier 1
44 / 7 / 0 with 20,752 replies delivered = received, slowest row 146.7 s (0.6.0.4); tier 2
15 / 0 / 0 with 873,049 = received, 0 dropped, slowest row 94.5 s. The first run's wall was 226 s
(vitest 210.5 s), so the host's new device-time pauses cost the suite nothing it can measure.

## 18. The version read waits out a camera that is still starting up (2026-09-24)

§17 left Compact 1.3.0.8 refused: its firmware STALLs every request for ~9 ms after
SET_CONFIGURATION, the emulated host now asks within that time, and the version read gave up
after two STALLs, in under 9 ms. A real host meets the same gate when it opens a camera right
after a reset or a replug. The toolkit source changed (`capability.ts`); FW-V1 did not (still
`526acf8f`, `emu-corpus`).

### 18.1 The rule

`readRunningFirmware` treats a **STALL before any read has been answered** as the firmware's
"Request sent during FW init" refusal, and reads again, 20 ms later, up to 26 reads
(`VERSION_READ_STARTUP_READS`, `VERSION_READ_STARTUP_SPACING_MS`). The first answer ends the
waiting at once; the ordinary rule (two answered reads in a row, §12.3) then settles the version.
If all 26 reads are refused, the version is unknown and the run is refused with
`device/version-unknown`, as before, and the note says so ("... on any of 26 reads 20 ms apart,
a start-up window of 500 ms ..."). Every retry is logged at `warn` ("GetFirmwareInfo was refused
(...), read 3 of up to 26: the camera may still be starting up; asking again in 20 ms"), and an
identification that needed retries says so in its note ("it answered after refusing 9 read(s)
while starting up"). Only GetFirmwareInfo is sent during the window, so the read stays inside
`SAFE_BEFORE_IDENTITY`. A **timeout** is not retried this way: it already held the request out
for the whole transfer deadline, longer than any start-up, and the ordinary rule (one more read)
is what Compact 0.6.0.4's silent refusal needs. After any answer the ordinary rule applies.

**The length.** From the firmware:

| firmware        | gate                                                           | measured                                     |
| --------------- | -------------------------------------------------------------- | -------------------------------------------- |
| Compact 1.3.0.8 | `g_systick_state <= 7`, STALL (the completed images: the same) | ~9 ms after SET_CONFIGURATION (FW-V1 Ph. 36) |
| Compact 0.6.0.4 | FSM `<= 8`, no STALL: the transfer times out                   | ~50-60k cycles, under one SysTick            |
| Compact 0.5.1.x | FSM `<= 11`, STALL, held by the sensor watchdog (10 restarts)  | ~58 ms of its own time with no sensor        |

The longest bounded init step inside the gate is 1.3.0.8's sensor poll (FSM state 2,
`fsm_poll_step`): it tries again every 50 ms and gives up after the fifth time, ~250 ms from
boot. The window is 500 ms on the camera's own clock: twice that, and 50 times the 9 ms measured.

**Why a count of reads, not a deadline.** A real camera starts on its own clock: 25 pauses of at
least 20 ms (a timer never fires early) are at least 500 ms. The emulator's clock is gated: the
device runs only while a request is outstanding, so a sleeping host ages it by nothing, and each
refused read ages it by one EHCI interrupt threshold (~1 ms, FW-V1 `docs/EMULATOR.md` §24.3). A
deadline alone would give the emulated device as many reads as fit into 500 ms of a loaded
machine; a count gives it 26 whatever the load, and makes the record the same on every run.
Measured on the emulator: the `insecure-8hz` 1.3.0.8 answered after **5** refused reads (the
retries logged "read 1" .. "read 5"), the FF image after none.

**Cancellation.** The wait does not consult the caller's signal, as the rest of the version read
does not: it is bounded, and a cancel lands at the caller's next check. The tier-1 first-contact
instrument relies on that (§11.1: it runs the dump with its signal already aborted). A first
version of this change checked the signal after each pause, and both 0.5.1.x rows then recorded
`cancelled` instead of the refusal; a test now pins the behaviour.

### 18.2 The tests, and what each did on the old code

`identity-gate.test.ts`, "a camera still starting up, which refuses every request for a while".
The fake camera STALLs every request while it starts, on either clock: after `n` requests (the
emulator's gated clock) or `t` ms after it was plugged in (a camera's own clock). The tests run
on vitest's fake timers, so the window's times are exact. Run against the old `readRunningFirmware`
(only the three constants added so the file loads), every one fails:

| test                                                                                       | on the old code                                                                     |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| is identified when it answers inside the window on the gated clock (nine refusals)         | `expected { permitsArming: false, … } to deeply equal { permitsArming: true, … }`   |
| is identified when it answers inside the window on its own clock (300 ms: 15 refusals)     | the same                                                                            |
| is refused after the window when it never answers, having waited it out (26 reads, 500 ms) | `expected 'the camera did not report its firmwar…' to contain 'on any of 26 reads'` |
| sends nothing but GetFirmwareInfo during the window, from every entry point                | `probe: expected [ …(2) ] to deeply equal [ …(26) ]`                                |
| reads through the window even when the run was cancelled before it began                   | `expected [ …(2) ] to have a length of 26 but got 2`                                |

The first three also check the warnings, one per retry (9, 15 and 25), and the first that the
second read follows the first answer at once. The fourth runs the probe, `runDump`,
`runSweep` and `readDeviceInfo` and asserts each sent exactly 26 control INs of GetFirmwareInfo
and nothing else.

Two existing tests pinned "two GetFirmwareInfo, then nothing" on a camera that STALLs every
read. They now pin exactly `VERSION_READ_STARTUP_READS` GetFirmwareInfo and nothing else
(`capability.test.ts` "sends nothing more to a camera that will not answer GetFirmwareInfo",
`identity-gate.test.ts` "is probed with GetFirmwareInfo only"); both fail on the old code with
`expected [ 78, 78 ] to deeply equal [ 78, 78, 78, 78, 78, 78, 78, …(19) ]`. The tests with a timing-out camera
("gives up after two failures in a row, and after the attempt budget") are unchanged and pass:
a timeout is not a start-up refusal. The block "a camera whose firmware version cannot be read"
now waits the real 500 ms per version read (four profiles in one test: ~2.4 s), so it has a
20 s timeout; no assertion in it changed.

### 18.3 Pinned results that changed

`node scripts/update-emulator-expectations.mjs` (both tiers): exit 0, 312 s, 471 tests. Tier 1
44 supported / 7 known-gap / 0 failed, 20,957 replies delivered = received (was 20,752); tier 2
15 / 0 / 0, 873,049 = received, 0 dropped, every dump 0 differing bytes.
**`expectations.roundtrip.json` is byte-identical.** In `expectations.rpc.json`:

| row                                  | field                   | old                                                                                                                                     | new                                                                                                                                                                              | why                                                                                                                   |
| ------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Compact 1.3.0.8 `insecure-8hz` image | `gate`                  | `firmwareVersion` null, `identified` false, `profile` "generic", `refusal` "device/version-unknown: ... (control IN 0x4e -> stall) ..." | `firmwareVersion` "1.3.0.8", `identified` true, `profile` "legacy-auth", `refusal` null                                                                                          | the version read waited out the ~9 ms gate (5 refused reads, then two answers); exactly the values `0f58218` replaced |
| Compact 0.5.1.0 and 0.5.1.3          | `gate.refusal`          | "... (GetFirmwareInfo did not answer (control IN 0x4e -> stall)); ..."                                                                  | "... (GetFirmwareInfo did not answer (control IN 0x4e -> stall) on any of 26 reads 20 ms apart, a start-up window of 500 ms; a camera still starting up answers within it); ..." | the new note: every read of the window was refused; the rest of the message is unchanged                              |
| Compact 0.5.1.0 and 0.5.1.3          | `staleSelector.answers` | `["stall", "stall"]`                                                                                                                    | 26 × `"stall"`                                                                                                                                                                   | the same read at the end of the row, now 26 reads                                                                     |

`sentBeforeIdentity` stays `["IN 0x4E"]` on all 51 rows, and nothing else in any row moved. The
extra replies come from the same two changes: each of the three version reads in a 0.5.1.x row
(the probe's, the dump's, the stale-selector read) is 24 reads longer, and 1.3.0.8's first
contact now identifies the camera, so its probe goes on to its arms and its read, and the dump
plans, where both used to stop after the version read.

### 18.4 How 0.6.0.4 and 0.5.1.x behave now

- **0.6.0.4** is unchanged: its refusal is silence, so its first read times out and is not a
  start-up retry; the second read answers, the third too, and compact-2014 refuses the dump as a
  pre-0.8 build (`gate` pin unchanged, 25 of 63 subcommands armed).
- **0.5.1.0 and 0.5.1.3** are still refused, now after 26 reads each time the version is read. On
  the emulator their gate is held by a sensor watchdog waiting for a sensor the emulator does not
  model, for millions of cycles (FW-V1 `docs/EMULATOR_CORPUS.md` §15-16), far beyond ~26 ms of
  device time; no bounded window a real host would accept reaches it. A real camera with a sensor
  passes that watchdog at once, and one without passes it in ~58 ms of its own time (FW-V1's
  estimate, TIMER0 at 10 kHz), inside the 500 ms window.

### 18.5 The checks

The source, tests and `docs/` are `9b03e86`; the pins `14e0bcf`, on their own. Both
`npm run check` runs were on the committed pins, one after the other, with no other emulator
running (`seek_emu` processes: 0 before each); the machine was busy with other work.

| run                                                             | exit | tests                 | wall (vitest)   | slowest row (tier 1 / tier 2) | delivered = received (t1 / t2) | load average at start / end |
| --------------------------------------------------------------- | ---- | --------------------- | --------------- | ----------------------------- | ------------------------------ | --------------------------- |
| `npm run check` 1                                               | 0    | 692 / 692             | 306 s (287.6 s) | 220.2 s (0.6.0.4) / 146.0 s   | 20,957 / 873,049, 0 dropped    | 15 (1 min; 66 over 5) / 23  |
| `npm run check` 2                                               | 0    | 692 / 692             | 296 s (278.2 s) | 209.4 s (0.6.0.4) / 138.4 s   | 20,957 / 873,049, 0 dropped    | 22 / 14                     |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npx vitest run`        | 0    | 555 passed, 4 skipped | 12.3 s          | —                             | —                              | —                           |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npm run test:coverage` | 0    | 555 passed, 4 skipped | —               | —                             | —                              | —                           |

Tier 1 was 44 / 7 / 0 and tier 2 15 / 0 / 0 on both runs; 0.6.0.4 armed its pinned 25 of 63
both times. Coverage: all files 85.2 % statements, 73.6 % branches; `capability.ts` 94.5 % /
88 %. `npm run build` after the commits leaves `docs/` unchanged.

The suite is ~75 s slower than §17.3's 222 s, and nearly all of it is the slowest row, 0.6.0.4
(63-74 s slower). That row never enters the start-up window (its refusal is a timeout, and its
version reads are as before), and the 5-minute load average was 40-66 during these runs, so the
difference is the machine's load, not this change. The window itself costs a 0.5.1.x row about
3 x 25 x 20 ms = 1.5 s of pauses.

## 19. The transport's deadlines on the emulated camera's clock (2026-09-24)

FW-V1 recorded Compact 0.6.0.4 twice with 22 and 23 armed subcommands where the pin says 25
(its campaign log, open item 12, Phases 32 and 37), both times in an `npm run check` on a loaded
machine, and the row alone measured the pin again. This section finds the race, removes it, and
proves it gone under deliberate load. The toolkit source changed (`webusb.ts`: an injected clock
for the transport's deadlines, defaulting to the wall clock); FW-V1 gained a device-time side
channel (`c8a93b37`, its `docs/EMULATOR.md` §26).

### 19.1 The race

0.6.0.4's tier-1 row sends **127 requests its firmware never completes**: its FW-init refusal is
silent (the vendor handler returns "handled" without a data stage, FW-V1 Phase 29), and it never
serves a read of the windows it arms. Two clocks decided what each one became:

| who gives up      | after                                                          | on which clock                |
| ----------------- | -------------------------------------------------------------- | ----------------------------- |
| the emulated host | 20,000 NAK polls of 10 µs (~200 ms), then `-110` (`ETIMEDOUT`) | the camera's (emulated)       |
| `WebUsbTransport` | `USB_TIMEOUT_MS`, 5 s, then `usb/timeout`                      | the wall clock (`setTimeout`) |

On an idle machine 200 ms of the camera's time is ~1.5 s of real time, so the `-110` always came
first. On a loaded one the emulator runs slower, the transport's 5 real seconds could run out
first, and then the transport abandoned a transfer the emulator was still polling: the next
request queued behind it, the device's history diverged, and the row's count moved. No reply was
lost - the late one was still read and matched - so the delivery audit (§9.8) could not see it:
the transport's timer is not the USB/IP client's deadline.

### 19.2 The design

**In the toolkit: an injected clock.** `WebUsbTransportOptions.clock` takes a `DeadlineClock`,
one method: `startTimer(ms, onExpire)`, returning a cancel function. `withTimeout(promise, ms,
what, clock)` races the transfer against it. The default, `WALL_CLOCK`, is `setTimeout` /
`clearTimeout` with the same delay and the same callback as before, so **no production path
changed**: the browser app and the CLI construct their transports without a clock. The CLI glue
(`packages/cli/src/node-usb.ts`) is untouched: it hands the deadline to nusb, which times it on
the host's real clock - the right clock for a real camera, and the CLI never drives the emulator.

**In FW-V1: the camera's time, beside the wire.** `seek_emu.py --usbip --usbip-clock` opens a TCP
side channel (`clock_port` in the READY line). Before every RET_SUBMIT, that session's writer
thread writes one JSON line `{"urb": [peer_port, seqnum, status, t0_ns, t1_ns]}`: the URB's start
and end on the emulated host's clock. Nothing on the USB/IP wire changed - a real kernel reads
every field of RET_SUBMIT. The client can also declare its per-transfer deadline
(`{"op": "deadline", "ms": D}`, acknowledged once it holds); the emulated host then gives a
never-completed control transfer up at exactly `t0 + D` of its clock (FW-V1 `usb_host.py` THE
HOST'S DEADLINE), which is what a real host does with its software's timeout.

**In the harness: the reply waits for its time.** `emulator/device-clock.ts`:
`DeviceClockLink` reads the side channel, `EmulatedDeviceClock` is a `DeadlineClock` whose time
moves only when a record arrives, and it fires every timer the record's `t1` has reached,
earliest first, synchronously. `UsbIpSession` delivers each RET_SUBMIT only after its record has
arrived (the emulator writes it first; the `clock:` summary line counts the few that arrived
ahead of it and waited: 0-1 per run in tier 1, 1-19 of 873,049 in tier 2), so the transport's timer has already fired if the completion came at or after its
deadline - as a real host's would have. Every transport over an emulator is built with
`clock: device.deadlineClock`. The emulator's clock is gated, so between a completion and the
next URB the camera's time does not move, and "now" is the last record's `t1`: every decision
is a function of the URB sequence alone, never of how long anything took in real time.

**Guards.** The adapter counts a vendor transfer whose transport started no timer on the
emulated clock (`wallClockTransfers`: a transport built without the clock), and the delivery
audit fails the row on it, as it does on a side channel that lost a record, wrote one with no
client listening, or left a reply without its record. The harness refuses an emulator without
`clock_port`.

### 19.3 The emulated host's give-up: fidelity against cost

A real host polls an unanswered transfer for the transport's whole deadline, 5 s, and then
cancels it. The faithful setting is therefore "the emulated host gives up at the transport's own
deadline", after which the transport reports its own `usb/timeout`. It is available
(`SEEK_EMU_HOST_GIVE_UP_MS=Infinity`). It is not affordable:

| emulated host's give-up                  | device time  | wall time per never-completed request (load average) |
| ---------------------------------------- | ------------ | ---------------------------------------------------- |
| 200 ms                                   | 200.000 ms   | 1.3-1.7 s (20-70)                                    |
| 1 s                                      | 1,000.000 ms | 6.1-7.0 s (20-30), 8.5 s (70)                        |
| 1 s, the first request after enumeration | —            | unfinished after 6 min (30-45), stopped              |
| 2 s, from 1.82 s of device time          | —            | unfinished after 16 min (250-350), stopped           |
| 5 s, the first request after enumeration | —            | unfinished after 9.5 min (20), stopped               |

About a second into an unanswered request the firmware stops sleeping (every stack sample is
inside Unicorn running guest code), so each further second of the camera's time is emulated
instruction by instruction. 0.6.0.4's row has 127 such requests: 25.4 s of its 26.2 s of device
time at 200 ms, 635 s at 5 s - many hours of wall time.

**The choice: 200 ms** (`DEFAULT_HOST_GIVE_UP_MS`, the poll budget the emulator always used, now
declared by the harness and exact on the camera's clock; `SEEK_EMU_HOST_GIVE_UP_MS` overrides it,
`Infinity` for the faithful setting). Every transfer the firmware never completes ends with the
emulator's `-110` after 200 ms of the camera's time, long before the transport's own 5 s (or
1.5 s) on the same clock, so the transport's deadline never fires in the suites (the `clock:`
line: 0) - and nothing depends on load. **How this differs from a real host**, for each such
request:

- the camera is polled for 200 ms of its time, not 5 s, and then sees the next SETUP: 4.8 s less
  of its own time passes (127 × 4.8 s = 610 s over 0.6.0.4's row). Firmware state that moves
  with elapsed time (timers, a watchdog, a FW-init gate) sees less of it;
- the transport reports `usb/transfer-failed` ("… failed, status -110") where a real host
  reports `usb/timeout` ("… did not answer within 5000 ms"). No decision in the toolkit tells the
  two apart - only a STALL is special (`capability.ts`, `isStall`) - so only the message text
  differs, and it is what every pin recorded before this section too.

### 19.4 The safety net

A stuck emulator reports no time, so no deadline on the camera's clock can fire. The USB/IP
client's per-URB **wall-clock** deadline stays (`SEEK_EMU_URB_TIMEOUT_MS`, 30 s): at a 200 ms
give-up it never fired in any run below (at load ~470 the whole 0.6.0.4 row, 313 URBs, took
1,152 s - under 4 s a URB on average - and its audit found no expired deadline). When it fires, the client unlinks the URB and counts it, and the delivery audit fails
the row as an `InfrastructureDefect` ("USB/IP deadline(s) expired on the client against a live
emulator") before anything is recorded or compared - never as a measurement. New test in
`emulator-failfast.test.ts`: a stand-in emulator that accepts an import and never answers is
caught by a 2 s watchdog, the camera's clock never moves, and the audit throws the defect. With
`SEEK_EMU_HOST_GIVE_UP_MS=Infinity`, raise `SEEK_EMU_URB_TIMEOUT_MS` too. The per-row vitest
timeouts (§9.8) remain the outermost net.

### 19.5 The load test: 0.6.0.4, idle and under deliberate load

The tier-1 row alone (`npx vitest run packages/core/test/emulator-rpc.test.ts -t 0.6.0.4`),
against FW-V1 `c8a93b37`. "Loaded" is twelve `yes > /dev/null` loops started before the run and
killed after it, beside FW-V1's full self-test, another session's emulator suite and a desktop
session, which together held the machine (10 cores) at load averages of 150-470 for most of the
hour. "Quiet" is no added load
(the self-test still running). Load is `uptime`'s 1-minute average at the start and the end.

| run        | added load    | load      | wall    | armed    | replies delivered = received | host give-ups | device time at the end | transport deadlines fired          |
| ---------- | ------------- | --------- | ------- | -------- | ---------------------------- | ------------- | ---------------------- | ---------------------------------- |
| loaded 1   | 12 busy loops | 177 → 303 | 845 s   | 25 of 63 | 313 = 313                    | 127           | 26.206000 s            | 0                                  |
| loaded 2   | 12 busy loops | 303 → 420 | 905 s   | —        | —                            | —             | —                      | — (the row's 900 s vitest timeout) |
| loaded 3 ¹ | 12 busy loops | 387 → 332 | 1,152 s | 25 of 63 | 313 = 313                    | 127           | 26.206000 s            | 0                                  |
| loaded 4 ¹ | 12 busy loops | 332 → 472 | 719 s   | 25 of 63 | 313 = 313                    | 127           | 26.206000 s            | 0                                  |
| loaded 5 ¹ | 12 busy loops | 472 → 154 | 789 s   | 25 of 63 | 313 = 313                    | 127           | 26.206000 s            | 0                                  |
| quiet 1    | none          | 142 → 58  | 172 s   | 25 of 63 | 313 = 313                    | 127           | 26.206000 s            | 0                                  |
| quiet 2    | none          | 58 → 14   | 173 s   | 25 of 63 | 313 = 313                    | 127           | 26.206000 s            | 0                                  |
| quiet 3    | none          | 14 → 15   | 170 s   | 25 of 63 | 313 = 313                    | 127           | 26.206000 s            | 0                                  |

¹ With `SEEK_EMU_TIER1_TIMEOUT_MS=3600000` for these three runs only, after loaded 2 hit the
row's 900 s vitest timeout at load 420: that timeout can abort a row, never change what it
records, and the `npm run check` runs below use the default.

**Every completed run is identical, down to the camera's final time to the microsecond**, over
a 7× spread of wall time: the same 127 give-ups at 200 ms of the camera's time, the same 313
replies, the pinned 25 of 63. The pin regeneration (19.6) ran through the same loads and agrees.
One run did not complete: at load 420 the row outlasted its vitest timeout, a failure of the row
and not a measurement. Before this section, a run at load ~100 recorded 23 and one at 33-97
recorded 22 (FW-V1 Phases 32, 37).

### 19.6 Pinned results that changed: none

`node scripts/update-emulator-expectations.mjs` (both tiers) against FW-V1 `c8a93b37`, run while
the machine went from load 53 to 340: exit 0, 893 s, 476 tests. **`expectations.rpc.json` and
`expectations.roundtrip.json` are byte-identical to the committed pins**, so there is no pins
commit. Tier 1: 44 supported / 7 known-gap / 0 failed, 20,957 replies delivered = received (as in
§18.3), 127 transfers given up by the emulated host - all of them 0.6.0.4's - and 0 transport
deadlines fired; tier 2: 15 / 0 / 0, 873,049 = received, 0 dropped, every dump 0 differing bytes.
The pins were always taken on runs where the emulator's `-110` came first, and that is now the
only possible order.

One thing did move under the pins, by design: a never-completed transfer now ends exactly 200 ms
of the camera's time after it started, where the poll budget ended it ~205.7 ms after (20,000
polls, each landing on the first basic block at or past its 10 µs; FW-V1 self-test). No pinned
field depends on those 5.7 ms.

### 19.7 The checks

The source, tests and `docs/` are `a469978`; no pins commit (19.6). FW-V1 `c8a93b37`. The
machine is 10 cores with a desktop session (screen recording, a browser) beside the suite;
"busy loops" are `yes > /dev/null`, started before the run and killed after it. Load is the
1-minute average at the start and the end.

| run                                                             | added load    | load     | exit  | tests                 | wall (vitest)       | slowest row (tier 1 / tier 2)        | delivered = received (t1 / t2), dropped | host give-ups / transport deadlines fired |
| --------------------------------------------------------------- | ------------- | -------- | ----- | --------------------- | ------------------- | ------------------------------------ | --------------------------------------- | ----------------------------------------- |
| `npm run check` 1                                               | none          | 17 → 88  | 0     | 697 / 697             | 516 s (492.5 s)     | 347.6 s / 225.2 s                    | 20,957 / 873,049, 0                     | 127 / 0                                   |
| `npm run check` 2                                               | 12 busy loops | 16 → 127 | **1** | 696 / 697             | 1,079 s (1,018.6 s) | 0.6.0.4 timed out at 900 s / 447.9 s | — / 873,049, 0                          | —                                         |
| `npm run check` 3                                               | 6 busy loops  | 64 → 179 | 0     | 697 / 697             | 766 s (735.6 s)     | 602.2 s / 286.7 s                    | 20,957 / 873,049, 0                     | 127 / 0                                   |
| `npm run check` 4, right after                                  | none          | 152 → 63 | 0     | 697 / 697             | 537 s (510.9 s)     | 363.5 s / 259.3 s                    | 20,957 / 873,049, 0                     | 127 / 0                                   |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npx vitest run`        | —             | —        | 0     | 560 passed, 4 skipped | 13.0 s              | —                                    | —                                       | —                                         |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npm run test:coverage` | —             | 17       | 0     | 560 passed, 4 skipped | —                   | —                                    | —                                       | —                                         |

- **Runs 3 and 4 are the two green runs in a row, run 3 under deliberate load.** In run 2, with
  twelve busy loops, 0.6.0.4's row did not finish inside its 900 s vitest timeout: a row that
  timed out, not one that measured something else (every completed 0.6.0.4 run in 19.5, at loads
  up to 472, measured the pin). The row costs ~170 s alone on a quiet machine, and the check runs
  it beside about fifteen other emulators, so under twelve extra CPU hogs it needs more than 900 s
  of real time. No timeout was raised to make a run pass.
- 697 = 692 (§18.5) + 4 transport-clock tests in `protocol.test.ts` + the hung-emulator test.
  Tier 1 was 44 / 7 / 0 and tier 2 15 / 0 / 0 in every completed run; the device time summed
  over tier 1 was 68.211003 s and over tier 2 879.651000 s in every run.
- An earlier coverage run at load ~350 failed on `packages/cli/test/camera.test.ts` "reads the
  whole flash…", which timed out at vitest's default 5 s (9.3 s under that load, coverage on);
  it uses the wall clock, as every non-emulator test does, and passed at load 17.
- **The new tests, and what they did on the old code.** The four transport-clock tests (a hung
  transfer ends at exactly the injected clock's deadline and no real timer is started; each
  deadline is measured from the clock at the transfer, in and out, and cancelled on an answer;
  earliest-first firing; the default is `setTimeout`) - the first two fail on the old code, which
  has no `clock` option and ignores it (a real timer is started, 60 s of fake time end the hung
  transfer, and the injected clock starts no timer); the last passes on the old code, as it must:
  it is the production path. The hung-emulator test passes on the old harness too (the watchdog was
  already there); it pins that the camera's clock does not replace it. The existing
  `protocol.test.ts` fake-timer tests of the wall-clock path (5 s, and the 20 s commit firing at
  exactly 20,000 ms) pass unchanged.

### 19.8 Still open

- **The faithful give-up is not run.** `SEEK_EMU_HOST_GIVE_UP_MS=Infinity` works (the FW-V1
  self-test checks the mechanism at 50 ms), but at 5 s a single unanswered 0.6.0.4 request did
  not finish in 9.5 minutes, so no row has been measured that way.
- ~~**`ensureMode0` still waits on the wall clock.**~~ Closed in §20.1. `SeekDevice.ensureMode0` polls
  `GetOperationMode` every 20 ms until `MODE_SETTLE_MS` (3 s) of real time has passed
  (`client.ts`). That is a second deadline outside the transport, with the same shape as §19.1:
  on the emulator, a camera that needed more of its own time to reach mode 0 than a loaded
  machine gives it in 3 real seconds would be refused under load and pass when idle. No row is
  known to depend on it (the pins agree at loads 14-472), and it was left alone because this
  change was the transport's deadline; putting it on the same `DeadlineClock` is the fix.
- The adapter's re-import retry (`REOPEN_TIMEOUT_MS`) and the READY / `OP_REQ_DEVLIST` waits
  are wall-clock too. They decide only whether the instrument is up - a device on the gated
  clock does not age while they wait - and a failure there fails the row.

## 20. The settle deadline on the camera's clock, the wall clock's tripwire, and the check's time (2026-09-24)

§19.8 left a second wall-clock deadline (`ensureMode0`) and a check that seemed to have gone from
~300 s to 520-540 s. This section moves the deadline, adds a guard that fails a row when any wait
is timed on real time, and measures the slowdown. The toolkit source changed (`webusb.ts`,
`transport.ts`, `client.ts`); FW-V1 did not.

### 20.1 The settle deadline on the transport's clock

- `DeadlineClock` gained `now()`, the clock's time in ms, for a deadline checked between
  requests rather than raced against one. `WALL_CLOCK.now()` is `Date.now()`.
- `UsbTransport` gained an optional `clock`. `WebUsbTransport` exposes the one it was built with
  (`WALL_CLOCK` by default), and a pass-through transport forwards it (`probe.ts`'s
  `IdentityRecorder` and `InfoAnswers` do).
- `SeekDevice.clock` is `transport.clock ?? WALL_CLOCK`, and `ensureMode0` computes and checks
  its `MODE_SETTLE_MS` deadline with `this.clock.now()`.

**In production nothing changes.** The browser app and the CLI build their transports without a
clock, so the deadline is `Date.now() + 3000` checked with `Date.now()`, the same expression as
before. Over the emulator it is 3 s of the camera's time. Between URBs the gated clock does not
move, so the 20 ms pauses age the camera by nothing and each `GetOperationMode` poll ages it by
about one interrupt threshold (~1 ms). A camera that never reached mode 0 would therefore be
polled ~3,000 times, where a real camera gets ~150, which is about a minute of wall time. No row
gets that far. The `clock:` summary line now counts the settle loop's reads of the camera's time,
and it was **0 in both tiers** in every run below: every emulated camera already reports mode 0
at the first read.

New tests in `protocol.test.ts`. One uses a camera that never settles and ages 100 ms per request
on an injected clock: exactly 1 + 31 `GetOperationMode` reads, ending at 3,300 ms of its time,
after about 0.7 s of real time. On the old code that loop ran for 3 real seconds, about 150
polls, so the test fails there. The other checks that the device takes its transport's clock and
falls back to `WALL_CLOCK`.

### 20.2 The other real-time waits in the toolkit

A grep of `packages/*/src` for `setTimeout`, `Date.now`, `performance.now`, `sleep` and `delay`
found these. Only the first two decide anything, and both are on the transport's clock now.

| wait                                                                              | decides                                       | treatment                                                                                                                        |
| --------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `withTimeout` (`webusb.ts`)                                                       | whether a transfer timed out                  | the transport's clock (§19)                                                                                                      |
| `ensureMode0`'s `MODE_SETTLE_MS`                                                  | whether mode 0 came in time                   | the transport's clock (20.1)                                                                                                     |
| `client.ts` pauses (20 ms after an arm, 10 ms after a selector, 50 ms on a retry) | nothing: the next request always follows      | left alone. On the gated clock a pause ages the camera by nothing however long it takes, so the URB sequence cannot depend on it |
| `capability.ts` start-up pauses (20 ms)                                           | nothing: the window is a count of reads (§18) | left alone                                                                                                                       |
| `dump.ts` `retryDelayMs`, `flash.ts` 200 ms after the commit                      | nothing                                       | left alone                                                                                                                       |
| `flash.ts` `Date.now()`                                                           | the throughput text in a log line             | left alone: reporting, and no pin records it                                                                                     |
| CLI `interrupt.ts`, `reporter.ts`; web `useReporter`, `yield-to-ui`, `download`   | UI and Ctrl-C only                            | left alone: no emulator suite runs them                                                                                          |

The harness's own wall-clock waits (the READY line, `OP_REQ_DEVLIST`, the re-import retry, the
30 s per-URB watchdog) are unchanged. They decide only whether the instrument is up, and each one
fails the row when it runs out (§19.4, §19.8).

### 20.3 The guard: the wall clock's tripwire

`harness.ts` wraps `WALL_CLOCK.now` and `WALL_CLOCK.startTimer` with counters. The wrappers call
straight through, so the clock itself does not change. Every emulator notes the counts when it
comes up, and the delivery audit fails the row as an `InfrastructureDefect` if either moved while
it ran ("the toolkit timed a wait on the WALL clock ..."). Within the toolkit, `WALL_CLOCK` is
only ever the fallback: a transport built without `clock: device.deadlineClock`, a `SeekDevice`
over a transport that has no clock, or a pass-through transport that did not forward one. A use
of it during a row is therefore a deadline that load could have moved. The count is per test
worker, so a row that ran beside the offender fails with it. That is deliberate: it fails closed
and never lets a row pass. The existing `wallClockTransfers` guard (§19.2) stays.

New test in `emulator-failfast.test.ts`: against the stand-in emulator, a `SeekDevice` over a
clockless transport settles mode 0 and a transfer is raced without a clock, and the audit throws
the defect. With the check disabled, the test fails.

### 20.4 Where the check's time went

A/B, in the same conditions: the harness before §19 (`662b696`, no side channel) against this one,
both against FW-V1 `eb0f07e9`, one after the other on a quiet machine. The tier-2 row is
Compact 4.8.2.1 (`2229A0YZ7E28`, 64,783 URBs), alone.

| run                                  | load                | wall                                        | emulator CPU (Python) | harness CPU (Node) |
| ------------------------------------ | ------------------- | ------------------------------------------- | --------------------- | ------------------ |
| tier-2 row, before §19               | 14 → 16             | 84.7 s                                      | 67.0 s                | 6.8 s              |
| tier-2 row, `63f76c0`                | 16 → 10             | 83.5 s                                      | 66.3 s                | 7.8 s              |
| tier-2 row, `63f76c0`                | 8 → 13              | 81.0 s                                      | 65.2 s                | 7.3 s              |
| tier-2 row, this change              | 10 → 8              | 85.8 s                                      | 67.9 s                | 7.7 s              |
| tier-2 row, this change              | 13 → 18             | 81.2 s                                      | 65.0 s                | 7.4 s              |
| full `vitest run`, before §19        | 12 → 19 (peak 105)  | 347 s; 0.6.0.4 measured **22** and failed   | —                     | —                  |
| full `vitest run`, before §19, again | 13 → 176 (peak 242) | 386 s; 0.6.0.4 measured **24** and failed   | —                     | —                  |
| full `vitest run`, this change       | 19 → 14 (peak 67)   | 281 s; 700 / 700; slowest 204.9 s / 139.3 s | —                     | —                  |

- **The side channel is not where the time went.** A tier-2 row costs the same wall time with it
  and without it (81-86 s against 84.7 s). The emulator's CPU is unchanged within noise. The
  harness spends about 0.5-1 s more CPU per 65k URBs (~15 µs a URB), for a second socket read per
  URB.
- **Its parts, measured in place** (temporary instrumentation, not committed). The emulator's
  `publish` took 2.28 s per 64,783 records, 35 µs each, of which json formatting is ~2 µs and the
  `send` ~10 µs. The harness's record handler took 0.62 s, 9.5 µs each. 24% of replies were read
  in a later event-loop turn than their record, which costs one extra wake-up. The rest shared a
  turn with it.
- **Holding replies costs nothing.** A reply waits only when its record is late, and that was 0
  in tier 1 and 1 of 873,049 in tier 2.
- **Wall time on this machine is noisy.** Earlier single-row runs of both harnesses at loads
  11-40 spread from 70 to 95 s, so any one pair can suggest a 10-20% difference either way. The
  full runs of the old harness both fell into load spikes, and both got 0.6.0.4 wrong (22, then
  24): the race §19 removed, on the old code.
- **So §19.7's 516-537 s was not reproduced.** Under the same conditions the suite takes ~281 s,
  as §18's 278-288 s did. Nothing in the side channel accounts for the difference. §19.5 records
  what else held that machine during that hour (FW-V1's self-test, another session's emulator
  suite, a desktop session).
- **What bounds the check** is emulation, not plumbing. Tier 1 waits on 0.6.0.4 (~205 s for 313
  URBs, most of it emulating 25.4 s of device time with the firmware spinning). Tier 2 is 873k
  URBs at 6 rows at a time, and the emulator uses ~9 times the harness's CPU per row.
- **Tried and dropped: two micro-optimisations.** In the emulator, the record formatted as bytes
  directly (the same bytes) and sent first through a non-blocking twin of the socket, which skips
  the poll a timeout socket makes before each send: `publish` went from 20.3 to 10.5 µs in
  isolation. In the harness, the channel read through `onread` into one reused buffer, with
  numeric pairing keys. Neither moved a row's wall time or the harness's CPU outside the noise
  (83.0 / 89.7 s against 82.2 / 87.5 s; 7.7 / 7.4 s against 7.3 / 7.8 s), so neither is committed
  and FW-V1 is unchanged. Each would save well under 1% of the check.

### 20.5 The checks

The source, tests and `docs/` are `f58c3e1`, against FW-V1 `eb0f07e9` (unchanged). The runs went
one after another. A desktop session (OBS screen recording, a browser) took about three cores
throughout, and the load climbed through the hour, independently of these runs. Load is the
1-minute average at the start and the end, with the peak of 15 s samples.

| run                                                             | load                 | exit | tests                 | wall (vitest)   | slowest row (tier 1 / tier 2) | delivered = received (t1 / t2), dropped | host give-ups / transport deadlines fired | settle reads |
| --------------------------------------------------------------- | -------------------- | ---- | --------------------- | --------------- | ----------------------------- | --------------------------------------- | ----------------------------------------- | ------------ |
| `node scripts/update-emulator-expectations.mjs` (both tiers)    | 176 → 62 (peak 276)  | 0    | 479                   | 390 s           | 286.7 s / 200.1 s             | 20,957 / 873,049, 0                     | 127 / 0                                   | 0 / 0        |
| `npm run check` 1                                               | 62 → 161 (peak 216)  | 0    | 700 / 700             | 343 s (322.8 s) | 238.9 s / 164.5 s             | 20,957 / 873,049, 0                     | 127 / 0                                   | 0 / 0        |
| `npm run check` 2                                               | 161 → 201 (peak 329) | 0    | 700 / 700             | 419 s (400.2 s) | 305.9 s / 205.0 s             | 20,957 / 873,049, 0                     | 127 / 0                                   | 0 / 0        |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npx vitest run`        | —                    | 0    | 563 passed, 4 skipped | 13.0 s          | —                             | —                                       | —                                         | —            |
| `SEEK_EMU_DIR=/none SEEK_DUMPS_DIR=/none npm run test:coverage` | —                    | 0    | 563 passed, 4 skipped | 13.2 s          | —                             | —                                       | —                                         | —            |

- **The pins are byte-identical**: regenerating both tiers left `expectations.rpc.json` and
  `expectations.roundtrip.json` unchanged, so there is no pins commit. Tier 1 was 44 / 7 / 0 and
  tier 2 15 / 0 / 0 in every run. The device time summed to 68.211003 s over tier 1 and
  879.651000 s over tier 2 in every run, the same as §19.7.
- **The two checks in a row were green**, at 343 s and 419 s under loads that peaked at 216 and
  329, against §19.7's 516 s and 537 s. On a quieter machine (peak 67) the same tree's
  `vitest run` took 281 s (20.4).
- Replies held for their record: 1, 3 and 0 in tier 1; 2, 3 and 1 of 873,049 in tier 2.
- 700 = 697 (§19.7) + 2 tests in `protocol.test.ts` + 1 in `emulator-failfast.test.ts`; 563 =
  560 + the same 3.
- The before-§19 harness got 0.6.0.4 wrong in both of its full runs here (22 at peak load 105, 24
  at peak 242). That is the load race §19 removed, seen on the old code.

### 20.6 Still open

- The faithful 5 s host give-up is still not run (§19.8).
- The side channel's remaining cost, about 0.5-1 s of harness CPU per 65k URBs, is within the
  noise of a row. Removing it would take a cheaper channel (a Unix socket, say). That is a
  protocol change in FW-V1 and would buy well under 1% of the check.
