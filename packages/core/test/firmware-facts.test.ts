/* ==================================================================== *
 * The profile tables, held to what real firmware images actually say.
 *
 * `profiles.test.ts` has forty tests and every one of them is about the TABLE:
 * that it is sorted, duplicate-free, covers a range, has no overlaps, refuses
 * what it says it refuses. All good properties, and not one of them would fail
 * if every address in the map were wrong and every opcode pointed at the wrong
 * command. They are consistency tests, and this file is the correctness one
 * beside them.
 *
 * WHAT IT READS. `test/firmware/facts.json` — facts recovered from the 36
 * decrypted Seek images in the FW-V1 corpus by
 * `scripts/update-firmware-facts.mjs`: each build's own RPC method table (an
 * array of 16-byte records whose first word points at the command's name, wire
 * id = index + 53) and whether it carries the 16-byte token the legacy handler
 * compares against. The IMAGES are not in this repository and never will be;
 * the derived facts are, which is what lets these assertions run on a bare
 * clone with no emulator, no camera and no corpus.
 *
 * WHAT A FAILURE HERE MEANS. Not "a test broke". Either the toolkit sends an
 * opcode this firmware has at a different id — which on a real camera means
 * sending it a different command — or a claim in a profile's comments has
 * drifted from the bytes it cites. Both are worth stopping for.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';

import { OP, OP_DIRECTION, READ_ONLY_OPS } from '../src/protocol/ops.js';
import {
  LEGACY_KNOWN_VERSIONS,
  OLD_FW_UNLOCK_TOKEN,
  legacySelectorRows,
  legacyWindowPlan,
} from '../src/profiles/legacy-auth.js';
import { buildModernWindowMap, modernWindowPlan } from '../src/profiles/modern-4x.js';
import { detectProfile, getProfile } from '../src/profiles/registry.js';
import type { SelectorRow } from '../src/profiles/types.js';
import { parseVersion } from '../src/profiles/version.js';
import { predatesDumpProtocol } from '../src/workflows/capability.js';
import facts from './firmware/facts.json' with { type: 'json' };

interface OpcodeFact {
  readonly toolkitCalls: string;
  readonly firmwareCalls: string | null;
  /** The handler a control IN reaches, or null for an empty column. */
  readonly getter: string | null;
  /** The handler a control OUT reaches, or null for an empty column. */
  readonly setter: string | null;
}

interface MethodColumns {
  readonly name: string;
  readonly getter: string | null;
  readonly setter: string | null;
  readonly flags: number;
}

interface WindowRowFact {
  readonly mode: number;
  readonly kind: 'literal' | 'computed';
  readonly address?: string;
  readonly loads?: readonly string[];
}

interface WindowTableFact {
  readonly handler: string;
  readonly located: string;
  readonly modes: number;
  readonly modeTwoRefusedOutright: boolean | null;
  readonly plainChannelLockedModes: readonly number[] | null;
  readonly rows: readonly WindowRowFact[];
}

interface ImageFact {
  readonly family: string;
  readonly product: string;
  readonly version: string;
  readonly length: number;
  readonly sha256: string;
  readonly rpcMethods: readonly string[] | null;
  readonly rpcHandlers: readonly MethodColumns[] | null;
  readonly rpcTableAt: string | null;
  readonly rpcNameBase: string | null;
  readonly opcodes: Readonly<Record<string, OpcodeFact>>;
  readonly windowTable: WindowTableFact | null;
  readonly unlockTokenAt: string | null;
}

const IMAGES = Object.entries(facts.images as Record<string, ImageFact>);

/** `0x4F` for a number, the way the facts file spells its keys. */
const wire = (op: number): string => `0x${op.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * The builds whose RPC table does NOT have the toolkit's read command at all.
 *
 * Named here rather than computed, so that a regeneration which changed the set
 * has to change this list too.
 */
const NO_READ_COMMAND_VERSIONS: readonly string[] = [
  '0.3.0.1',
  '0.5.0.2',
  '0.5.1.0',
  '0.5.1.3',
  '0.6.0.4',
];

/**
 * The builds that have the read command's NAME at 0x4F and no GETTER for it.
 *
 * The names-only facts could not see these two, and the toolkit called them
 * readable until 2026-09-23. With the five above they are the seven builds the
 * `compact-2014` profile refuses.
 */
const SETTER_ONLY_READ_VERSIONS: readonly string[] = ['0.7.0.7', '0.7.0.8'];

describe('firmware facts — the corpus is present and plausible', () => {
  it('covers every decrypted image and recovered every RPC table', () => {
    expect(IMAGES.length).toBe(36);
    const missing = IMAGES.filter(([, f]) => f.rpcMethods === null).map(([id]) => id);
    expect(missing, 'images whose RPC method table could not be recovered').toEqual([]);
  });

  it('recovered a table that starts at GetErrorCode on every image', () => {
    for (const [id, f] of IMAGES) {
      expect(f.rpcMethods?.[0], `${id}: wire id 53`).toBe('GetErrorCode');
    }
  });

  it('recovered between 33 and 41 methods per build', () => {
    /* 33 is 0.3.0.1, the smallest table in the corpus; 41 is the Compact PRO FF,
     * which FW-V1's byte-exact reconstruction independently declares as
     * `RPC_METHOD_COUNT` 41 with wire ids 53..93. Anything outside that band
     * means the recovery locked onto something that is not a method table. */
    for (const [id, f] of IMAGES) {
      expect(f.rpcMethods?.length ?? 0, id).toBeGreaterThanOrEqual(33);
      expect(f.rpcMethods?.length ?? 0, id).toBeLessThanOrEqual(41);
    }
  });

  it("ends every table where its records end: each row's fourth word is a u8 flags byte", () => {
    /* `rpc_method_t` is {name, get, set, u8 flags, u8 reserved[3]} (FW-V1
     * fw_types.h). A row whose fourth word has bits above the byte is not a
     * record: until 2026-09-28 the recovery ran one row past the end of
     * Compact 4.8.1.7 and 4.16.1.7 onto the next table of function pointers,
     * "HpGi6" / "HpGm6" with flags 0x10004905 (FW-V1 Phase 46, TESTING.md 21.4). */
    for (const [id, f] of IMAGES) {
      for (const [index, row] of (f.rpcHandlers ?? []).entries()) {
        expect(row.flags >>> 8, `${id}: wire id ${String(53 + index)} (${row.name})`).toBe(0);
      }
    }
  });

  it('gives 4.8.1.7 and 4.16.1.7 the 38 rows their dispatchers accept (ids 53..90)', () => {
    /* Read off the images: `SUB.W Rd, Rn, #0x35` then `CMP Rd, #0x25` in each
     * dispatcher (4.8.1.7 at 0x37B2 / 0x5D10 / 0x5E16). */
    const builds = IMAGES.filter(([, f]) => ['4.8.1.7', '4.16.1.7'].includes(f.version));
    expect(builds).toHaveLength(4);
    for (const [id, f] of builds) {
      expect(f.rpcMethods?.length, id).toBe(38);
      expect(f.rpcMethods?.at(-1), id).toBe('SetRamDataFeatures');
    }
  });
});

describe('the opcodes this toolkit sends are the commands the firmware has', () => {
  /**
   * The five opcodes a DUMP can reach. `ops.ts` asserts this set is disjoint
   * from the write set at module load; here it is checked against the firmware
   * that would receive them.
   */
  const DUMP_PATH_OPS: readonly number[] = [
    OP.GET_ERROR_CODE,
    OP.SET_OPERATION_MODE,
    OP.GET_OPERATION_MODE,
    OP.GET_FEATURED_FIRMWARE_DATA,
    OP.BEGIN_FIRMWARE_UPGRADE,
  ];

  it('agrees on GetErrorCode, SetOperationMode and GetOperationMode in all 36', () => {
    /* These three never moved. Every build from 0.3.0.1 (May 2014) to 4.16.1.7
     * (Sep 2018) puts them at 0x35, 0x3C and 0x3D, which is why the liveness
     * check in the emulator probe and the mode handshake in `SeekDevice` are
     * safe to send before anything is known about a camera. */
    for (const op of [OP.GET_ERROR_CODE, OP.SET_OPERATION_MODE, OP.GET_OPERATION_MODE]) {
      for (const [id, f] of IMAGES) {
        const fact = f.opcodes[wire(op)];
        expect(fact?.firmwareCalls, `${id}: wire ${wire(op)}`).toBe(fact?.toolkitCalls);
      }
    }
  });

  it('agrees on every dump-path opcode NAME in the 31 builds from 0.7.0.7 on', () => {
    /* Names only — which is exactly why this test passed 0.7.0.7 and 0.7.0.8.
     * The column test below is the one that decides whether a dump can run. */
    for (const [id, f] of IMAGES) {
      if (NO_READ_COMMAND_VERSIONS.includes(f.version)) continue;
      for (const op of DUMP_PATH_OPS) {
        const fact = f.opcodes[wire(op)];
        expect(fact?.firmwareCalls, `${id}: wire ${wire(op)}`).toBe(fact?.toolkitCalls);
      }
    }
  });

  it('finds exactly five builds with no GetFeaturedFirmwareData at 0x4F', () => {
    const without = IMAGES.filter(
      ([, f]) =>
        f.opcodes[wire(OP.GET_FEATURED_FIRMWARE_DATA)]?.firmwareCalls !== 'GetFeaturedFirmwareData',
    ).map(([, f]) => f.version);
    expect([...new Set(without)].sort()).toEqual([...NO_READ_COMMAND_VERSIONS].sort());
  });

  it('finds the one build where 0x52 is EnterBootloaderMode, not BeginFirmwareUpgrade', () => {
    /* THE SAFETY FINDING. A dump arms 63 windows with wire id 0x52 and a sweep
     * probes 66 selectors with it. On this build that is a request to leave the
     * application, with the subcommand as its argument. */
    const rogue = IMAGES.filter(
      ([, f]) =>
        f.opcodes[wire(OP.BEGIN_FIRMWARE_UPGRADE)]?.firmwareCalls === 'EnterBootloaderMode',
    );
    expect(rogue.map(([, f]) => f.version)).toEqual(['0.3.0.1']);
  });

  it('refuses to dump every build whose read has no getter', () => {
    /* The point of `compact-2014`, stated as a property rather than a list:
     * whichever builds cannot dispatch the read — no such command, or the
     * command in the setter column only — the profile that claims them must
     * refuse to dump, and it must be reachable from the version alone, because
     * the version is all a camera gives you before you send it anything. */
    const compact2014 = getProfile('compact-2014');
    expect(compact2014.capabilities.dump.supported).toBe(false);
    expect(compact2014.capabilities.sweep.supported).toBe(false);
    for (const [id, f] of IMAGES) {
      const read = f.opcodes[wire(OP.GET_FEATURED_FIRMWARE_DATA)];
      const noGetter = read?.firmwareCalls !== 'GetFeaturedFirmwareData' || read.getter === null;
      expect(predatesDumpProtocol(f.version), `${id} (${f.version})`).toBe(noGetter);
      const verdict = compact2014.detect({ firmwareVersion: f.version });
      expect(verdict.score > 0, `${id}: compact-2014 claims it`).toBe(noGetter);
      for (const legacy of ['legacy-auth', 'compact-2016'] as const) {
        if (!noGetter) continue;
        const score = getProfile(legacy).detect({ firmwareVersion: f.version }).score;
        expect(score, `${id}: ${legacy} must not claim a build it cannot read`).toBe(0);
      }
    }
  });

  it('finds exactly two builds with the read command in the setter column only', () => {
    const setterOnly = IMAGES.filter(([, f]) => {
      const read = f.opcodes[wire(OP.GET_FEATURED_FIRMWARE_DATA)];
      return read?.firmwareCalls === 'GetFeaturedFirmwareData' && read.getter === null;
    }).map(([, f]) => f.version);
    expect([...new Set(setterOnly)].sort()).toEqual([...SETTER_ONLY_READ_VERSIONS].sort());
    for (const [id, f] of IMAGES.filter(([, f]) => SETTER_ONLY_READ_VERSIONS.includes(f.version))) {
      expect(f.opcodes[wire(OP.GET_FEATURED_FIRMWARE_DATA)]?.setter, id).not.toBeNull();
    }
  });
});

describe('the dump uses only commands each firmware registers in the column it sends to', () => {
  /**
   * THE TEST THAT WOULD HAVE CAUGHT 0.7.0.x FROM THE IMAGES ALONE.
   *
   * A control IN reaches a record's getter and a control OUT its setter; an
   * empty column is a stall. So for every build this toolkit would dump — the
   * version gate passes and the profile the version selects allows `dump` —
   * every opcode a dump can send (`READ_ONLY_OPS`) must have its handler in the
   * column `OP_DIRECTION` says the toolkit sends it to. And for every build the
   * toolkit refuses, at least one of them must not, so the refusal is earned.
   */
  function wouldDump(version: string): boolean {
    if (predatesDumpProtocol(version)) return false;
    return detectProfile({ firmwareVersion: version }).best.profile.capabilities.dump.supported;
  }

  function missingColumns(f: ImageFact): string[] {
    const missing: string[] = [];
    for (const op of READ_ONLY_OPS) {
      const fact = f.opcodes[wire(op)];
      const column = OP_DIRECTION[op] === 'in' ? 'getter' : 'setter';
      if (fact?.firmwareCalls !== fact?.toolkitCalls || fact?.[column] === null) {
        missing.push(`${wire(op)} ${String(fact?.firmwareCalls)} has no ${column}`);
      }
    }
    return missing;
  }

  it('records both handler columns for every command of every image', () => {
    for (const [id, f] of IMAGES) {
      expect(
        f.rpcHandlers?.map((r) => r.name),
        id,
      ).toEqual(f.rpcMethods);
      for (const row of f.rpcHandlers ?? []) {
        for (const column of [row.getter, row.setter]) {
          if (column !== null) expect(column, `${id} ${row.name}`).toMatch(/^0x[0-9A-F]{8}$/);
        }
      }
    }
  });

  it('has every dump opcode in the right column on every build it would dump', () => {
    let dumpable = 0;
    for (const [id, f] of IMAGES) {
      if (!wouldDump(f.version)) continue;
      dumpable++;
      expect(missingColumns(f), `${id} (${f.version})`).toEqual([]);
    }
    expect(dumpable).toBe(29);
  });

  it('refuses every build on which some dump opcode has no handler in its column', () => {
    for (const [id, f] of IMAGES) {
      if (wouldDump(f.version)) continue;
      expect(missingColumns(f).length, `${id} (${f.version})`).toBeGreaterThan(0);
    }
  });

  it('sends every opcode in the direction the client really uses', () => {
    /* `OP_DIRECTION` is only as good as its agreement with the client; the
     * workflows suite checks a whole dump's traffic against it. Here: the one
     * opcode whose column decided 0.7.0.x is a read. */
    expect(OP_DIRECTION[OP.GET_FEATURED_FIRMWARE_DATA]).toBe('in');
    expect(OP_DIRECTION[OP.BEGIN_FIRMWARE_UPGRADE]).toBe('out');
    for (const op of READ_ONLY_OPS) expect(['in', 'out']).toContain(OP_DIRECTION[op]);
  });
});

describe("the selector tables, against each image's own BeginFirmwareUpgrade switch", () => {
  /** The facts' row, as the profile's `SelectorRow` would state it. */
  function asTableRow(row: WindowRowFact): number | null {
    return row.kind === 'literal' && row.address !== undefined ? Number(row.address) : null;
  }

  /** What every image reporting `version` agrees a mode arms; null if they differ. */
  function agreedAddress(images: readonly ImageFact[], mode: number): number | null {
    const values = images.map((f) => {
      const row = f.windowTable?.rows.find((r) => r.mode === mode);
      return row === undefined ? undefined : asTableRow(row);
    });
    const first = values[0];
    return first !== undefined && values.every((v) => v === first) ? first : null;
  }

  const legacyLine = IMAGES.filter(([, f]) => {
    const v = parseVersion(f.version);
    return v !== null && v.major <= 1 && !predatesDumpProtocol(f.version);
  });

  it('decodes a 34-mode switch from every image but 0.3.0.1', () => {
    for (const [id, f] of IMAGES) {
      if (f.version === '0.3.0.1') {
        /* -O0, no TBB, and wire 0x52 is EnterBootloaderMode. */
        expect(f.windowTable, id).toBeNull();
        continue;
      }
      expect(f.windowTable?.modes, id).toBe(0x22);
      expect(
        f.windowTable?.rows.map((r) => r.mode),
        id,
      ).toEqual([...Array(0x22).keys()]);
    }
  });

  it('has a decoded table for every dumpable build of the legacy line in the corpus', () => {
    /* A new 0.x / 1.x image in the corpus must come with its table here, or a
     * dump of it would fall back to the rows every known build agrees on. */
    const versions = [...new Set(legacyLine.map(([, f]) => f.version))].sort();
    expect(versions).toEqual([...LEGACY_KNOWN_VERSIONS].sort());
  });

  it('gives every legacy build exactly the rows its own image decodes to', () => {
    for (const version of LEGACY_KNOWN_VERSIONS) {
      const images = legacyLine.filter(([, f]) => f.version === version).map(([, f]) => f);
      const rows = legacySelectorRows(version) ?? [];
      expect(
        rows.map((r) => r.subcmd),
        version,
      ).toEqual([...Array(0x22).keys()]);
      for (const row of rows) {
        const expected = agreedAddress(images, row.subcmd);
        /* A refused row keeps the literal its case carries (1.0.3.x's 0x14000000):
         * the address is the image's, and the refusal is the gate's. */
        expect(row.address, `${version} mode ${String(row.subcmd)}`).toBe(expected);
      }
    }
  });

  it('refuses mode 2 exactly where the image refuses it before the channel test', () => {
    for (const version of LEGACY_KNOWN_VERSIONS) {
      const images = legacyLine.filter(([, f]) => f.version === version).map(([, f]) => f);
      const refused = images.map((f) => f.windowTable?.modeTwoRefusedOutright);
      const row: SelectorRow | undefined = legacySelectorRows(version)?.find((r) => r.subcmd === 2);
      /* Readable on the token channel only when EVERY image of that version
       * lets mode 2 through; 1.3.0.8's two images disagree, so it is refused. */
      expect(row?.channel, version).toBe(refused.every((r) => r === false) ? 'auth' : 'refused');
    }
  });

  it('puts the token channel on exactly the modes the image locks on the plain one', () => {
    for (const version of LEGACY_KNOWN_VERSIONS) {
      const images = legacyLine.filter(([, f]) => f.version === version).map(([, f]) => f);
      for (const f of images)
        expect(f.windowTable?.plainChannelLockedModes, version).toEqual([2, 9]);
      for (const row of legacySelectorRows(version) ?? []) {
        const locked = row.subcmd >= 2 && row.subcmd <= 9;
        expect(row.channel === 'plain', `${version} mode ${String(row.subcmd)}`).toBe(!locked);
      }
    }
  });

  it('finds 0x140B0000 twice in every 2014 table, and the dump never claims 0x140C0000 there', () => {
    for (const [id, f] of legacyLine) {
      const fourteen = f.windowTable?.rows.find((r) => r.mode === 0x0e);
      const thirteen = f.windowTable?.rows.find((r) => r.mode === 0x0d);
      const plan = legacyWindowPlan(f.version);
      if (fourteen?.address === '0x140B0000') {
        expect(thirteen?.address, id).toBe('0x140B0000');
        expect(
          plan.windows.some((w) => w.address === 0x140c0000),
          id,
        ).toBe(false);
      } else {
        expect(fourteen?.address, id).toBe('0x140C0000');
        expect(plan.windows.find((w) => w.address === 0x140c0000)?.subcmd, id).toBe(0x0e);
      }
    }
  });

  it('agrees with every post-2018 image wherever that image carries a constant', () => {
    /* The modern table is one for the family. Where a build computes a mode
     * (case 0 everywhere; 7/8/9 as slot + g_flash_base_offset on some) the
     * image states no constant to compare, and the emulator measures it
     * instead; wherever the image does carry one, the map must name it. */
    const map = new Map(buildModernWindowMap().map((e) => [e.subcmd, e.address]));
    for (const [id, f] of IMAGES) {
      const v = parseVersion(f.version);
      if (v === null || v.major <= 1) continue;
      expect(f.windowTable, id).not.toBeNull();
      for (const row of f.windowTable?.rows ?? []) {
        const claimed = map.get(row.mode);
        if (row.kind !== 'literal' || claimed === undefined) continue;
        expect(claimed, `${id} mode ${String(row.mode)}`).toBe(Number(row.address));
      }
    }
  });

  it('has a mode 0 on every post-2018 image, computed, as the upgrade-target row says', () => {
    /* The device read and the write arm the upgrade-target selector only when
     * the running build's table carries it, so the modern table carries a row
     * for mode 0 with no address. Every post-2018 image switches on mode 0 and
     * computes its block (`fw_update_slot_address()`); none carries a constant. */
    const row = modernWindowPlan('4.18.2.0').selectors.find((r) => r.subcmd === 0);
    expect(row?.address).toBeNull();
    let images = 0;
    for (const [id, f] of IMAGES) {
      const v = parseVersion(f.version);
      if (v === null || v.major <= 1) continue;
      images++;
      const mode0 = f.windowTable?.rows.find((r) => r.mode === 0);
      expect(mode0?.kind, id).toBe('computed');
    }
    /* the 14 post-2018 images of the corpus (sec.12.2 counts the same 14) */
    expect(images).toBe(14);
  });
});

describe('the legacy unlock token', () => {
  const tokenHex = Buffer.from(OLD_FW_UNLOCK_TOKEN).toString('hex');

  it('is the token the facts file searched for', () => {
    expect(facts.unlockToken).toBe(tokenHex);
  });

  it('is ONE token across 22 builds, not one per build', () => {
    /* `legacy-auth` used to call it build-specific. It occurs, byte for byte
     * and exactly once, in every 0.x and 1.x image in the corpus. */
    const withToken = IMAGES.filter(([, f]) => f.unlockTokenAt !== null);
    expect(withToken.length).toBe(22);
    for (const [id, f] of withToken) {
      const version = parseVersion(f.version);
      expect(version?.major, `${id} carries the token`).toBeLessThanOrEqual(1);
    }
  });

  it('is absent from every build that has no token check', () => {
    /* The post-2018 handler's only length test is `(req_len & 0xFFFFFFEF) != 2`
     * — it accepts the 18-byte form and compares nothing — so there is no
     * constant for it to hold, and there is none. */
    const without = IMAGES.filter(([, f]) => f.unlockTokenAt === null);
    expect(without.length).toBe(14);
    for (const [id, f] of without) {
      const version = parseVersion(f.version);
      expect(version?.major, `${id} has no token`).toBeGreaterThan(1);
    }
  });

  it('sits where FW-V1 says it does in the 2016 Compact PRO 1.0.3.0 9 Hz build', () => {
    /* Two independent derivations of the same 16 bytes. FW-V1 decoded the
     * handler and recorded "a 16-byte match at a1+2 against 0x100012A1 ... it
     * occurs exactly once in the whole image (raw 0xAC01)"; this file found the
     * token by searching for the value the profile carries. They agree. */
    const entry = IMAGES.find(
      ([id, f]) => f.version === '1.0.3.0' && id.includes('1.0.3.0-9hz') && f.length === 51848,
    );
    expect(entry, 'the 1.0.3.0 9 Hz image-only entry').toBeDefined();
    expect(entry?.[1].unlockTokenAt).toBe('0xAC01');
  });
});

describe('the profile tables, against the builds they claim', () => {
  it('claims every post-2018 build with modern-4x, on version alone', () => {
    /* The bug this closes: `detectModern` tested `major === 4`, so a Mosaic
     * (10.x, 2.27.x), a Nano 200 (42.x) and a Nano 300 (44.x) scored zero and
     * fell through to `generic` — which refuses to flash a camera whose whole
     * selector map it had just read correctly. */
    const modern = getProfile('modern-4x');
    for (const [id, f] of IMAGES) {
      const version = parseVersion(f.version);
      if (version === null || version.major <= 1) continue;
      const verdict = modern.detect({ firmwareVersion: f.version });
      expect(verdict.score, `${id} (${f.version})`).toBeGreaterThan(0.5);
    }
  });

  it('never claims a 0.x or 1.x build with modern-4x', () => {
    const modern = getProfile('modern-4x');
    for (const [id, f] of IMAGES) {
      const version = parseVersion(f.version);
      if (version === null || version.major > 1) continue;
      expect(modern.detect({ firmwareVersion: f.version }).score, `${id} (${f.version})`).toBe(0);
    }
  });

  it('gives compact-2016 and legacy-auth the same selector map', () => {
    /* They are one protocol with two ciphers: the 2016 Compact PRO's
     * `cmd_BeginFirmwareUpgrade` and the 1.3.0.8 Compact's were decoded
     * separately and FW-V1 records that their window tables are identical
     * "byte for byte, only the surrounding validation differs". */
    const a = getProfile('compact-2016').windowMap();
    const b = getProfile('legacy-auth').windowMap();
    expect(a.map((e) => [e.subcmd, e.address, e.auth === true])).toEqual(
      b.map((e) => [e.subcmd, e.address, e.auth === true]),
    );
    expect(getProfile('compact-2016').cipher.acceptanceSum).toBe(0x00000000);
    expect(getProfile('legacy-auth').cipher.acceptanceSum).toBe(0x0000ffff);
  });

  it('locks exactly the banks the legacy handler locks, and no others', () => {
    /* `if (req_len == 2 && (unsigned)(mode - 2) <= 7) return BAD_KEY` — so the
     * protected set is modes 2..9, on every build (the switch test above holds
     * each table to its image). Every window a plan reads through one of those
     * modes carries the token, and no other window does. */
    for (const version of [...LEGACY_KNOWN_VERSIONS, null]) {
      for (const entry of legacyWindowPlan(version).windows) {
        const locked = entry.subcmd >= 2 && entry.subcmd <= 9;
        expect(entry.auth === true, `${String(version)} subcmd ${String(entry.subcmd)}`).toBe(
          locked,
        );
      }
    }
  });

  it('puts 0x14060000 out of reach on the modern line and in reach on the legacy one', () => {
    /* The two generations disagree about one 64 KiB block, and the disagreement
     * is in the firmware: no modern switch arm assigns 0x14060000, while the
     * legacy `case 8` does. Getting this backwards costs a real 64 KiB. */
    const modern = getProfile('modern-4x');
    expect(modern.windowMap().some((e) => e.address === 0x14060000)).toBe(false);
    expect(modern.memory.unreachable.map((u) => u.address)).toContain(0x14060000);

    const legacy = getProfile('legacy-auth');
    const bank = legacy.windowMap().find((e) => e.address === 0x14060000);
    expect(bank?.subcmd).toBe(8);
    expect(bank?.auth).toBe(true);
    expect(legacy.memory.unreachable.map((u) => u.address)).not.toContain(0x14060000);
  });

  it('declares, per build, the blocks that build cannot arm', () => {
    /* `mode > 0x21` is refused on every build, so everything from 0x14200000 up
     * is a gap everywhere. The bootloader block is a gap only where the build
     * cannot arm it: refused outright on the 2016-2017 Compact PRO, armed
     * through a pointer on 0.8.0.0, and different between the two 1.3.0.8
     * builds; the 2014 builds from 0.9.0.2 arm it with the token. 0x140C0000 is
     * a gap on every 2014 build, whose table sends 0x0E to 0x140B0000. */
    const gapsOf = (v: string): number[][] =>
      legacyWindowPlan(v).unreachable.map((h) => [h.address, h.length]);
    const upper = [0x14200000, 0x200000];
    const boot = [0x14000000, 0x10000];
    const c = [0x140c0000, 0x10000];
    expect(gapsOf('1.0.3.0')).toEqual([boot, upper]);
    expect(gapsOf('1.0.3.2')).toEqual([boot, upper]);
    expect(gapsOf('1.3.0.8')).toEqual([boot, upper]);
    expect(gapsOf('0.8.0.0')).toEqual([boot, c, upper]);
    for (const v of [
      '0.9.0.2',
      '0.9.0.6',
      '0.9.0.7',
      '0.9.1.0',
      '0.10.0.0',
      '1.0.0.0',
      '1.2.0.0',
      '1.3.0.0',
    ]) {
      expect(gapsOf(v), v).toEqual([c, upper]);
    }
    for (const profile of ['legacy-auth', 'compact-2016'] as const) {
      const map = getProfile(profile).windowMap();
      expect(Math.max(...map.map((e) => e.address))).toBe(0x141f0000);
    }
  });
});
