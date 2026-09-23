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
word. So every emulator row in both tiers measured `0x40`/`0xC0` vendor requests, while a
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
5. **Not recommended now:** shortening the emulator's 20,000-step host-harness budget that
   0.6.0.4 pays 127 times. That budget is 1.32 M cycles against a worst observed answer of 94,048,
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
  on; 0x14000000 and 0x140C0000 are then gaps that say why. The manifest records the
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
is made. The probe's plain arm of 5 is then refused, `legacy-auth` wins on that, and the
plan is the version-unknown one: 30 windows, all unread. The dump would read nothing, and
nothing unsafe is sent (0x52 is `BeginFirmwareUpgrade` on those builds). The version gate
treats an unknown version as not old; on a 0.3.0.1 that did not answer `GetFirmwareInfo` it
would therefore not engage. Whether a real 0.5.1.x camera behaves like this is not known.

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

- **The version gate cannot see a build that does not answer `GetFirmwareInfo`** (§10.4,
  0.5.1.x). Refusing unknown versions would stop every camera that is slow to answer it.
- **1.3.0.8 8 Hz could give its bootloader block** (no mode-2 test), but the version does not
  tell it from the 16 Hz build. The build string might.
- **0.8.0.0's mode 1 on a real 2014 bootloader** is unmeasured; the plan does not use it.
- FW-V1 `targets/compact_32k_0_3_0_1/src/rpc_cmds.c` still carries the completed image's
  41-row method table and its modern `cmd_BeginFirmwareUpgrade` (`case 0xE` →
  0x140C0000), which the 0.3.0.1 image does not have; recorded in FW-V1
  `docs/ACTION_ITEMS.md`, not changed here.
- The web dump view still calls the unlock token "build-specific" (§9.3 shows one token in
  22 images); not changed here.
