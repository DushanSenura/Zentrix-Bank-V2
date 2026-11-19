import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** Uniform error body: { code, message, fields?, requestId }. Internals are never leaked on 5xx. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(ex: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const requestId = randomUUID().replace(/-/g, '');
    if (ex instanceof HttpException) {
      const status = ex.getStatus();
      const raw = ex.getResponse();
      const o = typeof raw === 'object' ? (raw as Record<string, unknown>) : { message: raw };
      const inner = (o.message && typeof o.message === 'object' ? o.message : o) as Record<string, unknown>;
      res.status(status).json({
        code: (inner.code as string) ?? (o.code as string) ?? HttpStatus[status]?.toLowerCase() ?? 'error',
        message: typeof inner.message === 'string' ? inner.message : ex.message,
        ...(inner.fields ? { fields: inner.fields } : {}),
        ...(inner.checks ? { checks: inner.checks } : {}),
        ...(inner.status ? { status: inner.status } : {}),
        requestId,
      });
      return;
    }
    this.log.error(`requestId=${requestId} ${ex instanceof Error ? ex.name : 'unknown'}`);
    res.status(500).json({ code: 'internal_error', message: 'Something went wrong on our side', requestId });
  }
}
