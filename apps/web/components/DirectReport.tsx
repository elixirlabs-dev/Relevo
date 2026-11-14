import type { DirectPayout, DirectReceipt } from "@elivo/shared/direct-receipt";
import type { DirectReceiptV2 } from "@elivo/shared/direct-receipt-v2";
import { LABEL } from "@elivo/shared/label";
import { Button, Eyebrow } from "./ui.tsx";

function outcome(p: DirectPayout): string {
  if (p.status === "Paid") return "Paid";
  const why = p.reference ? `: ${p.reference.replaceAll("_", " ").toLowerCase()}` : "";
  return `${p.status}${why}`;
}

/**
 * The delivery report for a direct receipt (payouts the issuer made itself, outside the escrow; v1 or v2):
 * on /verify once every check passes, and on /issue once the receipt is anchored. Prints on its own, like
 * the batch report. Positions are 1-based.
 */
export function DirectReport({
  receipt: r,
  hash,
  checkedBefore = false,
  print = () => window.print(),
}: {
  receipt: DirectReceipt | DirectReceiptV2;
  hash: string;
  /** True only when /verify's "checked before payment" check ran and passed for this receipt. */
  checkedBefore?: boolean;
  print?: () => void;
}) {
  const paid = r.payouts.filter((p) => p.status === "Paid").length;
  const v2 = r.version === "elivo-direct-receipt-2" ? (r as DirectReceiptV2) : null;
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
                <td>{p.id + 1}</td>
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
      {v2 && (
        <p className="small">
          {"Merkle root "}
          <code style={{ wordBreak: "break-all" }}>{v2.payouts_root}</code>
          {` over the ${v2.payout_count} payouts. The signatures and the anchor cover this root, so each payee can be given a proof of their own payout that shows nobody else's.`}
          {!v2.check_ref
            ? " No check made before payment is linked."
            : checkedBefore
              ? ` The batch was checked before payment: check report ${v2.check_ref.report_id}.`
              : ` This receipt names check report ${v2.check_ref.report_id}, but it was not shown to be anchored before the receipt.`}
        </p>
      )}
      <p className="small muted">{LABEL}</p>
    </section>
  );
}
