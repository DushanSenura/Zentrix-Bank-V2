import { describe, expect, it } from 'vitest';
import { Doc, label, LABELS, lkrText, runsOf, scriptOf } from '../src/modules/documents/pdf';

const fontNames = (pdf: Buffer): string[] => [...new Set([...pdf.toString('latin1').matchAll(/\/FontName \/[A-Z]{6}\+([A-Za-z0-9-]+)/g)].map((m) => m[1]!))];

describe('script detection and labels', () => {
  it('picks the font family by script', () => {
    expect(scriptOf('Amaya Perera')).toBe('latin');
    expect(scriptOf('අමායා පෙරේරා')).toBe('sinhala');
    expect(scriptOf('அமாயா பெரேரா')).toBe('tamil');
    expect(scriptOf('Fuel — කොළඹ')).toBe('sinhala'); // dominant script, used only for measuring
  });
  it('splits mixed text into runs so each font only draws glyphs it has', () => {
    const runs = runsOf('Fuel - කොළඹ 12');
    expect(runs.map((r) => r.script)).toEqual(['latin', 'sinhala', 'latin']);
    expect(runs.map((r) => r.text).join('')).toBe('Fuel - කොළඹ 12'); // nothing lost or duplicated
    expect(runsOf('plain text').length).toBe(1);
    expect(runsOf('').length).toBe(1);
  });
  it('every language defines every English label (no silent fallbacks)', () => {
    const keys = Object.keys(LABELS.en).sort();
    for (const lang of ['si', 'ta'] as const) {
      expect(Object.keys(LABELS[lang]).sort()).toEqual(keys);
      for (const k of keys) expect(LABELS[lang][k]!.trim().length).toBeGreaterThan(0);
      for (const k of ['statement', 'balance', 'debit', 'credit', 'disclaimer', 'receipt', 'certificate', 'schedule']) expect(label(lang, k)).not.toBe(label('en', k)); // really translated
    }
  });
  it('formats money with integer arithmetic', () => {
    expect(lkrText(250050n)).toBe('LKR 2,500.50');
    expect(lkrText(-5n)).toBe('-LKR 0.05');
    expect(lkrText(9_007_199_254_740_991n)).toBe('LKR 90,071,992,547,409.91');
  });
});

describe('PDF generation with Unicode fonts', () => {
  async function make(lang: 'en' | 'si' | 'ta', extra: string[]) {
    const d = new Doc(lang, 'Test');
    d.header(label(lang, 'statement'));
    for (const s of extra) d.line(s);
    return d.finish();
  }

  it('produces a valid, non-trivial PDF in every language', async () => {
    for (const lang of ['en', 'si', 'ta'] as const) {
      const pdf = await make(lang, ['Test line']);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(5000);
      expect(pdf.subarray(-6).toString()).toContain('%%EOF');
    }
  });

  it('embeds Sinhala and Tamil fonts when (and only when) those scripts are drawn', async () => {
    const en = fontNames(await make('en', ['Amaya Perera', 'Fuel station']));
    expect(en.some((f) => /NotoSans(?!Sinhala|Tamil)/.test(f))).toBe(true);
    expect(en.some((f) => /Sinhala|Tamil/.test(f))).toBe(false);

    const si = fontNames(await make('si', ['අමායා පෙරේරා — ඉන්ධන මධ්‍යස්ථානය']));
    expect(si.some((f) => /Sinhala/.test(f))).toBe(true);

    // a MIXED string needs both families embedded (Latin letters are not in the Sinhala font)
    const mixed = fontNames(await make('en', ['Fuel station - කොළඹ branch']));
    expect(mixed.some((f) => /Sinhala/.test(f))).toBe(true);
    expect(mixed.some((f) => /NotoSans(?!Sinhala|Tamil)/.test(f))).toBe(true);

    const ta = fontNames(await make('ta', ['அமாயா பெரேரா — எரிபொருள் நிலையம்']));
    expect(ta.some((f) => /Tamil/.test(f))).toBe(true);
  });

  it('paginates long tables and numbers every page', async () => {
    const d = new Doc('en', 'Long');
    d.header('Long table');
    const cols: [number, number, 'left' | 'right'][] = [[48, 100, 'left'], [160, 300, 'left']];
    for (let i = 0; i < 200; i++) d.row(cols, [`2026-03-${String((i % 28) + 1).padStart(2, '0')}`, `Row number ${i}`]);
    const pdf = await d.finish();
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(4);
  });
});
