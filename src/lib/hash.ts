/** FNV-1a 32-bit with a murmur3 finalizer. Stable across runs and platforms — the basis of spatial memory. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // murmur3 finalizer: FNV alone correlates on short sequential inputs ("1", "2", …).
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic value in [0, 1) derived from a string and an optional salt. */
export function unit(input: string, salt = ""): number {
  return hash32(salt + "\u0000" + input) / 0x1_0000_0000;
}
