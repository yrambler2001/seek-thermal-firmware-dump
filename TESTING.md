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

**Why the fill matters, in one line:** 68–96 % of a real Seek flash is erased, so without it
`0xFF` and "never transferred" are the same byte and a dump that lost a window still compares
clean over most of its length. With it, a gap is a diff at a named address.

**What it found that `profiles.test.ts` structurally could not.** The selector map is checked
by comparing the bytes each armed window serves against the emulator's own image at the
address the profile _claims_ — so "subcommand 5 exposes 0x14030000" becomes a measurement.
Across the 51: 26 firmwares confirm all 63 windows; 8 (the 2016 generation and the 1.3.0.8
Compacts) confirm 25 and refuse 38, which is exactly what `legacy-auth` describes; 16 (the
2014 Compacts) refuse all 63 because `BeginFirmwareUpgrade` stalls on every subcommand,
although `modern-4x`'s own summary says it covers the Compact line. The auth probe makes the
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
  and three defects lived in that churn. The one that mattered: a `quit` sentinel left
  behind by a dead session stopped the **next** session's writer thread, so a healthy
  device answered nothing for one session and one command came back `no-answer`.

**Five consecutive regenerations — one of them under deliberate CPU load, load average
10 → 161 — now produce byte-identical expectations for all 51 rows** (666.9 s, 679.7 s
loaded, 670.9 s for the last three; `0 of 51` differing between every consecutive pair).
No field is excluded from the pin, and nothing retries to make a row green.

**One residual failure mode is left, it is quantified, and it means `npm run check` does
not pass.** Every run above was `vitest run --project core` with `SEEK_EMU_TIER2=none` —
the emulator suites alone. Across six such runs (five regenerating, one asserting) that is
**306 row-measurements with zero divergence**. Run the emulator suites alongside the rest
of this repository's suite instead — `npm run check`, or a bare `vitest run` — and roughly
**one row in fifty-one wedges**: five failing rows across four such runs, _a different row
each time_ (`compact_xr 4.8.2.1`, `compact_pro 4.18.2.0-FF`, `compact_pro 1.0.3.2-FF`,
`nano_200` …), never the same one twice.

The signature never varies: the row costs 180–420 s instead of 4, the emulator log shows
`device stalled status IN bRequest=11` on **every** re-import from some point on, and the
commands after it read `no-answer`. That is the control endpoint wedged — and
`transport.open()`, which is the only thing that clears a wedge, is itself the request
being stalled, so it never recovers.

**What is left is not the emulator's clock and not its teardown; both of those were fixed
and measured.** It is the one coupling neither side may remove: the emulator runs three
orders of magnitude slower than silicon while `WebUsbTransport` applies its own **5 s
wall-clock deadline** per transfer. Under enough host contention one transfer is abandoned
mid-flight, and on these builds the firmware then refuses `SET_INTERFACE` for the rest of
the row. Shortening the work is not possible; lengthening the deadline would mean changing
the toolkit's real code, which is the one thing this suite must not do, and would make the
measurement a measurement of the change. It is written down here rather than hidden behind
a tolerance or a retry.

**Runtime, stated rather than hidden.** Tier 1 over all 51 is ~11 min at six concurrent
emulators, dominated by the 2014 Compacts, which pay `ensureMode0()`'s three-second settle
on each of 63 arms (~330 s a row). **Load barely moves it** — 666 s idle against 678 s at
load average 50–100 — because a gated emulator that is waiting costs no CPU at all. Tier 2
over the 15 dumps is ~10 min. `SEEK_EMU_TIER2=none` skips tier 2; `SEEK_EMU_WORKERS` sets
the concurrency (it is per suite _file_, so two files in flight double it).

Skips exactly as §4 rule 1 demands: `SEEK_EMU_DIR` absent → loud skip on stderr, exit 0.
With neither optional input: **404 passed | 3 skipped**, exit 0. With the dump corpus but no
emulator: **472 passed | 2 skipped**.
