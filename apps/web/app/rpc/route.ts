/**
 * /rpc: forwards read-only view calls on this app's escrow and receipt registry to the NEAR RPC, plus
 * get_policy on this app's DAO (to label attesters with their DAO role). Anything else (other contracts,
 * other DAO methods, transactions, sandbox_* state patches, other queries) is refused, so a public site
 * is not an open RPC proxy.
 */
import { deployment, rpcUrl } from "../../lib/deployment.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const target = rpcUrl();
  let body: {
    method?: unknown;
    params?: { request_type?: unknown; account_id?: unknown; method_name?: unknown };
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  if (body?.method !== "query" || body.params?.request_type !== "call_function")
    return Response.json({ error: "only contract view calls are allowed" }, { status: 403 });
  const d = deployment();
  const readable = [d.escrow, ...(d.registry ? [d.registry] : [])];
  const daoPolicy = !!d.dao && body.params.account_id === d.dao && body.params.method_name === "get_policy";
  if (!readable.includes(body.params.account_id as string) && !daoPolicy)
    return Response.json({ error: "only this app's escrow and registry can be read" }, { status: 403 });
  const r = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}
