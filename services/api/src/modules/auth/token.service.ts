import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { ENV, type Env } from '../../config/env';

export interface AccessClaims {
  sub: string;
  sid: string;
}

/** Short-lived access JWTs. Revocation is enforced by checking the session row on every request (see AuthGuard). */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;
  constructor(@Inject(ENV) private readonly env: Env) {
    this.key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
  }

  sign(userId: string, sessionId: string): Promise<string> {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer('zentrix-api')
      .setAudience('zentrix-clients')
      .setIssuedAt()
      .setExpirationTime(`${this.env.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: 'zentrix-api', audience: 'zentrix-clients', algorithms: ['HS256'] });
      return typeof payload.sub === 'string' && typeof payload.sid === 'string' ? { sub: payload.sub, sid: payload.sid } : null;
    } catch {
      return null;
    }
  }
}
