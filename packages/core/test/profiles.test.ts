import { describe, expect, it } from 'vitest';

import { hexUp } from '../src/bytes.js';
import { SeekError } from '../src/errors.js';
import {
  parseVersion,
  primaryVersion,
  versionSource,
  versionsIn,
} from '../src/profiles/version.js';
import {
  FLASH_BASE,
  FLASH_SIZE,
  GAP_ADDRESS,
  GENERIC_BASELINE,
  OLD_FW_UNLOCK_TOKEN,
  WINDOW_SIZE,
  buildLegacyWindowMap,
  buildModernWindowMap,
  compact2016,
  detectProfile,
  generic,
  getProfile,
  legacyAuth,
  listProfiles,
  modern4x,
  registerProfile,
  requireCapability,
  unregisterProfile,
} from '../src/profiles/index.js';
import type {
  CapabilityName,
  FirmwareProfile,
  ProfileId,
  SlotKey,
  WindowEntry,
} from '../src/profiles/index.js';

const WINDOW_COUNT = FLASH_SIZE / WINDOW_SIZE;

/** Every 64 KiB window address in the flash aperture, in order. */
function allWindowAddresses(): number[] {
  const out: number[] = [];
  for (let a = FLASH_BASE; a < FLASH_BASE + FLASH_SIZE; a += WINDOW_SIZE) out.push(a);
  return out;
}

function addressesMissingFrom(map: readonly WindowEntry[]): number[] {
  const covered = new Set(map.map((e) => e.address));
  return allWindowAddresses().filter((a) => !covered.has(a));
}

function expectWellFormedMap(map: readonly WindowEntry[]): void {
  expect(new Set(map.map((e) => e.subcmd)).size).toBe(map.length);
  expect(new Set(map.map((e) => e.address)).size).toBe(map.length);
  for (let i = 1; i < map.length; i++) {
    const prev = map[i - 1];
    const cur = map[i];
    expect(prev).toBeDefined();
    expect(cur).toBeDefined();
    expect(cur?.address).toBeGreaterThan(prev?.address ?? Number.POSITIVE_INFINITY);
  }
  for (const entry of map) {
    expect(entry.address % WINDOW_SIZE).toBe(0);
    expect(entry.address).toBeGreaterThanOrEqual(FLASH_BASE);
    expect(entry.address).toBeLessThan(FLASH_BASE + FLASH_SIZE);
  }
}

describe('modern-4x selector map', () => {
  const map = buildModernWindowMap();

  it('is sorted by address with no duplicate subcommand or address', () => {
    expectWellFormedMap(map);
  });

  it('covers 0x14000000..0x143fffff except exactly 0x14060000', () => {
    expect(addressesMissingFrom(map)).toEqual([GAP_ADDRESS]);
    // Computed, not a magic number: 64 windows in 4 MiB, one of them unreachable.
    expect(map.length).toBe(WINDOW_COUNT - 1);
  });

  it('records the one uncovered window as the profile’s only gap', () => {
    const gaps = modern4x.memory.unreachable;
    expect(gaps.map((g) => g.address)).toEqual(addressesMissingFrom(map));
    expect(gaps.map((g) => g.length)).toEqual([WINDOW_SIZE]);
    expect(gaps[0]?.reason).toMatch(/no beginfirmwareupgrade selector/i);
  });

  it('keeps the decoded subcommand assignment for the named banks', () => {
    const bySubcmd = new Map(map.map((e) => [e.subcmd, e.address]));
    expect(bySubcmd.get(2)).toBe(0x14000000);
    expect(bySubcmd.get(3)).toBe(0x14010000);
    expect(bySubcmd.get(1)).toBe(0x14020000);
    expect(bySubcmd.get(5)).toBe(0x14030000);
    expect(bySubcmd.get(6)).toBe(0x14040000);
    expect(bySubcmd.get(8)).toBe(0x14050000);
    expect(bySubcmd.get(9)).toBe(0x14070000);
    // The two generated runs are one linear sequence: (subcmd + 5118) << 16.
    for (let subcmd = 0x0a; subcmd <= 0x41; subcmd++) {
      expect(bySubcmd.get(subcmd)).toBe((subcmd + 5118) << 16);
    }
  });

  it('exposes no selector on the plain channel (nothing needs auth)', () => {
    expect(map.every((e) => e.auth !== true)).toBe(true);
    expect(map.every((e) => e.payload === undefined)).toBe(true);
  });

  it('matches the slot descriptors the flash path writes through', () => {
    const bySubcmd = new Map(map.map((e) => [e.subcmd, e.address]));
    for (const slot of modern4x.slots) {
      expect(bySubcmd.get(slot.subcmd)).toBe(slot.address);
    }
    expect(modern4x.slots.map((s) => s.key)).toEqual(['a', 'b', 'r']);
    expect(modern4x.slots.map((s) => s.address)).toEqual([0x14030000, 0x14050000, 0x14070000]);
  });
});

describe('legacy-auth selector map', () => {
  const map = buildLegacyWindowMap();

  /** Exactly the banks the legacy firmware locks behind the 18-byte channel. */
  const EXPECTED_AUTH_BANKS = [
    0x14010000, 0x14030000, 0x14040000, 0x14050000, 0x14060000, 0x14070000,
  ];

  /** Ground truth from legacy/index.html — recovered from one Compact PRO unit. */
  const EXPECTED_TOKEN = [
    0x53, 0x16, 0x10, 0x31, 0x80, 0xdd, 0x00, 0xb7, 0x4a, 0xf9, 0xe4, 0x17, 0xc5, 0x94, 0xbe, 0xd4,
  ];

  it('is sorted by address with no duplicate subcommand or address', () => {
    expectWellFormedMap(map);
  });

  it('marks exactly the protected banks as needing the authenticated channel', () => {
    const authed = map.filter((e) => e.auth === true).map((e) => e.address);
    expect(authed).toEqual(EXPECTED_AUTH_BANKS);
  });

  it('carries the unlock token verbatim', () => {
    expect([...OLD_FW_UNLOCK_TOKEN]).toEqual(EXPECTED_TOKEN);
  });

  it('builds an 18-byte payload of little-endian subcmd followed by the token', () => {
    for (const entry of map) {
      if (entry.auth !== true) {
        expect(entry.payload).toBeUndefined();
        continue;
      }
      const payload = entry.payload;
      if (payload === undefined)
        throw new Error(`auth bank ${hexUp(entry.address)} has no payload`);
      expect(payload.length).toBe(2 + OLD_FW_UNLOCK_TOKEN.length);
      expect(payload.length).toBe(0x12);
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      expect(view.getUint16(0, true)).toBe(entry.subcmd);
      expect([...payload.subarray(2)]).toEqual(EXPECTED_TOKEN);
    }
  });

  it('uses the old firmware’s own subcommand assignment, not the 4.x one', () => {
    const legacyBySubcmd = new Map(map.map((e) => [e.address, e.subcmd]));
    const modernBySubcmd = new Map(buildModernWindowMap().map((e) => [e.address, e.subcmd]));
    // The fact that makes a shared map impossible: 0x14050000/0x14060000/0x14070000
    // are subcommands 7/8/9 here, and 8/-/9 on the 4.x line.
    expect(legacyBySubcmd.get(0x14050000)).toBe(0x7);
    expect(legacyBySubcmd.get(0x14060000)).toBe(0x8);
    expect(legacyBySubcmd.get(0x14070000)).toBe(0x9);
    expect(modernBySubcmd.get(0x14050000)).toBe(0x8);
    expect(modernBySubcmd.get(0x14060000)).toBeUndefined();
    expect(modernBySubcmd.get(0x14070000)).toBe(0x9);
  });

  it('reaches 0x14010000..0x141fffff and records the rest as gaps', () => {
    const missing = addressesMissingFrom(map);
    expect(missing[0]).toBe(FLASH_BASE);
    expect(missing.slice(1).every((a) => a >= 0x14200000)).toBe(true);

    const gaps = legacyAuth.memory.unreachable;
    expect(gaps.map((g) => g.address)).toEqual([FLASH_BASE, 0x14200000]);
    const gapped = gaps.reduce((sum, g) => sum + g.length, 0);
    expect(gapped).toBe(missing.length * WINDOW_SIZE);
    expect(gaps[0]?.reason).toMatch(/xip\/boot base/i);
    expect(gaps[1]?.reason).toMatch(/upper 2 mib/i);

    // No entry may sit inside a declared gap.
    for (const entry of map) {
      for (const gap of gaps) {
        expect(entry.address >= gap.address && entry.address < gap.address + gap.length).toBe(
          false,
        );
      }
    }
  });
});

describe('modern-4x boot replay (select_boot_slot)', () => {
  interface BootCase {
    readonly cfg0: number;
    readonly bootable: readonly SlotKey[];
    readonly booted: SlotKey;
    readonly target: SlotKey;
    readonly why: string;
  }

  const cases: readonly BootCase[] = [
    // cfg0 blank/0: prefer A, then B, then recovery.
    {
      cfg0: 0,
      bootable: ['a', 'b', 'r'],
      booted: 'a',
      target: 'b',
      why: 'preferred A is bootable',
    },
    { cfg0: 0, bootable: ['b', 'r'], booted: 'b', target: 'a', why: 'A not bootable, falls to B' },
    { cfg0: 0, bootable: ['r'], booted: 'r', target: 'a', why: 'A and B not bootable' },
    { cfg0: 0, bootable: [], booted: 'r', target: 'a', why: 'nothing bootable, lands on recovery' },
    { cfg0: 0xffffffff, bootable: ['a'], booted: 'a', target: 'b', why: 'erased cfg0 == blank' },
    { cfg0: 0xffffffff, bootable: ['b', 'r'], booted: 'b', target: 'a', why: 'erased, A dead' },

    // cfg0 == 1: prefer B, then A, then recovery.
    {
      cfg0: 1,
      bootable: ['a', 'b', 'r'],
      booted: 'b',
      target: 'a',
      why: 'preferred B is bootable',
    },
    { cfg0: 1, bootable: ['a', 'r'], booted: 'a', target: 'b', why: 'B not bootable, falls to A' },
    { cfg0: 1, bootable: ['r'], booted: 'r', target: 'a', why: 'B and A not bootable' },
    { cfg0: 1, bootable: [], booted: 'r', target: 'a', why: 'nothing bootable' },

    // anything else: prefer recovery, then A, then B.
    { cfg0: 2, bootable: ['a', 'b', 'r'], booted: 'r', target: 'a', why: 'recovery preferred' },
    { cfg0: 2, bootable: ['a', 'b'], booted: 'a', target: 'b', why: 'recovery dead, falls to A' },
    { cfg0: 2, bootable: ['b'], booted: 'b', target: 'a', why: 'recovery and A dead' },
    { cfg0: 2, bootable: [], booted: 'b', target: 'a', why: 'nothing bootable, last resort B' },
    {
      cfg0: 7,
      bootable: ['a'],
      booted: 'a',
      target: 'b',
      why: 'unknown cfg0 uses the else branch',
    },
  ];

  for (const testCase of cases) {
    const label = `cfg0=${hexUp(testCase.cfg0)} bootable=[${testCase.bootable.join(',')}]`;
    it(`${label}: ${testCase.why}`, () => {
      const bootable = new Set<SlotKey>(testCase.bootable);
      const prediction = modern4x.boot.selectBootSlot(testCase.cfg0, (key) => bootable.has(key));
      expect(prediction).toEqual({ booted: testCase.booted, target: testCase.target });
    });
  }

  it('always names the slot an upgrade would overwrite as "not the booted one"', () => {
    for (const testCase of cases) {
      const bootable = new Set<SlotKey>(testCase.bootable);
      const { booted, target } = modern4x.boot.selectBootSlot(testCase.cfg0, (k) =>
        bootable.has(k),
      );
      // fw_update_slot_address(): booted A -> write B, otherwise write A.
      expect(target).toBe(booted === 'a' ? 'b' : 'a');
    }
  });

  it('describes cfg0 the way the original did', () => {
    expect(modern4x.boot.describeCfg0(0)).toBe('blank/0: prefer slot A, then B, then recovery');
    expect(modern4x.boot.describeCfg0(0xffffffff)).toBe(
      'blank/0: prefer slot A, then B, then recovery',
    );
    expect(modern4x.boot.describeCfg0(1)).toBe('prefer slot B, then A, then recovery');
    expect(modern4x.boot.describeCfg0(2)).toBe('prefer recovery, then A, then B');
    expect(modern4x.boot.describeCfg0(9)).toBe('prefer recovery, then A, then B');
  });

  it('arms selector 0 as the update target', () => {
    expect(modern4x.boot.updateTargetSubcmd).toBe(0);
  });
});

describe('legacy-auth boot policy', () => {
  it('refuses to predict a boot slot rather than replaying the 4.x bootloader', () => {
    expect(() => legacyAuth.boot.selectBootSlot(0, () => true)).toThrow(SeekError);
    expect(legacyAuth.boot.updateTargetSubcmd).toBeLessThan(0);
  });

  it('still describes cfg0 without throwing, so reports can print something', () => {
    expect(legacyAuth.boot.describeCfg0(0)).toMatch(/never decoded/i);
  });
});

describe('cipher profiles', () => {
  it('keeps whitening K and the acceptance target decoupled', () => {
    expect(modern4x.cipher.whiteningK).toBe(0x13579bdf);
    expect(modern4x.cipher.acceptanceSum).toBe(0x0000ffff);

    // Measured on 32K_43X0_1.3.0.8_COMPACT-16HZ: sum 0xFFFF with NO whitening.
    // This pairing is the one DEC_PROFILES could not express.
    expect(legacyAuth.cipher.whiteningK).toBe(0x00000000);
    expect(legacyAuth.cipher.acceptanceSum).toBe(0x0000ffff);

    expect(compact2016.cipher.whiteningK).toBe(0x00000000);
    expect(compact2016.cipher.acceptanceSum).toBe(0x00000000);
  });

  it('leaves the same header window in cleartext on every family', () => {
    for (const profile of listProfiles()) {
      expect(profile.cipher.clearWords).toEqual([128, 143]);
    }
  });
});

describe('detection', () => {
  it('reads a 0x0000FFFF acceptance sum as modern-4x', () => {
    const result = detectProfile({ observedAcceptanceSums: [0x0000ffff] });
    expect(result.best.profile.id).toBe('modern-4x');
    expect(result.ambiguous).toBe(false);
    expect(result.best.reasons.join(' ')).toMatch(/0x0000FFFF/);
  });

  it('reads a 0x00000000 acceptance sum as compact-2016', () => {
    const result = detectProfile({ observedAcceptanceSums: [0x00000000] });
    expect(result.best.profile.id).toBe('compact-2016');
    expect(result.ambiguous).toBe(false);
    // The same evidence rules modern-4x out outright.
    const modernMatch = result.ranked.find((m) => m.profile.id === 'modern-4x');
    expect(modernMatch?.score).toBe(0);
  });

  it('treats an authenticated selector that worked as weak evidence for legacy-auth', () => {
    /* It only says the 18-byte payload armed a bank; nothing tried the plain
     * one there, so it points at the family without settling it — the mirror of
     * what `plainSelectorWorks` alone does for modern-4x. */
    const result = detectProfile({ authSelectorWorks: true });
    expect(result.best.profile.id).toBe('legacy-auth');
    expect(result.ambiguous).toBe(true);
  });

  it('lets a 1.x version and a working authenticated selector settle legacy-auth', () => {
    const result = detectProfile({ authSelectorWorks: true, firmwareVersion: '1.0.3.0' });
    expect(result.best.profile.id).toBe('legacy-auth');
    expect(result.ambiguous).toBe(false);
  });

  it('does not rule modern-4x out on an authenticated selector that merely worked', () => {
    /* The authenticated payload goes out because the ACTING profile's map
     * carries a token, so ruling 4.x out on it would rule it out on the map the
     * caller picked rather than on the camera. */
    const result = detectProfile({ authSelectorWorks: true, observedAcceptanceSums: [0x0000ffff] });
    const modernMatch = result.ranked.find((m) => m.profile.id === 'modern-4x');
    expect(modernMatch?.score).toBeGreaterThan(0);
    expect(result.best.profile.id).toBe('modern-4x');
  });

  it('rules legacy-auth out when a plain selector armed a protected bank', () => {
    const result = detectProfile({ plainSelectorWorks: true });
    const legacyMatch = result.ranked.find((m) => m.profile.id === 'legacy-auth');
    expect(legacyMatch?.score).toBe(0);
  });

  it('falls back to generic, ambiguously, on no evidence at all', () => {
    const result = detectProfile({});
    expect(result.best.profile.id).toBe('generic');
    expect(result.best.score).toBe(GENERIC_BASELINE);
    expect(result.ambiguous).toBe(true);
  });

  it('never lets a weak signal alone produce a confident match', () => {
    // A plain selector rules out the locked legacy firmware but does not choose
    // between the remaining families, so the verdict stays ambiguous.
    expect(detectProfile({ plainSelectorWorks: true }).ambiguous).toBe(true);
  });

  it('treats the 1.x numbering line as legacy, not as an older 4.x', () => {
    for (const version of ['1.0.3.0', '1.0.3.2', '1.3.0.8']) {
      const result = detectProfile({ firmwareVersion: version });
      expect(result.best.profile.id).toBe('legacy-auth');
      const modernMatch = result.ranked.find((m) => m.profile.id === 'modern-4x');
      expect(modernMatch?.score).toBe(0);
    }
  });

  it('lets a reported 1.x version outrank a 0xFFFF acceptance sum', () => {
    // 32K_43X0_1.3.0.8_COMPACT-16HZ hits 0xFFFF and is NOT on the 4.x line, so
    // the sum alone must not be allowed to claim the camera for modern-4x.
    const result = detectProfile({
      firmwareVersion: '1.3.0.8',
      observedAcceptanceSums: [0x0000ffff],
    });
    expect(result.best.profile.id).not.toBe('modern-4x');
    const modernMatch = result.ranked.find((m) => m.profile.id === 'modern-4x');
    expect(modernMatch?.score).toBe(0);
  });

  it('corroborates a 4.x version with the acceptance sum', () => {
    const versionOnly = detectProfile({ firmwareVersion: '4.9.1.5' });
    const both = detectProfile({
      firmwareVersion: '4.9.1.5',
      observedAcceptanceSums: [0x0000ffff],
    });
    expect(versionOnly.best.profile.id).toBe('modern-4x');
    expect(both.best.profile.id).toBe('modern-4x');
    expect(both.best.score).toBeGreaterThan(versionOnly.best.score);
  });

  it('calls contradictory evidence ambiguous instead of picking a winner', () => {
    // A 1.x version on the authenticated channel says legacy; a zero acceptance
    // sum says 2016. Neither wins.
    const result = detectProfile({
      authSelectorWorks: true,
      firmwareVersion: '1.0.3.0',
      observedAcceptanceSums: [0],
    });
    expect(result.ambiguous).toBe(true);
  });

  it('ranks every registered profile, best first', () => {
    const result = detectProfile({ observedAcceptanceSums: [0x0000ffff] });
    expect(result.ranked.length).toBe(listProfiles().length);
    for (let i = 1; i < result.ranked.length; i++) {
      const prev = result.ranked[i - 1]?.score ?? 1;
      const cur = result.ranked[i]?.score ?? 1;
      expect(cur).toBeLessThanOrEqual(prev);
    }
    expect(result.ranked[0]).toBe(result.best);
  });

  it('gives every profile a reason for its score', () => {
    const result = detectProfile({ observedAcceptanceSums: [0x0000ffff] });
    for (const match of result.ranked) {
      expect(match.reasons.length).toBeGreaterThan(0);
      for (const reason of match.reasons) expect(reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('capabilities', () => {
  const REFUSING: readonly FirmwareProfile[] = [legacyAuth, compact2016, generic];

  it('lets modern-4x flash', () => {
    expect(() => {
      requireCapability(modern4x, 'flash');
    }).not.toThrow();
    expect(modern4x.capabilities.flash.supported).toBe(true);
  });

  for (const profile of REFUSING) {
    it(`refuses flash on ${profile.id} and says why`, () => {
      const support = profile.capabilities.flash;
      if (support.supported) throw new Error(`${profile.id} should refuse to flash`);
      expect(support.reason.length).toBeGreaterThan(20);

      let thrown: unknown;
      try {
        requireCapability(profile, 'flash');
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SeekError);
      const error = thrown as SeekError;
      expect(error.code).toBe('profile/unsupported');
      expect(error.message).toContain(support.reason);
      expect(error.detail?.reason).toBe(support.reason);
      expect(error.detail?.profile).toBe(profile.id);
    });
  }

  /**
   * WEAKENED ON PURPOSE, AND ONLY THIS FAR. This used to say "every read path is
   * open on every profile", which was a good rule while every profile could
   * read. `compact-2014` cannot: the five builds it covers have no
   * `GetFeaturedFirmwareData` in their RPC method table at all, and on 0.3.0.1
   * the wire id a dump ARMS with is `EnterBootloaderMode`. A profile that
   * dumped those would be sending a mode change 63 times.
   *
   * So the invariant becomes: reading is open unless the profile gives a
   * reason, and offline work — decrypting a dump somebody took with an SPI
   * programmer, and reading device info over commands that ARE at their usual
   * ids — stays open on every profile without exception. A future profile that
   * refuses `decrypt` has broken something real.
   */
  it('keeps decrypt and deviceInfo open on every profile', () => {
    const always: readonly CapabilityName[] = ['decrypt', 'deviceInfo'];
    for (const profile of listProfiles()) {
      for (const op of always) {
        expect(profile.capabilities[op].supported, `${profile.id}.${op}`).toBe(true);
        expect(() => {
          requireCapability(profile, op);
        }).not.toThrow();
      }
    }
  });

  it('opens the camera read paths on every profile but compact-2014', () => {
    const reads: readonly CapabilityName[] = ['dump', 'sweep'];
    for (const profile of listProfiles()) {
      const expected = profile.id !== 'compact-2014';
      for (const op of reads) {
        expect(profile.capabilities[op].supported, `${profile.id}.${op}`).toBe(expected);
      }
    }
  });

  it('gives compact-2014 a refusal that names the command it would have sent', () => {
    const profile = getProfile('compact-2014');
    for (const op of ['dump', 'sweep'] as const) {
      const support = profile.capabilities[op];
      expect(support.supported).toBe(false);
      if (support.supported) return;
      expect(support.reason).toContain('GetFeaturedFirmwareData');
      expect(support.reason).toContain('EnterBootloaderMode');
    }
  });

  it('gives compact-2014 no selector map at all, so a bypass still sends nothing', () => {
    const profile = getProfile('compact-2014');
    expect(profile.windowMap()).toEqual([]);
    const [lo, hi] = profile.sweepRange;
    expect(lo).toBeGreaterThan(hi);
  });
});

describe('registry', () => {
  it('registers the five built-ins and looks them up by id', () => {
    const ids: readonly ProfileId[] = [
      'modern-4x',
      'legacy-auth',
      'compact-2016',
      'compact-2014',
      'generic',
    ];
    expect(listProfiles().map((p) => p.id)).toEqual(ids);
    for (const id of ids) expect(getProfile(id).id).toBe(id);
  });

  it('throws a typed error for an unknown id', () => {
    expect(() => getProfile('nope')).toThrow(SeekError);
  });

  it('accepts a fifth family with no edit to any shared logic', () => {
    // The only thing a new family needs is its own file plus this one call. The
    // registry, the scoring, the ranking and the capability gate all stay put.
    const fakeId = 'bench-family' as unknown as ProfileId;
    const fake: FirmwareProfile = {
      ...modern4x,
      id: fakeId,
      name: 'Bench family',
      detect: () => ({ score: 0.99, reasons: ['bench fixture'] }),
    };
    const before = listProfiles().map((p) => p.id);
    try {
      registerProfile(fake);
      expect(listProfiles().length).toBe(before.length + 1);
      expect(getProfile(fakeId)).toBe(fake);
      // It competes on the same footing as the built-ins.
      const result = detectProfile({ observedAcceptanceSums: [0x0000ffff] });
      expect(result.best.profile.id).toBe(fakeId);
      expect(result.ranked.some((m) => m.profile.id === 'modern-4x')).toBe(true);
    } finally {
      unregisterProfile(fakeId);
    }
    expect(listProfiles().map((p) => p.id)).toEqual(before);
  });
});

/* ==================================================================== *
 * Reading a version out of the evidence.
 *
 * Two fields carry one, and only one of them used to be read. These are the
 * rules the profiles now share, tested where they live rather than four times
 * over in four `detect()`s.
 * ==================================================================== */

describe('version evidence', () => {
  it('parses a dotted version and ignores anything that is not one', () => {
    expect(parseVersion('4.18.2.0')).toEqual({ text: '4.18.2.0', major: 4, minor: 18 });
    expect(parseVersion(' 0.3.0.1 ')).toEqual({ text: '0.3.0.1', major: 0, minor: 3 });
    expect(parseVersion('42.32.3.10')?.major).toBe(42);
    expect(parseVersion('PIR206 Thermal Camera')).toBeNull();
    expect(parseVersion('4')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });

  it('prefers what the camera reported over what a dump contains', () => {
    const evidence = { firmwareVersion: '4.18.2.0', imageVersions: ['1.0.3.0'] };
    expect(primaryVersion(evidence)?.text).toBe('4.18.2.0');
    expect(versionSource(evidence)).toBe('camera');
    expect(versionsIn(evidence).map((v) => v.text)).toEqual(['4.18.2.0', '1.0.3.0']);
  });

  it("uses a dump's image headers when no camera reported one", () => {
    const evidence = { imageVersions: ['1.0.3.0', '1.0.3.0'] };
    /* Both slots hold the same build, which is the ordinary case; the duplicate
     * carries nothing and is dropped rather than double-counted. */
    expect(versionsIn(evidence).map((v) => v.text)).toEqual(['1.0.3.0']);
    expect(primaryVersion(evidence)?.text).toBe('1.0.3.0');
    expect(versionSource(evidence)).toBe('dump');
  });

  it('refuses to pick when a dump holds two different builds', () => {
    /* A part whose slot A and slot B are different versions cannot tell you
     * which one the camera runs, and a profile must not pretend it did. */
    const evidence = { imageVersions: ['1.0.3.0', '4.18.2.0'] };
    expect(primaryVersion(evidence)).toBeNull();
    expect(versionSource(evidence)).toBe('none');
  });

  it('has nothing to say about evidence with no version at all', () => {
    expect(primaryVersion({})).toBeNull();
    expect(versionsIn({})).toEqual([]);
    expect(versionSource({})).toBe('none');
    expect(versionsIn({ imageVersions: ['not a version'] })).toEqual([]);
  });

  it("lets a dump's own header rule modern-4x in and out", () => {
    /* The bug the version module exists to fix: `evidenceFromDump` parsed these
     * headers and every `detect()` ignored them, so a 1.3.0.8 image — which
     * hits the 4.x acceptance sum with no whitening — was detected as 4.x. */
    const modern = getProfile('modern-4x');
    expect(modern.detect({ imageVersions: ['1.3.0.8'] }).score).toBe(0);
    expect(modern.detect({ imageVersions: ['10.9.1.31'] }).score).toBeGreaterThan(0.5);
  });
});
