/* tslint:disable */
/* eslint-disable */

/**
 * The BOLT-8 Noise_XK **initiator** session (the browser device role in the
 * hosted topology: it connects OUT to the proxy responder). Holds the handshake
 * state until Act Two, then the post-handshake transport cipher.
 */
export class NoiseSession {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Decrypt a body (`len + 16` bytes) into the plaintext message.
     */
    decryptBody(body: Uint8Array): Uint8Array;
    /**
     * Decrypt an 18-byte length header, returning the body length that follows
     * (so the caller knows how many bytes to read next off the socket).
     */
    decryptHeader(hdr: Uint8Array): number;
    /**
     * Encrypt one plaintext message into a full BOLT-8 transport record
     * (18-byte encrypted length header || encrypted body+MAC).
     */
    encrypt(msg: Uint8Array): Uint8Array;
    /**
     * True once the handshake has completed and the transport is live.
     */
    isReady(): boolean;
    /**
     * Begin an initiator handshake toward a hosted proxy whose static pubkey is
     * `host_static_pubkey` (33 bytes, pinned), using our device transport
     * static privkey `device_static_privkey` (32 bytes) and a fresh 32-byte
     * `ephemeral_entropy` the caller draws from `crypto.getRandomValues`.
     */
    static newInitiator(host_static_pubkey: Uint8Array, device_static_privkey: Uint8Array, ephemeral_entropy: Uint8Array): NoiseSession;
    /**
     * Consume Act Two (50 bytes) from the responder, returning Act Three (66
     * bytes) and transitioning to the ready transport. After this call
     * [`encrypt`]/[`decrypt_header`]/[`decrypt_body`] are live.
     */
    readActTwo(act2: Uint8Array): Uint8Array;
    /**
     * Produce Act One (50 bytes) to send to the responder.
     */
    writeActOne(): Uint8Array;
}

/**
 * The device signer. Holds the mnemonic-derived crypto kernel and per-channel
 * policy state, exactly like the native `dispatch::Signer`.
 */
export class Signer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Convenience: construct from just the mnemonic string (no passphrase),
     * synthesizing the `32 zero bytes || mnemonic` on-disk form.
     */
    static fromMnemonic(mnemonic: string): Signer;
    /**
     * Construct from the raw `hsm_secret` bytes (mnemonic format:
     * `32 zero bytes || mnemonic`, i.e. the exact on-disk file). Throws on a
     * malformed / unsupported secret.
     */
    constructor(hsm_secret_bytes: Uint8Array);
    /**
     * Drive ONE hsmd request -> reply. `frame_bytes` is a single signer-split
     * frame (`signer_frame.h`: little-endian `u32 len | is_main | node_id? |
     * dbid | capabilities | hsmd_msg`); the return is the single framed reply
     * (`u32 len | hsmd_reply`, a zero-length body being the error sentinel) —
     * byte-for-byte what the native serve loop writes back. Throws only on a
     * libhsmd-fatal condition (which closes the transport natively).
     */
    processFrame(frame_bytes: Uint8Array): Uint8Array;
    /**
     * Turn the M4 validating policy on (`enforce`) or off (`permissive`). The
     * browser build has no env, so this is how a caller selects enforce mode.
     */
    setEnforce(enforce: boolean): void;
    /**
     * The node's OWN wallet sweep scriptPubKey for key `index`: p2wpkh of the
     * bip86 key when `taproot` is false (the Elements sweep destination), or the
     * bip86 taproot output when true (the Bitcoin sweep destination). Lets a JS
     * harness synthesize a legit sweep output (and tamper it) for the enforce
     * custody proof, without hard-coding key derivation in JS.
     */
    walletSweepScript(index: number, taproot: boolean): Uint8Array;
}

/**
 * Derive the compressed static pubkey (33 bytes) for a transport static privkey
 * (32 bytes) — used to compute the device pubkey a hosted proxy must pin.
 */
export function devicePubkey(static_privkey: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_noisesession_free: (a: number, b: number) => void;
    readonly __wbg_signer_free: (a: number, b: number) => void;
    readonly devicePubkey: (a: number, b: number) => [number, number, number, number];
    readonly noisesession_decryptBody: (a: number, b: number, c: number) => [number, number, number, number];
    readonly noisesession_decryptHeader: (a: number, b: number, c: number) => [number, number, number];
    readonly noisesession_encrypt: (a: number, b: number, c: number) => [number, number, number, number];
    readonly noisesession_isReady: (a: number) => number;
    readonly noisesession_newInitiator: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly noisesession_readActTwo: (a: number, b: number, c: number) => [number, number, number, number];
    readonly noisesession_writeActOne: (a: number) => [number, number, number, number];
    readonly signer_fromMnemonic: (a: number, b: number) => [number, number, number];
    readonly signer_new: (a: number, b: number) => [number, number, number];
    readonly signer_processFrame: (a: number, b: number, c: number) => [number, number, number, number];
    readonly signer_setEnforce: (a: number, b: number) => void;
    readonly signer_walletSweepScript: (a: number, b: number, c: number) => [number, number];
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
