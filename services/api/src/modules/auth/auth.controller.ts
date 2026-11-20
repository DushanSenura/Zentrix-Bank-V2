import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentUser, Public, type AuthUser } from './auth.decorators';
import { AuthService, type ClientContext } from './auth.service';

const strict = { default: { limit: 10, ttl: 60_000 } };
const ctxOf = (r: Request): ClientContext => ({ ip: r.ip, userAgent: r.headers['user-agent'] });

const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{3,30}$/, '3-30 letters, digits, _ or .'),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().regex(/^\+?[0-9 ]{7,16}$/).optional(),
  password: z.string().max(128),
});
const loginSchema = z.object({ identifier: z.string().trim().min(1).max(200), password: z.string().min(1).max(128), mfaCode: z.string().length(6).optional(), recoveryCode: z.string().min(8).max(14).optional() });
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });
const resetRequestSchema = z.object({ identifier: z.string().trim().min(1).max(200) });
const resetConfirmSchema = z.object({ token: z.string().min(20).max(200), newPassword: z.string().max(128) });

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Throttle(strict) @Post('register')
  register(@Body(new ZodPipe(registerSchema)) b: z.infer<typeof registerSchema>, @Req() r: Request) {
    return this.auth.register(b, ctxOf(r));
  }

  @Public() @Throttle(strict) @HttpCode(200) @Post('login')
  login(@Body(new ZodPipe(loginSchema)) b: z.infer<typeof loginSchema>, @Req() r: Request) {
    return this.auth.login(b, ctxOf(r));
  }

  @Public() @Throttle(strict) @HttpCode(200) @Post('refresh')
  refresh(@Body(new ZodPipe(refreshSchema)) b: z.infer<typeof refreshSchema>) {
    return this.auth.refresh(b.refreshToken);
  }

  @HttpCode(204) @Post('logout')
  async logout(@CurrentUser() u: AuthUser) {
    await this.auth.logout(u.sessionId, u.id);
  }

  @Public() @Throttle(strict) @HttpCode(202) @Post('password-reset/request')
  async resetRequest(@Body(new ZodPipe(resetRequestSchema)) b: z.infer<typeof resetRequestSchema>) {
    await this.auth.requestPasswordReset(b.identifier);
    return { status: 'accepted' };
  }

  @Public() @Throttle(strict) @HttpCode(204) @Post('password-reset/confirm')
  async resetConfirm(@Body(new ZodPipe(resetConfirmSchema)) b: z.infer<typeof resetConfirmSchema>) {
    await this.auth.confirmPasswordReset(b.token, b.newPassword);
  }
}
