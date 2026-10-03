/**
 * THE RESET IS NOT A SWAP — the adoption logic, driven end to end through the
 * REAL `useDevice` and the REAL generation guard, against a fake
 * `navigator.usb`:
 *
 *  - during phase ② (which resets the camera), the mid-phase disconnect does
 *    NOT cancel: the opener ladder's boot silence is progress text, the
 *    re-enumerated unit (same vid/pid — this camera has no serial string) is
 *    auto-adopted on its connect event, and the phase continues;
 *  - with a SECOND authorized camera on the bus, the reconnect cannot be
 *    told apart — the run stops loudly;
 *  - during phase ① (no reset expected) a disconnect stops the phase;
 *  - every core step receives the state the previous one returned, so a
 *    true swap that slips the guard is caught by the steps' own gates.
 *
 * `runPreserveStep` is faked (the camera steps are the emulator suite's
 * business); the fake records the state each step was handed, so the
 * hand-off is asserted here rather than trusted.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelledError, nextStepAfter, type Artifact } from '@seek-fw/core';
import { DEFAULT_OPTIONS_FORM } from '@/lib/options';
import type * as PreserveClient from '@/lib/preserve/client';
import { useDevice, type DeviceHandle } from './useDevice';
import { usePreservePanel, type PreservePanelApi } from './usePreservePanel';
import { useRunner, type Runner } from './useRunner';
import { utf8 } from '@seek-fw/core';
import type {
  PreservePhaseId,
  PreserveRunState,
  PreserveStepId,
  PreserveStepOutcome,
} from '@/lib/preserve/types';
import { renderHook, waitFor } from '@/test-helpers';

/* ---- the fakes ----------------------------------------------------------- */

interface Deferred {
  resolve: (outcome: PreserveStepOutcome) => void;
}

/** Which step hangs until the test releases it. */
let hungStep: PreserveStepId | null = null;
const deferreds = new Map<PreserveStepId, Deferred>();
/** The state each fake step was handed, in call order. */
const handed: [PreserveStepId, PreserveRunState][] = [];

function fakeOutcome(step: PreserveStepId, state: PreserveRunState): PreserveStepOutcome {
  const record = { status: 'done' as const, startedAt: 's', finishedAt: 'f', notes: 'fake' };
  const base: PreserveRunState = {
    ...state,
    steps: { ...state.steps, [step]: record },
    nextStep: nextStepAfter(step),
  };
  const artifacts: Artifact[] = [];
  switch (step) {
    case 'backup':
      artifacts.push(
        { name: 'preserve_backup_windows.bin', data: utf8('windows') },
        { name: 'preserve_bank_capture.bin', data: utf8('capture') },
        { name: 'preserve_image_plain.bin', data: utf8('plain') },
      );
      return {
        state: {
          ...base,
          buildFamily: 'v1-2014',
          buildId: 'compact-1.3.0.8-8hz',
          buildLabel: 'Compact 1.3.0.8 (8 Hz)',
          imageSha256: 'a'.repeat(64),
          expectedVersion: '1.3.0.8',
          stagedForm: 'plain',
          restoreForm: 'capture-verbatim',
          route: 'active-bank',
          detection: {
            cfgHex: 'ff',
            cfg0: 0,
            blank: true,
            bank: 'a',
            bankAddress: 0x14050000,
            bankMode: 7,
            verdict: 'blank -> bank A',
          },
        },
        artifacts,
      };
    case 'patch':
      artifacts.push({ name: 'preserve_patch_plain_patched.bin', data: utf8('patched') });
      return {
        state: {
          ...base,
          patch: {
            sites: [],
            rebalanceWord: 0x30006240,
            stagedLength: 0x4000,
            chunkCount: 256,
            patchedSha256: 'b'.repeat(64),
            diffCount: 10,
          },
        },
        artifacts,
      };
    case 'drain':
      artifacts.push(
        { name: 'preserve_dump_postwrite.bin', data: utf8('raw') },
        { name: 'preserve_dump_original.bin', data: utf8('delivered') },
      );
      return {
        state: { ...base, rawDumpSha256: 'c'.repeat(64), deliveredSha256: 'd'.repeat(64) },
        artifacts,
      };
    case 'commit':
    case 'restore':
    case 'verify':
      return { state: base, artifacts };
  }
}

async function fakeRunStep(
  step: PreserveStepId,
  state: PreserveRunState,
  signal: AbortSignal,
): Promise<PreserveStepOutcome> {
  handed.push([step, state]);
  const outcome = fakeOutcome(step, state);
  if (step === hungStep) {
    return new Promise<PreserveStepOutcome>((resolve, reject) => {
      deferreds.set(step, { resolve });
      signal.addEventListener(
        'abort',
        () => {
          reject(new CancelledError());
        },
        { once: true },
      );
    });
  }
  return outcome;
}

vi.mock('@/lib/preserve/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PreserveClient>();
  return {
    ...actual,
    runPreserveStep: (
      step: PreserveStepId,
      _opener: unknown,
      state: PreserveRunState,
      _load: unknown,
      _reporter: unknown,
      signal: AbortSignal,
    ): Promise<PreserveStepOutcome> => fakeRunStep(step, state, signal),
  };
});

const downloads: { name: string; bytes: number }[] = [];
vi.mock('@/lib/download', () => ({
  downloadBytes: (data: Uint8Array, name: string): void => {
    downloads.push({ name, bytes: data.length });
  },
}));

/* ---- a navigator.usb that only knows events and getDevices --------------- */

type Handler = (event: { device: USBDevice }) => void;

class FakeUsb {
  readonly handlers = new Map<string, Set<Handler>>();
  /** The authorized devices `getDevices()` answers with. */
  authorized: USBDevice[] = [];

  addEventListener(type: string, handler: Handler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)?.add(handler);
  }

  removeEventListener(type: string, handler: Handler): void {
    this.handlers.get(type)?.delete(handler);
  }

  getDevices(): Promise<USBDevice[]> {
    return Promise.resolve([...this.authorized]);
  }

  fire(type: 'connect' | 'disconnect', device: USBDevice): void {
    for (const handler of this.handlers.get(type) ?? []) handler({ device });
  }
}

function fakeCameraUnit(pid: number): USBDevice {
  return { vendorId: 0x289d, productId: pid } as unknown as USBDevice;
}

let usb: FakeUsb;

function installUsb(): void {
  usb = new FakeUsb();
  Object.defineProperty(navigator, 'usb', { value: usb, configurable: true });
}

/* ---- the harness ---------------------------------------------------------- */

interface Mounted {
  readonly result: { current: { panel: PreservePanelApi; runner: Runner; device: DeviceHandle } };
  rerender: () => void;
  unmount: () => void;
}

/** The live hook values — read fresh on every access, never snapshotted. */
function current(mounted: Mounted): {
  panel: PreservePanelApi;
  runner: Runner;
  device: DeviceHandle;
} {
  return mounted.result.current;
}

function mountPanel(authorized: USBDevice[] = []): Mounted {
  usb.authorized = authorized;
  return renderHook(() => {
    const runner = useRunner();
    const device = useDevice();
    const panel = usePreservePanel({ runner, device, form: DEFAULT_OPTIONS_FORM });
    return { runner, device, panel };
  });
}

async function runTo(mounted: Mounted, phase: 'read-build' | 'patch-dump', until: () => boolean) {
  act(() => {
    void current(mounted).panel.runPhase(phase);
  });
  await waitFor(until);
}

function linesOf(panel: PreservePanelApi, phase: PreservePhaseId): string {
  return panel.phaseReporters[phase].lines.map((line) => line.text).join('\n');
}

beforeEach(() => {
  hungStep = null;
  deferreds.clear();
  handed.length = 0;
  downloads.length = 0;
  installUsb();
});

afterEach(() => {
  Object.defineProperty(navigator, 'usb', { value: undefined, configurable: true });
});

describe('the reset is not a swap — the guard and the opener ladder cooperate', () => {
  it('phase ②: the disconnect is the reset; the re-enumerated unit is adopted; the phase completes', async () => {
    const unitA = fakeCameraUnit(0x0010);
    const mounted = mountPanel([unitA]);
    await waitFor(() => current(mounted).device.device !== null);
    expect(current(mounted).device.device).not.toBeNull();

    await runTo(mounted, 'read-build', () => current(mounted).panel.state?.nextStep === 'commit');
    expect(downloads.length).toBe(1); /* phase ① zip */

    hungStep = 'drain';
    act(() => {
      void current(mounted).panel.runPhase('patch-dump');
    });
    await waitFor(() => handed.some(([step]) => step === 'drain'));

    /* THE RESET: the camera leaves the bus mid-drain. */
    usb.authorized = [];
    act(() => {
      usb.fire('disconnect', unitA);
    });
    expect(current(mounted).panel.activePhase).toBe('patch-dump'); /* NOT cancelled */
    expect(current(mounted).device.device).toBeNull();
    await waitFor(() =>
      linesOf(current(mounted).panel, 'patch-dump').includes('the reset was expected'),
    );

    /* THE RE-ENUMERATION: same vid/pid, a new USBDevice object. */
    const unitA2 = fakeCameraUnit(0x0010);
    usb.authorized = [unitA2];
    act(() => {
      usb.fire('connect', unitA2);
    });
    expect(current(mounted).device.device).not.toBeNull(); /* auto-adopted, no user gesture */
    await waitFor(() =>
      linesOf(current(mounted).panel, 'patch-dump').includes('adopting it and continuing'),
    );

    /* The boot silence ends; the drain finishes; the phase completes. */
    act(() => {
      deferreds
        .get('drain')
        ?.resolve(fakeOutcome('drain', handed.at(-1)?.[1] ?? current(mounted).panel.state!));
    });
    await waitFor(() => current(mounted).panel.activePhase === null);
    expect(current(mounted).panel.activePhase).toBeNull();
    expect(current(mounted).panel.state?.nextStep).toBe('restore');
    expect(current(mounted).panel.state?.steps.commit?.status).toBe('done');
    expect(current(mounted).panel.state?.steps.drain?.status).toBe('done');
    expect(downloads.length).toBe(2); /* the phase ② zip */
    mounted.unmount();
  });

  it('phase ② with a second authorized camera: the reconnect cannot be told apart — the run stops', async () => {
    const unitA = fakeCameraUnit(0x0010);
    const mounted = mountPanel([unitA]);
    await waitFor(() => current(mounted).device.device !== null);
    expect(current(mounted).device.device).not.toBeNull();
    await runTo(mounted, 'read-build', () => current(mounted).panel.state?.nextStep === 'commit');

    hungStep = 'drain';
    act(() => {
      void current(mounted).panel.runPhase('patch-dump');
    });
    await waitFor(() => handed.some(([step]) => step === 'drain'));

    usb.authorized = [];
    act(() => {
      usb.fire('disconnect', unitA);
    });
    /* A second authorized unit answers when the camera re-enumerates —
     * which one came back cannot be proven, so the phase stops. */
    const unitA2 = fakeCameraUnit(0x0010);
    const unitB = fakeCameraUnit(0x0010);
    usb.authorized = [unitA2, unitB];
    act(() => {
      usb.fire('connect', unitA2);
    });
    await waitFor(() => current(mounted).panel.activePhase === null);
    expect(current(mounted).panel.activePhase).toBeNull();
    expect(linesOf(current(mounted).panel, 'patch-dump')).toContain('cannot be told apart');
    /* The stop is a cancel, not a failure — and the commit that DID land
     * stays recorded, in memory and in the saved file. */
    expect(current(mounted).panel.state?.steps.commit?.status).toBe('done');
    expect(current(mounted).panel.state?.steps.drain).toBeUndefined();
    expect(downloads.length).toBe(2);
    mounted.unmount();
  });

  it('phase ① resets the camera mid-phase now: a disconnect rides instead of stopping', async () => {
    const unitA = fakeCameraUnit(0x0010);
    const mounted = mountPanel([unitA]);
    await waitFor(() => current(mounted).device.device !== null);
    expect(current(mounted).device.device).not.toBeNull();

    hungStep = 'backup';
    act(() => {
      void current(mounted).panel.runPhase('read-build');
    });
    await waitFor(() => handed.some(([step]) => step === 'backup'));

    /* The backup step reboots the camera by command between windows, so the
     * disconnect is the reset working: the phase does NOT stop — it waits
     * for the re-enumeration. */
    act(() => {
      usb.fire('disconnect', unitA);
    });
    await waitFor(() =>
      linesOf(current(mounted).panel, 'read-build').includes(
        'the camera left the bus — the reset was expected',
      ),
    );
    expect(current(mounted).panel.activePhase).toBe('read-build');

    /* Cancel to end the hung step; a cancel is not recorded. */
    act(() => {
      current(mounted).panel.cancel();
    });
    await waitFor(() => current(mounted).panel.activePhase === null);
    expect(current(mounted).panel.state?.steps.backup).toBeUndefined();
    mounted.unmount();
  });

  it('each core step is handed the state the previous one returned — a swap is caught downstream', async () => {
    const mounted = mountPanel([]);
    await runTo(mounted, 'read-build', () => current(mounted).panel.state?.nextStep === 'commit');
    await runTo(mounted, 'patch-dump', () => current(mounted).panel.state?.nextStep === 'restore');

    expect(handed.map(([step]) => step)).toEqual(['backup', 'patch', 'commit', 'drain']);
    const [, patchedState] = handed.find(([step]) => step === 'commit')!;
    expect(patchedState.steps.backup?.status).toBe('done');
    expect(patchedState.patch).toBeDefined();
    const [, drainState] = handed.find(([step]) => step === 'drain')!;
    expect(drainState.steps.commit?.status).toBe('done');
    /* The commit and drain sessions re-check the version and the bank
     * against exactly this state — core's own gates (its emulator suites
     * prove them); the wizard's job is only to never hand a step a state
     * the previous step did not vouch for. */
    mounted.unmount();
  });
});

describe('useDevice — the reconnect is judged by vid/pid', () => {
  it('adopts a re-enumeration that matches what dropped, and never a different model', () => {
    usb.authorized = [];
    const mounted = renderHook(() => useDevice());
    expect(mounted.result.current.device).toBeNull();

    const unit = fakeCameraUnit(0x0010);
    act(() => {
      usb.fire('connect', unit);
    });
    expect(mounted.result.current.device).toBe(unit);

    act(() => {
      usb.fire('disconnect', unit);
    });
    expect(mounted.result.current.device).toBeNull();

    const sameUnitAgain = fakeCameraUnit(0x0010);
    act(() => {
      usb.fire('connect', sameUnitAgain);
    });
    expect(mounted.result.current.device).toBe(sameUnitAgain);

    act(() => {
      usb.fire('disconnect', sameUnitAgain);
    });
    const otherModel = fakeCameraUnit(0x0011);
    act(() => {
      usb.fire('connect', otherModel);
    });
    expect(mounted.result.current.device).toBeNull(); /* a swap is a user decision */

    mounted.unmount();
  });

  it('adopts an authorized device at page load, as before', async () => {
    const unit = fakeCameraUnit(0x0010);
    usb.authorized = [unit];
    const mounted = renderHook(() => useDevice());
    await waitFor(() => mounted.result.current.device === unit);
    expect(mounted.result.current.device).toBe(unit);
    mounted.unmount();
  });
});
