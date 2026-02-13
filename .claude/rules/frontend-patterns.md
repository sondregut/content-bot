---
paths:
  - "studio/public/app.js"
  - "studio/public/index.html"
  - "studio/public/styles.css"
---

# Frontend Patterns

## Architecture

- Vanilla JavaScript — no framework, no bundler, no TypeScript
- Single `app.js` file with all state, event handlers, and DOM manipulation
- Firebase Auth SDK loaded via CDN in index.html
- All API calls go through `authFetch()` which injects Bearer token

## State Management

- Module-level `let` variables: `brands`, `currentBrand`, `contentData`, `selectedIdea`, `slideEdits`, `generatedImages`
- `currentBrand` can be `null` — always guard before using in API calls
- `slideEdits` is a mutable copy of the selected idea's slides — edits don't affect `contentData`
- `generatedImages` is an index-keyed object `{ 0: { url, filename }, ... }`

## Brand Selector

- `renderBrandSelector()` handles empty state: shows "No brands yet" disabled option
- Brand delete must handle last-brand-deleted case: set `currentBrand = null`, show empty sidebar
- Never fall back to `'athlete-mindset'` — always use `null` or `brands[0]?.id`

## Content Loading

- `loadContentIdeas()` guards against null `currentBrand` — calls `renderEmptySidebar()` instead
- `renderEmptySidebar()` shows "Create a brand to get started" message
- Freeform generate button guards: `if (!currentBrand)` return with "Create a brand first"

## Slide Form

- `loadSlideIntoForm(index)` populates form from `slideEdits[index]`
- `saveCurrentSlideEdits()` reads form back into `slideEdits[currentSlideIndex]`
- Always call `saveCurrentSlideEdits()` before switching slides or generating
- Three slide types: `photo`, `text`, `mockup` — each has its own form fields section

## DOM Conventions

- All DOM refs declared at module top as `const`
- Event listeners attached imperatively (not inline HTML)
- Dynamic HTML built with template strings, inserted via `innerHTML`
- Re-rendering (sidebar, tabs, gallery) replaces full innerHTML and re-attaches listeners
