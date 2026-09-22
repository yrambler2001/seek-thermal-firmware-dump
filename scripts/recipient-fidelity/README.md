# recipient-fidelity: does the emulator harness talk like a real host?

Instruments from 2026-09-22 (`TESTING.md` §9.9, and FW-V1 `docs/EMULATOR_CAMPAIGN_LOG.md`
Phase 19). They lived in FW-V1 under a repo-root `tools/recipient_fidelity/` until
2026-09-23 and were moved here, because they import this repository's own transport and
test harness and run from this checkout. FW-V1 has no repo-root `tools/`: its tools are
authored in `codegen/harness/tools/` and generated into each target.

**The question.** The USB/IP adapter (`packages/core/test/emulator/webusb-over-usbip.ts`)
presents an emulated camera to the toolkit's real `WebUsbTransport`. Until `aa69f72` its
`claimInterface()` sent `SET_INTERFACE` as bmRequestType 0x00. Every firmware stalled
that, and the transport then quietly fell back to device-recipient vendor requests. So
every emulator row measured 0x40/0xC0, while a real host sends 0x41/0xC1. Did that change
any result, and does the real camera care?

All three are TypeScript and run with `npx jiti` from this checkout. `SEEK_TOOLKIT_DIR`
defaults to the current directory. `SEEK_EMU_DIR` defaults to `<toolkit>/../FW-V1/emu`.

| file                                                | what it produces                                                                                                                                                                                                                                                           | backs                                                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ground_truth.ts <entry>`                           | For one corpus entry, it prints: the import record's configuration; `transport.info` and `onWarning` after `open()` with recipient `auto`; SET_INTERFACE sent as 0x00 and as 0x01; GET_INTERFACE; and four read-only vendor requests as 0xC0, 0xC1 and 0xC1 with wIndex=1. | §9.9 "ground truth". Run on 8 builds: 0.3.0.1, 0.5.0.2, 1.3.0.8, 4.8.1.9, CP 1.0.3.0 dump, CP FF 4.18.2.0 dump, Mosaic FF 2.27.1.33 dump, Nano 300 dump. |
| `stop_stress.ts <entry> <new\|old> [workers] [per]` | It boots, runs the probe's shape, closes, stops with SIGTERM and times the stop. mode=old reproduces the pre-fix adapter's claim.                                                                                                                                          | §9.9 "the SIGTERM self-deadlock". This timing did not reproduce the hang (0 in 200); FW-V1 `emu/selftest.py check_usbip_signal_stop` forces it instead.  |
| `hw_readonly.ts`                                    | The real camera through the CLI's host stack (node-usb 3.x / nusb) and `WebUsbTransport`, with `auto` then `device` recipient. It sends 4 allow-listed vendor IN reads and nothing else.                                                                                   | §9.9 "measured on the real camera" (Compact PRO FF 4.18.2.0).                                                                                            |

`hw_readonly.ts` is read-only by construction. It holds an allow-list of GetErrorCode
(0x35), GetChipID (0x36), GetOperationMode (0x3D) and GetFirmwareInfo (0x4E), checked
against `packages/core/test/firmware/facts.json`'s row for 4.18.2.0. It sends no OUT
request. Before pointing it at any other build, check that build's facts.json row. Power
the camera through the bench switch (`USBSW-1`, channel 2) and off again afterwards.

## Why `npm run check` does not lint, format or typecheck the three `.ts` files

They are excluded explicitly: `eslint.config.js` ignores `scripts/recipient-fidelity/**`,
`.prettierignore` lists `scripts/recipient-fidelity/*.ts`, and no `tsconfig` includes
them. The reason is what they are for:

- They reach **past the adapter's public surface on purpose**. `ground_truth.ts` sends raw
  control transfers through the adapter's private `session` (a `SET_INTERFACE` with a
  bmRequestType no `WebUsbDevice` call can produce), and `stop_stress.ts` patches
  `claimInterface` back to the pre-fix behaviour. That is `any` by construction, which
  `strictTypeChecked` rejects everywhere; typing it would mean widening the adapter's API
  for the sake of a measurement tool.
- They load the toolkit through **computed dynamic imports** (`SEEK_TOOLKIT_DIR`), so the
  same file can be pointed at another checkout, such as the pre-fix `dd336c0`.
- They are **kept as they were run**, so the results recorded in §9.9 stay reproducible.
  Since the move only the usage lines and the cross-repository references in their header
  comments have changed. `hw_readonly.ts` drives real hardware and could not be
  re-validated after a rewrite.

The SIGTERM self-deadlock reproduction that was a scratch script here is now part of
FW-V1's `emu/selftest.py` (`check_usbip_signal_stop`). It runs the pre-fix handler
verbatim, as a control that must deadlock.
