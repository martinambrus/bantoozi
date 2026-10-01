# Exposing the rating server through a tunnel

The rating server (`pnpm evaluate serve-rating`, spec 10 §2.4) runs on the owner's dev box next to
the dedicated golden database. It binds to `127.0.0.1:5180` only and is never deployed. Raters reach
it through an HTTPS tunnel. This page shows how to set that up.

## Before you start

- The golden database runs on this machine with an ingest-only worker (`EVAL_INGEST_ONLY=true`), and
  `eval status` shows the sample. No ordinary development worker may use this database (D-96).
- `.env` has `DATABASE_URL_WORKER` pointing at the golden database.
- Rater links are built from `EVAL_PUBLIC_URL`. Set it to the tunnel's public HTTPS address
  **before** running `eval rater add` or `eval rater token`. With an `https://` address the session
  cookie is marked `Secure`.

## Setting up the golden database (once)

The golden database is a separate database on the dev box's PostgreSQL, never the everyday
development database. As the PostgreSQL superuser, create it with the same extensions and grants as
`infra/postgres/init.sh`:

```sql
CREATE DATABASE bantoozi_golden OWNER bantoozi_owner;
\connect bantoozi_golden
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO bantoozi_owner;
REVOKE ALL ON DATABASE bantoozi_golden FROM PUBLIC;
GRANT CONNECT ON DATABASE bantoozi_golden TO bantoozi_app, bantoozi_worker;
```

Then, with an env file whose `DATABASE_URL*` variables point at `bantoozi_golden` and with
`EVAL_INGEST_ONLY=true`:

```sh
pnpm db:migrate && pnpm db:seed
pnpm --filter @bantoozi/worker dev          # the only worker on this database, ingest-only
pnpm evaluate ingest-sample --dry-run       # every feed reachable from this machine?
pnpm evaluate ingest-sample                 # subscribe, fetch once, wait for extraction
pnpm evaluate sample --version golden-v1    # draw and split the sample
pnpm evaluate status
```

Keep the worker running while raters work, so `ingest-sample --watch` and the assignment top-ups
see fresh articles.

## Option A: Cloudflare Tunnel (recommended)

1. Install `cloudflared` from Cloudflare's downloads page and log in: `cloudflared tunnel login`.
2. Create a named tunnel and a DNS name for it:
   ```sh
   cloudflared tunnel create bantoozi-eval
   cloudflared tunnel route dns bantoozi-eval rate.example.com
   ```
3. Write `~/.cloudflared/config.yml`, which forwards only to the loopback rating server:
   ```yaml
   tunnel: bantoozi-eval
   credentials-file: /home/<you>/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: rate.example.com
       service: http://127.0.0.1:5180
     - service: http_status:404
   ```
4. Optional but recommended: put a Cloudflare Access policy (for example one-time PIN to the
   raters' email addresses) in front of `rate.example.com`. The rater token still applies inside.
5. Start both processes:
   ```sh
   EVAL_PUBLIC_URL=https://rate.example.com pnpm evaluate serve-rating
   cloudflared tunnel run bantoozi-eval
   ```

For a short session without a domain, `cloudflared tunnel --url http://127.0.0.1:5180` prints a
temporary `https://….trycloudflare.com` address. It changes on every start, so the links you already
sent stop working; reissue them with `eval rater token <id>` after setting `EVAL_PUBLIC_URL`.

## Option B: Tailscale Funnel

If the raters are on your tailnet, `tailscale serve --bg 5180` exposes the server to them only.
For raters outside it, `tailscale funnel --bg 5180` publishes `https://<machine>.<tailnet>.ts.net`.
Set `EVAL_PUBLIC_URL` to that address.

## Adding raters and sending links

```sh
pnpm evaluate rater add --name owner --langs sk,en --context "web development"
pnpm evaluate rater add --name owner --langs sk,en --participant <key printed above> --context cooking
```

Each command prints a private link `${EVAL_PUBLIC_URL}/r?t=<token>`. Send it to the rater over a
private channel. The token is shown once; only its hash is stored. Links expire after 30 days
(`--token-days <n>` changes that). `eval rater token <id>` issues a new link and ends every session of
the old one; `eval rater revoke <id>` ends access at once. Neither touches cards or ratings.

## Safety checklist

- The server binds to loopback; the tunnel forwards one hostname to it and returns 404 for anything
  else. Do not open port 5180 on the router or firewall.
- Never paste rater links into chats, issues or pull requests.
- Stop the tunnel when rating is paused.
- Back up the golden database with a complete `pg_dump -Fc` (not `pg_dump -n eval`, which cannot
  restore its foreign keys) and keep dumps, the eval cache and tokens out of git.
