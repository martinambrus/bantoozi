/**
 * en/sk templates for auth, invite and alert emails (spec 01 §2 `mail/`, spec 08 §2.1). Every email
 * has a plain-text and an HTML part; no tracking, no remote images. Every interpolated value is
 * HTML-escaped in the HTML part.
 */
export type MailLocale = 'en' | 'sk';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export type EmailTemplate =
  | { kind: 'login_code'; code: string; expiresInMinutes: number }
  | { kind: 'signup_code'; code: string; expiresInMinutes: number }
  /** An unknown email asked for a code while signup is invite-only (spec 08 §2.1). */
  | { kind: 'invite_only'; waitlistUrl: string }
  | { kind: 'invite'; inviterName: string | null; link: string; expiresAt: Date }
  | { kind: 'alert'; title: string; detail: string; firstAt: Date };

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** One block of the HTML body; every string is escaped when rendered. */
type Block = { p: string } | { code: string } | { link: string; label: string };

function renderHtml(locale: MailLocale, subject: string, blocks: readonly Block[]): string {
  const body = blocks
    .map((block) => {
      if ('p' in block) return `<p>${escapeHtml(block.p)}</p>`;
      if ('code' in block) {
        return `<p style="font-size:28px;font-weight:bold;letter-spacing:4px;font-family:monospace">${escapeHtml(block.code)}</p>`;
      }
      return `<p><a href="${escapeHtml(block.link)}">${escapeHtml(block.label)}</a></p>`;
    })
    .join('\n');
  return [
    '<!doctype html>',
    `<html lang="${locale}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>`,
    '<body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a">',
    body,
    '</body></html>',
    '',
  ].join('\n');
}

function email(
  locale: MailLocale,
  subject: string,
  text: string,
  blocks: readonly Block[],
): RenderedEmail {
  return { subject, text, html: renderHtml(locale, subject, blocks) };
}

export function renderEmail(template: EmailTemplate, locale: MailLocale): RenderedEmail {
  const sk = locale === 'sk';
  switch (template.kind) {
    case 'login_code': {
      const minutes = template.expiresInMinutes;
      if (sk) {
        const note = `Kód platí ${minutes} minút. Ak ste o prihlásenie nežiadali, tento e-mail ignorujte.`;
        return email(
          locale,
          'Váš prihlasovací kód do Bantoozi',
          `Váš prihlasovací kód je ${template.code}.\n\n${note}\n`,
          [{ p: 'Váš prihlasovací kód je:' }, { code: template.code }, { p: note }],
        );
      }
      const note = `It expires in ${minutes} minutes. If you did not try to sign in, ignore this email.`;
      return email(
        locale,
        'Your Bantoozi sign-in code',
        `Your sign-in code is ${template.code}.\n\n${note}\n`,
        [{ p: 'Your sign-in code is:' }, { code: template.code }, { p: note }],
      );
    }
    case 'signup_code': {
      const minutes = template.expiresInMinutes;
      if (sk) {
        const note = `Kód platí ${minutes} minút. Ak ste sa neregistrovali, tento e-mail ignorujte.`;
        return email(
          locale,
          'Potvrďte svoj účet v Bantoozi',
          `Váš overovací kód je ${template.code}.\n\n${note}\n`,
          [{ p: 'Váš overovací kód je:' }, { code: template.code }, { p: note }],
        );
      }
      const note = `It expires in ${minutes} minutes. If you did not sign up, ignore this email.`;
      return email(
        locale,
        'Confirm your Bantoozi account',
        `Your confirmation code is ${template.code}.\n\n${note}\n`,
        [{ p: 'Your confirmation code is:' }, { code: template.code }, { p: note }],
      );
    }
    case 'invite_only': {
      if (sk) {
        const intro =
          'Niekto (možno vy) sa pokúsil prihlásiť do Bantoozi s touto adresou. Bantoozi je zatiaľ len na pozvánky.';
        const outro = 'Ak ste to neboli vy, tento e-mail ignorujte.';
        return email(
          locale,
          'Bantoozi je zatiaľ len na pozvánky',
          `${intro}\n\nZapíšte sa do poradovníka a pošleme vám pozvánku: ${template.waitlistUrl}\n\n${outro}\n`,
          [
            { p: intro },
            { link: template.waitlistUrl, label: 'Zapísať sa do poradovníka' },
            { p: outro },
          ],
        );
      }
      const intro =
        'Someone (perhaps you) tried to sign in to Bantoozi with this address. Bantoozi is invite-only for now.';
      const outro = 'If this was not you, ignore this email.';
      return email(
        locale,
        'Bantoozi is invite-only',
        `${intro}\n\nJoin the waitlist and we will send you an invite: ${template.waitlistUrl}\n\n${outro}\n`,
        [{ p: intro }, { link: template.waitlistUrl, label: 'Join the waitlist' }, { p: outro }],
      );
    }
    case 'invite': {
      const who = template.inviterName;
      const until = template.expiresAt.toISOString().slice(0, 10);
      if (sk) {
        const intro = `${who === null ? 'Dostali ste' : `${who} vám posiela`} pozvánku do Bantoozi, čítačky feedov s vkusom.`;
        return email(
          locale,
          'Pozvánka do Bantoozi',
          `${intro}\n\nPrijať pozvánku: ${template.link}\n\nPozvánka platí do ${until}.\n`,
          [
            { p: intro },
            { link: template.link, label: 'Prijať pozvánku' },
            { p: `Pozvánka platí do ${until}.` },
          ],
        );
      }
      const intro = `${who === null ? 'You have been' : `${who} has`} invited you to Bantoozi, a feed reader with a taste.`;
      return email(
        locale,
        "You're invited to Bantoozi",
        `${intro}\n\nAccept the invite: ${template.link}\n\nThe invite is valid until ${until}.\n`,
        [
          { p: intro },
          { link: template.link, label: 'Accept the invite' },
          { p: `The invite is valid until ${until}.` },
        ],
      );
    }
    case 'alert': {
      const first = template.firstAt.toISOString();
      return sk
        ? email(
            locale,
            `Bantoozi upozornenie: ${template.title}`,
            `${template.detail}\n\nPrvýkrát zaznamenané: ${first}\n`,
            [{ p: template.detail }, { p: `Prvýkrát zaznamenané: ${first}` }],
          )
        : email(
            locale,
            `Bantoozi alert: ${template.title}`,
            `${template.detail}\n\nFirst seen: ${first}\n`,
            [{ p: template.detail }, { p: `First seen: ${first}` }],
          );
    }
  }
}
