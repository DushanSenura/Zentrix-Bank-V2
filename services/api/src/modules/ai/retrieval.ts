import type { Passage } from './knowledge';

const STOP = new Set('a an the and or but of to in on for with is are was were be been it its this that these those i me my we our you your can could do does did how what when where why which who will would should may might not no yes at as by from about into if so than then there their they them have has had get got want need please'.split(' '));
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');
export const tokens = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

export interface Hit { passage: Passage; score: number }

/** TF-IDF retrieval over the approved passages. Deterministic and runs without any AI service. */
export function retrieve(question: string, docs: Passage[], k = 3, minScore = 0.15): Hit[] {
  const q = [...new Set(tokens(question))];
  if (q.length === 0) return [];
  const docTokens = docs.map((d) => tokens(`${d.title} ${d.title} ${d.text}`));
  const df = new Map<string, number>();
  for (const t of docTokens) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const hits = docs.map((passage, i) => {
    const t = docTokens[i]!;
    let score = 0;
    for (const w of q) {
      const tf = t.filter((x) => x === w).length;
      if (tf > 0) score += (1 + Math.log(tf)) * Math.log(1 + docs.length / (df.get(w) ?? 1));
    }
    return { passage, score: score / Math.sqrt(t.length || 1) };
  });
  return hits.filter((h) => h.score >= minScore).sort((a, b) => b.score - a.score).slice(0, k);
}
