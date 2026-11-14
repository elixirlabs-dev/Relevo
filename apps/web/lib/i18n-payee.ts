/** English and Spanish (Mexico) text for the /payee page, and the remembered language choice. */

export type Lang = "en" | "es";
export const LANG_KEY = "elivo-payee-lang";

type Status = "Paid" | "Returned" | "Failed";

export interface PayeeText {
  locale: string;
  langLabel: string;
  eyebrow: string;
  title: string;
  lede: string;
  privacy: string;
  empty: string;
  broken: string;
  sample: string;
  sampleNote: string;
  sampleError: (msg: string) => string;
  loading: string;
  checking: string;
  verified: string;
  notVerified: string;
  amount: string;
  status: string;
  statusWord: Record<Status, string>;
  paidAt: string;
  reference: string;
  account: string;
  accountEnding: (last4: string) => string;
  issuer: string;
  receipt: string;
  position: (i: number, n: number) => string;
  checksTitle: string;
  signatureOk: (issuer: string) => string;
  signatureBad: (issuer: string) => string;
  anchorOk: (when: string) => string;
  anchorBad: string;
  merkleOk: (n: number) => string;
  merkleBad: string;
  registryOk: string;
  registryBad: string;
  details: string;
  footnote: (registry: string, network: string) => string;
  noRegistry: string;
  confirmTitle: string;
  confirmHelp: string;
  clabeLabel: string;
  confirmButton: string;
  match: string;
  noMatch: (last4: string) => string;
  clabeLength: string;
}

export const PAYEE_TEXT: Record<Lang, PayeeText> = {
  en: {
    locale: "en-US",
    langLabel: "Language",
    eyebrow: "For payees · from a private link",
    title: "Your payout",
    lede: "The company that paid you sent you this link. Your browser checks it against NEAR: the payer's signature, the record they anchored on the chain, and that your payout is one of the payouts in that receipt. Nobody else's payouts are in the link.",
    privacy: "Treat this link like a payslip: anyone who has it can see this payout.",
    empty:
      "Open the link you were sent to see your payout here. This page reads the payout from the link itself: nothing is looked up by your name or account.",
    broken: "This link is broken or incomplete: ask whoever sent it to send it again.",
    sample: "See a sample payee link",
    sampleNote: "Sample link: invented payroll data, anchored on NEAR testnet.",
    sampleError: (msg) => `Could not load the sample: ${msg}`,
    loading: "Loading…",
    checking: "Checking against NEAR…",
    verified: "✓ Verified on NEAR",
    notVerified: "✗ Not verified",
    amount: "Amount",
    status: "Status",
    statusWord: { Paid: "Paid", Returned: "Returned", Failed: "Failed" },
    paidAt: "Paid at",
    reference: "SPEI tracking key (simulated)",
    account: "Account",
    accountEnding: (last4) => `ending in ${last4}`,
    issuer: "Paid by (NEAR account)",
    receipt: "Receipt",
    position: (i, n) => `payout ${i} of ${n}`,
    checksTitle: "Checks",
    signatureOk: (issuer) => `Signed by ${issuer}'s key on NEAR`,
    signatureBad: (issuer) => `Not signed by ${issuer}'s key on NEAR`,
    anchorOk: (when) => `Anchored on NEAR at ${when}`,
    anchorBad: "Not anchored on NEAR as this link says",
    merkleOk: (n) => `Your payout is one of ${n} in this receipt`,
    merkleBad: "Your payout doesn't match this receipt: the link was changed",
    registryOk: "From the receipt registry this app checks",
    registryBad: "This link is for another receipt registry or network than the one this app checks",
    details: "Technical details",
    footnote: (registry, network) =>
      `Checked against ${registry} on ${network}: the payer's keys and the anchored record come from the chain, never from the link.`,
    noRegistry: "This app has no receipt registry configured, so it cannot check payee links.",
    confirmTitle: "Confirm it's your account",
    confirmHelp:
      "Type your CLABE. It is checked here in your browser: it is never sent anywhere and never stored.",
    clabeLabel: "Your CLABE (18 digits)",
    confirmButton: "Check my account",
    match: "✓ This is your account: the payout went to this CLABE",
    noMatch: (last4) => `✗ Not this account: this payout went to an account ending in ${last4}`,
    clabeLength: "A CLABE has 18 digits.",
  },
  es: {
    locale: "es-MX",
    langLabel: "Idioma",
    eyebrow: "Para quien recibe el pago · desde un enlace privado",
    title: "Tu pago",
    lede: "La empresa que te pagó te mandó este enlace. Tu navegador lo revisa contra NEAR: la firma de quien te pagó, el registro que dejó en la cadena y que tu pago es uno de los pagos de ese recibo. El enlace no trae los pagos de nadie más.",
    privacy: "Cuida este enlace como un recibo de nómina: cualquiera que lo tenga puede ver este pago.",
    empty:
      "Abre el enlace que te mandaron para ver aquí tu pago. Esta página lee el pago del mismo enlace: no se busca nada con tu nombre ni con tu cuenta.",
    broken: "Este enlace está roto o incompleto: pide que te lo vuelvan a mandar.",
    sample: "Ver un enlace de ejemplo",
    sampleNote: "Enlace de ejemplo: datos de nómina inventados, registrados en NEAR testnet.",
    sampleError: (msg) => `No se pudo cargar el ejemplo: ${msg}`,
    loading: "Cargando…",
    checking: "Revisando en NEAR…",
    verified: "✓ Verificado en NEAR",
    notVerified: "✗ No verificado",
    amount: "Monto",
    status: "Estado",
    statusWord: { Paid: "Pagado", Returned: "Devuelto", Failed: "No se pudo pagar" },
    paidAt: "Fecha de pago",
    reference: "Clave de rastreo SPEI (simulada)",
    account: "Cuenta",
    accountEnding: (last4) => `con terminación ${last4}`,
    issuer: "Pagado por (cuenta de NEAR)",
    receipt: "Recibo",
    position: (i, n) => `pago ${i} de ${n}`,
    checksTitle: "Revisiones",
    signatureOk: (issuer) => `Firmado con la llave de ${issuer} en NEAR`,
    signatureBad: (issuer) => `No está firmado con la llave de ${issuer} en NEAR`,
    anchorOk: (when) => `Registrado en NEAR el ${when}`,
    anchorBad: "No está registrado en NEAR como dice este enlace",
    merkleOk: (n) => `Tu pago es uno de los ${n} de este recibo`,
    merkleBad: "Tu pago no coincide con este recibo: alguien modificó el enlace",
    registryOk: "Del registro de recibos que revisa esta app",
    registryBad: "Este enlace es de otro registro de recibos o de otra red, no del que revisa esta app",
    details: "Detalles técnicos",
    footnote: (registry, network) =>
      `Revisado contra ${registry} en ${network}: las llaves de quien te pagó y el registro vienen de la cadena, nunca del enlace.`,
    noRegistry:
      "Esta app no tiene un registro de recibos configurado, así que no puede revisar enlaces de pago.",
    confirmTitle: "Confirma que es tu cuenta",
    confirmHelp:
      "Escribe tu CLABE. Se revisa aquí, en tu navegador: nunca se envía a ningún lado ni se guarda.",
    clabeLabel: "Tu CLABE (18 dígitos)",
    confirmButton: "Revisar mi cuenta",
    match: "✓ Es tu cuenta: el pago se hizo a esta CLABE",
    noMatch: (last4) => `✗ No es esta cuenta: este pago se hizo a una cuenta con terminación ${last4}`,
    clabeLength: "Una CLABE tiene 18 dígitos.",
  },
};

/** The remembered choice if there is one, else Spanish when the browser language starts with "es". */
export function initialLang(stored: string | null, browser: string | undefined): Lang {
  if (stored === "en" || stored === "es") return stored;
  return browser?.toLowerCase().startsWith("es") ? "es" : "en";
}

export function readLang(storage: () => Storage | null): string | null {
  try {
    return storage()?.getItem(LANG_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveLang(storage: () => Storage | null, lang: Lang): void {
  try {
    storage()?.setItem(LANG_KEY, lang);
  } catch {}
}

/** An ISO time as a date and time in UTC, in the page's language. */
export function formatWhen(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = new Intl.DateTimeFormat(PAYEE_TEXT[lang].locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(d);
  return `${s} UTC`;
}

/** "18500.00" → "18,500.00" (exact: grouped as text, never through a float). */
export function formatAmount(amount: string): string {
  const [int, frac] = amount.split(".");
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac === undefined ? "" : `.${frac}`}`;
}
