---
paths:
  - "studio/server.mjs"
---

# Server Patterns

## Brand Isolation (CRITICAL)

- **Never** use a specific brand ID as a default/fallback in any route or function
- All generation routes MUST require an explicit `brand` parameter — return 400 if missing
- `getBrandAsync()` falls back to `GENERIC_BRAND` — the only brand lookup function
- Firestore brand lookups verify `createdBy === userId` — users only see their own brands
- Open signup — no email allowlist or admin gating

## Image Generation

- **AI slides:** buildTextPrompt() or buildPhotoPrompt() -> refinePromptWithClaude() -> openai.images.generate()
- **Mockup slides:** generateMockupSlide() -> Sharp SVG rendering (no AI API call)
- Claude refinement model: `claude-haiku-4-5-20251001` (fast, cheap)
- Image model: `gpt-image-1.5`, size `1024x1536`, quality `high`
- Always check `if (!openai)` and `if (!anthropic)` before API calls

## Mockup Rendering (Sharp)

- Canvas: 1080x1920, font: Helvetica/Arial
- Three layouts: `phone-right`, `phone-left`, `text-statement`
- Image usage modes: `phone` (iPhone frame), `figure` (positioned element), `background` (full-bleed with overlay), `none`
- Text wrapping: `wrapText()` estimates char width — not pixel-perfect
- SVG text rendered as `<text>` elements, composited onto base image
- Icon overlay: `addAppIconOverlay()` with 5 position options

## Batch Jobs

- Jobs stored in `carouselJobs` Map (in-memory, not persisted)
- Auto-deleted after 30 minutes via setTimeout
- Sequential slide processing (not parallel — API rate limits)
- Frontend polls `/api/carousel-status/:jobId` every 2 seconds

## Firebase

- `db = admin.firestore()` — null if no service account configured
- `bucket = admin.storage().bucket()` — falls back to local disk if null
- Always guard with `if (!db)` before Firestore operations
- Service account JSON comes from env var with escaped newlines — `private_key` needs `\\n` -> `\n` replacement
