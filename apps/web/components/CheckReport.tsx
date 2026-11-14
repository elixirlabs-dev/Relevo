import { CHECK_LEVELS, type CheckReport } from "@elivo/shared/check-report";
import { LABEL } from "@elivo/shared/label";
import type { CheckLevel } from "@elivo/shared/payout-check";
import { Button, Chip, Eyebrow } from "./ui.tsx";

/** A finding as a chip: the word "Block" or "Warning" says the level, so colour is not the only signal. */
export function FindingChip({ level, text }: { level: CheckLevel; text: string }) {
  return (
    <Chip
      tone={level === "block" ? "rose" : "peach"}
    >{`${level === "block" ? "Block" : "Warning"} · ${text}`}</Chip>
  );
}

/**
 * A check report that has passed every check on /verify: which checks the issuer ran on a batch before
 * paying it, and what they found. It names no payee. Prints on its own, like the delivery reports.
 */
export function CheckReportSheet({
  report: r,
  hash,
  print = () => window.print(),
}: {
  report: CheckReport;
  hash: string;
  print?: () => void;
}) {
  const s = r.summary;
  return (
    <section className="report sheet" aria-labelledby="check-report-title">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <Eyebrow>Checked before paying</Eyebrow>
          <h2 id="check-report-title">Check report</h2>
        </div>
        <span className="no-print">
          <Button variant="secondary" onClick={print}>
            Print report
          </Button>
        </span>
      </div>
      <p>{`${r.report_id} · checked by ${r.issuer} · ${r.rail} · ${r.network} · ${r.checked_at.replace("T", " ").replace(/(\.\d+)?Z$/, " UTC")}`}</p>
      <p>{`${s.rows} rows: ${s.blocked} blocked, ${s.warned} with warnings, ${s.clean} clean. Checks by engine ${r.engine}.`}</p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Payee</th>
              <th>Bank</th>
              <th>Amount</th>
              <th>Findings</th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>{`account ****${row.account_last4}`}</td>
                <td>{row.bank ?? "-"}</td>
                <td>{row.amount}</td>
                <td>
                  {row.findings.length === 0 ? (
                    "none"
                  ) : (
                    <span className="row" style={{ gap: 6 }}>
                      {row.findings.map((c) => (
                        <FindingChip key={c} level={CHECK_LEVELS[c]} text={c} />
                      ))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">
        Report hash <code style={{ wordBreak: "break-all" }}>{hash}</code>
        {`, anchored by ${r.issuer} in ${r.registry}. It shows which checks the issuer ran on this batch before paying, and when; it does not show that the payouts were made. Name-to-account matching was not checked. Payees are identified only by the last 4 digits of their account.`}
      </p>
      <p className="small muted">{LABEL}</p>
    </section>
  );
}
