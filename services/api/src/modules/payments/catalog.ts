/** Sample (fictional) biller catalogue. Real billers would be onboarded through a licensed aggregator. */
export interface Biller {
  code: string;
  name: string;
  category: string;
}

export const BILLERS: Biller[] = [
  { code: 'ELEC-01', name: 'Island Power (sample)', category: 'Electricity' },
  { code: 'WATER-01', name: 'National Water (sample)', category: 'Water' },
  { code: 'TEL-01', name: 'Lanka Mobile (sample)', category: 'Telephone & mobile' },
  { code: 'TEL-02', name: 'Ceylon Telecom (sample)', category: 'Telephone & mobile' },
  { code: 'NET-01', name: 'FibreNet (sample)', category: 'Internet' },
  { code: 'TV-01', name: 'SkyView TV (sample)', category: 'Television' },
  { code: 'INS-01', name: 'Safeguard Insurance (sample)', category: 'Insurance' },
  { code: 'EDU-01', name: 'Bright Future College (sample)', category: 'Education' },
  { code: 'CC-01', name: 'Credit card payment (sample)', category: 'Credit cards' },
  { code: 'GOV-01', name: 'Municipal Council (sample)', category: 'Government & rates' },
  { code: 'OTH-01', name: 'Community Fund (sample)', category: 'Other' },
];

/** Fictional banks for the simulation. The codes are stored with saved recipients and payments, so they never change; names can. */
export const SIMULATED_BANKS = [
  { code: 'SIM-BANK-A', name: 'Lanka Heritage Bank (sample)' },
  { code: 'SIM-BANK-B', name: 'Island Commerce Bank (sample)' },
  { code: 'SIM-BANK-C', name: 'Ceylon Trust Bank (sample)' },
  { code: 'SIM-BANK-D', name: 'Serendib Savings Bank (sample)' },
  { code: 'SIM-BANK-E', name: 'Lotus National Bank (sample)' },
  { code: 'SIM-BANK-F', name: 'Pearl Union Bank (sample)' },
] as const;

export const bankName = (code: string) => (code === 'ZENTRIX' ? 'Zentrix Bank' : SIMULATED_BANKS.find((b) => b.code === code)?.name ?? code);

/**
 * Zentrix QR payload. It carries IDENTITY ONLY (account number) - never an amount or balance - and anything that is
 * not exactly this format (e.g. a foreign payment QR) is refused. Real national QR standards would be added behind
 * an explicit integration interface.
 */
export const encodeQr = (accountNumber: string): string => `ZENTRIX1|${accountNumber}`;
export function parseQr(payload: string): string | null {
  const m = /^ZENTRIX1\|(\d{11})$/.exec(payload.trim());
  return m ? m[1]! : null;
}
