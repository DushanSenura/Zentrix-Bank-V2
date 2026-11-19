/** A text-in, text-out model. It has no tools and no access to banking services: the only thing it can do is return words. */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(i: { system: string; user: string; maxTokens: number }): Promise<string>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  constructor(private readonly apiKey: string, readonly model: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async complete(i: { system: string; user: string; maxTokens: number }): Promise<string> {
    const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.model, max_tokens: i.maxTokens, system: i.system, messages: [{ role: 'user', content: i.user }] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`AI provider responded ${res.status}`); // never include the body: it may echo prompt content
    const j = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim();
    if (!text) throw new Error('AI provider returned no text');
    return text;
  }
}

/** Null when no key is configured: the AI features then report themselves as off instead of pretending. */
export function createProvider(env: { ANTHROPIC_API_KEY?: string; AI_MODEL?: string }): AiProvider | null {
  return env.ANTHROPIC_API_KEY ? new AnthropicProvider(env.ANTHROPIC_API_KEY, env.AI_MODEL ?? 'claude-haiku-5-5') : null;
}
