# Brand System

## Brand Data Structure

Every brand (stored in Firestore) follows this shape:
```javascript
{
  id: 'slug-uuid',           // URL-safe identifier
  name: 'Brand Name',
  website: 'brand.app',
  colors: {
    primary: '#hex',          // Main background color
    accent: '#hex',           // Highlights, micro-labels
    white: '#hex',            // Primary text
    secondary: '#hex',        // Alt backgrounds
    cta: '#hex',              // CTA buttons only
  },
  defaultMicroLabel: 'BRAND NAME',
  defaultBackground: 'one-line visual description for AI',
  iconOverlayText: 'brand.app',
  systemPrompt: '150-200 word brand brief for Claude',
  createdBy: 'firebase-uid',   // Firestore brands only
  createdAt: Timestamp,         // Firestore brands only
}
```

## Brand Storage

All brands live in Firestore `carousel_brands` collection. Users only see brands where `createdBy` matches their UID.

- **Content ideas:** Optional `brands/{id}/content-ideas.md` on disk (loaded if present)
- **App icon:** `brands/{id}/assets/app-icon.png` on disk, or uploaded via `/api/upload-icon`

## Content Ideas Markdown Format

```markdown
## Category 1: Category Name

### 1.1 — "Carousel Title"
**Sources:** Source 1, Source 2

**Slide 1** — Hook (photo)
- Micro-label: BRAND NAME
- Headline: Hook text here
- Body: Supporting text
- Highlight: key phrase

**Slide 2** — Content (text)
...
```

Parsed by `parseContentIdeas()` in server.mjs. Slide types: `photo`, `text`, `mockup`.
