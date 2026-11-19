import PDFDocument from 'pdfkit';

export type Lang = 'en' | 'si' | 'ta';
export const LANGS: Lang[] = ['en', 'si', 'ta'];

/**
 * Document labels. Sinhala and Tamil strings are drafted for the simulation and MUST be reviewed by a native speaker
 * before any real use. Customer data (names, merchants) is never translated, only the fixed labels.
 */
export const LABELS: Record<Lang, Record<string, string>> = {
  en: {
    bank: 'Zentrix Bank', statement: 'Account statement', period: 'Period', account: 'Account', holder: 'Account holder', opening: 'Opening balance', closing: 'Closing balance',
    date: 'Date', reference: 'Reference', description: 'Description', debit: 'Debit', credit: 'Credit', balance: 'Balance', page: 'Page',
    disclaimer: 'Simulation document. Not an official record. Fictional data only.', receipt: 'Payment receipt', amount: 'Amount', fee: 'Fee', total: 'Total', to: 'To', from: 'From', status: 'Status', note: 'Note', paidAt: 'Completed',
    certificate: 'Account certificate', certifies: 'This certifies that the account below was held with Zentrix Bank (simulation) on the date shown.', product: 'Product', opened: 'Opened', asOf: 'As of', certRef: 'Certificate no.',
    fdCertificate: 'Fixed deposit certificate', principal: 'Principal', rate: 'Interest rate', term: 'Term', matures: 'Maturity date', renewal: 'At maturity',
    schedule: 'Loan repayment schedule', instalment: 'No.', due: 'Due date', interest: 'Interest', paid: 'Paid', outstanding: 'Outstanding principal', noTransactions: 'No transactions in this period.',
  },
  si: {
    bank: 'සෙන්ට්‍රික්ස් බැංකුව', statement: 'ගිණුම් ප්‍රකාශය', period: 'කාල සීමාව', account: 'ගිණුම', holder: 'ගිණුම් හිමියා', opening: 'ආරම්භක ශේෂය', closing: 'අවසාන ශේෂය',
    date: 'දිනය', reference: 'යොමුව', description: 'විස්තරය', debit: 'හර', credit: 'බැර', balance: 'ශේෂය', page: 'පිටුව',
    disclaimer: 'මෙය අනුකරණ ලේඛනයකි. නිල වාර්තාවක් නොවේ. සියල්ලම ප්‍රබන්ධ දත්තයි.', receipt: 'ගෙවීම් රිසිට්පත', amount: 'මුදල', fee: 'ගාස්තුව', total: 'මුළු මුදල', to: 'ලබන්නා', from: 'යවන්නා', status: 'තත්ත්වය', note: 'සටහන', paidAt: 'සම්පූර්ණ වූ වේලාව',
    certificate: 'ගිණුම් සහතිකය', certifies: 'පහත ගිණුම දක්වා ඇති දිනයේ බැංකුවේ පැවති බව මෙයින් සහතික කෙරේ.', product: 'නිෂ්පාදනය', opened: 'විවෘත කළ දිනය', asOf: 'දිනය අනුව', certRef: 'සහතික අංකය',
    fdCertificate: 'ස්ථාවර තැන්පතු සහතිකය', principal: 'මූලික මුදල', rate: 'පොලී අනුපාතය', term: 'කාලය', matures: 'පරිණත වන දිනය', renewal: 'පරිණතයේදී',
    schedule: 'ණය ආපසු ගෙවීමේ කාලසටහන', instalment: 'අංකය', due: 'නියමිත දිනය', interest: 'පොලිය', paid: 'ගෙවූ', outstanding: 'ඉතිරි මූලික මුදල', noTransactions: 'මෙම කාලය තුළ ගනුදෙනු නැත.',
  },
  ta: {
    bank: 'ஜென்ட்ரிக்ஸ் வங்கி', statement: 'கணக்கு அறிக்கை', period: 'காலம்', account: 'கணக்கு', holder: 'கணக்கு உரிமையாளர்', opening: 'தொடக்க இருப்பு', closing: 'இறுதி இருப்பு',
    date: 'தேதி', reference: 'குறிப்பு', description: 'விவரம்', debit: 'பற்று', credit: 'வரவு', balance: 'இருப்பு', page: 'பக்கம்',
    disclaimer: 'இது உருவகப்படுத்தப்பட்ட ஆவணம். அதிகாரப்பூர்வ பதிவு அல்ல. அனைத்தும் கற்பனைத் தரவு.', receipt: 'கட்டண ரசீது', amount: 'தொகை', fee: 'கட்டணம்', total: 'மொத்தம்', to: 'பெறுநர்', from: 'அனுப்புநர்', status: 'நிலை', note: 'குறிப்பு', paidAt: 'நிறைவடைந்த நேரம்',
    certificate: 'கணக்கு சான்றிதழ்', certifies: 'கீழ்க்கண்ட கணக்கு குறிப்பிட்ட தேதியில் வங்கியில் இருந்தது என்பதை இது சான்றளிக்கிறது.', product: 'தயாரிப்பு', opened: 'தொடங்கிய தேதி', asOf: 'தேதியின்படி', certRef: 'சான்றிதழ் எண்',
    fdCertificate: 'நிலையான வைப்புச் சான்றிதழ்', principal: 'அசல்', rate: 'வட்டி விகிதம்', term: 'காலம்', matures: 'முதிர்வு தேதி', renewal: 'முதிர்வில்',
    schedule: 'கடன் திருப்பிச் செலுத்தும் அட்டவணை', instalment: 'எண்', due: 'செலுத்த வேண்டிய தேதி', interest: 'வட்டி', paid: 'செலுத்தியது', outstanding: 'நிலுவை அசல்', noTransactions: 'இந்தக் காலத்தில் பரிவர்த்தனைகள் இல்லை.',
  },
};

export const label = (lang: Lang, key: string): string => LABELS[lang][key] ?? LABELS.en[key] ?? key;

const FONT_FILES = {
  latin: ['@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff', '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff'],
  sinhala: ['@fontsource/noto-sans-sinhala/files/noto-sans-sinhala-sinhala-400-normal.woff', '@fontsource/noto-sans-sinhala/files/noto-sans-sinhala-sinhala-700-normal.woff'],
  tamil: ['@fontsource/noto-sans-tamil/files/noto-sans-tamil-tamil-400-normal.woff', '@fontsource/noto-sans-tamil/files/noto-sans-tamil-tamil-700-normal.woff'],
} as const;

type Script = keyof typeof FONT_FILES;
export const scriptOf = (s: string): Script => (/[඀-෿]/.test(s) ? 'sinhala' : /[஀-௿]/.test(s) ? 'tamil' : 'latin');

const charScript = (c: string): Script | null => (/[඀-෿‌‍]/.test(c) ? 'sinhala' : /[஀-௿]/.test(c) ? 'tamil' : /[A-Za-z0-9]/.test(c) ? 'latin' : null);

/**
 * Splits text into runs that each use ONE font. Neutral characters (spaces, punctuation) join the preceding run, so
 * "Fuel - කොළඹ" becomes a Latin run followed by a Sinhala run: each font only ever draws glyphs it actually has.
 */
export function runsOf(s: string): { text: string; script: Script }[] {
  const runs: { text: string; script: Script }[] = [];
  let pending = '';
  for (const ch of s) {
    const sc = charScript(ch);
    if (sc === null) { pending += ch; continue; }
    const last = runs[runs.length - 1];
    if (last && last.script === sc) { last.text += pending + ch; pending = ''; }
    else { runs.push({ text: (last ? pending : pending) + ch, script: sc }); pending = ''; }
  }
  if (pending) { if (runs.length) runs[runs.length - 1]!.text += pending; else runs.push({ text: pending, script: 'latin' }); }
  if (runs.length === 0) runs.push({ text: '', script: 'latin' });
  return runs;
}

/** Money for documents: "LKR 2,500.50". Integer arithmetic only. */
export function lkrText(minor: bigint | number): string {
  const v = BigInt(minor);
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? '-' : ''}LKR ${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(a % 100n).toString().padStart(2, '0')}`;
}

export const dateText = (d: Date): string => d.toISOString().slice(0, 10);

/** Thin wrapper around PDFKit with Unicode font selection per string (Latin, Sinhala, Tamil) and page management. */
export class Doc {
  readonly pdf: PDFKit.PDFDocument;
  private readonly chunks: Buffer[] = [];
  private readonly done: Promise<Buffer>;
  y = 0;
  readonly left = 48;
  readonly right: number;
  readonly bottom: number;
  private pageNo = 1;

  constructor(readonly lang: Lang, title: string, private readonly onNewPage?: (d: Doc) => void) {
    this.pdf = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: title, Author: 'Zentrix Bank (simulation)', Creator: 'Zentrix Bank V2' } });
    for (const [script, files] of Object.entries(FONT_FILES)) {
      this.pdf.registerFont(`${script}-r`, require.resolve(files[0]));
      this.pdf.registerFont(`${script}-b`, require.resolve(files[1]));
    }
    this.right = this.pdf.page.width - 48;
    this.bottom = this.pdf.page.height - 70;
    this.done = new Promise((res, rej) => {
      this.pdf.on('data', (c: Buffer) => this.chunks.push(c));
      this.pdf.on('end', () => res(Buffer.concat(this.chunks)));
      this.pdf.on('error', rej);
    });
    this.y = 48;
  }

  font(text: string, bold = false, size = 10): this {
    this.pdf.font(`${scriptOf(text)}-${bold ? 'b' : 'r'}`).fontSize(size);
    return this;
  }

  /** Draws text at (x, y) without moving the cursor. Returns the height used. */
  text(s: string, x: number, y: number, o: { bold?: boolean; size?: number; width?: number; align?: 'left' | 'right' | 'center'; color?: string } = {}): number {
    const size = o.size ?? 10;
    const width = o.width ?? this.right - x;
    this.pdf.fillColor(o.color ?? '#0b1b3b');
    const runs = runsOf(s);
    if (runs.length <= 1) {
      this.font(s, o.bold, size);
      this.pdf.text(s, x, y, { width, align: o.align ?? 'left', lineBreak: true });
      return this.pdf.heightOfString(s, { width });
    }
    // Mixed scripts: draw run by run (continued) so each run uses a font that has its glyphs.
    runs.forEach((r, i) => {
      this.pdf.font(`${r.script}-${o.bold ? 'b' : 'r'}`).fontSize(size);
      if (i === 0) this.pdf.text(r.text, x, y, { width, align: o.align ?? 'left', continued: i < runs.length - 1 });
      else this.pdf.text(r.text, { continued: i < runs.length - 1 });
    });
    this.font(runs[0]!.text, o.bold, size);
    return this.pdf.heightOfString(s, { width });
  }

  line(s: string, o: { bold?: boolean; size?: number; gap?: number; color?: string } = {}): void {
    const h = this.text(s, this.left, this.y, { ...o, width: this.right - this.left });
    this.y += h + (o.gap ?? 4);
  }

  rule(): void {
    this.pdf.moveTo(this.left, this.y).lineTo(this.right, this.y).strokeColor('#c9d3e8').lineWidth(0.7).stroke();
    this.y += 6;
  }

  header(title: string): void {
    this.text(label(this.lang, 'bank'), this.left, this.y, { bold: true, size: 16, color: '#155eef' });
    this.y += 24;
    this.line(title, { bold: true, size: 14, gap: 8 });
  }

  /** Starts a new page when fewer than `need` points remain. */
  ensure(need: number): void {
    if (this.y + need <= this.bottom) return;
    this.pdf.addPage();
    this.pageNo++;
    this.y = 48;
    this.onNewPage?.(this);
  }

  /** One table row. `cols` are [x, width, align] relative to the page; `cells` are strings. */
  row(cols: [number, number, 'left' | 'right'][], cells: string[], o: { bold?: boolean; size?: number } = {}): void {
    const size = o.size ?? 9;
    const heights = cells.map((c, i) => {
      this.font(c, o.bold, size);
      return this.pdf.heightOfString(c, { width: cols[i]![1] });
    });
    const h = Math.max(...heights, size + 2);
    this.ensure(h + 4);
    cells.forEach((c, i) => this.text(c, cols[i]![0], this.y, { bold: o.bold, size, width: cols[i]![1], align: cols[i]![2] }));
    this.y += h + 4;
  }

  async finish(): Promise<Buffer> {
    const range = this.pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      this.pdf.switchToPage(range.start + i);
      const y = this.pdf.page.height - 52;
      this.pdf.moveTo(this.left, y - 6).lineTo(this.right, y - 6).strokeColor('#c9d3e8').lineWidth(0.5).stroke();
      this.text(label(this.lang, 'disclaimer'), this.left, y, { size: 8, color: '#54627f', width: this.right - this.left - 80 });
      this.text(`${label(this.lang, 'page')} ${i + 1}/${range.count}`, this.right - 80, y, { size: 8, color: '#54627f', width: 80, align: 'right' });
    }
    this.pdf.end();
    return this.done;
  }
}
