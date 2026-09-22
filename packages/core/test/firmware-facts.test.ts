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

import { OP } from '../src/protocol/ops.js';
import { OLD_FW_UNLOCK_TOKEN } from '../src/profiles/legacy-auth.js';
import { getProfile } from '../src/profiles/registry.js';
import { parseVersion } from '../src/profiles/version.js';
import { predatesDumpProtocol } from '../src/workflows/capability.js';
import facts from './firmware/facts.json' with { type: 'json' };

interface OpcodeFact {
  readonly toolkitCalls: string;
  readonly firmwareCalls: string | null;
}

interface ImageFact {
  readonly family: string;
  readonly product: string;
  readonly version: string;
  readonly length: number;
  readonly sha256: string;
  readonly rpcMethods: readonly string[] | null;
  readonly rpcTableAt: string | null;
  readonly rpcNameBase: string | null;
  readonly opcodes: Readonly<Record<string, OpcodeFact>>;
  readonly unlockTokenAt: string | null;
}

const IMAGES = Object.entries(facts.images as Record<string, ImageFact>);

/** `0x4F` for a number, the way the facts file spells its keys. */
const wire = (op: number): string => `0x${op.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * The builds whose RPC table does NOT have the toolkit's read command.
 *
 * Named here rather than computed, so that a regeneration which changed the set
 * has to change this list too. They are the whole justification for the
 * `compact-2014` profile.
 */
const NO_READ_COMMAND_VERSIONS: readonly string[] = [
  '0.3.0.1',
  '0.5.0.2',
  '0.5.1.0',
  '0.5.1.3',
  '0.6.0.4',
];

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

  it('agrees on every dump-path opcode in the 31 builds from 0.7.0.7 on', () => {
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

  it('refuses to dump every build whose read command is missing', () => {
    /* The point of `compact-2014`, stated as a property rather than a list:
     * whichever builds lack the read command, the profile that claims them must
     * refuse to dump, and it must be reachable from the version alone — because
     * the version is all a camera gives you before you send it anything. */
    const compact2014 = getProfile('compact-2014');
    expect(compact2014.capabilities.dump.supported).toBe(false);
    expect(compact2014.capabilities.sweep.supported).toBe(false);
    for (const [id, f] of IMAGES) {
      const lacksRead =
        f.opcodes[wire(OP.GET_FEATURED_FIRMWARE_DATA)]?.firmwareCalls !== 'GetFeaturedFirmwareData';
      expect(predatesDumpProtocol(f.version), `${id} (${f.version})`).toBe(lacksRead);
      const verdict = compact2014.detect({ firmwareVersion: f.version });
      expect(verdict.score > 0, `${id}: compact-2014 claims it`).toBe(lacksRead);
    }
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
     * protected set is modes 2..9. Mode 2 is refused on EVERY channel and is
     * therefore not in the map at all; the other seven are in it with the
     * token. Subcommand 4 is a locked alias of 0x14020000 and is deliberately
     * left out, since 1 reaches the same block unlocked. */
    const entries = getProfile('legacy-auth').windowMap();
    const authed = entries.filter((e) => e.auth === true).map((e) => e.subcmd);
    expect([...authed].sort((x, y) => x - y)).toEqual([3, 5, 6, 7, 8, 9]);
    expect(entries.some((e) => e.subcmd === 2)).toBe(false);
    for (const entry of entries) {
      const locked = entry.subcmd >= 2 && entry.subcmd <= 9 && entry.subcmd !== 1;
      expect(entry.auth === true, `subcmd ${String(entry.subcmd)}`).toBe(locked);
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

  it('declares the two blocks the legacy handler rejects outright', () => {
    /* `mode == 2` and `mode > 0x21`, i.e. the XIP base and everything from
     * 0x14200000 up. Both are refused before any channel test, so a dump must
     * record them as gaps rather than trying and reporting a stall. */
    const legacy = getProfile('legacy-auth');
    const holes = legacy.memory.unreachable;
    expect(holes.map((h) => [h.address, h.length])).toEqual([
      [0x14000000, 0x10000],
      [0x14200000, 0x200000],
    ]);
    for (const profile of ['legacy-auth', 'compact-2016'] as const) {
      const map = getProfile(profile).windowMap();
      expect(Math.max(...map.map((e) => e.address))).toBe(0x141f0000);
    }
  });
});
