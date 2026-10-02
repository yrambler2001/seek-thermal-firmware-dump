/* ==================================================================== *
 * The six resumable preservation steps, unit-tested against the fake
 * camera — the gates, the checkpoint state, and the recovery behaviours a
 * resume depends on, all without a device or the emulator.
 *
 * THE FAKE V1 CAMERA. A 4 MiB flash carrying: a blank boot-config record at
 * 0x14010000 (cfg[0]=0 -> bank A, the bootloader's fixed validate order), the
 * factory plaintext AS STORED in bank A (the 2014 banks hold the image, no
 * cipher), and the selector map the pipeline arms — modes 3..9 on the token
 * form, 0x0A..0x21 plain, and mode 2 widened to the whole part (what the
 * PATCHED image serves; the fake serves it always, because the drain tests
 * run against a post-commit part). `readVersion` reports the version the
 * synthetic image's header declares, as every corpus build does.
 *
 * THE RUN SELF-SOURCES. No test hands over a plaintext image: the backup step
 * reads the active slot twice, requires the two reads to agree, derives the
 * factory plaintext from the agreed capture (identity on this plain chain),
 * and records the build it finds. What these tests pin, and why each one
 * earns its place:
 *  - the state document round-trips through JSON (it IS the checkpoint);
 *  - the derivation gates refuse, with their reason: two reads that
 *    disagree, a scrambled slot whose verbatim header window no family can
 *    read, a camera whose version contradicts the slot image's header, and
 *    an already-patched bank (the before-byte gate on the DERIVED image);
 *  - every step-ordering gate refuses, with its reason (a --from-step must
 *    never run against a torn run directory);
 *  - a completed commit moves nextStep to drain, and a re-run of commit
 *    refuses — the commit is not replayed, on the state level either;
 *  - a commit whose bank already holds the patch refuses with "resume at
 *    drain" (the crash-between-transfer-and-checkpoint case);
 *  - an abort mid-step throws CancelledError and leaves the caller's state
 *    untouched — the previous checkpoint stands;
 *  - a restore whose bank already holds the original marks itself done
 *    instead of erasing and reprogramming the same bytes;
 *  - and the whole six-step run lands: delivered == the as-booted part, the
 *    restored flash == the original, verify 0 diffs, nextStep done.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';

import { hexToBytes, sha256hex } from '../../src/bytes.js';
import { silentReporter, type Reporter } from '../../src/events.js';
import { CancelledError, SeekError } from '../../src/errors.js';
import { FLASH_SIZE } from '../../src/profiles/modern-4x.js';
import { SeekDevice } from '../../src/protocol/client.js';
import { OP } from '../../src/protocol/ops.js';
import {
  BOOT_CONFIG_BYTES,
  PRESERVE_BANK_CAPTURE_FILE,
  PRESERVE_BACKUP_FILE,
  PRESERVE_DUMP_ORIGINAL_FILE,
  PRESERVE_DUMP_POSTWRITE_FILE,
  PRESERVE_PATCHED_FILE,
  PRESERVE_PLAIN_NAME,
  PRESERVE_STEP_IDS,
  backupResultFromImage,
  createPreserveRun,
  describeStepGate,
  doubleReadWindows,
  parseBootConfig,
  planWindowAt,
  recordStepFailure,
  rotatedDrainBase,
  runPreserveStep,
  spentReaderSignature,
  unrotateDump,
  type PreserveArtifactLoader,
  type PreserveRunState,
  type PreserveStepId,
  type SessionOpener,
} from '../../src/preservation/index.js';
import {
  REBALANCE_WORD_OFFSET,
  V1_2014_PATCH_SITES,
  buildV1Patch,
  wordSum,
} from '../../src/preservation/patch.js';
import { FakeCamera, type FakeWindowSpec } from '../fake-transport.js';

/* ---- the synthetic factory plaintext (the patch sites included) --------- */

const IMAGE_LENGTH = 0x4000;
const VERSION_WORD = 0x0000_0301; /* little-endian bytes 01 03 00 00 -> "1.3.0.0" */
const EXPECTED_VERSION = '1.3.0.0';
const FLASH_BASE = 0x14000000;
const BANK_A_OFFSET = 0x50000;
const RECOVERY_OFFSET = 0x70000;
const BOOT_CFG_OFFSET = 0x10000;

/**
 * A synthetic 1.3.0.8-FF image: the shapes (window ladder, widen tail, mode-2
 * guard), the FF key blocks, the 0xFFFF word-sum sentinel — everything the
 * build table's detect hooks read, and nothing else for them to find. The
 * same recipe the families suite builds its synthetic builds with.
 */
function ffBankImage(): Uint8Array {
  const bytes = new Uint8Array(IMAGE_LENGTH);
  let s = 0x2468ace1;
  for (let i = 0; i < bytes.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    bytes[i] = s & 0xff;
  }
  const put = (at: number, hex: string): void => {
    bytes.set(hexToBytes(hex), at);
  };
  const LADDER_AT = 0x3000;
  put(LADDER_AT, '00000614000005140000021400000014');
  put(LADDER_AT - 0x4a, '4ff480336360e360'); /* the widen tail */
  put(LADDER_AT - 0x154, '022b06d10420'); /* the mode-2 guard */
  put(0x2800, '5d7984797c47eb9354fa35898ab11701'); /* the FF key block 0 */
  put(0x2810, 'b5541579754be4b33b6f1ba975a8badc'); /* the FF key block 1 */
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0x200, 0xa1b2c3d4, true);
  dv.setUint32(0x204, bytes.length, true);
  dv.setUint32(0x20c, 0x0800_0301, true); /* bytes 01 03 00 08 -> "1.3.0.8" */
  dv.setUint32(REBALANCE_WORD_OFFSET, 0, true);
  const scratch = 0x3ff0;
  dv.setUint32(scratch, 0, true);
  dv.setUint32(scratch, ((0xffff - wordSum(bytes)) | 0) >>> 0, true);
  return bytes;
}

function syntheticPlain(): Uint8Array {
  const bytes = new Uint8Array(IMAGE_LENGTH);
  let state = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  for (const site of V1_2014_PATCH_SITES) bytes.set(site.before, site.offset);
  bytes[REBALANCE_WORD_OFFSET] = 0;
  bytes[REBALANCE_WORD_OFFSET + 1] = 0;
  bytes[REBALANCE_WORD_OFFSET + 2] = 0;
  bytes[REBALANCE_WORD_OFFSET + 3] = 0;
  const dv = new DataView(bytes.buffer);
  /* A header, so the derived image's version can be cross-checked against
   * what the camera reports. */
  dv.setUint32(0x200, 0xa1b2c3d4, true);
  dv.setUint32(0x204, IMAGE_LENGTH, true);
  dv.setUint32(0x20c, VERSION_WORD, true);
  /* Balanced LAST, through a word far from every site and the header. */
  const scratch = 0x3ff0;
  dv.setUint32(scratch, 0, true);
  dv.setUint32(scratch, (0 - wordSum(bytes)) >>> 0, true);
  if (wordSum(bytes) !== 0) throw new Error('fixture is not balanced');
  return bytes;
}

/* ---- the fake v1 camera -------------------------------------------------- */

function v1WindowMap(): FakeWindowSpec[] {
  const windows: FakeWindowSpec[] = [{ subcmd: 2, offset: 0, size: FLASH_SIZE }];
  for (let mode = 3; mode <= 9; mode++) {
    windows.push({ subcmd: mode, offset: (mode - 2) * 0x10000 });
  }
  for (let mode = 0x0a; mode <= 0x21; mode++) {
    windows.push({ subcmd: mode, offset: 0x80000 + (mode - 0x0a) * 0x10000 });
  }
  return windows;
}

interface V1CameraOptions {
  readonly flash?: Uint8Array;
  /** The version word wire 0x4E reports (default: the fixture's 1.3.0.0). */
  readonly version?: readonly number[];
}

/** A stock-shaped v1 camera: blank cfg, factory plaintext in bank A. */
function v1Camera(plain: Uint8Array, options: V1CameraOptions = {}): FakeCamera {
  const flash =
    options.flash ??
    (() => {
      const bytes = new Uint8Array(FLASH_SIZE).fill(0xff);
      new DataView(bytes.buffer).setUint32(BOOT_CFG_OFFSET, 0xffffffff, true); /* blank -> A */
      bytes.set(plain, BANK_A_OFFSET);
      return bytes;
    })();
  return new FakeCamera({
    flash,
    windows: v1WindowMap(),
    authBanks: [3, 4, 5, 6, 7, 8, 9] /* the token form; any 18-byte payload matches */,
    fwInfo: new Map([[0, Uint8Array.from(options.version ?? [1, 3, 0, 0, 0, 0, 0, 0])]]),
  });
}

/** The pipeline's opener over one camera: a new SeekDevice per open, the same
 *  part behind it — exactly what a real re-enumeration hands back. */
function fakeOpener(camera: FakeCamera): SessionOpener {
  return {
    open: async () => {
      await camera.open();
      return new SeekDevice(camera, { reporter: silentReporter });
    },
    close: async () => {
      await camera.close();
    },
  };
}

/** A device whose wire-79 data reads stall — the exhausted reader's measured
 *  afterlife (TESTING.md sec. 28.4: `control IN 0x4f -> stall`, four reads in
 *  a row) — while every other request, the version read included, answers
 *  normally, exactly as the hardware ordered it after a spent drain. */
class StalledWire79Device extends SeekDevice {
  override rpcIn(op: number, length: number, timeoutMs?: number): Promise<Uint8Array> {
    if (op === OP.GET_FEATURED_FIRMWARE_DATA) {
      throw new SeekError('usb/stalled', 'control IN 0x4f -> stall');
    }
    return super.rpcIn(op, length, timeoutMs);
  }
}

/**
 * A device whose wire-79 reads go bad once a given window is armed a THIRD
 * time — the read glitch the double read exists to catch. The arms of the
 * watched window come in a fixed order: the backup sweep's arm (clean), the
 * double read's FIRST arm — the bank window (clean), and the double read's
 * SECOND arm — the plan window, from which every serve carries one flipped
 * byte per chunk. The two captures then disagree, and the step must refuse;
 * a build that collapsed the double read onto one arm would serve both reads
 * clean and this test would not refuse.
 */
class GlitchySecondReadDevice extends SeekDevice {
  private readonly watchSubcmd: number;
  private readonly glitchFromArm: number;
  private armed = 0;
  constructor(camera: FakeCamera, watchSubcmd: number, glitchFromArm = 3) {
    super(camera, { reporter: silentReporter });
    this.watchSubcmd = watchSubcmd;
    this.glitchFromArm = glitchFromArm;
  }
  override async armWindow(...args: Parameters<SeekDevice['armWindow']>): Promise<void> {
    if (args[0].subcmd === this.watchSubcmd) this.armed += 1;
    return super.armWindow(...args);
  }
  override async rpcIn(op: number, length: number, timeoutMs?: number): Promise<Uint8Array> {
    const data = await super.rpcIn(op, length, timeoutMs);
    if (op === OP.GET_FEATURED_FIRMWARE_DATA && this.armed >= this.glitchFromArm) {
      const out = new Uint8Array(data);
      out[0] = (out[0] ?? 0) ^ 0xff;
      return out;
    }
    return data;
  }
}

/** A loader that serves the in-memory artifacts a step emitted — the
 *  one-process stand-in for the run directory. The run self-sources: nothing
 *  is seeded; the backup step's own artifacts (the derived plaintext among
 *  them) are what the later steps load. */
function memoryStore(): {
  load: PreserveArtifactLoader;
  add: (outcome: {
    readonly artifacts: readonly { readonly name: string; readonly data: Uint8Array }[];
  }) => void;
} {
  const map = new Map<string, Uint8Array>();
  return {
    load: (name) => Promise.resolve(map.get(name) ?? null),
    add: (outcome) => {
      for (const artifact of outcome.artifacts) map.set(artifact.name, artifact.data);
    },
  };
}

const never: PreserveArtifactLoader = () => Promise.resolve(null);

/** Runs one step against `camera` and files its artifacts into `store`. */
async function step(
  id: PreserveStepId,
  camera: FakeCamera,
  state: PreserveRunState,
  store: ReturnType<typeof memoryStore>,
): Promise<PreserveRunState> {
  const outcome = await runPreserveStep(id, fakeOpener(camera), state, store.load, silentReporter);
  store.add(outcome);
  return outcome.state;
}

/* ==================================================================== *
 * createPreserveRun — the checkpoint document
 * ==================================================================== */

describe('createPreserveRun — the checkpoint document', () => {
  it(
    'builds the version-2 state — self-sourced, with nothing derived yet',
    { timeout: 120_000 },
    async () => {
      const { state } = await createPreserveRun();
      expect(state.version).toBe(2);
      expect(state.imageSource).toBe('device');
      expect(state.runId).toMatch(/^preserve-\d{4}-\d{2}-\d{2}T/);
      expect(state.nextStep).toBe('backup');
      expect(state.steps).toEqual({});
      /* The build facts do not exist yet: the backup step derives them from
       * the camera. */
      expect(state.buildFamily).toBeUndefined();
      expect(state.imageSha256).toBeUndefined();
      expect(state.expectedVersion).toBeUndefined();
      expect(state.patch).toBeUndefined();
    },
  );

  it(
    'round-trips through JSON and still gates the round-tripped state',
    { timeout: 120_000 },
    async () => {
      const { state } = await createPreserveRun({ now: () => new Date(0) });
      const restored: PreserveRunState = JSON.parse(JSON.stringify(state)) as PreserveRunState;
      expect(restored).toEqual(state);
      /* The gate runs against the restored document — the shape a resume gets. */
      await expect(describeStepGate('backup', restored, never)).resolves.toBeNull();
    },
  );
});

/* ==================================================================== *
 * the derivation — the backup step's own gates
 * ==================================================================== */

describe('runPreserveStep(backup) — the double read and the derived-image gates', () => {
  const plain = syntheticPlain();

  it('refuses when the two reads of the active slot disagree', { timeout: 120_000 }, async () => {
    const camera = v1Camera(plain);
    const store = memoryStore();
    const created = await createPreserveRun({ runId: 'double-read' });
    /* Bank A's window is mode 7: the backup armed it once (clean), the double
     * read's first arm — the bank window — reads clean, and from the second
     * arm — the plan window — every wire-79 serve carries one flipped byte. */
    const corruptedOpener: SessionOpener = {
      open: async () => {
        await camera.open();
        return new GlitchySecondReadDevice(camera, 7);
      },
      close: async () => {
        await camera.close();
      },
    };
    const error: unknown = await runPreserveStep(
      'backup',
      corruptedOpener,
      created.state,
      store.load,
      silentReporter,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeekError);
    expect((error as Error).message).toMatch(/the two reads of the active slot disagree/);
    /* Nothing was recorded: the refusal precedes every artifact. */
    const failed = recordStepFailure(created.state, 'backup', error);
    expect(failed.steps.backup?.status).toBe('failed');
    expect(failed.detection).toBeUndefined();
    expect(failed.slotReadShas).toBeUndefined();
  });

  it(
    'refuses a scrambled slot at the derivation — no guess, no write',
    { timeout: 120_000 },
    async () => {
      /* The bank holds the image XOR 0x5A over EVERY byte, the header window
       * included: no bootloader could read the length from it, so the
       * identity path refuses on the magic and both cipher families refuse
       * at their first gate (a real at-rest capture stores that window in
       * clear — these bytes are not one). The run refuses; nothing is
       * recorded, nothing written. */
      const ciphered = new Uint8Array(plain);
      for (let i = 0; i < ciphered.length; i++) ciphered[i] = (ciphered[i] ?? 0) ^ 0x5a;
      const camera = v1Camera(ciphered);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'cipher' });
      const error: unknown = await step('backup', camera, created.state, store).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SeekError);
      expect((error as Error).message).toMatch(/do not yield the factory plaintext/);
      expect((error as Error).message).toMatch(/v1-2014-ff/);
      expect((error as Error).message).toMatch(/compact-2016/);
      expect((error as Error).message).toMatch(/verbatim window itself is scrambled/);
    },
  );

  it(
    'refuses when the camera reports a version the slot image does not carry',
    { timeout: 120_000 },
    async () => {
      /* The slot image's header says 1.2.0.0; the camera reports 1.3.0.0 —
       * the cross-check refuses before the build table is even consulted. */
      const other = syntheticPlain();
      new DataView(other.buffer).setUint32(0x20c, 0x0000_0201, true); /* -> "1.2.0.0" */
      const scratch = 0x3ff0;
      const dv = new DataView(other.buffer);
      dv.setUint32(scratch, 0, true);
      dv.setUint32(scratch, (0 - wordSum(other)) >>> 0, true);
      const camera = v1Camera(other, { version: [1, 3, 0, 0, 0, 0, 0, 0] });
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'version' });
      const error: unknown = await step('backup', camera, created.state, store).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SeekError);
      expect((error as Error).message).toMatch(
        /the camera reports 1\.3\.0\.0 but the active slot's image says 1\.2\.0\.0/,
      );
    },
  );

  it(
    'refuses an already-patched bank at the before-bytes of the derived image',
    { timeout: 120_000 },
    async () => {
      /* The bank holds the PATCHED image: the derivation solves it (identity
       * — a patched plain chain bank still parses), the version cross-check
       * passes (the patch never touches the version word), and the build
       * table refuses it — an already-patched bank has no factory build. */
      const patched = buildV1Patch(plain).patched;
      const camera = v1Camera(patched);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'already-patched' });
      const error: unknown = await step('backup', camera, created.state, store).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SeekError);
      expect((error as Error).message).toMatch(/do not yield the factory plaintext/);
      expect((error as Error).message).toMatch(/does not carry the v1 2014 update machinery/);
      expect((error as Error).message).toMatch(/failed its build gates/);
    },
  );

  it(
    'records the build, the slot-read shas, and the derived artifact when everything agrees',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'derive' });
      const state = await step('backup', camera, created.state, store);

      expect(state.version).toBe(2);
      expect(state.imageSource).toBe('device');
      expect(state.buildFamily).toBe('v1-2014');
      expect(state.buildId).toBe('v1-2014');
      expect(state.expectedVersion).toBe(EXPECTED_VERSION);
      /* The two reads agreed: both shas recorded, and they are the same. */
      expect(state.slotReadShas).toHaveLength(2);
      expect(state.slotReadShas?.[0]).toBe(state.slotReadShas?.[1]);
      /* The derived plaintext is a first-class artifact, and its sha is the
       * run's image sha. */
      const derived = await store.load(PRESERVE_PLAIN_NAME);
      expect(derived).not.toBeNull();
      expect(await sha256hex(derived!)).toBe(state.imageSha256);
      expect([...derived!]).toEqual([...plain]);
      expect(state.steps.backup?.notes).toMatch(/both reads agree/);
      expect(state.steps.backup?.notes).toMatch(
        /two arms \(bank window mode 7, plan window mode 7\)/,
      );
      expect(state.steps.backup?.notes).toMatch(/identity/);
      /* THE TWO ARMS, on the wire: mode 7 went out THREE times — the sweep's
       * arm, then the double read's bank-window arm and its plan-window arm,
       * with the boot-config read (mode 3) between sweep and double read. */
      expect(camera.arms.slice(-3)).toEqual([3, 7, 7]);
      expect(camera.arms.filter((mode) => mode === 7)).toHaveLength(3);
      /* The capture, as before, is the bank verbatim. */
      const capture = await store.load(PRESERVE_BANK_CAPTURE_FILE);
      expect(capture?.length).toBe(0x10000);
      expect([...(capture?.subarray(0, plain.length) ?? [])]).toEqual([...plain]);
    },
  );

  it(
    're-points the capture at recovery when the derived build commits only there',
    { timeout: 120_000 },
    async () => {
      /* The FF chimera's shape (doc 35.3): a blank cfg names bank A, but the
       * 0xFFFF-sum build in the slots can never BOOT from A — the bootloader
       * rejects it there and runs the recovery bank unchecked. The route is
       * only known once a capture has been derived, so the backup derives the
       * build from the cfg-named bank's capture first, then re-points and
       * captures the bank that actually runs. */
      const ff = ffBankImage();
      const flash = new Uint8Array(FLASH_SIZE).fill(0xff);
      const dv = new DataView(flash.buffer);
      dv.setUint32(BOOT_CFG_OFFSET, 0xffffffff, true); /* blank -> names A */
      flash.set(ff, BANK_A_OFFSET);
      flash.set(ff, RECOVERY_OFFSET); /* the bank that runs */
      const camera = v1Camera(ff, {
        flash,
        version: [1, 3, 0, 8, 0, 0, 0, 0] /* the FF build reports 1.3.0.8 */,
      });
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'repoint' });
      const state = await step('backup', camera, created.state, store);

      expect(state.buildId).toBe('compact-1.3.0.8-ff');
      expect(state.route).toBe('recovery-only');
      /* The detection and the capture act on RECOVERY, not on the A the blank
       * record named. */
      expect(state.detection?.bank).toBe('r');
      expect(state.detection?.bankAddress).toBe(0x14070000);
      const capture = (await store.load(PRESERVE_BANK_CAPTURE_FILE))!;
      expect([...capture.subarray(0, ff.length)]).toEqual([...ff]);
      expect(state.imageSha256).toBe(await sha256hex(ff));
      /* The double-read proof is the RECOVERY capture's, both reads. */
      const window = new Uint8Array(0x10000).fill(0xff);
      window.set(ff, 0);
      expect(state.slotReadShas?.[0]).toBe(await sha256hex(window));
      expect(state.slotReadShas?.[1]).toBe(state.slotReadShas?.[0]);
      expect(state.steps.backup?.notes).toMatch(/re-pointed at the recovery bank/);
    },
  );

  /* ---- the 0.x line: the wire-88 reader and the generation gate ------------ */

  /** A synthetic 0.x factory plaintext: the widen tail (unique), the reader
   *  trio at ONE build's widen-relative layout, no indirect mode-2 body, the
   *  build's header version word, and a balance. The recipe the real images
   *  follow (doc 36.3.2), at synthetic offsets. */
  function zeroXPlain(versionWord: number, layout: readonly number[]): Uint8Array {
    const bytes = new Uint8Array(IMAGE_LENGTH);
    let state = 0x12345678;
    for (let i = 0; i < bytes.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bytes[i] = state & 0xff;
    }
    const put = (at: number, hex: string): void => {
      bytes.set(hexToBytes(hex), at);
    };
    const WIDEN_AT = 0x3d00; /* the mov.w inside the tail */
    put(WIDEN_AT - 2, '63614ff48033a3602361');
    const trioBefore = ['a989', 'a289', 'a381'];
    layout.forEach((delta, i) => {
      put(WIDEN_AT + delta, trioBefore[i] ?? '');
    });
    const dv = new DataView(bytes.buffer);
    dv.setUint32(0x200, 0xa1b2c3d4, true);
    dv.setUint32(0x204, IMAGE_LENGTH, true);
    dv.setUint32(0x20c, versionWord, true);
    dv.setUint32(REBALANCE_WORD_OFFSET, 0, true);
    const scratch = 0x3ff0;
    dv.setUint32(scratch, 0, true);
    dv.setUint32(scratch, (0 - wordSum(bytes)) >>> 0, true);
    return bytes;
  }

  it(
    'a 0.7.0.7 camera reads its windows through wire 88, and the run names the 0.7 build',
    { timeout: 120_000 },
    async () => {
      /* 0.7.0.7: layout C. The camera reports 0.7.0.7; every window read of
       * the backup goes out on 0x58 (GetFeaturedData — the build's reader
       * row), and NO read on 0x4f, which would stall on this generation. */
      const plain = zeroXPlain(0x0700_0700, [-0x1a2, -0x156, -0x14e]);
      const camera = v1Camera(plain, { version: [0, 7, 0, 7, 0, 0, 0, 0] });
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'wire88' });
      const state = await step('backup', camera, created.state, store);

      expect(state.buildId).toBe('compact-0.7.0.7');
      expect(state.buildFamily).toBe('v1-2014');
      expect(state.expectedVersion).toBe('0.7.0.7');
      const ins = camera.calls.filter((c) => c.direction === 'in');
      expect(ins.some((c) => c.op === OP.GET_FEATURED_DATA)).toBe(true);
      expect(
        ins.some((c) => c.op === OP.GET_FEATURED_FIRMWARE_DATA),
        'no window read may go out on wire 79 against a 0.7.x build',
      ).toBe(false);
      /* The reads served: the derived plaintext is the synthetic image. */
      expect(await store.load(PRESERVE_PLAIN_NAME)).not.toBeNull();
      expect(state.imageSha256).toBe(await sha256hex(plain));
    },
  );

  it(
    'a 0.9.x camera keeps the wire-79 reader and names its own build',
    { timeout: 120_000 },
    async () => {
      const plain = zeroXPlain(0x0200_0900, [-0x198, -0x14c, -0x144]);
      const camera = v1Camera(plain, { version: [0, 9, 0, 2, 0, 0, 0, 0] });
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'wire79' });
      const state = await step('backup', camera, created.state, store);

      expect(state.buildId).toBe('compact-0.9.0.2');
      const ins = camera.calls.filter((c) => c.direction === 'in');
      expect(ins.some((c) => c.op === OP.GET_FEATURED_FIRMWARE_DATA)).toBe(true);
      expect(ins.some((c) => c.op === OP.GET_FEATURED_DATA)).toBe(false);
    },
  );

  it(
    'a pre-0.7 camera refuses at the version read, before any window is armed',
    { timeout: 120_000 },
    async () => {
      /* 0.5.0.2 is the STOPPED generation (doc 36.7): the refusal is the
       * doc-cited verdict, and the wire ledger shows the version read and
       * NOTHING else — no Begin, no arm, no read of any window. */
      const camera = v1Camera(syntheticPlain(), { version: [0, 5, 0, 2, 0, 0, 0, 0] });
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'pre07' });
      const error: unknown = await step('backup', camera, created.state, store).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SeekError);
      expect((error as Error).message).toMatch(/predates the widening route/);
      expect((error as Error).message).toMatch(/0x400000/);
      expect((error as Error).message).toMatch(/sec\. 36\.7/);
      expect(
        camera.calls.some((c) => c.op === OP.BEGIN_FIRMWARE_UPGRADE),
        'no window arm may be sent against the stopped generation',
      ).toBe(false);
      expect(camera.calls.filter((c) => c.direction === 'out').length).toBe(0);
    },
  );
});

/* ==================================================================== *
 * the spent-reader refusals and the two-arm double read — the 2026-10-02
 * incident's fixes: the double read draws on two descriptor lifetimes, and a
 * capture that came back from a spent reader names the power-cycle remedy
 * before anything else
 * ==================================================================== */

describe('the spent-reader refusals and the two-arm double read', () => {
  const plain = syntheticPlain();

  it('selects the mode pair per bank: the bank window and the matching plan window', () => {
    /* The pair per bank — two arms covering the same 64 KiB block. The plan's
     * row at a bank address IS the bank's row (modes 7/8/9 are both), so the
     * two mode ids come out equal for every bank; what makes the reads
     * independent is that each is its own arm, each with its own reader
     * descriptor — the firmware re-stages the descriptor at every
     * BeginFirmwareUpgrade. */
    expect(doubleReadWindows('a').map((entry) => [entry.subcmd, entry.address])).toEqual([
      [7, 0x14050000],
      [7, 0x14050000],
    ]);
    expect(doubleReadWindows('b').map((entry) => [entry.subcmd, entry.address])).toEqual([
      [8, 0x14060000],
      [8, 0x14060000],
    ]);
    expect(doubleReadWindows('r').map((entry) => [entry.subcmd, entry.address])).toEqual([
      [9, 0x14070000],
      [9, 0x14070000],
    ]);
    /* Two distinct descriptors: the bank entry is the write-capable window,
     * the plan entry is the sweep's own row. */
    const [bankEntry, planEntry] = doubleReadWindows('a');
    expect(bankEntry.note).toMatch(/write-capable/);
    expect(planEntry.note).toMatch(/protected window/);
    /* A block the plan does not cover refuses rather than guesses. */
    expect(() => planWindowAt(0x14000000)).toThrow(/names no window at 0x14000000/);
  });

  it(
    'an all-blank capture refuses with the power-cycle remedy first',
    { timeout: 120_000 },
    async () => {
      /* The bank holds nothing but 0xFF: the sweep reads it fine, the two
       * arms agree on an all-blank capture, and the derivation refuses with
       * the spent-reader diagnosis — a reader state, not an image — before
       * any cipher talk. */
      const flash = new Uint8Array(FLASH_SIZE).fill(0xff);
      new DataView(flash.buffer).setUint32(BOOT_CFG_OFFSET, 0xffffffff, true);
      const camera = v1Camera(plain, { flash });
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'blank' });
      const error: unknown = await step('backup', camera, created.state, store).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SeekError);
      const message = (error as Error).message;
      expect(message.startsWith('the camera’s window reader is budgeted per boot')).toBe(true);
      expect(message).toMatch(
        /power-cycle the camera \(unplug and replug it, or use its power switch\)/,
      );
      expect(message).toMatch(/preserve --resume/);
      expect(message).toMatch(/every byte of the capture is 0xFF \(an all-blank read\)/);
      /* The generic puzzle text stays out of this shape. */
      expect(message).not.toMatch(/do not yield the factory plaintext/);
    },
  );

  it(
    'a stale-descriptor capture (the bootloader vector) refuses with the remedy, not a cipher puzzle',
    { timeout: 120_000 },
    async () => {
      /* The 2026-10-02 incident's capture shape: a spent reader serves the
       * BOOTLOADER block's first words into the bank read — initial SP
       * 0x10018000, reset 0x14000269 — where a real bank image's own first
       * word is a different SP (0x10008000 on the real 1.3.0.0). */
      const flash = new Uint8Array(FLASH_SIZE).fill(0xff);
      const dv = new DataView(flash.buffer);
      dv.setUint32(BOOT_CFG_OFFSET, 0xffffffff, true);
      dv.setUint32(BANK_A_OFFSET, 0x10018000, true);
      dv.setUint32(BANK_A_OFFSET + 4, 0x14000269, true);
      const camera = v1Camera(plain, { flash });
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'stale' });
      const error: unknown = await step('backup', camera, created.state, store).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SeekError);
      const message = (error as Error).message;
      expect(message.startsWith('the camera’s window reader is budgeted per boot')).toBe(true);
      expect(message).toMatch(/preserve --resume/);
      expect(message).toMatch(/0x10018000/);
      expect(message).toMatch(/stale reader descriptor/);
      expect(message).toMatch(/initial SP/);
      expect(message).not.toMatch(/do not yield the factory plaintext/);
    },
  );

  it('a boot-config read served as the bootloader’s SP refuses with the remedy, not the slot table', () => {
    /* parseBootConfig on the incident's stale bytes: cfg[0]=0x10018000. The
     * refusal leads with the remedy and never presents the word as a
     * boot-config puzzle. */
    const block = new Uint8Array(BOOT_CONFIG_BYTES).fill(0xff);
    new DataView(block.buffer).setUint32(0, 0x10018000, true);
    const error: unknown = (() => {
      try {
        parseBootConfig(block);
        return null;
      } catch (e: unknown) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(SeekError);
    expect(
      (error as Error).message.startsWith('the camera’s window reader is budgeted per boot'),
    ).toBe(true);
    expect((error as Error).message).toMatch(/initial SP/);
    expect((error as Error).message).toMatch(/preserve --resume/);
    expect((error as Error).message).not.toMatch(/names no slot/);
    /* A genuinely unknown selector word keeps the slot-table refusal. */
    const other = new Uint8Array(BOOT_CONFIG_BYTES).fill(0xff);
    new DataView(other.buffer).setUint32(0, 5, true);
    expect(() => parseBootConfig(other)).toThrow(/names no slot/);
  });

  it('a real bank capture is not mistaken for a stale descriptor: the app image’s own SP word differs', () => {
    /* The guard against false refusals: a real 1.3.0.0 bank capture starts
     * with the app's own vector (SP 0x10008000, handlers in SRAM) — the
     * same SRAM-shaped neighbourhood as the bootloader's 0x10018000, and it
     * must NOT carry the spent-reader signature. The real words come off
     * the donor J-Link dump (bank A at 0x14050000). */
    const capture = new Uint8Array(0x10000).fill(0xff);
    const dv = new DataView(capture.buffer);
    dv.setUint32(0, 0x10008000, true);
    dv.setUint32(4, 0x1008066d, true);
    dv.setUint32(0x200, 0xa1b2c3d4, true);
    expect(spentReaderSignature(capture)).toBeNull();
  });
});

describe('describeStepGate — every prerequisite refusal', () => {
  const plain = syntheticPlain();

  const patchSummary = (length: number): NonNullable<PreserveRunState['patch']> => ({
    sites: [],
    rebalanceWord: 1,
    stagedLength: length,
    chunkCount: Math.ceil(length / 64),
    patchedSha256: 'ab',
    diffCount: 10,
  });

  /** A state advanced by actually RUNNING the named steps against a fresh
   *  camera, artifacts filed into the returned store. */
  async function stateThrough(
    steps: readonly PreserveStepId[],
  ): Promise<{ state: PreserveRunState; store: ReturnType<typeof memoryStore> }> {
    const camera = v1Camera(plain);
    const store = memoryStore();
    let state = await createPreserveRun({ runId: 'gates' }).then((r) => r.state);
    for (const id of steps) state = await step(id, camera, state, store);
    return { state, store };
  }

  it(
    'patch refuses before the backup — the run dumps the regions first',
    { timeout: 120_000 },
    async () => {
      const { state } = await createPreserveRun({ runId: 'gates' });
      const refusal = await describeStepGate('patch', state, never);
      expect(refusal).toMatch(/patch runs after the backup/);
      expect(refusal).toMatch(/the only.*copy of this camera/);
    },
  );

  it(
    'commit refuses without the patch record, and without the backup files',
    { timeout: 120_000 },
    async () => {
      const { state: afterBackup, store } = await stateThrough(['backup']);
      expect(await describeStepGate('commit', afterBackup, store.load)).toMatch(
        /commit runs after the patch step/,
      );

      const withPatch: PreserveRunState = {
        ...afterBackup,
        nextStep: 'commit',
        patch: patchSummary(plain.length),
        steps: { ...afterBackup.steps, patch: { status: 'done', notes: 'patch built' } },
      };
      /* Satisfy the type checker the way the runtime already works: the gate
       * reads `patch === undefined`, so absence — not an undefined value. */
      expect(await describeStepGate('commit', withPatch, store.load)).toBeNull();
      /* The same state against an EMPTY run directory: the commit's restore
       * source is gone, so it refuses with the file names. */
      expect(await describeStepGate('commit', withPatch, never)).toMatch(
        /commit requires the backup files .* missing: .*preserve_backup_windows\.bin/,
      );
    },
  );

  it('drain refuses before a completed commit', { timeout: 120_000 }, async () => {
    const { state } = await stateThrough(['backup', 'patch']);
    /* Rewind the commit, as a crash before its checkpoint would leave it. */
    const rewound: PreserveRunState = { ...state };
    delete rewound.steps.commit;
    expect(await describeStepGate('drain', rewound, never)).toMatch(/no completed commit/);
  });

  it(
    'restore refuses before a completed commit, and without the patch summary',
    { timeout: 120_000 },
    async () => {
      const { state: throughPatch } = await stateThrough(['backup', 'patch']);
      expect(await describeStepGate('restore', throughPatch, never)).toMatch(
        /nothing it can be reverting/,
      );

      const { state: throughCommit, store } = await stateThrough(['backup', 'patch', 'commit']);
      const noSummary: PreserveRunState = { ...throughCommit };
      delete noSummary.patch; /* absence, not an undefined value */
      expect(await describeStepGate('restore', noSummary, store.load)).toMatch(/patch summary/);
      expect(await describeStepGate('restore', throughCommit, store.load)).toBeNull();
    },
  );

  it(
    'a cipher-family restore refuses without the derived plaintext artifact',
    { timeout: 120_000 },
    async () => {
      const { state: throughCommit, store } = await stateThrough(['backup', 'patch', 'commit']);
      const cipher: PreserveRunState = {
        ...throughCommit,
        stagedForm: 'xor-ks0',
        buildFamily: 'compact-2016',
      };
      const withoutPlain: PreserveRunState = { ...cipher };
      expect(await describeStepGate('restore', cipher, store.load)).toBeNull();
      /* The artifact's name is in the refusal, with the remedy. */
      expect(await describeStepGate('restore', withoutPlain, never)).toMatch(
        /preserve_image_plain\.bin[\s\S]*run zip/,
      );
    },
  );

  it(
    'verify refuses before a completed restore, and without the backup file',
    { timeout: 120_000 },
    async () => {
      const { state: throughCommit, store } = await stateThrough(['backup', 'patch', 'commit']);
      expect(await describeStepGate('verify', throughCommit, never)).toMatch(
        /no completed restore/,
      );

      const restored: PreserveRunState = {
        ...throughCommit,
        nextStep: 'verify',
        steps: { ...throughCommit.steps, restore: { status: 'done', notes: 'restored' } },
      };
      expect(await describeStepGate('verify', restored, never)).toMatch(
        /verify needs preserve_backup_windows\.bin/,
      );
      expect(await describeStepGate('verify', restored, store.load)).toBeNull();
    },
  );

  it(
    'a done step refuses; so does any step on a run that is done',
    { timeout: 120_000 },
    async () => {
      const { state: afterBackup, store } = await stateThrough(['backup']);
      expect(await describeStepGate('backup', afterBackup, store.load)).toMatch(
        /backup is already done/,
      );
      const jumped: PreserveRunState = { ...afterBackup, nextStep: 'drain' };
      expect(await describeStepGate('backup', jumped, store.load)).toMatch(
        /backup is already done/,
      );

      const done: PreserveRunState = { ...afterBackup, nextStep: 'done' };
      for (const step of PRESERVE_STEP_IDS) {
        expect(await describeStepGate(step, done, store.load)).toMatch(/this run is done/);
      }
    },
  );

  it(
    'allowJump relaxes only the ordering gates past the commit — never the file gates',
    { timeout: 120_000 },
    async () => {
      const { state: throughPatch, store } = await stateThrough(['backup', 'patch']);
      /* Without the override: drain/restore/verify refuse on the missing commit. */
      for (const step of ['drain', 'restore', 'verify'] as const) {
        expect(await describeStepGate(step, throughPatch, never)).toMatch(
          /no completed (commit|restore)/,
        );
      }
      /* With the explicit jump override: the ordering gates open... */
      for (const step of ['drain', 'restore', 'verify'] as const) {
        expect(
          await describeStepGate(step, throughPatch, store.load, { allowJump: true }),
        ).toBeNull();
      }
      /* ...but the FILE gates stay absolute — a jump cannot fabricate a
       * restore source. */
      for (const step of ['drain', 'restore'] as const) {
        const refusal = await describeStepGate(step, throughPatch, never, { allowJump: true });
        expect(refusal).toMatch(/preserve_bank_capture\.bin/);
      }
      expect(await describeStepGate('verify', throughPatch, never, { allowJump: true })).toMatch(
        /verify needs preserve_backup_windows\.bin/,
      );
      /* The commit step's own gates never relax: throughPatch HAS the patch
       * record, so the gate proceeds to the file check — and even under a jump
       * the missing backup files refuse the write. */
      expect(await describeStepGate('commit', throughPatch, never, { allowJump: true })).toMatch(
        /commit requires the backup files .* missing/,
      );
      /* And a completed step still refuses under a jump. */
      const { state: throughCommit, store: store2 } = await stateThrough([
        'backup',
        'patch',
        'commit',
      ]);
      expect(
        await describeStepGate('commit', throughCommit, store2.load, { allowJump: true }),
      ).toMatch(/commit is already done/);
    },
  );

  it(
    'a failed step does not block its own re-run — past the power-cycle ack for backup',
    { timeout: 120_000 },
    async () => {
      const { state } = await createPreserveRun({ runId: 'gates' });
      const failed = recordStepFailure(state, 'backup', new Error('the camera came unplugged'));
      expect(failed.steps.backup?.status).toBe('failed');
      expect(failed.steps.backup?.error).toBe('the camera came unplugged');
      /* The retry gate: a failed backup names the power cycle and the honest
       * limit of the acknowledgement — core cannot observe one. */
      const refusal = await describeStepGate('backup', failed, never);
      expect(refusal).toMatch(/must be POWER-CYCLED/);
      expect(refusal).toMatch(
        /Power-cycle the camera \(unplug and replug it, or use its power switch\)/,
      );
      expect(refusal).toMatch(/Core cannot observe the power cycle/);
      expect(refusal).toMatch(/preserve --resume/);
      expect(refusal).toMatch(/the camera came unplugged/);
      /* The acknowledgement opens it. */
      expect(await describeStepGate('backup', failed, never, { powerCycled: true })).toBeNull();
    },
  );

  it(
    'the power-cycle gate applies only to a failed backup — never to a fresh run or another step',
    { timeout: 120_000 },
    async () => {
      const { state } = await createPreserveRun({ runId: 'gates' });
      /* A fresh run: no backup record, no gate. */
      expect(await describeStepGate('backup', state, never)).toBeNull();
      /* A failure of another step carries no power-cycle record and does not
       * gate the backup shape. */
      const failedPatch = recordStepFailure(state, 'patch', new Error('no plaintext'));
      expect(failedPatch.steps.patch?.powerCycleRequired).toBeUndefined();
      const failedRestore = recordStepFailure(state, 'restore', new Error('stalled'));
      expect(failedRestore.steps.restore?.powerCycleRequired).toBeUndefined();
      /* A failed backup whose record predates the field (an old run directory)
       * does not gate either — the gate reads the recorded field, not the
       * status alone. */
      const legacy: PreserveRunState = {
        ...state,
        steps: { ...state.steps, backup: { status: 'failed', error: 'old failure' } },
      };
      expect(await describeStepGate('backup', legacy, never)).toBeNull();
    },
  );
});

/* ==================================================================== *
 * the steps themselves, against the fake camera
 * ==================================================================== */

describe('runPreserveStep — the recovery behaviours', () => {
  const plain = syntheticPlain();
  /* The ten bytes: the four instruction sites plus the rebalance word at
   * 0x238 (three of its four bytes move on this image). */
  const patchRanges: readonly [number, number][] = [
    ...V1_2014_PATCH_SITES.map((s) => [s.offset, s.offset + s.before.length] as [number, number]),
    [REBALANCE_WORD_OFFSET, REBALANCE_WORD_OFFSET + 4] as [number, number],
  ];
  const inPatch = (i: number): boolean => patchRanges.some(([start, end]) => i >= start && i < end);

  it(
    'backup produces the assembled windows, the capture, and the dump archive',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'steps' });
      const state = await step('backup', camera, created.state, store);

      expect(state.nextStep).toBe('patch');
      expect(state.detection?.bank).toBe('a');
      expect(state.detection?.blank).toBe(true);
      expect(state.steps.backup?.status).toBe('done');
      expect(state.steps.backup?.notes).toMatch(/31 windows/);
      expect(state.steps.backup?.notes).toMatch(/dump archive/);

      /* The checkpoint files, loadable through the store the test keeps. */
      const windows = await store.load(PRESERVE_BACKUP_FILE);
      expect(windows?.length).toBe(FLASH_SIZE);
      const capture = await store.load(PRESERVE_BANK_CAPTURE_FILE);
      expect(capture?.length).toBe(0x10000);
      /* The capture IS the factory plaintext (the 2014 banks hold the image). */
      expect([...(capture?.subarray(0, plain.length) ?? [])]).toEqual([...plain]);
      /* The archive came along: manifest, README, and a source sha that names
       * the assembled backup. */
      const manifestBytes = await store.load('manifest.json');
      expect(manifestBytes).not.toBeNull();
      expect(await store.load('README.md')).not.toBeNull();
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes!)) as {
        source: { sha256: string };
      };
      expect(manifest.source.sha256).toBe(await sha256hex(windows!));
      /* The assembled backup carries the reachable windows and 0xFF past them. */
      expect(windows![BANK_A_OFFSET + 5]).toBe(plain[5]);
      expect(windows![0x200000]).toBe(0xff);
    },
  );

  it(
    'patch records the summary; the staged chunk count comes from the derived image',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'steps' });
      const afterBackup = await step('backup', camera, created.state, store);
      const afterPatch = await step('patch', camera, afterBackup, store);

      expect(afterPatch.nextStep).toBe('commit');
      expect(afterPatch.patch?.stagedLength).toBe(plain.length);
      expect(afterPatch.patch?.diffCount).toBe(10);
      expect(afterPatch.patch?.chunkCount).toBe(Math.ceil(plain.length / 64));
      const patched = await store.load(PRESERVE_PATCHED_FILE);
      expect(patched?.length).toBe(plain.length);
      /* Exactly the ten enumerated bytes differ. */
      let diffs = 0;
      for (let i = 0; i < plain.length; i++) {
        if (plain[i] !== patched?.[i]) {
          expect(inPatch(i)).toBe(true);
          diffs++;
        }
      }
      expect(diffs).toBe(10);
    },
  );

  it(
    'patch refuses when the run directory lost the derived plaintext',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'lost-plain' });
      const afterBackup = await step('backup', camera, created.state, store);
      /* The derived artifact vanishes — the version-1 migration shape, where
       * the plaintext lived outside the run directory. */
      const empty: PreserveArtifactLoader = (name) =>
        name === PRESERVE_PLAIN_NAME ? Promise.resolve(null) : store.load(name);
      const error: unknown = await runPreserveStep(
        'patch',
        fakeOpener(camera),
        afterBackup,
        empty,
        silentReporter,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SeekError);
      expect((error as Error).message).toMatch(/preserve_image_plain\.bin/);
      expect((error as Error).message).toMatch(/version-1 run/);
    },
  );

  it(
    'commit moves nextStep to drain and writes exactly the patch into the bank',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'steps' });
      let state = await step('backup', camera, created.state, store);
      state = await step('patch', camera, state, store);
      state = await step('commit', camera, state, store);

      expect(state.nextStep).toBe('drain');
      expect(state.steps.commit?.status).toBe('done');
      expect(state.steps.commit?.notes).toMatch(/no reset sent in this session/);
      /* The camera's bank now holds the patched plaintext (no cipher). */
      const bank = camera.flash.subarray(BANK_A_OFFSET, BANK_A_OFFSET + plain.length);
      let diffs = 0;
      for (let i = 0; i < plain.length; i++) {
        if (bank[i] !== plain[i]) {
          expect(inPatch(i)).toBe(true);
          diffs++;
        }
      }
      expect(diffs).toBe(10);
    },
  );

  it(
    'commit refuses — with "resume at drain" — when the bank already holds the patch',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'steps' });
      let state = await step('backup', camera, created.state, store);
      state = await step('patch', camera, state, store);
      state = await step('commit', camera, state, store);
      /* The crash case: the checkpoint says commit is pending, but the bank
       * says it landed. Rewind the state and re-offer the commit. */
      const rewound: PreserveRunState = { ...state, nextStep: 'commit' };
      delete rewound.steps.commit;
      await expect(
        runPreserveStep('commit', fakeOpener(camera), rewound, store.load, silentReporter),
      ).rejects.toThrow(/already holds the patched bytes .* Resume at the drain/);
    },
  );

  it(
    'a completed commit refuses a re-run, on the state level too',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'steps' });
      let state = await step('backup', camera, created.state, store);
      state = await step('patch', camera, state, store);
      state = await step('commit', camera, state, store);
      await expect(
        runPreserveStep('commit', fakeOpener(camera), state, store.load, silentReporter),
      ).rejects.toThrow(/commit is already done/);
    },
  );

  it(
    'an abort mid-step throws CancelledError and leaves the state untouched',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'abort' });
      const controller = new AbortController();
      /* Abort out of the reporter, deterministically: the fifth window's
       * progress event fires the signal, and the next loop check throws. */
      const aborting: Reporter = {
        log: () => undefined,
        artifact: () => undefined,
        progress: (done) => {
          if (done >= 5) controller.abort();
        },
      };
      await expect(
        runPreserveStep(
          'backup',
          fakeOpener(camera),
          created.state,
          store.load,
          aborting,
          controller.signal,
        ),
      ).rejects.toBeInstanceOf(CancelledError);
      /* The caller's state was never touched: the previous checkpoint stands. */
      expect(created.state.steps).toEqual({});
      expect(created.state.nextStep).toBe('backup');
      /* And the step re-runs clean on a fresh signal. */
      const state = await step('backup', camera, created.state, store);
      expect(state.steps.backup?.status).toBe('done');
    },
  );

  it(
    'restore marks itself done without writing when the bank already holds the original',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'steps' });
      let state = created.state;
      for (const id of ['backup', 'patch', 'commit', 'drain'] as const) {
        state = await step(id, camera, state, store);
      }
      expect(state.nextStep).toBe('restore');

      /* The crash-after-restore case: the bank already holds the original. */
      const capture = (await store.load(PRESERVE_BANK_CAPTURE_FILE))!;
      camera.flash.set(capture.subarray(0, plain.length), BANK_A_OFFSET);
      const outcome = await step('restore', camera, state, store);
      expect(outcome.steps.restore?.status).toBe('done');
      expect(outcome.steps.restore?.notes).toMatch(/already held the original content/);
    },
  );

  it(
    'a restore whose first read stalls after the drain names the power-cycle remedy',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'stall' });
      let state = created.state;
      for (const id of ['backup', 'patch', 'commit', 'drain'] as const) {
        state = await step(id, camera, state, store);
      }
      /* The hardware shape (TESTING.md secs. 23.3, 28.4): the drain's asks
       * spent the reader's arm budget, the version read still answers, and the
       * boot-config read — the restore's first wire-79 — stalls on every
       * retry. The error must carry the remedy a person at the camera needs. */
      const stallingOpener: SessionOpener = {
        open: async () => {
          await camera.open();
          return new StalledWire79Device(camera, { reporter: silentReporter });
        },
        close: async () => {
          await camera.close();
        },
      };
      const error: unknown = await runPreserveStep(
        'restore',
        stallingOpener,
        state,
        store.load,
        silentReporter,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SeekError);
      expect((error as Error).message).toMatch(/stalled/);
      expect((error as Error).message).toMatch(/power-cycle the camera/i);
      expect((error as Error).message).toMatch(/preserve --resume/);
      /* And the caller can checkpoint it: the step is recorded failed, and the
       * run stays at restore for the re-run after the power cycle. */
      const failed = recordStepFailure(state, 'restore', error);
      expect(failed.steps.restore?.status).toBe('failed');
      expect(failed.nextStep).toBe('restore');
      expect(failed.steps.restore?.error).toMatch(/preserve --resume/);
    },
  );

  it(
    'the whole run lands: delivered == the as-booted part, verify 0 diffs, nextStep done',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const asBooted = new Uint8Array(camera.flash);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'full' });
      let state = created.state;
      for (const id of PRESERVE_STEP_IDS) {
        state = await step(id, camera, state, store);
      }
      expect(state.nextStep).toBe('done');
      expect(state.verify).toEqual({ diffBytes: 0, windowsRead: 31, badWindows: [] });

      /* The delivered dump is the camera's ORIGINAL flash content. */
      const delivered = await store.load(PRESERVE_DUMP_ORIGINAL_FILE);
      expect(await sha256hex(delivered!)).toBe(await sha256hex(asBooted));
      /* The raw post-write dump differs exactly at the bank's patch bytes. */
      const raw = await store.load(PRESERVE_DUMP_POSTWRITE_FILE);
      let rawDiffs = 0;
      for (let i = 0; i < FLASH_SIZE; i++) {
        if (raw![i] !== asBooted[i]) {
          expect(
            i >= BANK_A_OFFSET && i < BANK_A_OFFSET + plain.length && inPatch(i - BANK_A_OFFSET),
          ).toBe(true);
          rawDiffs++;
        }
      }
      expect(rawDiffs).toBe(10);
      /* And the part was restored: the camera's flash is the as-booted image. */
      expect(await sha256hex(camera.flash)).toBe(await sha256hex(asBooted));
    },
  );

  it(
    'verify refuses when the part re-reads different, and the failure records',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'verify-fail' });
      let state = created.state;
      for (const id of ['backup', 'patch', 'commit', 'drain', 'restore'] as const) {
        state = await step(id, camera, state, store);
      }
      /* Corrupt one byte under the backup, then verify. */
      const corruptAt = BANK_A_OFFSET + 123;
      camera.flash[corruptAt] = (camera.flash[corruptAt] ?? 0) ^ 0xff;
      const error = await runPreserveStep(
        'verify',
        fakeOpener(camera),
        state,
        store.load,
        silentReporter,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/differing byte\(s\)/);
      /* The caller checkpoints the failure; the state it keeps is unchanged. */
      const failed = recordStepFailure(state, 'verify', error);
      expect(failed.steps.verify?.status).toBe('failed');
      expect(failed.nextStep).toBe('verify');
      /* The backup file itself still matches its recorded sha. */
      const windows = await store.load(PRESERVE_BACKUP_FILE);
      expect(await sha256hex(windows!)).toBe(
        state.steps.backup?.artifactShas?.[PRESERVE_BACKUP_FILE],
      );
    },
  );

  it(
    'the verify reference rebuilt from the assembled backup matches, window for window',
    { timeout: 120_000 },
    async () => {
      const camera = v1Camera(plain);
      const store = memoryStore();
      const created = await createPreserveRun({ runId: 'assemble' });
      const state = await step('backup', camera, created.state, store);
      const windows = (await store.load(PRESERVE_BACKUP_FILE))!;
      const rebuilt = backupResultFromImage(windows);
      expect(rebuilt.windows.length).toBe(31);
      for (const entry of rebuilt.windows) {
        const at = entry.address - FLASH_BASE;
        expect(windows.subarray(at, at + 0x10000)).toEqual(entry.bytes);
      }
      expect(state.steps.backup?.artifactShas?.[PRESERVE_BACKUP_FILE]).toBe(
        await sha256hex(windows),
      );
    },
  );
});

/* ==================================================================== *
 * the 0.x line's drain plumbing: the mode-2 hazard ordering, the 0.7.0.7
 * rotation base, and the unrotation algebra
 * ==================================================================== */

describe('the mode-2 hazard ordering, in the drain gate', () => {
  /** A state advanced to the post-commit shape the drain gate reads, with a
   *  recorded patch summary that carries or lacks the hazard site. */
  const hazardState = (sites: readonly number[]): PreserveRunState => {
    const base: PreserveRunState = {
      version: 2,
      imageSource: 'device',
      slotReadShas: ['aa', 'aa'],
      runId: 'hazard',
      imageSha256: 'ab',
      expectedVersion: '0.8.0.0',
      createdAt: '2026-10-02T00:00:00Z',
      nextStep: 'drain',
      buildFamily: 'v1-2014',
      buildId: 'compact-0.8.0.0',
      capability: {
        wholePart: true,
        losslessReadUnit: 64,
        modeTwoHazardSites: [0x3ce4],
        note: 'the factory mode 2 arms *(0x14000000) — the nop site must be committed first',
      },
      detection: {
        cfgHex: '00000000',
        cfg0: 0,
        blank: true,
        bank: 'a',
        bankAddress: 0x14050000,
        bankMode: 7,
        verdict: 'blank -> bank A',
      },
      patch: {
        sites: sites.map((offset) => ({
          name: 'site',
          offset,
          before: [0x1b, 0x68],
          after: [0x00, 0xbf],
        })),
        rebalanceWord: 0x30000b5b,
        stagedLength: 0x4000,
        chunkCount: 256,
        patchedSha256: 'ab',
        diffCount: 12,
      },
      steps: {
        backup: { status: 'done', notes: 'backup done' },
        patch: { status: 'done', notes: 'patch done' },
        commit: { status: 'done', notes: 'commit done' },
      },
    };
    return base;
  };

  it('refuses a run whose recorded patch lacks the nop site, before any mode-2 arm', async () => {
    const refusal = await describeStepGate('drain', hazardState([0x3d64]), never);
    expect(refusal).toMatch(/the drain step refuses on compact-0\.8\.0\.0/);
    expect(refusal).toMatch(/faults the camera/);
    expect(refusal).toMatch(/0x00003CE4/);
    expect(refusal).toMatch(/run the patch step/);
    /* The other write steps are not mode-2 arms; they keep their ordinary
     * refusals, not this one. */
    for (const step of ['commit', 'restore'] as const) {
      const other = await describeStepGate(step, hazardState([0x3d64]), never);
      expect(other ?? '').not.toMatch(/faults the camera/);
    }
  });

  it('lets the drain through once the patch summary carries the nop site', async () => {
    const refusal = await describeStepGate('drain', hazardState([0x3d64, 0x3ce4]), never);
    expect(refusal ?? '').not.toMatch(/faults the camera/);
  });
});

describe('the 0.7.0.7 rotation — the base from the detection, and the algebra', () => {
  const detection = (bank: 'a' | 'b' | 'r'): NonNullable<PreserveRunState['detection']> => ({
    cfgHex: '00000000',
    cfg0: 0,
    blank: bank === 'a',
    bank,
    bankAddress: bank === 'a' ? 0x14050000 : bank === 'b' ? 0x14060000 : 0x14070000,
    bankMode: bank === 'a' ? 7 : bank === 'b' ? 8 : 9,
    verdict: 'test',
  });

  it('the walk serves the A/B slot the detection does not name; recovery refuses', () => {
    expect(rotatedDrainBase(detection('a'))).toBe(0x14060000);
    expect(rotatedDrainBase(detection('b'))).toBe(0x14050000);
    expect(() => rotatedDrainBase(detection('r'))).toThrow(/recovery-named record/);
    expect(() => rotatedDrainBase(detection('r'))).toThrow(/doc 36\.10/);
  });

  it('unrotateDump folds the served bytes back to part layout order', { timeout: 120_000 }, () => {
    /* A deterministic 4 MiB part, served from base 0x14060000: served[i] ==
     * part[(0x60000 + i) % SIZE] — the NOR alias decode the doc measured.
     * The whole-part compares run as loops: 4M-element spreads are heavy
     * enough to starve under the full suite's parallel load. */
    const part = new Uint8Array(FLASH_SIZE);
    let s = 0x2b3c4d5e;
    for (let i = 0; i < part.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      part[i] = s & 0xff;
    }
    const base = 0x14060000;
    const served = new Uint8Array(FLASH_SIZE);
    for (let i = 0; i < served.length; i++) {
      served[i] = part[(i + (base - FLASH_BASE)) % FLASH_SIZE] ?? 0;
    }
    const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    };
    const layout = unrotateDump(served, base);
    expect(sameBytes(layout, part), 'unrotated == the part in layout order').toBe(true);
    /* The measured donor case, at the seam: layout byte 0 is served byte
     * 0x60000, and the wrap hands the part's head back at the end. */
    expect(layout[0]).toBe(served[0x60000]);
    expect(layout[FLASH_SIZE - 1]).toBe(served[0x5ffff]);
    /* Identity when the base is the part base. */
    expect(sameBytes(unrotateDump(part, FLASH_BASE), part)).toBe(true);
    /* A non-slot-aligned base refuses. */
    expect(() => unrotateDump(served, FLASH_BASE + 0x123)).toThrow(/slot-aligned/);
  });
});
