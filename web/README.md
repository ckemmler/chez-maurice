# akita-web

A personal website that documents a thinking process. The site's architectural evolution—new sections, reorganized navigation, visual language changes—is as meaningful as its content.

## Philosophy

This is not a standard blog. Every meaningful state of the site is preservable and retrievable. A reader navigating to an earlier date sees the site exactly as it was: old templates, old structure, old content. The site's history is part of its content.

## Sections

- **Blog** — Time-stamped posts, informal register
- **Essays** — Longer-form intellectual pieces, organized thematically
- **Books** — Notes on books read, with highlights
- **Articles** — Annotated articles with comments
- **About** — Meta-documentation including the site's construction philosophy

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Deployment

The site deploys to **Cloudflare Pages** via Git integration. Every push to `main` triggers a build.

## Time-Travel Feature

Milestone snapshots are stored in **Cloudflare R2**. A Pages Function intercepts requests with `?t=YYYY-MM-DD` and serves the appropriate snapshot.

### Creating a Milestone

1. Tag the commit with a descriptive annotation:
   ```bash
   git tag -a milestone-2026-02-launch -m "Initial launch"
   git push origin milestone-2026-02-launch
   ```

2. The GitHub Actions workflow will:
   - Build the site
   - Upload to R2 under `snapshots/<tag>/`
   - Update the manifest
   - Commit the updated `milestones.json`

### Manual Snapshot Upload

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_R2_ACCESS_KEY_ID=...
export CLOUDFLARE_R2_SECRET_ACCESS_KEY=...

./scripts/upload-snapshot.sh milestone-name "Label for this milestone"
```

## Content Structure

```
src/content/
├── blog/           # One .md per post
├── books/          # One .md per book
├── articles/       # One .md per article
└── essays/         # One .md or .mdx per essay
```

### Frontmatter Schemas

**Blog post:**
```yaml
title: string
date: date
tags: string[]
draft: boolean
description: string (optional)
```

**Book:**
```yaml
title: string
author: string
date_read: date
status: read | reading | abandoned
tags: string[]
rating: 1-5 (optional)
```

**Article:**
```yaml
title: string
author: string (optional)
source: string
url: string
date_read: date
tags: string[]
```

**Essay:**
```yaml
title: string
date: date
last_updated: date (optional)
tags: string[]
section: string
draft: boolean
description: string (optional)
```

## Akita Integration

The site is a downstream artifact of the Akita knowledge system. The `scripts/import-from-akita.ts` stub shows how content can be auto-generated from Akita sources.

## Required Secrets (GitHub Actions)

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`

## Local Development with Time-Travel

To test the time-travel feature locally:

```bash
npm run build
npm run pages:dev
```

This requires an R2 bucket with snapshots. For pure local development without R2, use `npm run preview`.
