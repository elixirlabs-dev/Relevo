/**
 * Share links for receipts: `/verify#r=<base64url(deflate-raw(receipt JSON))>`. The receipt travels in
 * the URL fragment, which browsers never send to a server, so only whoever opens the link sees it. The
 * text round-trips byte for byte, so the anchored hash still matches. Decoding refuses anything that
 * inflates past 1 MB.
 */

const PREFIX = "#r=";
const MAX_BYTES = 1_000_000;

function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[\w-]+$/.test(s)) return null;
  try {
    const b = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** The fragment payload (without "#r=" or "#p=") for a JSON text: base64url(deflate-raw(text)). */
export async function encodeShare(text: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return toB64url(
    (await readAll(stream as ReadableStream<Uint8Array>, Number.POSITIVE_INFINITY)) as Uint8Array,
  );
}

/**
 * The text carried by a fragment with this prefix (e.g. "#r=" or "#p="), or by a bare payload, or null.
 * Shared by receipt links (`#r=`) and payee links (`#p=`, lib/payee.ts).
 */
export async function decodeFragment(fragment: string, prefix: string): Promise<string | null> {
  const payload = fragment.startsWith(prefix)
    ? fragment.slice(prefix.length)
    : fragment.startsWith("#")
      ? ""
      : fragment;
  if (!payload) return null;
  const bytes = fromB64url(payload);
  if (!bytes) return null;
  try {
    const stream = new Blob([new Uint8Array(bytes)])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    const out = await readAll(stream as ReadableStream<Uint8Array>, MAX_BYTES);
    return out ? new TextDecoder("utf-8", { fatal: true }).decode(out) : null;
  } catch {
    return null;
  }
}

/** The receipt JSON text carried by a `#r=` fragment (or a bare payload), or null. */
export function decodeShare(fragment: string): Promise<string | null> {
  return decodeFragment(fragment, PREFIX);
}

export function shareUrl(origin: string, payload: string): string {
  return `${origin}/verify${PREFIX}${payload}`;
}
