/** en/sk templates for auth and alert emails (spec 01 §2 `mail/`). Plain text; no tracking. */
export type MailLocale = 'en' | 'sk';

export interface RenderedEmail {
  subject: string;
  text: string;
}

export type EmailTemplate =
  | { kind: 'login_code'; code: string; expiresInMinutes: number }
  | { kind: 'signup_code'; code: string; expiresInMinutes: number }
  | { kind: 'invite'; inviterName: string | null; link: string; expiresAt: Date }
  | { kind: 'alert'; title: string; detail: string; firstAt: Date };

export function renderEmail(template: EmailTemplate, locale: MailLocale): RenderedEmail {
  const sk = locale === 'sk';
  switch (template.kind) {
    case 'login_code':
      return sk
        ? {
            subject: 'Váš prihlasovací kód do Bantoozi',
            text: `Váš prihlasovací kód je ${template.code}.\n\nKód platí ${template.expiresInMinutes} minút. Ak ste o prihlásenie nežiadali, tento e-mail ignorujte.\n`,
          }
        : {
            subject: 'Your Bantoozi sign-in code',
            text: `Your sign-in code is ${template.code}.\n\nIt expires in ${template.expiresInMinutes} minutes. If you did not try to sign in, ignore this email.\n`,
          };
    case 'signup_code':
      return sk
        ? {
            subject: 'Potvrďte svoj účet v Bantoozi',
            text: `Váš overovací kód je ${template.code}.\n\nKód platí ${template.expiresInMinutes} minút. Ak ste sa neregistrovali, tento e-mail ignorujte.\n`,
          }
        : {
            subject: 'Confirm your Bantoozi account',
            text: `Your confirmation code is ${template.code}.\n\nIt expires in ${template.expiresInMinutes} minutes. If you did not sign up, ignore this email.\n`,
          };
    case 'invite': {
      const who = template.inviterName;
      const until = template.expiresAt.toISOString().slice(0, 10);
      return sk
        ? {
            subject: 'Pozvánka do Bantoozi',
            text: `${who === null ? 'Dostali ste' : `${who} vám posiela`} pozvánku do Bantoozi, čítačky feedov s vkusom.\n\nPrijať pozvánku: ${template.link}\n\nPozvánka platí do ${until}.\n`,
          }
        : {
            subject: "You're invited to Bantoozi",
            text: `${who === null ? 'You have been' : `${who} has`} invited you to Bantoozi, a feed reader with a taste.\n\nAccept the invite: ${template.link}\n\nThe invite is valid until ${until}.\n`,
          };
    }
    case 'alert':
      return sk
        ? {
            subject: `Bantoozi upozornenie: ${template.title}`,
            text: `${template.detail}\n\nPrvýkrát zaznamenané: ${template.firstAt.toISOString()}\n`,
          }
        : {
            subject: `Bantoozi alert: ${template.title}`,
            text: `${template.detail}\n\nFirst seen: ${template.firstAt.toISOString()}\n`,
          };
  }
}
