/* ==================================================================== *
 * Finding firmware images in a flash dump.
 *
 * Slots are block-aligned, so only the 64 KiB boundaries are probed — scanning
 * every offset for the magic would turn stray data into "slots". The length
 * gate is what keeps a chance magic hit from being reported as an image: a real
 * header declares a word-aligned length that is larger than the header window
 * it sits in, smaller than the largest bank this family ships, and inside the
 * dump.
 * ==================================================================== */

import { HEADER_OFFSET, IMAGE_MAGIC, MAX_IMAGE_LEN } from './header.js';

/** Flash slots are one 64 KiB upgrade window apart. */
export const SLOT_STEP = 0x10000;

export interface ImageSlot {
  /** Offset of the slot within the scanned buffer, not a flash address. */
  readonly base: number;
  /** Declared header.length, in bytes. */
  readonly len: number;
}

export function findImages(view: DataView, len: number = view.byteLength): ImageSlot[] {
  const out: ImageSlot[] = [];
  for (let b = 0; b + HEADER_OFFSET + 8 <= len; b += SLOT_STEP) {
    if (view.getUint32(b + HEADER_OFFSET, true) !== IMAGE_MAGIC >>> 0) continue;
    const imgLen = view.getUint32(b + HEADER_OFFSET + 4, true);
    if ((imgLen & 3) !== 0) continue;
    if (imgLen <= HEADER_OFFSET || imgLen >= MAX_IMAGE_LEN) continue;
    if (b + imgLen > len) continue;
    out.push({ base: b, len: imgLen });
  }
  return out;
}
