# Carousel Studio

Multi-brand AI carousel generator for TikTok/Instagram. Uses **gpt-image-1.5** for image generation with **Claude** prompt refinement.

## Brands

| Brand | Description |
|-------|-------------|
| **Athlete Mindset** | AI mental performance training app for athletes |
| **TrackSpeed** | Professional sprint timing via iPhone Photo Finish detection |

## Quick Start

```bash
cd studio
npm install
cp .env.example .env   # Add your API keys
npm run dev             # http://localhost:4545
```

### Environment Variables

Create `studio/.env`:

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

## Features

- **Multi-brand support** — Switch brands from the header dropdown. Each brand has its own color palette, content ideas, and Claude system prompt.
- **Content ideas library** — Pre-written carousel templates loaded from markdown files with slide-by-slide specifications.
- **Freeform AI input** — Type a natural language prompt and Claude generates all slide content for review before image generation.
- **Slide preview** — HTML/CSS mockup of each slide at correct dimensions before generating with AI.
- **Reference image upload** — Upload images for the AI to use as backgrounds, composites, or style references.
- **App icon watermark** — Configurable brand icon overlay with corner position picker.
- **Claude prompt refinement** — Raw prompts are refined by Claude Haiku for better image generation results.
- **Batch generation** — Generate all slides in a carousel with progress tracking.
- **Download** — Individual slide download or batch ZIP export.

## Project Structure

```
content-bot/
├── brands/
│   ├── athlete-mindset/
│   │   ├── style-guide.md
│   │   ├── content-ideas.md
│   │   ├── research-evidence.md
│   │   └── assets/          (app-icon.png, owl_image_nobg.png)
│   └── trackspeed/
│       ├── style-guide.md
│       ├── content-ideas.md
│       └── assets/          (app-icon.png)
├── generators/              (standalone generation scripts)
├── studio/
│   ├── server.mjs           (Express API server)
│   ├── public/              (frontend: index.html, app.js, styles.css)
│   ├── output/              (generated images — gitignored)
│   └── uploads/             (reference images — gitignored)
├── package.json
└── README.md
```

## Adding a New Brand

1. Create `brands/<brand-id>/` with `style-guide.md`, `content-ideas.md`, and `assets/app-icon.png`
2. Add brand config to `BRANDS` object in `studio/server.mjs`
3. Brand appears automatically in the dropdown

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/brands` | List available brands |
| GET | `/api/content-ideas?brand=` | Get content ideas for a brand |
| POST | `/api/generate` | Generate a single slide |
| POST | `/api/generate-carousel` | Batch generate all slides |
| GET | `/api/carousel-status/:jobId` | Poll batch job status |
| POST | `/api/generate-freeform` | AI-generate slide content from a prompt |
| POST | `/api/upload-reference` | Upload a reference image |
| POST | `/api/upload-icon` | Upload a brand app icon |
| GET | `/api/download/:filename` | Download a single image |
| GET | `/api/download-carousel/:jobId` | Download batch as ZIP |
| POST | `/api/download-selected` | Download selected images as ZIP |

## Cost

- ~$0.02-0.08 per slide (gpt-image-1.5)
- ~$0.001 per Claude refinement (Haiku)
- A 7-slide carousel costs ~$0.15-0.60 depending on quality setting
