import { z } from 'zod';
import { HttpError } from './errors.js';

const userSchema = z.object({ id: z.string().min(1).max(256), email: z.email(), nickname: z.string().min(1).max(256), approved: z.literal(true) });
const grantSchema = z.object({ session_id: z.string().min(1).max(512), expires_at: z.number().int().positive(), user: userSchema });
const introspectionSchema = z.discriminatedUnion('active', [z.object({ active: z.literal(false) }), z.object({ active: z.literal(true), expires_at: z.number().int().positive(), user: userSchema })]);
export type IdentityGrant = z.infer<typeof grantSchema>;
export type Introspection = z.infer<typeof introspectionSchema>;
export interface IdentityProvider {
  readonly origin: string;
  readonly callback: string;
  exchange(code: string, verifier: string): Promise<IdentityGrant>;
  introspect(sessionId: string): Promise<Introspection>;
  revoke(sessionId: string): Promise<void>;
}

export class AccountsProvider implements IdentityProvider {
  readonly origin: string;
  readonly callback: string;
  private readonly base: string;
  private readonly secret: string;

  constructor(publicUrl: string) {
    const origin = process.env.OVERROOT_IDENTITY_ORIGIN;
    const secret = process.env.OVERROOT_IDENTITY_CLIENT_SECRET;
    if (!origin || !secret) throw new Error('Shared account configuration is required; local password auth is disabled');
    if (secret.length < 32) throw new Error('OVERROOT_IDENTITY_CLIENT_SECRET must contain at least 32 characters');
    const issuer = new URL(origin);
    const base = new URL(process.env.OVERROOT_IDENTITY_BASE_URL ?? origin);
    if (issuer.origin !== origin || issuer.protocol !== 'https:' || issuer.username || issuer.password ||
        base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
        !(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)))) {
      throw new Error('Invalid identity origin/backchannel URL');
    }
    const app = new URL(publicUrl);
    if (app.origin !== publicUrl || app.protocol !== 'https:') throw new Error('Identity callback requires an exact HTTPS app origin');
    this.origin = origin;
    this.callback = `${publicUrl}/api/v1/auth/callback`;
    this.base = base.origin;
    this.secret = secret;
  }

  private async call(endpoint: string, input: Record<string, string>): Promise<unknown> {
    try {
      const response = await fetch(`${this.base}/api/accounts/${endpoint}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/json', 'X-Accounts-Client-Key': this.secret, Host: new URL(this.origin).host },
        body: JSON.stringify({ client_id: 'overroot', ...input })
      });
      if (!response.ok) throw new Error('Identity provider rejected request');
      // Bound even a malformed provider response, without buffering an unlimited body.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty identity response');
      let body = '';
      let size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 16_384) throw new Error('Oversized identity response');
          body += decoder.decode(part.value, { stream: true });
        }
        return JSON.parse(body + decoder.decode());
      } finally { await reader.cancel(); }
    } catch {
      throw unavailable();
    }
  }

  async exchange(code: string, verifier: string): Promise<IdentityGrant> {
    const result = grantSchema.safeParse(await this.call('token', { grant_type: 'authorization_code', redirect_uri: this.callback, code, code_verifier: verifier }));
    if (!result.success || result.data.expires_at * 1000 <= Date.now()) throw unavailable();
    return result.data;
  }
  async introspect(sessionId: string): Promise<Introspection> {
    const result = introspectionSchema.safeParse(await this.call('introspect', { session_id: sessionId }));
    if (!result.success) throw unavailable();
    return result.data;
  }
  async revoke(sessionId: string): Promise<void> {
    const result = await this.call('revoke', { session_id: sessionId });
    if (!z.object({ ok: z.literal(true) }).safeParse(result).success) throw unavailable();
  }
}
export function unavailable(): HttpError {
  return new HttpError(503, 'Shared accounts are temporarily unavailable. Try again shortly.', 'identity_unavailable');
}
