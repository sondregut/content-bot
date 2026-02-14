# Carousel Studio

Multi-brand AI carousel generator for TikTok/Instagram. Express.js backend + vanilla JS frontend, deployed on Vercel.

## Quick Start

```bash
cd studio && npm run dev    # http://localhost:4545
```

## Architecture

- **Backend:** `studio/server.mjs` — Express API with Sharp image rendering, OpenAI image gen, Claude prompt refinement
- **Frontend:** `studio/public/` — Vanilla JS, Firebase Auth (email/password + Google)
- **Brands:** `brands/{brand-id}/` — Per-brand config (colors, content ideas, style guides, assets)
- **Legacy:** `generators/` — Standalone Node/Python scripts (pre-studio, mostly unused)

## Environment Variables

Required in `studio/.env`:
```
OPENAI_API_KEY=         # gpt-image-1.5 generation
ANTHROPIC_API_KEY=      # Claude prompt refinement + freeform content
FIREBASE_SERVICE_ACCOUNT=  # JSON string (escaped newlines)
FIREBASE_API_KEY=          # Firebase client API key
FIREBASE_AUTH_DOMAIN=      # e.g. myproject.firebaseapp.com
FIREBASE_PROJECT_ID=       # Firebase project ID
FIREBASE_STORAGE_BUCKET=   # e.g. myproject.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=  # Firebase messaging sender ID
FIREBASE_APP_ID=           # Firebase web app ID
```

## Deployment

Vercel auto-deploys from `main` branch. Config in root `vercel.json`.
- API routes: `/api/*` -> `studio/server.mjs`
- Brand assets: `/brands/*` -> served via Express
- Static: `studio/public/*`
- Temp storage on Vercel: `/tmp/output/`, `/tmp/uploads/`

## Workflow

- **Commit between implementations** — after completing each feature or fix, `git add . && git commit -m "descriptive message" && git push`. Vercel auto-deploys from main.
- Don't batch multiple unrelated changes into one commit

## Key Conventions

- **ES Modules** throughout (`import/export`, `"type": "module"`)
- **No frontend framework** — vanilla JS with direct DOM manipulation in `public/app.js`
- **Brand-scoped everything** — all generation routes require a `brand` parameter; no hardcoded defaults
- **All brands in Firestore** — no hardcoded brands; every user creates their own via the UI
- **GENERIC_BRAND** fallback — safety net for missing/invalid brand lookups
- **Open signup** — anyone can create an account (no email allowlist)
- **Firebase optional** — server runs without Firebase in local dev (no auth, local disk storage)
- **Image pipeline:** User prompt -> Claude Haiku refines -> GPT-Image-1.5 generates -> Sharp composites overlays

## API Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/firebase-config` | No | Firebase client config from env vars |
| GET | `/api/brands` | Yes | List user's Firestore brands |
| POST | `/api/brands` | Yes | Create brand in Firestore |
| PUT | `/api/brands/:id` | Yes | Update own brand |
| DELETE | `/api/brands/:id` | Yes | Delete own brand |
| POST | `/api/brands/ai-setup` | Yes | AI-generate brand config from description |
| GET | `/api/content-ideas?brand=` | Yes | Pre-written carousel templates (from `brands/{id}/content-ideas.md`) |
| POST | `/api/generate` | Yes | Generate single slide (AI or mockup) |
| POST | `/api/generate-carousel` | Yes | Batch generate with job polling |
| GET | `/api/carousel-status/:jobId` | Yes | Poll batch progress |
| POST | `/api/generate-freeform` | Yes | Claude generates slide content from natural language |
| POST | `/api/upload-reference` | Yes | Upload reference/screenshot image |
| POST | `/api/upload-icon` | Yes | Upload brand app icon |
| GET/POST | `/api/download*` | Yes | Download individual or ZIP |

## Protected Accounts

- **Sondre (owner):** `sondre@athletemindset.app` / `sondreg600@gmail.com` — NEVER delete this account or its data.

## Critical Patterns

- **Brand isolation:** Users only see brands where `createdBy === uid`. All fallbacks use `GENERIC_BRAND`.
- **`getBrandAsync(brandId, userId)`** resolves: Firestore lookup (with `createdBy` check) -> GENERIC_BRAND fallback.
- **Mockup canvas:** 1080x1920 (9:16 TikTok). Safe zones: top 120px, bottom 200px, sides 90px.
- **Batch jobs:** In-memory Map (`carouselJobs`), auto-cleaned after 30 min. Not persistent across deploys.

## File Map

```
studio/server.mjs          # All API routes + image generation + Sharp rendering (~1800 lines)
studio/public/app.js        # Frontend state, DOM, auth, brand/slide management (~1200 lines)
studio/public/index.html    # Single HTML page with all UI components
studio/public/styles.css    # All styling
brands/{id}/content-ideas.md   # Pre-written carousel templates (markdown)
brands/{id}/style-guide.md     # Brand voice, colors, typography rules
brands/{id}/assets/app-icon.png # Brand icon for watermark overlay
```
