/**
 * jsdom already gives us `crypto.subtle`, `URL.createObjectURL` and
 * `Blob.arrayBuffer`, so the only thing missing is React's act() opt-in.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export {};
