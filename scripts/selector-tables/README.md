# selector-tables: what a firmware's own BeginFirmwareUpgrade table says, and what the toolkit sees

Instruments from 2026-09-23 (`TESTING.md` §10, and FW-V1 `docs/EMULATOR_CAMPAIGN_LOG.md`
Phase 21). The main instrument of that work is not here: the decoder that reads each
image's window switch out of its bytes is part of `scripts/update-firmware-facts.mjs`
(`windowTable` in `packages/core/test/firmware/facts.json`), because the tests are held to
its output. FW-V1 keeps the emulator-side instruments (`emu/instruments/selector_tables/`):
an independent Python decoder of the same switch, and a reader of the boot record that
0.8.0.0's mode 1 indexes.

| file                                      | what it produces                                                                                                                                                                                              | backs                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `early_version_read.ts <entry-substring>` | Boots one corpus entry with the tier-1 fill, attaches over USB/IP and prints GetFirmwareInfo (36 and 4 bytes, twice), GetErrorCode, then `probeSelectorChannel()`'s result and notes, and the delivery audit. | §10.4: on 0.5.1.0 and 0.5.1.3 every request stalls at that point, so the probe sees no version and its plain arm is "refused" with everything else. 0.5.0.2 is the control. |

Run from this checkout with `npx jiti`. `SEEK_TOOLKIT_DIR` defaults to the current directory
and `SEEK_EMU_DIR` to `<toolkit>/../FW-V1/emu`. It sends only GetFirmwareInfo, GetErrorCode
and what `probeSelectorChannel` sends, all in `READ_ONLY_OPS`, and it drives the emulator
only.

Like `scripts/recipient-fidelity/`, it is excluded from lint (`eslint.config.js`) and from
every `tsconfig`: it loads the toolkit and the harness by computed dynamic import, which is
`any` by construction. Unlike those, it is formatted by Prettier.
