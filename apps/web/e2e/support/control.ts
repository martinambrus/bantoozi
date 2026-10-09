import { URLS, type FeedKey } from './env.js';

/**
 * Typed client of the E2E control API (packages/testing/src/e2e/control.ts). Specs reach the
 * fixture feeds, the fake TypeSafe server and named database queries only through it.
 */

export interface FeedItem {
  slug: string;
  guid: string;
  title: string;
  excerpt: string;
  topic: string;
  /** The article page. */
  url: string;
  imageUrl: string | null;
  publishedAt: string;
}

export interface FeedView {
  key: FeedKey;
  title: string;
  origin: string;
  /** The feed document a reader subscribes to. */
  url: string;
  /** Catalogue and appended items, newest first. */
  items: FeedItem[];
}

export interface NewFeedItem {
  title: string;
  excerpt?: string;
  slug?: string;
  topic?: string;
  /** Serve a PNG for the item and reference it from the feed. */
  image?: boolean;
  /** ISO 8601; default: now. */
  publishedAt?: string;
}

export interface FeedRequest {
  method: string;
  path: string;
  at: string;
  userAgent: string | null;
  referer: string | null;
}

export interface FakeOptions {
  latencyMs?: number;
  failRate?: number;
  /** 400-599. */
  failStatus?: number;
  /** A string requires `Authorization: Bearer <apiKey>`; null lifts the requirement. */
  apiKey?: string | null;
}

export interface FakeOptionsView {
  latencyMs: number;
  failRate: number;
  failStatus: number | null;
  apiKeyRequired: boolean;
}

export interface ArticleState {
  id: string;
  title: string;
  pipelineState: string;
  contentRevision: string;
}

export class ControlError extends Error {
  override readonly name = 'ControlError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

export class Control {
  constructor(private readonly base: string = URLS.control) {}

  private async send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } }).error;
      throw new ControlError(
        response.status,
        error?.code ?? 'unknown',
        `${method} ${path}: ${error?.message ?? response.statusText}`,
      );
    }
    return payload as T;
  }

  async workerReady(): Promise<boolean> {
    const response = await fetch(`${this.base}/worker-ready`);
    return response.ok;
  }

  async feeds(): Promise<Record<FeedKey, FeedView>> {
    return (await this.send<{ feeds: Record<FeedKey, FeedView> }>('GET', '/feeds')).feeds;
  }

  async feed(key: FeedKey): Promise<FeedView> {
    return (await this.feeds())[key];
  }

  async appendItem(key: FeedKey, item: NewFeedItem): Promise<FeedItem> {
    return this.send<FeedItem>('POST', `/feeds/${key}/items`, item);
  }

  /** Answers `path` of a feed's origin with `status` (400-599) from now on, or normally again for null. */
  async scriptRoute(key: FeedKey, path: string, status: number | null): Promise<void> {
    await this.send<Json>('POST', `/feeds/${key}/routes`, { path, status });
  }

  async feedRequests(key: FeedKey): Promise<FeedRequest[]> {
    return (await this.send<{ requests: FeedRequest[] }>('GET', `/feeds/${key}/requests`)).requests;
  }

  /** Requests the fake TypeSafe server has received since the last `reset()`. */
  async fakeCount(): Promise<number> {
    return (await this.send<{ count: number }>('GET', '/fake')).count;
  }

  async setFakeOptions(options: FakeOptions): Promise<FakeOptionsView> {
    return (await this.send<{ options: FakeOptionsView }>('POST', '/fake/options', options))
      .options;
  }

  /** Drops appended items, scripted routes and request logs; restores the fake's options and count. */
  async reset(): Promise<void> {
    await this.send<Json>('POST', '/reset', {});
  }

  async articleStates(feedUrl: string): Promise<ArticleState[]> {
    return this.sql<ArticleState[]>('articleStates', { feedUrl });
  }

  /** Runs the named SQL hook on the run's database. */
  async sql<T>(hook: string, params: Json): Promise<T> {
    return this.send<T>('POST', `/sql/${encodeURIComponent(hook)}`, params);
  }
}
