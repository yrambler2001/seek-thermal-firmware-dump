/**
 * THE RESET IS NOT A SWAP — the adoption logic, driven end to end through the
 * REAL `useDevice` and the REAL generation guard, against a fake
 * `navigator.usb`:
 *
 *  - during phase ② (which resets the camera), the mid-phase disconnect does
 *    NOT cancel: the opener ladder's boot silence is progress text, the
 *    re-enumerated unit (same vid/pid — this camera has no serial string) is
 *    auto-adopted on its connect event, and the phase continues;
 *  - when Chrome does NOT hand the rebooted unit back (no serial string, so
 *    no grant survives the re-enumeration — what real Chrome does), the REAL
 *    opener ladder tells the user to press "Connect device", and that click
 *    resumes the phase;
 *  - phase ② ends by asking for an unplug and replug (the drain leaves the
 *    reader dead), and completes only once it has seen the camera leave and a
 *    camera come back — cancelling that wait keeps the recorded steps;
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
import { CancelledError, nextStepAfter, type Artifact, type SessionOpener } from '@seek-fw/core';
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
/** Which step opens one session through the wizard's REAL opener ladder, once
 *  the test releases its gate — so the drop can land between the phase's
 *  start and the open, where the reset puts it. */
let openingStep: PreserveStepId | null = null;
const openGates = new Map<PreserveStepId, () => void>();
/** The sites the fake patch step records — empty is a patch without the arm
 *  tail's cursor reset, which owes the replug after the drain. */
let fakePatchSites: { name: string; offset: number; before: number[]; after: number[] }[] = [];

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
            sites: fakePatchSites,
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
  opener: SessionOpener,
  state: PreserveRunState,
  signal: AbortSignal,
): Promise<PreserveStepOutcome> {
  handed.push([step, state]);
  const outcome = fakeOutcome(step, state);
  if (step === openingStep) {
    await new Promise<void>((resolve) => {
      openGates.set(step, resolve);
    });
    const session = await opener.open();
    await opener.close(session);
    return outcome;
  }
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
      opener: SessionOpener,
      state: PreserveRunState,
      _load: unknown,
      _reporter: unknown,
      signal: AbortSignal,
    ): Promise<PreserveStepOutcome> => fakeRunStep(step, opener, state, signal),
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

  /** The chooser: the unit the user picks, which Chrome then authorizes. */
  picked: USBDevice | null = null;

  requestDevice(): Promise<USBDevice> {
    const unit = this.picked;
    if (unit === null)
      return Promise.reject(new DOMException('No device selected.', 'NotFoundError'));
    this.authorized = [...this.authorized, unit];
    return Promise.resolve(unit);
  }

  fire(type: 'connect' | 'disconnect', device: USBDevice): void {
    for (const handler of this.handlers.get(type) ?? []) handler({ device });
  }
}

/** A unit the transport can open and close — enough for the opener ladder;
 *  no transfer is ever sent to it. */
function fakeCameraUnit(pid: number): USBDevice {
  const unit = {
    vendorId: 0x289d,
    productId: pid,
    manufacturerName: 'Seek Thermal',
    productName: 'PIR206 Thermal Camera',
    serialNumber: '',
    opened: false,
    configuration: { configurationValue: 1 },
    open: () => {
      unit.opened = true;
      return Promise.resolve();
    },
    close: () => {
      unit.opened = false;
      return Promise.resolve();
    },
    selectConfiguration: () => Promise.resolve(),
    claimInterface: () => Promise.resolve(),
    releaseInterface: () => Promise.resolve(),
  };
  return unit as unknown as USBDevice;
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
  openingStep = null;
  openGates.clear();
  fakePatchSites = [];
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

    /* The boot silence ends; the drain finishes; the run file is saved and
     * the phase asks for the replug. */
    act(() => {
      deferreds
        .get('drain')
        ?.resolve(fakeOutcome('drain', handed.at(-1)?.[1] ?? current(mounted).panel.state!));
    });
    await waitFor(() =>
      linesOf(current(mounted).panel, 'patch-dump').includes('Now unplug the camera'),
    );
    expect(current(mounted).panel.activePhase).toBe('patch-dump');
    expect(current(mounted).panel.state?.steps.drain?.status).toBe('done');
    expect(downloads.length).toBe(2); /* the phase ② zip, BEFORE the wait */

    /* THE UNPLUG, then the replug and the Connect click. */
    usb.authorized = [];
    act(() => {
      usb.fire('disconnect', unitA2);
    });
    await waitFor(() =>
      linesOf(current(mounted).panel, 'patch-dump').includes('the camera is unplugged'),
    );
    expect(current(mounted).panel.activePhase).toBe('patch-dump');
    const unitA3 = fakeCameraUnit(0x0010);
    usb.picked = unitA3;
    await act(async () => {
      await current(mounted).device.connect();
    });

    await waitFor(() => current(mounted).panel.activePhase === null);
    expect(linesOf(current(mounted).panel, 'patch-dump')).toContain('back on a fresh boot');
    expect(current(mounted).panel.state?.nextStep).toBe('restore');
    expect(current(mounted).panel.state?.steps.commit?.status).toBe('done');
    expect(current(mounted).panel.state?.steps.drain?.status).toBe('done');
    expect(downloads.length).toBe(2); /* saved once, not again after the replug */
    mounted.unmount();
  });

  it('phase ②: Chrome does not hand the rebooted camera back — the ladder asks for the Connect click, and the click resumes the phase', async () => {
    const unitA = fakeCameraUnit(0x0010);
    const mounted = mountPanel([unitA]);
    await waitFor(() => current(mounted).device.device !== null);
    await runTo(mounted, 'read-build', () => current(mounted).panel.state?.nextStep === 'commit');

    openingStep = 'drain';
    act(() => {
      void current(mounted).panel.runPhase('patch-dump');
    });
    await waitFor(() => openGates.has('drain'));

    /* THE RESET, as real Chrome shows it for a camera with no serial string:
     * the unit leaves, and the unit that comes back is a stranger — no
     * connect event reaches the page and getDevices() answers empty. */
    usb.authorized = [];
    act(() => {
      usb.fire('disconnect', unitA);
    });
    await waitFor(() =>
      linesOf(current(mounted).panel, 'patch-dump').includes('the reset was expected'),
    );

    /* The drain opens its session AFTER the drop, through the ladder the
     * phase built while the camera was still on the bus. */
    act(() => {
      openGates.get('drain')?.();
    });
    await waitFor(() =>
      linesOf(current(mounted).panel, 'patch-dump').includes('Press "Connect device"'),
    );
    expect(current(mounted).panel.phaseReporters['patch-dump'].progress.text).toContain(
      'Re-connect the camera',
    );
    expect(current(mounted).panel.activePhase).toBe('patch-dump'); /* still waiting, not failed */

    /* THE CLICK: the user picks the camera in Chrome's chooser. */
    const unitA2 = fakeCameraUnit(0x0010);
    usb.picked = unitA2;
    await act(async () => {
      await current(mounted).device.connect();
    });
    expect(current(mounted).device.device).toBe(unitA2);

    await waitFor(() =>
      linesOf(current(mounted).panel, 'patch-dump').includes('Now unplug the camera'),
    );
    expect(linesOf(current(mounted).panel, 'patch-dump')).toContain('adopting it and continuing');
    expect(current(mounted).panel.state?.steps.drain?.status).toBe('done');
    expect(current(mounted).panel.state?.nextStep).toBe('restore');
    expect(unitA2.opened).toBe(false); /* the ladder's session was closed */

    /* Cancelling the replug wait ends the phase with its steps recorded and
     * the replug still owed — no second save, no failure. */
    act(() => {
      current(mounted).panel.cancel();
    });
    await waitFor(() => current(mounted).panel.activePhase === null);
    expect(linesOf(current(mounted).panel, 'patch-dump')).toContain('the replug wait was stopped');
    expect(current(mounted).panel.phaseReporters['patch-dump'].progress.text).toContain(
      'Unplug and replug the camera before the restore',
    );
    expect(current(mounted).panel.state?.steps.drain?.status).toBe('done');
    expect(downloads.length).toBe(2);
    mounted.unmount();
  }, 15_000); /* the ladder's real 1 s pauses: the ask lands on its third attempt */

  it('phase ②: a patch with the arm tail’s cursor reset owes no replug — the phase ends after the drain', async () => {
    fakePatchSites = [
      { name: 'arm cursor reset', offset: 0x3dc6, before: [0xa5, 0x81], after: [0xe5, 0x60] },
    ];
    const unitA = fakeCameraUnit(0x0010);
    const mounted = mountPanel([unitA]);
    await waitFor(() => current(mounted).device.device !== null);
    await runTo(mounted, 'read-build', () => current(mounted).panel.state?.nextStep === 'commit');
    act(() => {
      void current(mounted).panel.runPhase('patch-dump');
    });
    await waitFor(() => current(mounted).panel.activePhase === null);
    const log = linesOf(current(mounted).panel, 'patch-dump');
    expect(log).toContain('no replug needed');
    expect(log).not.toContain('Now unplug the camera');
    expect(current(mounted).panel.state?.steps.drain?.status).toBe('done');
    expect(current(mounted).panel.phaseReporters['patch-dump'].progress.text).toContain(
      'The run file in your downloads is up to date',
    );
    mounted.unmount();
  });

  it('phase ②: two authorized cameras after the replug — the phase ends, and says which camera to leave', async () => {
    const unitA = fakeCameraUnit(0x0010);
    const mounted = mountPanel([unitA]);
    await waitFor(() => current(mounted).device.device !== null);
    await runTo(mounted, 'read-build', () => current(mounted).panel.state?.nextStep === 'commit');
    act(() => {
      void current(mounted).panel.runPhase('patch-dump');
    });
    await waitFor(() =>
      linesOf(current(mounted).panel, 'patch-dump').includes('Now unplug the camera'),
    );

    usb.authorized = [];
    act(() => {
      usb.fire('disconnect', unitA);
    });
    const unitA2 = fakeCameraUnit(0x0010);
    usb.authorized = [fakeCameraUnit(0x0010)];
    usb.picked = unitA2; /* the chooser adds it: two authorized units */
    await act(async () => {
      await current(mounted).device.connect();
    });

    await waitFor(() => current(mounted).panel.activePhase === null);
    expect(linesOf(current(mounted).panel, 'patch-dump')).toContain('cannot be told apart');
    expect(linesOf(current(mounted).panel, 'patch-dump')).not.toContain('back on a fresh boot');
    expect(current(mounted).panel.state?.steps.drain?.status).toBe('done');
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

    /* Phase ② now waits for the replug; there is no camera here to unplug. */
    act(() => {
      current(mounted).panel.cancel();
    });
    await waitFor(() => current(mounted).panel.activePhase === null);

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
