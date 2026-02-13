# Brand System

## Brand Data Structure

Every brand (hardcoded or Firestore) follows this shape:
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

## Hardcoded vs Custom Brands

| | Hardcoded (BRANDS object) | Custom (Firestore) |
|---|---|---|
| Storage | `server.mjs` constant | `carousel_brands` collection |
| Visible to | Admin emails only | Creator only (`createdBy` check) |
| Content ideas | `brands/{id}/content-ideas.md` | None (use freeform) |
| App icon | `brands/{id}/assets/app-icon.png` | Uploaded via `/api/upload-icon` |
| `isDefault` flag | `true` | `false` |

## Adding a New Hardcoded Brand

1. Add entry to `BRANDS` object in `server.mjs`
2. Create `brands/{id}/` directory with: `content-ideas.md`, `style-guide.md`, `assets/app-icon.png`
3. Add admin email to `ADMIN_EMAILS` if needed
4. Content ideas format: see existing brands for markdown structure

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
