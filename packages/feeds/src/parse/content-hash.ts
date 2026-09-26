import { canonicalSha256, sha256Hex } from '@bantoozi/shared/server';

/** The model inputs covered by `content_hash` (spec 03 §6.2). */
export interface ContentHashInput {
  /** Cleaned, case-preserving title. */
  title: string;
  /** Plain-text excerpt. */
  excerpt: string | null;
  author: string | null;
  categories: readonly string[];
  /** The selected article link. */
  link: string | null;
  /** Full feed body text; only its SHA-256 enters the hash. */
  feedBodyText: string | null;
}

/**
 * `content_hash` (spec 03 §6.2): SHA-256 of the canonical JSON (sorted keys) of
 * `{author, body_sha256, categories, excerpt, link, title}`, where the title is case- and
 * diacritic-preserving, `categories` are sorted by code unit and `body_sha256` is the SHA-256 of
 * `feedBodyText` when present (else `null`). It detects changes to model inputs, including
 * corrections beyond the excerpt, not article identity.
 */
export function computeContentHash(input: ContentHashInput): string {
  return canonicalSha256({
    title: input.title,
    excerpt: input.excerpt,
    author: input.author,
    categories: [...input.categories].sort(),
    link: input.link,
    body_sha256: input.feedBodyText === null ? null : sha256Hex(input.feedBodyText),
  });
}
