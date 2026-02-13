import express from 'express';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

dotenv.config({ path: path.join(__dirname, '.env') });

const API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5';
const apiEnabled = Boolean(API_KEY);
const claudeEnabled = Boolean(ANTHROPIC_KEY);

if (!apiEnabled) {
  console.warn('Missing OPENAI_API_KEY. UI will load but generation will be disabled.');
}
if (!claudeEnabled) {
  console.warn('Missing ANTHROPIC_API_KEY. Prompt refinement will be skipped.');
}

const openai = apiEnabled ? new OpenAI({ apiKey: API_KEY }) : null;
const anthropic = claudeEnabled ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;
const app = express();
const PORT = process.env.PORT || 4545;

const outputDir = path.join(__dirname, 'output');
await fs.mkdir(outputDir, { recursive: true });

// File upload for reference images
const uploadsDir = path.join(__dirname, 'uploads');
await fs.mkdir(uploadsDir, { recursive: true });
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  },
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(outputDir));
app.use('/uploads', express.static(uploadsDir));

// --- Brand Configurations ---

const BRANDS = {
  'athlete-mindset': {
    id: 'athlete-mindset',
    name: 'Athlete Mindset',
    website: 'athletemindset.app',
    colors: {
      primary: '#072F57',
      accent: '#73A6D1',
      white: '#FFFFFF',
      secondary: '#D9D0C2',
      cta: '#43AA32',
    },
    defaultMicroLabel: 'ATHLETE MINDSET',
    defaultBackground: 'dark premium navy/near-black with very subtle grain',
    iconOverlayText: 'athletemindset.app',
    systemPrompt: `You are an expert visual designer and prompt engineer for Athlete Mindset, a premium AI-powered mental performance training app for athletes.

About the app: Athlete Mindset helps athletes unlock peak performance through science-backed visualization, breathwork, and AI voice coaching. Think of it as a sports psychologist in your pocket — accessible, evidence-based, and built for the modern athlete.

Content pillars for social media:
1. Science-backed visualization benefits — research showing mental rehearsal improves performance
2. Mental training as competitive edge — the mindset separates good from great
3. Accessibility — an AI mental performance coach at a fraction of a sports psychologist's cost
4. CTA slides — "Try free" / "athletemindset.app" / download nudge

Brand palette (use these EXACT hex codes in prompts):
- Navy: #072F57 (primary background)
- Cyan: #73A6D1 (highlights, accents)
- White: #FFFFFF (text)
- Beige: #D9D0C2 (warm alternate backgrounds)
- Green: #43AA32 (CTA buttons ONLY — never for general decoration)`,
  },
  'trackspeed': {
    id: 'trackspeed',
    name: 'TrackSpeed',
    website: 'trackspeed.app',
    colors: {
      primary: '#191919',
      accent: '#5C8DB8',
      white: '#FDFDFD',
      secondary: '#2B2E32',
      cta: '#22C55E',
    },
    defaultMicroLabel: 'TRACKSPEED',
    defaultBackground: 'deep charcoal #191919 with subtle noise texture',
    iconOverlayText: 'trackspeed.app',
    systemPrompt: `You are an expert visual designer and prompt engineer for TrackSpeed, a professional sprint timing app that uses iPhone camera Photo Finish detection.

About the app: TrackSpeed gives coaches and athletes timing gate accuracy using just their phone camera. 120fps Photo Finish detection with sub-frame interpolation — professional sprint timing without expensive equipment. Competitors: VALD SmartSpeed ($2,000+), OVR Sprint ($529), Freelap ($500+).

Content pillars for social media:
1. Speed Data & Science — sprint biomechanics, what times mean, acceleration vs top speed
2. Equipment Disruption — $0 vs $529 vs $2,000 comparisons, setup speed, portability
3. Coaching & Testing — how to run proper speed tests, warm-up protocols, testing day guides
4. Training Protocols — sprint workouts, weekly splits, speed development tips
5. Photo Finish Technology — how it works, 120fps detection, sub-frame interpolation

Brand palette (use these EXACT hex codes in prompts):
- Dark Background: #191919 (deep charcoal)
- Surface: #2B2E32 (blue-gray elevated surface)
- Accent Blue: #5C8DB8 (primary accent)
- Accent Cyan: #73A6D1 (lighter highlight)
- Success Green: #22C55E (PR/improvement callouts)
- White: #FDFDFD (primary text on dark)
- Muted: #9B9A97 (secondary text)

Tone: Technical but accessible, data-driven, provocative (challenge hand-timing culture), confident.
Typography: Sprint times should be monospace, large, high contrast.`,
  },
};

function getBrand(brandId) {
  return BRANDS[brandId] || BRANDS['athlete-mindset'];
}

const ICON_OVERLAY_CONFIGS = {
  'bottom-right': { position: 'bottom-right', sizePercent: 8, opacity: 0.18 },
  'bottom-left': { position: 'bottom-left', sizePercent: 8, opacity: 0.18 },
  'top-right': { position: 'top-right', sizePercent: 6, opacity: 0.15 },
  'top-left': { position: 'top-left', sizePercent: 6, opacity: 0.15 },
  'mid-right': { position: 'mid-right', sizePercent: 10, opacity: 0.2 },
};

function spacedLetters(word) {
  return word.split('').join(' - ');
}

function buildTrickyWordsLine(trickyWords) {
  if (!trickyWords) return '';
  const words = trickyWords
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) return '';
  const spelled = words.map((w) => `"${w}": "${spacedLetters(w)}"`).join(', ');
  return `Spell these tricky words letter-by-letter: ${spelled}.`;
}

function buildTextPrompt(data, brand) {
  const {
    backgroundStyle,
    layoutTemplate,
    microLabel,
    headline,
    highlightPhrase,
    body,
    citation,
    trickyWords,
  } = data;

  const c = brand.colors;
  const safeMicro = microLabel || brand.defaultMicroLabel;
  const safeHeadline = headline || 'Your mind leads your body';
  const safeBody = body || '';
  const safeBackground = backgroundStyle || brand.defaultBackground;
  const safeLayout = layoutTemplate || 'Layout A - Classic Left Lane';

  const textBlocks = [
    `Micro-label (EXACT text):\n"${safeMicro}"`,
    `Headline (EXACT, verbatim, include line breaks exactly as shown):\n"${safeHeadline}"`,
  ];

  if (highlightPhrase) {
    textBlocks.push(`Highlight ONLY this phrase in accent color ${c.accent}: "${highlightPhrase}"`);
  }

  if (safeBody) {
    textBlocks.push(`Body text (EXACT, verbatim):\n"${safeBody}"`);
  }

  if (citation) {
    textBlocks.push(`Optional citation (EXACT, verbatim):\n"${citation}"`);
  }

  const trickyLine = buildTrickyWordsLine(trickyWords);

  return [
    `Create a minimalist premium TikTok carousel slide (1080x1920, 9:16) for ${brand.name}.`,
    `Background: ${safeBackground} using brand palette primary ${c.primary}, accent ${c.accent}, white ${c.white}, secondary ${c.secondary}, CTA color ${c.cta} (CTA only).`,
    `Composition: ${safeLayout}. Large left-aligned text block within safe zones (top 180px, bottom 320px, sides 90px). Plenty of negative space.`,
    textBlocks.join('\n\n'),
    'Typography constraints: modern sans-serif like Inter/SF Pro, headline extra-bold with tight line-height, body regular with comfortable line-height, clean kerning, high readability.',
    'Icon constraints: do NOT add any logos or icons; the brand watermark will be added separately after generation.',
    trickyLine || null,
    'Hard constraints: No additional words beyond quoted text. No watermarks. No extra logos. No clutter. Keep background clean and minimal. High contrast, text must be perfectly legible.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildPhotoPrompt(data, brand) {
  const {
    sport,
    setting,
    action,
    mood,
    overlayStyle,
    overlayPlacement,
    microLabel,
    headline,
    highlightPhrase,
    body,
    trickyWords,
  } = data;

  const c = brand.colors;
  const safeSport = sport || 'track';
  const safeSetting = setting || 'empty stadium at dusk';
  const safeAction = action || 'head down, slow breathing';
  const safeMood = mood || 'calm intensity, disciplined';
  const safeOverlayStyle = overlayStyle || 'dark gradient';
  const safeOverlayPlacement = overlayPlacement || 'bottom third';
  const safeMicro = microLabel || brand.defaultMicroLabel;
  const safeHeadline = headline || 'Calm is a competitive advantage';
  const safeBody = body || '';

  const trickyLine = buildTrickyWordsLine(trickyWords);

  return [
    'Create a candid, authentic-looking sports photo for a TikTok carousel slide (1080x1920, 9:16). Shot on iPhone 15 Pro, 50mm equivalent lens, medium close-up at eye level.',
    `Scene: ${safeSport} athlete in ${safeSetting}, ${safeAction}. Honest and unposed moment — not staged or glamorized.`,
    'Subject: one athlete, natural proportions, real skin texture with visible pores and natural imperfections, authentic worn gear (no brand logos). No airbrushed or plastic-looking skin.',
    `Lighting: soft natural daylight, natural color balance, shallow depth of field. No dramatic studio lighting or heavy color grading. Subtle film grain, 35mm film photograph aesthetic.`,
    `Mood: ${safeMood}.`,
    `Composition: simple, clean background — not overly dramatic. Leave negative space for text overlay in the ${safeOverlayPlacement}.`,
    `Add a subtle ${safeOverlayStyle} behind text for readability; image stays dominant and uncluttered.`,
    'Overlay text (EXACT, verbatim):',
    `Micro-label: "${safeMicro}"`,
    `Headline: "${safeHeadline}"`,
    highlightPhrase ? `Highlight ONLY: "${highlightPhrase}" in accent ${c.accent}` : null,
    safeBody ? `Body: "${safeBody}"` : null,
    'Typography: modern sans-serif like Inter/SF Pro, headline bold, body regular, clean kerning.',
    `Brand palette accents only (accent ${c.accent}, CTA color ${c.cta} for CTA only).`,
    trickyLine || null,
    'Hard constraints: no extra text beyond quoted. no watermarks. no random logos. no distorted faces/hands. no nonsense text. no perfect/flawless skin. no ultra-smooth rendering. no heavy retouching look.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function addAppIconOverlay(baseBuffer, configKey = 'bottom-right', brandId = 'athlete-mindset') {
  const cfg = ICON_OVERLAY_CONFIGS[configKey] || ICON_OVERLAY_CONFIGS['bottom-right'];
  const brand = getBrand(brandId);
  const base = sharp(baseBuffer);
  const meta = await base.metadata();

  if (!meta.width || !meta.height) return baseBuffer;

  // Look for brand-specific app icon, fall back to studio default
  const brandIconPath = path.join(rootDir, 'brands', brandId, 'assets', 'app-icon.png');
  const defaultIconPath = path.join(__dirname, 'app-icon.png');

  let iconPath;
  try {
    await fs.access(brandIconPath);
    iconPath = brandIconPath;
  } catch {
    iconPath = defaultIconPath;
  }

  const iconSize = Math.round(meta.width * (cfg.sizePercent / 100));
  const cornerRadius = Math.round(iconSize * 0.22);

  const roundedMask = Buffer.from(
    `<svg width="${iconSize}" height="${iconSize}">
      <rect x="0" y="0" width="${iconSize}" height="${iconSize}" rx="${cornerRadius}" ry="${cornerRadius}" fill="white"/>
    </svg>`
  );

  const iconBuffer = await sharp(iconPath)
    .resize({ width: iconSize, height: iconSize })
    .composite([{ input: roundedMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const fontSize = Math.round(iconSize * 0.28);
  const textWidth = Math.round(iconSize * 2.5);
  const textHeight = Math.round(fontSize * 1.6);
  const textSvg = Buffer.from(
    `<svg width="${textWidth}" height="${textHeight}">
      <text x="${textWidth / 2}" y="${fontSize * 1.1}" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600" fill="white" text-anchor="middle" opacity="0.85">${brand.iconOverlayText}</text>
    </svg>`
  );
  const textBuffer = await sharp(textSvg).png().toBuffer();
  const textMeta = await sharp(textBuffer).metadata();

  const padding = Math.round(meta.width * 0.04);
  const textGap = Math.round(iconSize * 0.15);
  const totalHeight = iconSize + textGap + textMeta.height;
  const totalWidth = Math.max(iconSize, textMeta.width);

  const positionMap = {
    'bottom-right': {
      left: meta.width - totalWidth - padding,
      top: meta.height - totalHeight - padding,
    },
    'bottom-left': {
      left: padding,
      top: meta.height - totalHeight - padding,
    },
    'top-right': {
      left: meta.width - totalWidth - padding,
      top: padding,
    },
    'top-left': {
      left: padding,
      top: padding,
    },
    'mid-right': {
      left: meta.width - totalWidth - padding,
      top: Math.round((meta.height - totalHeight) / 2),
    },
  };

  const pos = positionMap[cfg.position] || positionMap['bottom-right'];
  const iconLeft = pos.left + Math.round((totalWidth - iconSize) / 2);
  const textLeft = pos.left + Math.round((totalWidth - textMeta.width) / 2);

  const composed = await base
    .composite([
      {
        input: iconBuffer,
        left: Math.max(0, iconLeft),
        top: Math.max(0, pos.top),
      },
      {
        input: textBuffer,
        left: Math.max(0, textLeft),
        top: Math.max(0, pos.top + iconSize + textGap),
      },
    ])
    .png()
    .toBuffer();

  return composed;
}

// --- Claude Prompt Refinement ---

const BASE_REFINEMENT_INSTRUCTIONS = `Your job: Take a raw image-generation prompt and refine it for gpt-image-1.5. Your refinements should:
- Strengthen text legibility instructions (exact spelling, letter spacing for tricky words, font weight)
- Ensure safe zones are respected (top 180px, bottom 320px, sides 90px for TikTok 9:16)
- Keep backgrounds clean, simple, and uncluttered — avoid overly dramatic or staged-looking scenes
- Reinforce correct spelling of all words
- Optimize composition cues for the AI image model
- Preserve ALL exact text content from the original — never change the user's words
- Keep the prompt concise and direct — no fluff, no markdown, no explanation

CRITICAL for photo slides with people:
- Push hard for REALISM over cinematic drama. The goal is photos that look like they were taken on an iPhone, not a Hollywood set
- Include: "natural skin texture with pores", "35mm film grain", "soft natural daylight", "candid and unposed", "shallow depth of field"
- AVOID these words that make images look AI-generated: "perfect", "flawless", "ultra-smooth", "ultra-detailed", "8K", "hyper-realistic", "masterpiece"
- Specify a real camera/lens feel: "shot on iPhone", "50mm lens", "medium close-up at eye level"
- Backgrounds should be simple and believable — a real gym, a regular field, a plain wall — not epic dramatic stadiums with god rays
- Skin should have real texture, natural imperfections, visible pores — never airbrushed or plastic

Return ONLY the refined prompt text. No preamble, no explanation, no markdown formatting.`;

async function refinePromptWithClaude(rawPrompt, slideType, formData, brand) {
  if (!anthropic) return null;

  try {
    const systemPrompt = `${brand.systemPrompt}\n\n${BASE_REFINEMENT_INSTRUCTIONS}`;
    const context = slideType === 'photo'
      ? `This is a photo-led slide for ${brand.name} featuring a ${formData.sport || 'athlete'} scene with text overlay.`
      : `This is a text-only minimalist slide for ${brand.name} with a ${formData.backgroundStyle || 'dark premium'} background.`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `${context}\n\nRefine this image-generation prompt:\n\n${rawPrompt}`,
        },
      ],
    });

    const refined = response.content?.[0]?.text?.trim();
    if (refined) {
      console.log(`[Claude] Prompt refined for ${brand.name}`);
      return refined;
    }
    return null;
  } catch (err) {
    console.warn('[Claude] Refinement failed, using raw prompt:', err.message);
    return null;
  }
}

// --- Content Ideas Parser ---

function parseContentIdeas(markdown, brandId, brandName) {
  const app = { id: brandId, name: brandName, categories: [] };

  const categoryBlocks = markdown.split(/(?=^## Category \d+)/m).filter((b) => b.startsWith('## Category'));

  for (const catBlock of categoryBlocks) {
    const catMatch = catBlock.match(/^## (Category \d+: .+)$/m);
    if (!catMatch) continue;

    const category = { name: catMatch[1].replace(/^Category \d+: /, ''), ideas: [] };
    const ideaBlocks = catBlock.split(/(?=^### \d+\.\d+)/m).filter((b) => b.startsWith('### '));

    for (const ideaBlock of ideaBlocks) {
      const ideaMatch = ideaBlock.match(/^### (\d+\.\d+) — "(.+)"$/m);
      if (!ideaMatch) continue;

      const srcMatch = ideaBlock.match(/^\*\*Sources:\*\* (.+)$/m);
      const idea = {
        id: ideaMatch[1],
        title: ideaMatch[2],
        sources: srcMatch ? srcMatch[1].split(',').map((s) => s.trim()) : [],
        slides: [],
      };

      const slideRe = /\*\*Slide (\d+)\*\* — (.+?) \((\w+)\)\s*\n([\s\S]*?)(?=\n\*\*Slide |\n---|\n##|$)/g;
      let slideMatch;
      while ((slideMatch = slideRe.exec(ideaBlock)) !== null) {
        const [, num, label, type, body] = slideMatch;
        const slide = { number: parseInt(num), label, type };

        const lines = body.split('\n');
        for (const line of lines) {
          const fm = line.match(/^- (Micro-label|Headline|Body|Highlight|Citation): (.+)$/);
          if (fm) {
            const key = fm[1] === 'Micro-label' ? 'microLabel' : fm[1] === 'Highlight' ? 'highlight' : fm[1].toLowerCase();
            slide[key] = fm[2];
          }
        }

        idea.slides.push(slide);
      }

      if (idea.slides.length > 0) {
        category.ideas.push(idea);
      }
    }

    if (category.ideas.length > 0) {
      app.categories.push(category);
    }
  }

  return app;
}

// --- API Routes ---

// List available brands
app.get('/api/brands', (req, res) => {
  const brands = Object.values(BRANDS).map((b) => ({
    id: b.id,
    name: b.name,
    website: b.website,
    colors: b.colors,
  }));
  res.json({ brands });
});

// Get content ideas for a brand
app.get('/api/content-ideas', async (req, res) => {
  try {
    const brandId = req.query.brand || 'athlete-mindset';
    const brand = getBrand(brandId);
    const mdPath = path.join(rootDir, 'brands', brandId, 'content-ideas.md');
    const markdown = await fs.readFile(mdPath, 'utf-8');
    const appData = parseContentIdeas(markdown, brandId, brand.name);
    res.json({ apps: [appData] });
  } catch (error) {
    console.error('[Content Ideas]', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload reference image
app.post('/api/upload-reference', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Rename to keep extension
    const ext = path.extname(req.file.originalname) || '.png';
    const newName = `ref_${crypto.randomUUID().slice(0, 8)}${ext}`;
    const newPath = path.join(uploadsDir, newName);
    await fs.rename(req.file.path, newPath);

    res.json({
      ok: true,
      filename: newName,
      url: `/uploads/${newName}`,
    });
  } catch (error) {
    console.error('[Upload]', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate single slide
app.post('/api/generate', async (req, res) => {
  try {
    const data = req.body || {};
    const brandId = data.brand || 'athlete-mindset';
    const brand = getBrand(brandId);

    if (!data.slideType) {
      return res.status(400).json({ error: 'Missing slideType' });
    }

    const rawPrompt =
      data.slideType === 'photo'
        ? buildPhotoPrompt(data, brand)
        : buildTextPrompt(data, brand);

    // If a reference image is provided, append instruction to use it
    let referenceInstruction = '';
    if (data.referenceImage) {
      referenceInstruction = `\n\nReference image provided: Use it as ${data.referenceUsage || 'background inspiration'}. ${data.referenceInstructions || ''}`;
    }

    const refinedPrompt = await refinePromptWithClaude(
      rawPrompt + referenceInstruction,
      data.slideType,
      data,
      brand
    );
    const prompt = refinedPrompt || (rawPrompt + referenceInstruction);

    console.log(`[Generate] ${brand.name} | ${refinedPrompt ? 'Claude-refined' : 'raw'} prompt`);

    // Build generation params
    const genParams = {
      model: IMAGE_MODEL,
      prompt,
      size: '1024x1536',
      quality: data.quality || 'high',
      output_format: 'png',
    };

    // If reference image provided, use image editing mode
    if (data.referenceImage) {
      const refPath = path.join(uploadsDir, data.referenceImage);
      try {
        await fs.access(refPath);
        const refBuffer = await fs.readFile(refPath);
        genParams.image = [{ image: refBuffer, detail: 'auto' }];
      } catch {
        console.warn('[Generate] Reference image not found, generating without it');
      }
    }

    const response = await openai.images.generate(genParams);

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error('No image returned from API');
    }

    let buffer = Buffer.from(b64, 'base64');

    if (data.includeOwl) {
      buffer = await addAppIconOverlay(buffer, data.owlPosition, brandId);
    }

    const slug = crypto.randomUUID().slice(0, 8);
    const filename = `slide_${brandId}_${data.slideType}_${Date.now()}_${slug}.png`;
    const filepath = path.join(outputDir, filename);

    await fs.writeFile(filepath, buffer);

    res.json({
      ok: true,
      filename,
      url: `/output/${filename}`,
      prompt: rawPrompt,
      refinedPrompt: refinedPrompt || null,
      usedRefined: Boolean(refinedPrompt),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Generation failed' });
  }
});

// Batch carousel generation
const carouselJobs = new Map();

app.post('/api/generate-carousel', async (req, res) => {
  const { slides, includeOwl, owlPosition, quality, brand: brandId } = req.body || {};
  if (!slides || !Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: 'Missing slides array' });
  }

  const brand = getBrand(brandId || 'athlete-mindset');

  const jobId = crypto.randomUUID().slice(0, 12);
  const job = {
    id: jobId,
    brandId: brand.id,
    total: slides.length,
    completed: 0,
    current: 0,
    slides: [],
    status: 'running',
    error: null,
  };
  carouselJobs.set(jobId, job);

  res.json({ jobId, total: slides.length });

  (async () => {
    for (let i = 0; i < slides.length; i++) {
      job.current = i + 1;
      const slideData = { ...slides[i], includeOwl, owlPosition, quality: quality || 'high' };

      try {
        const rawPrompt =
          slideData.slideType === 'photo'
            ? buildPhotoPrompt(slideData, brand)
            : buildTextPrompt(slideData, brand);

        const refinedPrompt = await refinePromptWithClaude(rawPrompt, slideData.slideType, slideData, brand);
        const prompt = refinedPrompt || rawPrompt;

        console.log(`[Carousel ${jobId}] ${brand.name} | Slide ${i + 1}/${slides.length}`);

        const response = await openai.images.generate({
          model: IMAGE_MODEL,
          prompt,
          size: '1024x1536',
          quality: slideData.quality || 'high',
          output_format: 'png',
        });

        const b64 = response.data?.[0]?.b64_json;
        if (!b64) throw new Error('No image returned');

        let buffer = Buffer.from(b64, 'base64');
        if (slideData.includeOwl) {
          buffer = await addAppIconOverlay(buffer, slideData.owlPosition, brand.id);
        }

        const slug = crypto.randomUUID().slice(0, 8);
        const filename = `carousel_${brand.id}_${jobId}_s${i + 1}_${slug}.png`;
        await fs.writeFile(path.join(outputDir, filename), buffer);

        job.slides.push({
          slideNumber: i + 1,
          url: `/output/${filename}`,
          filename,
          ok: true,
        });
        job.completed = i + 1;
      } catch (err) {
        console.error(`[Carousel ${jobId}] Slide ${i + 1} failed:`, err.message);
        job.slides.push({
          slideNumber: i + 1,
          url: null,
          error: err.message,
          ok: false,
        });
        job.completed = i + 1;
      }
    }
    job.status = 'done';
    console.log(`[Carousel ${jobId}] Complete — ${job.slides.filter((s) => s.ok).length}/${job.total} succeeded`);

    setTimeout(() => carouselJobs.delete(jobId), 30 * 60 * 1000);
  })();
});

app.get('/api/carousel-status/:jobId', (req, res) => {
  const job = carouselJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({
    jobId: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    current: job.current,
    slides: job.slides,
  });
});

// --- Freeform AI Content Generation ---
app.post('/api/generate-freeform', async (req, res) => {
  try {
    const { prompt: userPrompt, brand: brandId, slideCount } = req.body || {};
    if (!userPrompt) {
      return res.status(400).json({ error: 'Missing prompt' });
    }
    if (!anthropic) {
      return res.status(500).json({ error: 'Claude API not configured' });
    }

    const brand = getBrand(brandId || 'athlete-mindset');
    const numSlides = Math.min(Math.max(parseInt(slideCount) || 7, 1), 20);

    const freeformSystemPrompt = `${brand.systemPrompt}

You are generating carousel slide content for ${brand.name} social media (TikTok/Instagram).

Given a freeform prompt from the user, generate exactly ${numSlides} slides for a carousel post.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "title": "Short carousel title",
  "slides": [
    {
      "number": 1,
      "label": "Hook",
      "type": "photo or text",
      "microLabel": "BRAND LABEL",
      "headline": "Main headline text",
      "body": "Supporting body text",
      "highlight": "key phrase to highlight in accent color",
      "sport": "only for photo type - sport shown",
      "setting": "only for photo type - location",
      "action": "only for photo type - what athlete is doing",
      "mood": "only for photo type - emotional tone"
    }
  ]
}

Rules:
- First slide should be a strong hook (usually photo type)
- Last slide should be a CTA with "Download ${brand.name} — link in bio"
- Mix photo and text types for visual variety
- Headlines should be punchy, under 15 words
- Body text should be 1-2 sentences max
- Highlight the most impactful phrase in each slide
- Use ${brand.defaultMicroLabel} as default micro-label
- For photo slides, include sport/setting/action/mood fields
- Content should match the brand's tone and content pillars`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: freeformSystemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
      ],
    });

    const text = response.content?.[0]?.text?.trim();
    if (!text) {
      throw new Error('No response from Claude');
    }

    // Parse JSON from response (handle potential markdown wrapping)
    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      throw new Error('Failed to parse Claude response as JSON');
    }

    console.log(`[Freeform] ${brand.name} | Generated ${parsed.slides?.length || 0} slides`);
    res.json({ ok: true, ...parsed });
  } catch (error) {
    console.error('[Freeform]', error);
    res.status(500).json({ error: error.message });
  }
});

// --- App Icon Upload ---
app.post('/api/upload-icon', upload.single('icon'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No icon uploaded' });
    }

    const brandId = req.body.brand || 'athlete-mindset';
    const assetsDir = path.join(rootDir, 'brands', brandId, 'assets');
    await fs.mkdir(assetsDir, { recursive: true });

    const iconPath = path.join(assetsDir, 'app-icon.png');

    // Convert to PNG and resize to standard size
    await sharp(req.file.path)
      .resize(512, 512, { fit: 'cover' })
      .png()
      .toFile(iconPath);

    // Clean up temp file
    await fs.unlink(req.file.path).catch(() => {});

    res.json({
      ok: true,
      url: `/brands/${brandId}/assets/app-icon.png?t=${Date.now()}`,
    });
  } catch (error) {
    console.error('[Icon Upload]', error);
    res.status(500).json({ error: error.message });
  }
});

// --- API Key Settings ---
app.post('/api/settings', async (req, res) => {
  try {
    const { openaiKey, anthropicKey } = req.body || {};
    const envPath = path.join(__dirname, '.env');

    let envContent = '';
    try {
      envContent = await fs.readFile(envPath, 'utf-8');
    } catch {
      envContent = '';
    }

    const lines = envContent.split('\n').filter((l) => l.trim());
    const envMap = {};
    for (const line of lines) {
      const [key, ...valParts] = line.split('=');
      if (key) envMap[key.trim()] = valParts.join('=').trim();
    }

    if (openaiKey) envMap['OPENAI_API_KEY'] = openaiKey;
    if (anthropicKey) envMap['ANTHROPIC_API_KEY'] = anthropicKey;

    const newContent = Object.entries(envMap)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';

    await fs.writeFile(envPath, newContent);

    // Reload dotenv
    dotenv.config({ path: envPath, override: true });

    res.json({ ok: true });
  } catch (error) {
    console.error('[Settings]', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve brand assets
app.use('/brands', express.static(path.join(rootDir, 'brands')));

// Download single image
app.get('/api/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = path.join(outputDir, filename);
    await fs.access(filepath);
    res.download(filepath, filename);
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

// Download all carousel images as zip
app.get('/api/download-carousel/:jobId', async (req, res) => {
  const job = carouselJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const successSlides = job.slides.filter((s) => s.ok && s.filename);
  if (successSlides.length === 0) {
    return res.status(404).json({ error: 'No generated slides found' });
  }

  const brand = getBrand(job.brandId || 'athlete-mindset');
  const zipName = `${brand.id}_carousel_${job.id}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.pipe(res);

  for (const slide of successSlides) {
    const filepath = path.join(outputDir, slide.filename);
    archive.file(filepath, { name: `slide_${slide.slideNumber}.png` });
  }

  await archive.finalize();
});

// Download selected images as zip
app.post('/api/download-selected', async (req, res) => {
  const { filenames, brandId } = req.body || {};
  if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
    return res.status(400).json({ error: 'No filenames provided' });
  }

  const brand = getBrand(brandId || 'athlete-mindset');
  const zipName = `${brand.id}_slides_${Date.now()}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.pipe(res);

  for (let i = 0; i < filenames.length; i++) {
    const filepath = path.join(outputDir, filenames[i]);
    try {
      await fs.access(filepath);
      archive.file(filepath, { name: `slide_${i + 1}.png` });
    } catch {
      // skip missing files
    }
  }

  await archive.finalize();
});

// Start server (only when run directly, not on Vercel)
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`Carousel Studio running on http://localhost:${PORT}`);
    console.log(`Brands: ${Object.values(BRANDS).map((b) => b.name).join(', ')}`);
  });
}

// Export for Vercel serverless
export default app;
