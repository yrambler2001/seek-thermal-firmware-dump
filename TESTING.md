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
`device stalled status IN bRequest=11` from some point on and `no-answer` thereafter. The fix is
harness-side and it is a distinction rather than a tolerance. `probeTier1` now throws
`ProbeUnmeasurable` when the camera **was** answering and then answers neither `GetErrorCode` nor
`GetFirmwareInfo` through three fresh USB/IP imports, or when the emulator process has exited; the
suite discards that attempt entirely and re-measures from a **new emulator**, up to three times.
Nothing about a discarded attempt is recorded, and a stall or a device error code — the device
speaking — is still measured once and written down as it answered.

That distinction also re-classified rows that were never a flake. Eleven rows were pinned with
`no-answer` on every command; on the 2014 Compacts the emulator **dies**, with
`UC_ERR_WRITE_UNMAPPED` on a write to `0x42040204` — a Cortex-M bit-band alias, which FW-V1's own
`docs/EMULATOR_CORPUS.md` says the emulator does not model. Those rows were never a statement about
firmware, and they no longer read as one.

### 9.5 The open disagreement, stated as one

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

So it is **not zero**, and the honest number is **2 rows in 204 row-measurements
(1.0 %)**, all four failures in the one run that took twice as long as the
others. Before this work the same suite lost about one row in fifty-one (2 %),
every run, and lost it _silently_ — the row was pinned as a finding about
firmware.

What is left is narrower and is named: on the slow run the only two fields that
moved were `SetFirmwareInfoFeatures` and `EnsureMode0`, which are the **last two
measurements the probe takes**. The wedge begins there and the row ends before
the re-take can get a second answer that differs. Both are `no-answer` — a host
deadline, never a refusal — so nothing false was recorded about the firmware;
the run simply went red.

Three things would close it, in order of how much they cost:

1. **Take the two cheap commands earlier.** They are last because the selector
   map is the measurement that matters and runs first, before anything can
   wedge the endpoint. Moving these two to just after the identity read costs
   nothing and puts them where the endpoint is still clean.
2. **Re-take the whole command block, not one command.** The block is eight
   transfers; a lost one is currently re-taken alone, into an endpoint that may
   already be wedged.
3. **Fix the wedge itself**, which is FW-V1's: `SET_INTERFACE` is stalled on
   every re-import from some point on, and `WebUsbTransport`'s fallback to
   `recipient: 'device'` then silently changes what the probe is asking.

### 9.7 Where the wall time goes (2026-09-22)

The question was why some emulator rows run for minutes while nothing uses any CPU. **Answer:
it is an emulator defect, not the firmware, the clock gate or the 5 s deadline.** The USB/IP
server in FW-V1 `emu/seekemu/usbip.py` leaves writer threads orphaned, and those threads **drop
replies the device has already computed.** The host then waits out its deadline for a reply
that will never arrive, and neither side is doing anything while it waits. The same mechanism
is the "one row in fifty-one" residual of §8 and §9.6. Everything below is measured at `497a6f2`
against FW-V1 `c8d56404`.

**Pre-flight: `npm run check` does not pass.** At the tests it is **565 passed, 16 expected
fail, 0 failed**, but one suite fails and the exit code is 1; wall 914 s, vitest 900.3 s. The
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
| (b) the `SET_INTERFACE` stall                                                      | ~0               | it stalls on **1,362 of 1,362** imports, every row, from the first. It is the baseline, not a wedge signature, and costs 1–3 ms                                                                                        |
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
be tier-2-bound at roughly 190 s instead of 775–900 s. **That is arithmetic from run B, not a
measurement; the fix has not been made.**

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

#### Fixes, ranked by value against risk (none implemented)

1. **Emulator: route completions per session** (FW-V1 `emu/seekemu/usbip.py`). Give each import
   its own queue for completions, unlinks and its quit, so a writer can never dequeue another
   session's item. Count dropped completions in `Bridge.summary()`, and add a self-test that
   forces the interleaving (a delay between `detach()` and the quit) and asserts zero drops and
   at most one live writer. This removes 2,210 of 2,608 s of tier-1 row time, the 900 s hang,
   and by mechanism the residual. It changes delivery only; the device's answers, the gate and
   the cycle counts are untouched, so no test measures anything different. **Low risk, highest
   value.**
2. **Harness: make a dropped reply impossible to mistake for firmware silence.** The emulator
   already counts URBs completed; have the harness compare that with what the client received,
   and raise `ProbeUnmeasurable` naming "completed by the device, never delivered". Cheap, loud,
   changes no measurement, and guards fix 1 against regressing.
3. **Harness: a known gap must not pass on a timeout.** `test.fails` turned run A's 900 s hang
   into a green "expected failure". Assert the gap's own condition and let any other error,
   a timeout included, fail the row. Low risk.
4. **Harness fidelity, and a separate decision because it changes what is measured.**
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
