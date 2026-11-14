/**
 * Payee links: `/payee#p=<base64url(deflate-raw(payee proof JSON))>`. Like the `#r=` share links, the
 * proof travels in the URL fragment, which browsers never send to a server. A proof carries one payout
 * (salted payee_ref and last 4 digits, never a name) and the signed header, so it shows nobody else's pay.
 */
import type { PayeeProof } from "@elivo/shared/direct-receipt-v2";
import { encodeShare } from "./share.ts";

export async function payeeLink(origin: string, proof: PayeeProof): Promise<string> {
  return `${origin}/payee#p=${await encodeShare(JSON.stringify(proof))}`;
}
