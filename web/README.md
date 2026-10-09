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

A garden's public site is published to **Cloudflare Pages** by `scripts/publish-web.sh` (build, then `wrangler pages deploy`). Nothing is deployed on a push.

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
