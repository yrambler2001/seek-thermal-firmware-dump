/**
 * What both real-camera runs (Electron's real WebUSB, and the bridge over
 * node-usb) check, so the two routes assert exactly the same things.
 */

import type { Page } from 'puppeteer-core';
import { expect } from 'vitest';

import { OP } from '../../packages/core/src/protocol/ops.js';
import { RESET_OP } from '../../packages/core/src/preservation/pipeline.js';
import { sha256, names, runState, type RunStateView } from './checks.js';
import { installWriteGuard, type WriteGuardConfig } from './write-guard.js';
import { PHASE_FOLDER, Wizard, phaseSection, type DumpRun, type PhaseRun } from './wizard.js';

/**
 * This camera's whole flash, as its Dump & decrypt image reads it: the bench
 * Compact 1.3.0.0's J-Link dump (TESTING.md sec. 34). Another camera, or this
 * one after a change, sets `SEEK_E2E_CAMERA_SHA` (empty skips the check).
 */
export const CAMERA_FLASH_SHA =
  process.env.SEEK_E2E_CAMERA_SHA ??
  '40447c7e6da5cbc84621f4694ffff5bda0f783e7807a45e80443383b19a8eb72';

/** Which chooser entry is the camera. */
export const CAMERA_NAME = /PIR206|Seek|Thermal|289d/i;

/** Requests that must never appear on the wire in a read-only run. */
export const NEVER_ON_THE_WIRE = ['out 0x50', 'out 0x51', 'out 0x55', 'out 0x5a'];

export const WRITE_GUARD_GLOBAL = '__seekWriteGuard';

/** The real-WebUSB run's page-side guard: the same whitelist `CameraBus` holds. */
export const WRITE_GUARD: WriteGuardConfig = {
  global: WRITE_GUARD_GLOBAL,
  readsAllowed: [
    OP.GET_ERROR_CODE,
    OP.GET_OPERATION_MODE,
    OP.GET_FIRMWARE_INFO,
    OP.GET_FEATURED_FIRMWARE_DATA,
    OP.GET_FEATURED_DATA,
  ],
  neverOps: [
    OP.SET_FEATURED_FIRMWARE_DATA,
    OP.COMPLETE_MEMORY_UPGRADE,
    OP.SET_FIRMWARE_INFO_FEATURES,
    OP.SET_RAM_DATA_FEATURES,
  ],
  modeOp: OP.SET_OPERATION_MODE,
  armOp: OP.BEGIN_FIRMWARE_UPGRADE,
  versionOp: OP.GET_FIRMWARE_INFO,
  resetOp: RESET_OP,
};

/** The guard as a script: what Electron's preload runs before the app. */
export function writeGuardScript(): string {
  return `(${installWriteGuard.toString()})(${JSON.stringify(WRITE_GUARD)});\n`;
}

/** The Dump & decrypt archive: its layout, and its whole image against the camera's. */
export function checkDumpArchive(dump: DumpRun): void {
  expect(dump.status).toMatch(/^Done — (\d+)\/\1 windows read/);
  const all = names(dump.entries);
  const dir = all[0]?.split('/')[0] ?? '';
  expect(dir).toMatch(/^seek_flash4m_/);
  expect(all).toContain(`${dir}/manifest.json`);
  expect(all).toContain(`${dir}/README.md`);
  const image = dump.entries.find((e) => /^[^/]+\/flash_4m_usb[^/]*\.bin$/.test(e.name));
  expect(image?.data.length).toBe(4 * 1024 * 1024);
  if (CAMERA_FLASH_SHA !== '') {
    expect(sha256(image?.data ?? new Uint8Array(0)), "the dump's image: this camera's flash").toBe(
      CAMERA_FLASH_SHA,
    );
  }
}

/** Step 02's run file: its name pattern is checked by the wizard; here the folders and state. */
export function checkStep02RunFile(run: PhaseRun): RunStateView {
  const all = names(run.entries);
  expect(all.slice(0, 2)).toEqual(['preserve_run.json', 'README.md']);
  for (const file of [
    'preserve_backup_windows.bin',
    'preserve_bank_capture.bin',
    'preserve_image_plain.bin',
    'preserve_patch_plain_patched.bin',
  ]) {
    expect(all).toContain(`${PHASE_FOLDER['read-build']}/${file}`);
  }
  expect(all.filter((n) => /^0[34]-/.test(n))).toEqual([]);
  const state = runState(run.entries);
  expect(state.steps.backup?.status).toBe('done');
  expect(state.steps.patch?.status).toBe('done');
  expect(state.steps.commit).toBeUndefined();
  expect(state.nextStep).toBe('commit');
  return state;
}

/** The page offers step 03 — not taken — and shows no red past-commit alarm. */
export async function checkStep03Offered(wizard: Wizard, page: Page): Promise<void> {
  expect(await wizard.isEnabled(phaseSection('patch-dump'), Wizard.startLabel('patch-dump'))).toBe(
    true,
  );
  expect(await wizard.redAlerts()).toEqual([]);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toContain('The commit is not on record');
  expect(text).not.toContain('Concerns the patched part');
}
