/**
 * SPEI bank codes: CLABE digits 1-3 mapped to a short bank name.
 *
 * PARTIAL list of well-known SPEI participants. Check it against Banxico's current participant list
 * before production use; a code missing here is only a warning, never a block.
 */
export const SPEI_BANKS: Record<string, string> = {
  "002": "BANAMEX",
  "006": "BANCOMEXT",
  "009": "BANOBRAS",
  "012": "BBVA MEXICO",
  "014": "SANTANDER",
  "019": "BANJERCITO",
  "021": "HSBC",
  "030": "BAJIO",
  "032": "IXE",
  "036": "INBURSA",
  "042": "MIFEL",
  "044": "SCOTIABANK",
  "058": "BANREGIO",
  "059": "INVEX",
  "062": "AFIRME",
  "072": "BANORTE",
  "106": "BANK OF AMERICA",
  "127": "AZTECA",
  "130": "COMPARTAMOS",
  "137": "BANCOPPEL",
  "166": "BANCO DEL BIENESTAR",
  "638": "NU MEXICO",
  "646": "STP",
  "699": "FONDEADORA",
  "722": "MERCADO PAGO",
};

export function bankForClabe(clabe: string): string | null {
  return SPEI_BANKS[clabe.slice(0, 3)] ?? null;
}
