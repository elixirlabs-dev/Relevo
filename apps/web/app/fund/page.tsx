import { FundView } from "../../components/FundView.tsx";
import { Eyebrow } from "../../components/ui.tsx";

export default function FundPage() {
  return (
    <div className="stack">
      <div>
        <Eyebrow>NEAR Intents · 1Click · mainnet</Eyebrow>
        <h1 className="page-title">Fund from any chain</h1>
        <p className="lede">
          A payroll treasury can be topped up from another chain through NEAR Intents. Pick the chain you send
          from, get a price, then get a one-time deposit address. Send USDC to it from your own wallet and
          this page follows the deposit until the USDC arrives in the NEAR mainnet account you chose.
        </p>
      </div>
      <FundView />
    </div>
  );
}
