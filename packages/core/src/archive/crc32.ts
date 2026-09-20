/** Standard CRC-32 (IEEE 802.3 / zip / gzip polynomial 0xEDB88320). */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of `bytes`. `crc32(utf8("123456789")) === 0xcbf43926`; `crc32(new Uint8Array()) === 0`. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    const tableIndex = (c ^ byte) & 0xff;
    c = (CRC_TABLE[tableIndex] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
