import nodemailer from 'nodemailer';

import type { Logger } from '../logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly transport: 'smtp' | 'log';
  /** Bounded synchronous delivery; rejects on failure (callers report it, spec 02 §5.1). */
  send(message: EmailMessage): Promise<void>;
  /** `log` transport only: the last email, for the test-only endpoint (spec 08 §10). */
  lastEmail(): EmailMessage | undefined;
  close(): void;
}

export interface CreateMailerOptions {
  transport: 'smtp' | 'log';
  from: string;
  smtpUrl?: string | undefined;
  logger?: Logger;
  /** SMTP connection/greeting/socket timeout; delivery stays bounded. */
  timeoutMs?: number;
}

/**
 * `smtp` sends through nodemailer; `log` (development/test only, refused in production by
 * `loadConfig`) prints emails to the console and keeps the last one.
 */
export function createMailer(options: CreateMailerOptions): Mailer {
  if (options.transport === 'log') return createLogMailer(options.logger);
  if (options.smtpUrl === undefined) throw new Error('SMTP_URL is required for the smtp transport');
  const timeout = options.timeoutMs ?? 15_000;
  const transporter = nodemailer.createTransport({
    ...smtpOptionsFromUrl(options.smtpUrl),
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  });
  return {
    transport: 'smtp',
    async send(message) {
      await transporter.sendMail({
        from: options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
    lastEmail: () => undefined,
    close: () => transporter.close(),
  };
}

function createLogMailer(logger?: Logger): Mailer {
  let last: EmailMessage | undefined;
  return {
    transport: 'log',
    send(message) {
      last = { ...message };
      if (logger === undefined) {
        process.stdout.write(
          `[mail:log] to=${message.to} subject=${message.subject}\n${message.text}\n`,
        );
      } else {
        logger.info(
          { mail: { to: message.to, subject: message.subject, text: message.text } },
          'email (log transport)',
        );
      }
      return Promise.resolve();
    },
    lastEmail: () => (last === undefined ? undefined : { ...last }),
    close: () => undefined,
  };
}

/** `smtp://user:pass@host:587` / `smtps://…` → nodemailer SMTP options (credentials URL-decoded). */
export function smtpOptionsFromUrl(url: string): {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
} {
  const u = new URL(url);
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:')
    throw new Error('SMTP_URL must use smtp: or smtps:');
  const secure = u.protocol === 'smtps:';
  const port = u.port === '' ? (secure ? 465 : 587) : Number(u.port);
  const user = decodeURIComponent(u.username);
  return {
    host: u.hostname,
    port,
    secure,
    ...(user === '' ? {} : { auth: { user, pass: decodeURIComponent(u.password) } }),
  };
}
