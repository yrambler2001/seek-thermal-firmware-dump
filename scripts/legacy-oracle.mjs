/**
 * Loads the ORIGINAL <script> out of `legacy/index.html` into a stub-DOM `vm`
 * context and hands back its internals.
 *
 * Why this exists: the TypeScript core in `packages/core` is a port of that
 * page, and the page is the only version that has ever driven real hardware.
 * Running the shipped legacy code headless gives an independent oracle to diff
 * the port against — see `scripts/verify-against-legacy.mjs`, which decrypts
 * real flash dumps with both implementations and requires identical results.
 *
 * A previous round of this work built the same harness in a throwaway
 * scratchpad and lost it. Keeping it in the repo means the next person changing
 * the cipher or the flash packaging can re-run the comparison in one command.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadLegacy(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  if (!m) throw new Error('could not find the page script');
  const src = m[1];

  const noop = () => {};
  const makeEl = () => ({
    classList: { add: noop, remove: noop, toggle: noop },
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    remove: noop,
    click: noop,
    querySelectorAll: () => [],
    setAttribute: noop,
    removeAttribute: noop,
    style: {},
    dataset: {},
    files: null,
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
  });

  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Math,
    Date,
    JSON,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    BigInt,
    Uint8Array,
    Uint32Array,
    DataView,
    ArrayBuffer,
    Error,
    RegExp,
    isNaN,
    parseInt,
    parseFloat,
    Blob: class {
      constructor(parts) {
        this.parts = parts;
        this.size = 0;
      }
    },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: noop },
    document: {
      getElementById: makeEl,
      createElement: makeEl,
      querySelectorAll: () => [],
      body: makeEl(),
      title: '',
    },
    window: { addEventListener: noop, isSecureContext: true, confirm: () => false },
    navigator: {
      userAgent: 'node-oracle',
      platform: 'MacIntel',
      maxTouchPoints: 0,
      usb: undefined,
    },
    location: { hash: '', protocol: 'https:' },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);
  // Expose the internals we want to compare against.
  const exposed = [
    'recoverState',
    'recoverKeyInfo',
    'decryptImage',
    'checksum32',
    'keyFromState',
    'stateFromKey',
    'findImages',
    'findKeyCandidates',
    'pickKeyTable',
    'findEmbeddedKeyTable',
    'countOccurrences',
    'bankPayloadSize',
    'footerOffsetFor',
    'setAcceptSum',
    'buildBankPayload',
    'assertBankPayload',
    'wordSum32',
    'transferSum16',
    'parseImageHeader',
    'parseFooter',
    'versionString',
    'crc32',
    'buildZip',
    'buildAddressMap',
    'buildOldFirmwareMap',
    'authPayload',
    'predictBoot',
    'identifyKey',
    'storeKeyOf',
    'bytesToHex',
    'hexToBytes',
    'DEC_PROFILES',
    'FLASH_K',
    'ACCEPT_SUM',
    'xsNext',
    'cryptBytes',
  ];
  const wrapped =
    src +
    '\n;globalThis.__api = { ' +
    exposed.map((n) => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(', ') +
    ' };\n';
  vm.runInContext(wrapped, ctx, { filename: 'legacy-index.html' });
  return ctx.__api;
}
