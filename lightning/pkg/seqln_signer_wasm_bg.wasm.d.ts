/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const __wbg_noisesession_free: (a: number, b: number) => void;
export const __wbg_signer_free: (a: number, b: number) => void;
export const devicePubkey: (a: number, b: number) => [number, number, number, number];
export const noisesession_decryptBody: (a: number, b: number, c: number) => [number, number, number, number];
export const noisesession_decryptHeader: (a: number, b: number, c: number) => [number, number, number];
export const noisesession_encrypt: (a: number, b: number, c: number) => [number, number, number, number];
export const noisesession_isReady: (a: number) => number;
export const noisesession_newInitiator: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
export const noisesession_readActTwo: (a: number, b: number, c: number) => [number, number, number, number];
export const noisesession_writeActOne: (a: number) => [number, number, number, number];
export const signer_fromMnemonic: (a: number, b: number) => [number, number, number];
export const signer_new: (a: number, b: number) => [number, number, number];
export const signer_processFrame: (a: number, b: number, c: number) => [number, number, number, number];
export const signer_setEnforce: (a: number, b: number) => void;
export const signer_walletSweepScript: (a: number, b: number, c: number) => [number, number];
export const rustsecp256k1_v0_10_0_context_create: (a: number) => number;
export const rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
export const rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
export const rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_start: () => void;
