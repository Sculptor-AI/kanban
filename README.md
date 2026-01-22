# Kanban

A lightweight, real-time kanban board application built on Cloudflare Workers.

## Features

- Board, list, and card management
- Real-time collaboration via WebSockets
- User authentication with invite-only registration
- Member management and access control
- Labels and card assignments
- GitHub issue/PR linking
- Profile picture uploads

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2
- **Real-time**: Durable Objects with WebSocket Hibernation
- **Framework**: Hono

## Development

```bash
npm install
npm run dev
```

## Deployment

Deployments are handled automatically via GitHub Actions on push to main.

Required secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Required Cloudflare resources:
- D1 database named `kanban-db`
- R2 bucket named `kanban-storage`
- Custom domain configured for `tasks.sculptorai.org`

## Environment Setup

Set the following secrets in Cloudflare:

```bash
wrangler secret put JWT_SECRET
wrangler secret put INVITE_KEY_SALT
```

Generate invite keys by inserting into the `invite_keys` table with a SHA-256 hash of the key.

## License

Proprietary - Sculptorai
