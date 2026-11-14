import type { DirectPayout, DirectReceipt } from "@elivo/shared/direct-receipt";
import { LABEL } from "@elivo/shared/label";
import { Button, Eyebrow } from "./ui.tsx";

function outcome(p: DirectPayout): string {
  if (p.status === "Paid") return "Paid";
  const why = p.reference ? `: ${p.reference.replaceAll("_", " ").toLowerCase()}` : "";
  return `${p.status}${why}`;
}

/**
 * The delivery report for a direct receipt (payouts the issuer made itself, outside the escrow) that has
 * passed every check on /verify. Prints on its own, like the batch report.
 */
export function DirectReport({
  receipt: r,
  hash,
  print = () => window.print(),
}: {
  receipt: DirectReceipt;
  hash: string;
  print?: () => void;
}) {
  const paid = r.payouts.filter((p) => p.status === "Paid").length;
  return (
    <section className="report sheet" aria-labelledby="report-title">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <Eyebrow>For donors and auditors</Eyebrow>
          <h2 id="report-title">Delivery report</h2>
        </div>
        <span className="no-print">
          <Button variant="secondary" onClick={print}>
            Print report
          </Button>
        </span>
      </div>
      <p>{`Receipt ${r.receipt_id} · issued by ${r.issuer} · ${r.rail} in ${r.currency} · ${r.network}`}</p>
      <p>{`${r.payouts.length} payouts: ${paid} paid, ${r.payouts.length - paid} not paid. ${r.totals.paid} ${r.currency} paid, ${r.totals.not_paid} ${r.currency} not paid.`}</p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Payee</th>
              <th>{r.currency}</th>
              <th>Outcome</th>
              <th>Paid at</th>
              <th>Reference</th>
            </tr>
          </thead>
          <tbody>
            {r.payouts.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td>{`account ****${p.account_last4}`}</td>
                <td>{p.amount}</td>
                <td>{outcome(p)}</td>
                <td>{p.paid_at ? p.paid_at.replace("T", " ").replace("Z", " UTC") : "-"}</td>
                <td>{p.status === "Paid" ? (p.reference ?? "-") : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">
        Receipt hash <code style={{ wordBreak: "break-all" }}>{hash}</code>
        {`, anchored by ${r.issuer} in ${r.registry}. These payouts were made outside the escrow: the receipt proves what the issuer signed and anchored, not that a bank confirmed each transfer. Payees are identified only by the last 4 digits of their account.`}
      </p>
      <p className="small muted">{LABEL}</p>
    </section>
  );
}
