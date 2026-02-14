import express from 'express';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import multer from 'multer';
import admin from 'firebase-admin';
import { spawn, execSync } from 'child_process';
import rateLimit from 'express-rate-limit';
import ffmpegPath from 'ffmpeg-static';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = __dirname; // brands/ lives inside studio/

dotenv.config({ path: path.join(__dirname, '.env') });

const DEFAULT_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5';
const ALLOWED_IMAGE_MODELS = {
  'gpt-image-1.5': 'GPT Image 1.5',
  'gpt-image-1': 'GPT Image 1',
  'dall-e-3': 'DALL-E 3',
  'gemini-2.5-flash-preview-image-generation': 'Gemini 2.5 Flash Image',
  'gemini-2.0-flash-preview-image-generation': 'Gemini 2.0 Flash Image',
  'imagen-4.0-generate-001': 'Imagen 4.0',
  'imagen-4.0-fast-generate-001': 'Imagen 4.0 Fast',
  'imagen-4.0-ultra-generate-001': 'Imagen 4.0 Ultra',
};
function resolveImageModel(requested) {
  return (requested && ALLOWED_IMAGE_MODELS[requested]) ? requested : DEFAULT_IMAGE_MODEL;
}

const DEFAULT_TEXT_MODEL = 'claude-haiku-4-5-20251001';
const ALLOWED_TEXT_MODELS = {
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'claude-sonnet-4-5-20250929': 'Claude Sonnet 4.5',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
};
function resolveTextModel(requested) {
  return (requested && ALLOWED_TEXT_MODELS[requested]) ? requested : DEFAULT_TEXT_MODEL;
}

// --- BYOK: Per-request API client helpers ---
// Users provide their own API keys via request headers (X-OpenAI-Key, X-Anthropic-Key, X-Fal-Key)
function getOpenAI(req) {
  const key = req.headers['x-openai-key'];
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}
function getAnthropic(req) {
  const key = req.headers['x-anthropic-key'];
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}
function getGemini(req) {
  const key = req.headers['x-gemini-key'];
  if (!key) return null;
  return new GoogleGenAI({ apiKey: key });
}
function isFalEnabled(req) {
  return Boolean(req.headers['x-fal-key']);
}

// --- Unified text generation (Claude + Gemini) ---
async function generateText({ model, system, messages, maxTokens, req }) {
  const resolvedModel = resolveTextModel(model);

  if (resolvedModel.startsWith('gemini-')) {
    const gemini = getGemini(req);
    if (!gemini) throw new Error('Add your Google Gemini API key in Settings to use Gemini models.');
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));
    const response = await gemini.models.generateContent({
      model: resolvedModel,
      contents,
      config: {
        systemInstruction: system || undefined,
        maxOutputTokens: maxTokens || 2048,
      },
    });
    return response.text || '';
  }

  // Claude (default)
  const anthropic = getAnthropic(req);
  if (!anthropic) throw new Error('Add your Anthropic API key in Settings.');
  const response = await anthropic.messages.create({
    model: resolvedModel,
    max_tokens: maxTokens || 2048,
    system: system || undefined,
    messages,
  });
  return response.content?.[0]?.text?.trim() || '';
}

// --- Unified image generation (OpenAI + Gemini + Imagen) ---
async function generateImage({ model, prompt, size, quality, referenceImage, req }) {
  const resolvedModel = resolveImageModel(model);

  // Gemini native image generation
  if (resolvedModel.startsWith('gemini-')) {
    const gemini = getGemini(req);
    if (!gemini) throw new Error('Add your Google Gemini API key in Settings to use Gemini models.');
    const parts = [];
    if (referenceImage) {
      parts.push({ inlineData: { data: referenceImage.toString('base64'), mimeType: 'image/png' } });
    }
    parts.push({ text: prompt });
    const response = await gemini.models.generateContent({
      model: resolvedModel,
      contents: [{ parts }],
      config: { responseModalities: ['TEXT', 'IMAGE'] },
    });
    const imagePart = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!imagePart?.inlineData?.data) throw new Error('No image returned from Gemini');
    return Buffer.from(imagePart.inlineData.data, 'base64');
  }

  // Imagen (Google)
  if (resolvedModel.startsWith('imagen-')) {
    const gemini = getGemini(req);
    if (!gemini) throw new Error('Add your Google Gemini API key in Settings to use Imagen models.');
    const aspectMap = { '1024x1536': '9:16', '1536x1024': '16:9', '1024x1024': '1:1' };
    const response = await gemini.models.generateImages({
      model: resolvedModel,
      prompt,
      config: { numberOfImages: 1, aspectRatio: aspectMap[size] || '9:16' },
    });
    const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
    if (!imageBytes) throw new Error('No image returned from Imagen');
    return Buffer.from(imageBytes, 'base64');
  }

  // OpenAI (default)
  const openai = getOpenAI(req);
  if (!openai) throw new Error('Add your OpenAI API key in Settings to generate images.');

  if (referenceImage) {
    const imageFile = new File([referenceImage], 'reference.png', { type: 'image/png' });
    const response = await openai.images.edit({
      model: resolvedModel,
      image: imageFile,
      prompt,
      size: size || '1024x1536',
      quality: quality || 'high',
    });
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error('No image returned from API');
    return Buffer.from(b64, 'base64');
  }

  const response = await openai.images.generate({
    model: resolvedModel,
    prompt,
    size: size || '1024x1536',
    quality: quality || 'high',
    output_format: 'png',
  });
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image returned from API');
  return Buffer.from(b64, 'base64');
}

async function generateWithFlux(faceImagePaths, prompt, { aspectRatio = '9:16', falKey } = {}) {
  if (!falKey) throw new Error('Fal.ai API key not configured. Add it in Settings.');

  // Support both single path (string) and array of paths
  const paths = Array.isArray(faceImagePaths) ? faceImagePaths : [faceImagePaths];

  // Convert all face images to data URLs
  const imageUrls = await Promise.all(paths.map(async (p) => {
    const buf = await fs.readFile(p);
    const mime = p.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  }));

  const response = await fetch('https://fal.run/fal-ai/flux-pro/kontext/multi', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      image_urls: imageUrls,
      num_images: 1,
      output_format: 'png',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Flux API error: ${err}`);
  }

  const data = await response.json();
  const imgUrl = data.images?.[0]?.url;
  if (!imgUrl) throw new Error('No image returned from Flux');

  const imgRes = await fetch(imgUrl);
  return Buffer.from(await imgRes.arrayBuffer());
}

// --- LoRA Inference (trained person model via fal.ai) ---
async function generateWithLoRA(loraUrl, prompt, { loraModel, aspectRatio = '9:16', falKey } = {}) {
  if (!falKey) throw new Error('Fal.ai API key not configured. Add it in Settings.');
  const isFlux2 = loraModel === 'flux-2';
  const endpoint = isFlux2 ? 'fal-ai/flux-2/lora' : 'fal-ai/flux-lora';
  const guidanceScale = isFlux2 ? 2.5 : 3.5;

  const response = await fetch(`https://fal.run/${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      loras: [{ path: loraUrl, scale: 1.0 }],
      image_size: aspectRatio === '9:16' ? 'portrait_16_9' : 'square_hd',
      num_images: 1,
      output_format: 'png',
      guidance_scale: guidanceScale,
      num_inference_steps: 28,
      enable_safety_checker: false,
    }),
  });

  if (!response.ok) throw new Error(`Flux LoRA API error: ${await response.text()}`);
  const data = await response.json();
  const imgUrl = data.images?.[0]?.url;
  if (!imgUrl) throw new Error('No image returned from Flux LoRA');
  const imgRes = await fetch(imgUrl);
  return Buffer.from(await imgRes.arrayBuffer());
}

// --- Video Generation (Kling 3.0 via fal.ai) ---
const FAL_VIDEO_ENDPOINT = 'https://queue.fal.run/fal-ai/kling-video/v3/standard/text-to-video';

function buildVideoPrompt(data, brand) {
  const scene = data.scene || data.headline || 'dynamic product showcase';
  const mood = data.mood || 'energetic and professional';
  const cameraMove = data.cameraMove || 'slow tracking shot';

  return [
    `Brand: ${brand.name}.`,
    brand.imageStyle ? `Visual style: ${brand.imageStyle}.` : null,
    brand.defaultBackground ? `Brand aesthetic: ${brand.defaultBackground}.` : null,
    `Scene: ${scene}.`,
    `Mood: ${mood}.`,
    `Camera: ${cameraMove}.`,
    `Duration: ${data.duration || 5} seconds.`,
  ].filter(Boolean).join('\n');
}

async function generateVideoSlide(prompt, options = {}) {
  const { falKey } = options;
  if (!falKey) throw new Error('Fal.ai API key not configured. Add it in Settings.');

  // Submit to fal.ai queue
  const submitRes = await fetch(FAL_VIDEO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      duration: String(options.duration || 5),
      aspect_ratio: options.aspectRatio || '9:16',
      generate_audio: options.audio || false,
      negative_prompt: 'blur, distortion, low quality, morphing, flickering, disfigured hands, extra fingers, watermark, text overlay, logo, compression artifacts',
    }),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`fal.ai video submit error (${submitRes.status}): ${errText}`);
  }

  const submitData = await submitRes.json();
  const { request_id, status_url, response_url } = submitData;
  if (!request_id) throw new Error('fal.ai did not return a request_id');

  // Poll for completion (timeout after 10 min)
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(status_url, {
      headers: { 'Authorization': `Key ${falKey}` },
    });
    if (!statusRes.ok) continue;
    const status = await statusRes.json();
    if (status.status === 'COMPLETED') {
      // Fetch the result
      const resultRes = await fetch(response_url, {
        headers: { 'Authorization': `Key ${falKey}` },
      });
      if (!resultRes.ok) throw new Error(`fal.ai result fetch failed (${resultRes.status})`);
      const result = await resultRes.json();
      const videoUrl = result.video?.url;
      if (!videoUrl) throw new Error('fal.ai returned success but no video URL');
      return videoUrl;
    }
    if (status.status === 'FAILED') {
      throw new Error(`Video generation failed: ${status.error || 'unknown error'}`);
    }
  }
  throw new Error('Video generation timed out after 10 minutes');
}

// --- Firebase Admin ---
let bucket = null;
let db = null;
try {
  // Parse Firebase service account JSON, handling various env var encoding formats
  const rawSA = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  // Fix escaped quotes (\"->"), then convert real newlines to \\n so JSON.parse doesn't break
  const cleanedSA = (rawSA || '{}').replace(/\\"/g, '"').replace(/\n/g, '\\n').replace(/\r/g, '');
  const serviceAccount = JSON.parse(cleanedSA);
  if (serviceAccount.project_id) {
    // Ensure private key has actual newlines (\\n -> real newline)
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    const storageBucketName = process.env.FIREBASE_STORAGE_BUCKET?.trim();
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      ...(storageBucketName && { storageBucket: storageBucketName }),
    });
    db = admin.firestore();
    if (storageBucketName) {
      bucket = admin.storage().bucket();
      console.log('[Firebase] Storage bucket configured:', storageBucketName);
    } else {
      console.warn('[Firebase] No FIREBASE_STORAGE_BUCKET set — vault uses local disk.');
    }
    console.log('[Firebase] Admin initialized for project:', serviceAccount.project_id);
  } else {
    console.warn('[Firebase] No valid service account — auth disabled (local dev mode).');
  }
} catch (err) {
  console.error('[Firebase] Init failed:', err.message);
}


// OpenAI and Anthropic clients are now created per-request via getOpenAI(req) / getAnthropic(req)
const app = express();
const PORT = process.env.PORT || 4545;

const isVercel = process.env.VERCEL === '1';
const outputDir = isVercel ? '/tmp/output' : path.join(__dirname, 'output');
const uploadsDir = isVercel ? '/tmp/uploads' : path.join(__dirname, 'uploads');
const backgroundsDir = isVercel ? '/tmp/backgrounds' : path.join(__dirname, 'backgrounds');

try {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(backgroundsDir, { recursive: true });
} catch (err) {
  console.warn('Could not create dirs:', err.message);
}

let galleryDlAvailable = false;
if (!isVercel) {
  try { execSync('which gallery-dl', { stdio: 'ignore' }); galleryDlAvailable = true; }
  catch { console.warn('gallery-dl not found. Background download disabled. Install: brew install gallery-dl'); }
}
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  },
});

// --- Safe error message helper ---
const isProduction = process.env.NODE_ENV === 'production';
function safeErrorMessage(err, fallback = 'An error occurred') {
  if (isProduction) return fallback;
  return (err instanceof Error ? err.message : String(err)) || fallback;
}

// --- SSRF validation helper ---
function isUrlSafe(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return false;
    // Block private IP ranges
    const parts = host.split('.').map(Number);
    if (parts.length === 4 && !parts.some(isNaN)) {
      if (parts[0] === 10) return false;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] === 169 && parts[1] === 254) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// --- MIME validation helper ---
async function validateImageFile(file) {
  try {
    const input = file.path || file.buffer;
    const meta = await sharp(input).metadata();
    if (!meta.format) throw new Error('Unrecognized image format');
    return meta;
  } catch (err) {
    throw new Error('Uploaded file is not a valid image');
  }
}

// --- Firebase Auth middleware ---
async function requireAuth(req, res, next) {
  if (!admin.apps.length) {
    if (process.env.NODE_ENV === 'production') return res.status(500).json({ error: 'Auth service unavailable' });
    req.user = { email: 'dev@local', uid: 'local-dev' }; return next();
  }
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Firebase Storage upload ---
async function uploadToStorage(buffer, filename) {
  if (!bucket) {
    // local dev fallback — write to disk
    await fs.writeFile(path.join(outputDir, filename), buffer);
    return `/output/${filename}`;
  }
  try {
    const file = bucket.file(`carousel-studio/${filename}`);
    await file.save(buffer, { metadata: { contentType: 'image/png' } });
    await file.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/carousel-studio/${filename}`;
  } catch (err) {
    console.error('[Storage Upload] Failed, falling back to local disk:', err.message);
    await fs.writeFile(path.join(outputDir, filename), buffer);
    return `/output/${filename}`;
  }
}

async function uploadVideoToStorage(buffer, filename) {
  if (!bucket) {
    await fs.writeFile(path.join(outputDir, filename), buffer);
    return `/output/${filename}`;
  }
  try {
    const file = bucket.file(`carousel-studio/${filename}`);
    await file.save(buffer, { metadata: { contentType: 'video/mp4' } });
    await file.makePublic();
    return `https://storage.googleapis.com/${bucket.name}/carousel-studio/${filename}`;
  } catch (err) {
    console.error('[Video Upload] Failed, falling back to local disk:', err.message);
    await fs.writeFile(path.join(outputDir, filename), buffer);
    return `/output/${filename}`;
  }
}

// --- Face Photo Helpers ---
async function getFacePhotoUrls(facePhotos) {
  if (!facePhotos || facePhotos.length === 0) return [];
  if (!bucket) {
    // Local dev — return local paths
    return facePhotos.map(p => ({ ...p, url: `/output/${path.basename(p.storagePath)}` }));
  }
  return Promise.all(facePhotos.map(async (photo) => {
    try {
      const file = bucket.file(photo.storagePath);
      await file.makePublic();
      const url = `https://storage.googleapis.com/${bucket.name}/${photo.storagePath}`;
      return { ...photo, url };
    } catch (err) {
      console.warn('[getFacePhotoUrls] Failed for', photo.storagePath, err.message);
      return { ...photo, url: null };
    }
  }));
}

async function downloadFacePhotosToTemp(brand) {
  const photos = brand.facePhotos;
  if (!photos || photos.length === 0) return [];
  const tmpPaths = [];
  for (const photo of photos) {
    const tmpPath = path.join(uploadsDir, `face_${crypto.randomUUID().slice(0, 8)}.png`);
    if (bucket) {
      const file = bucket.file(photo.storagePath);
      const [buffer] = await file.download();
      await fs.writeFile(tmpPath, buffer);
    } else {
      // Local dev — copy from output dir
      const src = path.join(outputDir, path.basename(photo.storagePath));
      await fs.copyFile(src, tmpPath);
    }
    tmpPaths.push(tmpPath);
  }
  return tmpPaths;
}

async function cleanupTempFiles(paths) {
  for (const p of paths) {
    await fs.unlink(p).catch(() => {});
  }
}

// --- Person Helpers ---
async function getPersonById(personId, userId) {
  if (!db) return null;
  const doc = await db.collection('carousel_persons').doc(personId).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (data.userId !== userId) return null;
  return { id: personId, ...data };
}

async function downloadPersonPhotosToTemp(person) {
  const photos = person.photos;
  if (!photos || photos.length === 0) return [];
  const tmpPaths = [];
  for (const photo of photos) {
    const tmpPath = path.join(uploadsDir, `face_${crypto.randomUUID().slice(0, 8)}.png`);
    if (bucket) {
      const file = bucket.file(photo.storagePath);
      const [buffer] = await file.download();
      await fs.writeFile(tmpPath, buffer);
    } else {
      const src = path.join(outputDir, path.basename(photo.storagePath));
      await fs.copyFile(src, tmpPath);
    }
    tmpPaths.push(tmpPath);
  }
  return tmpPaths;
}

// --- Save image record to Firestore for vault ---
async function saveImageRecord({ userId, brandId, filename, type }) {
  if (!db) return null;
  try {
    const doc = db.collection('generated_images').doc();
    await doc.set({
      userId,
      brandId: brandId || null,
      filename,
      storagePath: `carousel-studio/${filename}`,
      type, // 'slide' | 'meme' | 'carousel' | 'edit' | 'personalized'
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return doc.id;
  } catch (err) {
    console.warn('[saveImageRecord] Failed:', err.message);
    return null;
  }
}

app.use(express.json({ limit: '10mb' }));

// --- Rate limiting for expensive generation routes ---
const generationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.uid || req.ip,
  message: { error: 'Too many requests, please try again in a minute' },
});

// --- Security headers ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// --- Health check ---
app.get('/health', (req, res) => res.json({ status: 'ok', firebase: !!admin.apps.length, timestamp: Date.now() }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(outputDir));
app.use('/uploads', express.static(uploadsDir));
app.use('/backgrounds', express.static(backgroundsDir));

// --- Brand Configurations ---

const GENERIC_BRAND = {
  id: 'generic',
  name: 'My Brand',
  website: '',
  colors: { primary: '#1A1A2E', accent: '#E94560', white: '#FFFFFF', secondary: '#16213E', cta: '#0F3460' },
  defaultMicroLabel: 'MY BRAND',
  defaultBackground: 'dark premium background with subtle grain',
  iconOverlayText: '',
  systemPrompt: 'Generate social media carousel content. Focus on punchy headlines, clear messaging, and visual variety.',
  imageStyle: 'Minimalist and clean. Candid photography with natural lighting, shot on iPhone. 35mm film grain aesthetic. Simple uncluttered backgrounds.',
};

// --- Local brand store (JSON file fallback when Firestore is unavailable) ---
const localBrandsPath = path.join(__dirname, 'local-brands.json');

async function readLocalBrands() {
  try {
    const data = await fs.readFile(localBrandsPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function writeLocalBrands(data) {
  await fs.writeFile(localBrandsPath, JSON.stringify(data, null, 2));
}

async function updateBrandFields(brandId, fields) {
  if (db) {
    await db.collection('carousel_brands').doc(brandId).update(fields);
  } else {
    const all = await readLocalBrands();
    if (all[brandId]) {
      Object.assign(all[brandId], fields);
      await writeLocalBrands(all);
    }
  }
}

async function getBrandAsync(brandId, userId) {
  if (!brandId) return GENERIC_BRAND;
  if (db) {
    try {
      const doc = await db.collection('carousel_brands').doc(brandId).get();
      if (doc.exists && doc.data().createdBy === userId) return { id: brandId, ...doc.data() };
    } catch (e) {
      console.error('[getBrandAsync]', e.message);
    }
  } else {
    try {
      const brands = await readLocalBrands();
      if (brands[brandId] && brands[brandId].createdBy === userId) {
        return { id: brandId, ...brands[brandId] };
      }
    } catch (e) {
      console.error('[getBrandAsync local]', e.message);
    }
  }
  return GENERIC_BRAND;
}

function trimGenerationHistory(history, max = 50) {
  if (!Array.isArray(history)) return [];
  return history.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, max);
}

function buildHistoryPromptSection(history, maxInject = 30) {
  if (!Array.isArray(history) || history.length === 0) return '';
  const recent = history.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, maxInject);
  const lines = recent.map(entry => {
    const headlines = (entry.headlines || []).slice(0, 5).join(' | ');
    return `- "${entry.title}"${headlines ? ` (covered: ${headlines})` : ''}`;
  });
  return `\nPREVIOUSLY GENERATED CONTENT (avoid repeating these topics and angles):\n${lines.join('\n')}`;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

const ICON_OVERLAY_CONFIGS = {
  'bottom-right': { position: 'bottom-right', sizePercent: 8, opacity: 0.18 },
  'bottom-left': { position: 'bottom-left', sizePercent: 8, opacity: 0.18 },
  'top-right': { position: 'top-right', sizePercent: 6, opacity: 0.15 },
  'top-left': { position: 'top-left', sizePercent: 6, opacity: 0.15 },
  'mid-right': { position: 'mid-right', sizePercent: 10, opacity: 0.2 },
};

// --- Mockup (Sharp-rendered) Slide Constants & Helpers ---

const MOCKUP_CANVAS = { width: 1080, height: 1920 };
const MOCKUP_ASPECT_RATIOS = {
  '9:16': { width: 1080, height: 1920 },
  '4:5':  { width: 1080, height: 1350 },
  '1:1':  { width: 1080, height: 1080 },
};
const MOCKUP_SAFE_ZONE = { top: 120, bottom: 200, left: 90, right: 90 };
const MOCKUP_FONT_FAMILY = 'Helvetica, Arial, sans-serif';
const MOCKUP_AVAILABLE_FONTS = ['Helvetica', 'Arial', 'Georgia', 'Times New Roman', 'Courier', 'Impact'];

function getCanvasDimensions(aspectRatio) {
  return MOCKUP_ASPECT_RATIOS[aspectRatio] || MOCKUP_ASPECT_RATIOS['9:16'];
}

function getSafeZone(canvasHeight) {
  // Scale safe zones proportionally for shorter canvases
  const scale = canvasHeight / 1920;
  return {
    top: Math.round(120 * scale),
    bottom: Math.round(200 * scale),
    left: 90,
    right: 90,
  };
}

function clampOffset(val, min, max) {
  return Math.max(min, Math.min(max, parseInt(val) || 0));
}

function resolveFontFamily(requested) {
  if (requested && MOCKUP_AVAILABLE_FONTS.includes(requested)) {
    return `${requested}, ${MOCKUP_FONT_FAMILY}`;
  }
  return MOCKUP_FONT_FAMILY;
}

const MOCKUP_THEMES = {
  dark: (brand) => ({
    background: brand.colors.primary,
    textColor: '#FFFFFF',
    subtextColor: 'rgba(255,255,255,0.7)',
    microColor: brand.colors.accent,
    highlightColor: brand.colors.accent,
  }),
  light: (brand) => ({
    background: '#F5F3EF',
    textColor: brand.colors.primary,
    subtextColor: 'rgba(0,0,0,0.6)',
    microColor: brand.colors.accent,
    highlightColor: brand.colors.accent,
  }),
};

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapText(text, fontSize, maxWidth, isBold = false) {
  const charWidth = fontSize * (isBold ? 0.56 : 0.52);
  const maxChars = Math.floor(maxWidth / charWidth);
  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    if (current && (current.length + 1 + word.length) > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function svgTextLines(lines, { x, startY, fontSize, fontWeight, fill, lineHeight, letterSpacing, fontFamily }) {
  const ff = fontFamily || MOCKUP_FONT_FAMILY;
  return lines.map((line, i) => {
    const y = startY + i * (fontSize * (lineHeight || 1.3));
    const ls = letterSpacing ? ` letter-spacing="${letterSpacing}"` : '';
    return `<text x="${x}" y="${y}" font-family="${ff}" font-size="${fontSize}" font-weight="${fontWeight || 'normal'}" fill="${fill}"${ls}>${escapeXml(line)}</text>`;
  }).join('\n');
}

function svgHighlightBars(lines, phrase, { x, startY, fontSize, lineHeight, color, opacity }) {
  if (!phrase) return '';
  const charWidth = fontSize * 0.56;
  const rects = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.toLowerCase().indexOf(phrase.toLowerCase());
    if (idx === -1) continue;

    const matchLen = phrase.length;
    const rx = x + idx * charWidth - 6;
    const ry = startY + i * (fontSize * (lineHeight || 1.3)) - fontSize * 0.85;
    const rw = matchLen * charWidth + 12;
    const rh = fontSize * 1.2;

    rects.push(`<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="6" fill="${color}" opacity="${opacity}" />`);
  }

  return rects.join('\n');
}

async function getIPhoneFrame(brandId, width, height) {
  const brandFramePath = path.join(rootDir, 'brands', brandId, 'assets', 'iphone-frame.png');
  try {
    await fs.access(brandFramePath);
    return sharp(brandFramePath).resize(width, height).png().toBuffer();
  } catch {
    // Generate SVG iPhone frame with Dynamic Island
    const r = Math.round(width * 0.12);
    const bezelW = Math.round(width * 0.03);
    const diW = Math.round(width * 0.35);
    const diH = Math.round(height * 0.018);
    const diX = Math.round((width - diW) / 2);
    const diY = Math.round(height * 0.015);

    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" rx="${r}" fill="#1A1A1A"/>
      <rect x="${bezelW}" y="${bezelW}" width="${width - bezelW * 2}" height="${height - bezelW * 2}" rx="${r - bezelW}" fill="#000"/>
      <rect x="${diX}" y="${diY}" width="${diW}" height="${diH}" rx="${Math.round(diH / 2)}" fill="#1A1A1A"/>
    </svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }
}

async function createPhoneMockup({ screenshotPath, brandId, phoneWidth, phoneHeight, angle }) {
  phoneWidth = phoneWidth || 420;
  phoneHeight = phoneHeight || 860;
  angle = angle || 0;

  const frameBuffer = await getIPhoneFrame(brandId, phoneWidth, phoneHeight);

  // Inner screen area (inset from frame)
  const bezel = Math.round(phoneWidth * 0.03);
  const cornerR = Math.round(phoneWidth * 0.09);
  const screenW = phoneWidth - bezel * 2;
  const screenH = phoneHeight - bezel * 2;

  let screenBuffer;
  if (screenshotPath) {
    const fullPath = path.join(uploadsDir, path.basename(screenshotPath));
    try {
      await fs.access(fullPath);
      screenBuffer = await sharp(fullPath)
        .resize(screenW, screenH, { fit: 'cover' })
        .png()
        .toBuffer();
    } catch {
      screenBuffer = null;
    }
  }

  if (!screenBuffer) {
    // Placeholder screen
    const placeholderSvg = `<svg width="${screenW}" height="${screenH}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${screenW}" height="${screenH}" rx="${cornerR}" fill="#1e293b"/>
      <text x="${screenW / 2}" y="${screenH / 2}" font-family="${MOCKUP_FONT_FAMILY}" font-size="24" fill="rgba(255,255,255,0.3)" text-anchor="middle">Upload a screenshot</text>
    </svg>`;
    screenBuffer = await sharp(Buffer.from(placeholderSvg)).png().toBuffer();
  }

  // Mask screenshot with rounded corners
  const maskSvg = `<svg width="${screenW}" height="${screenH}"><rect width="${screenW}" height="${screenH}" rx="${cornerR}" fill="white"/></svg>`;
  screenBuffer = await sharp(screenBuffer)
    .composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
    .png()
    .toBuffer();

  // Composite screen onto frame
  let phone = await sharp(frameBuffer)
    .composite([{ input: screenBuffer, left: bezel, top: bezel }])
    .png()
    .toBuffer();

  // Apply rotation if needed
  if (angle !== 0) {
    // Extend canvas to fit rotated image, then rotate
    const diag = Math.ceil(Math.sqrt(phoneWidth * phoneWidth + phoneHeight * phoneHeight));
    phone = await sharp(phone)
      .extend({
        top: Math.round((diag - phoneHeight) / 2),
        bottom: Math.round((diag - phoneHeight) / 2),
        left: Math.round((diag - phoneWidth) / 2),
        right: Math.round((diag - phoneWidth) / 2),
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .trim()
      .png()
      .toBuffer();
  }

  return phone;
}

// --- Image Usage Helpers (figure, background) ---

async function createFigureElement({ imagePath, maxWidth, maxHeight, borderRadius }) {
  const fullPath = path.join(uploadsDir, path.basename(imagePath));
  try {
    await fs.access(fullPath);
  } catch {
    return null;
  }

  let img = sharp(fullPath).resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true });
  let buf = await img.png().toBuffer();

  // Apply rounded corners if requested
  if (borderRadius && borderRadius > 0) {
    const meta = await sharp(buf).metadata();
    const mask = `<svg width="${meta.width}" height="${meta.height}"><rect width="${meta.width}" height="${meta.height}" rx="${borderRadius}" fill="white"/></svg>`;
    buf = await sharp(buf).composite([{ input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();
  }

  return buf;
}

async function createBackgroundImage(imagePath, overlayOpacity, canvasWidth, canvasHeight) {
  const width = canvasWidth || MOCKUP_CANVAS.width;
  const height = canvasHeight || MOCKUP_CANVAS.height;
  const fullPath = path.join(uploadsDir, path.basename(imagePath));
  try {
    await fs.access(fullPath);
  } catch {
    return null;
  }

  const bgBuffer = await sharp(fullPath)
    .resize(width, height, { fit: 'cover' })
    .png()
    .toBuffer();

  // Apply dark gradient overlay for text readability
  const opacity = overlayOpacity || 0.55;
  const overlaySvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#000" stop-opacity="${opacity * 0.6}"/>
        <stop offset="40%" stop-color="#000" stop-opacity="${opacity * 0.3}"/>
        <stop offset="70%" stop-color="#000" stop-opacity="${opacity * 0.7}"/>
        <stop offset="100%" stop-color="#000" stop-opacity="${opacity}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#g)"/>
  </svg>`;

  const result = await sharp(bgBuffer)
    .composite([{ input: Buffer.from(overlaySvg), blend: 'over' }])
    .png()
    .toBuffer();

  return result;
}

function getFigurePosition(position, figMeta, canvasW, canvasH, padding) {
  const fw = figMeta.width || 300;
  const fh = figMeta.height || 300;
  const p = padding || 60;
  const positions = {
    'top-right': { left: canvasW - fw - p, top: p + 80 },
    'top-left': { left: p, top: p + 80 },
    'center-right': { left: canvasW - fw - p, top: Math.round((canvasH - fh) / 2) },
    'center-left': { left: p, top: Math.round((canvasH - fh) / 2) },
    'bottom-right': { left: canvasW - fw - p, top: canvasH - fh - p - 120 },
    'bottom-left': { left: p, top: canvasH - fh - p - 120 },
    'center': { left: Math.round((canvasW - fw) / 2), top: Math.round((canvasH - fh) / 2) },
  };
  return positions[position] || positions['center-right'];
}

// --- Mockup Layout Renderers ---

// Shared: build the text SVG layer for any layout
function buildTextSvg({ width, height, bgFill, textX, textMaxWidth, microLabel, headline, body, highlight, highlightStyle, theme, fontSizes }) {
  const { headlineFontSize, bodyFontSize, microFontSize } = fontSizes;
  const highlightOpacity = highlightStyle === 'bold' ? 0.4 : 0.28;

  const headlineLines = wrapText(headline, headlineFontSize, textMaxWidth, true);
  const bodyLines = body ? wrapText(body, bodyFontSize, textMaxWidth) : [];

  return { headlineLines, bodyLines, headlineFontSize, bodyFontSize, microFontSize, highlightOpacity };
}

async function renderPhoneRight(data, brand, theme) {
  const { width, height } = getCanvasDimensions(data.aspectRatio);
  const safe = getSafeZone(height);
  const imageUsage = data.imageUsage || 'phone';
  const fontFamily = resolveFontFamily(data.fontFamily);

  const micro = data.microLabel || brand.defaultMicroLabel;
  const headline = data.headline || 'Your headline here';
  const body = data.body || '';
  const highlight = data.highlightPhrase || '';
  const highlightOpacity = data.highlightStyle === 'bold' ? 0.4 : 0.28;

  // Color overrides
  const microColor = data.microColor || theme.microColor;
  const textFill = data.textColor || (imageUsage === 'background' ? '#FFFFFF' : theme.textColor);
  const subtextFill = data.subtextColor || (imageUsage === 'background' ? 'rgba(255,255,255,0.75)' : theme.subtextColor);
  const highlightColor = data.microColor || theme.highlightColor;

  // Determine base layer + composites based on imageUsage
  let baseBuffer = null;
  let imageComposite = null;
  let textMaxWidth;
  const headlineFontSize = parseInt(data.headlineFontSize) || 72;
  const bodyFontSize = parseInt(data.bodyFontSize) || 32;
  const microFontSize = 24;

  if (imageUsage === 'background' && data.screenshotImage) {
    baseBuffer = await createBackgroundImage(data.screenshotImage, parseFloat(data.bgOverlayOpacity) || 0.55, width, height);
    textMaxWidth = width - safe.left - safe.right;
  } else if (imageUsage === 'figure' && data.screenshotImage) {
    const figSizeMap = { small: 280, medium: 380, large: 500 };
    const maxW = figSizeMap[data.figureSize] || 380;
    const figBuf = await createFigureElement({
      imagePath: data.screenshotImage,
      maxWidth: maxW,
      maxHeight: Math.round(maxW * 1.5),
      borderRadius: parseInt(data.figureBorderRadius) || 24,
    });
    if (figBuf) {
      const figMeta = await sharp(figBuf).metadata();
      const pos = getFigurePosition(data.figurePosition || 'bottom-right', figMeta, width, height, 60);
      imageComposite = { input: figBuf, left: pos.left, top: pos.top };
    }
    textMaxWidth = Math.round(width * 0.65) - safe.left;
  } else {
    // Phone frame (default)
    const phoneSizeMap = { small: 360, medium: 420, large: 500 };
    const pw = phoneSizeMap[data.phoneSize] || 420;
    const ph = Math.round(pw * 2.05);
    const phoneAngle = parseInt(data.phoneAngle) || -8;

    const phoneMockup = await createPhoneMockup({
      screenshotPath: data.screenshotImage,
      brandId: brand.id,
      phoneWidth: pw,
      phoneHeight: ph,
      angle: phoneAngle,
    });
    const phoneMeta = await sharp(phoneMockup).metadata();
    const phoneLeft = width - (phoneMeta.width || pw) + 20;
    const phoneTop = height - (phoneMeta.height || ph) + Math.round(ph * 0.12);
    imageComposite = { input: phoneMockup, left: Math.max(0, phoneLeft), top: Math.max(0, Math.min(phoneTop, height - 10)) };
    textMaxWidth = Math.round(width * 0.65) - safe.left;
  }

  const headlineLines = wrapText(headline, headlineFontSize, textMaxWidth, true);
  const bodyLines = body ? wrapText(body, bodyFontSize, textMaxWidth) : [];

  // Per-element offsets (fall back to legacy textOffsetX/Y)
  const fallbackX = parseInt(data.textOffsetX) || 0;
  const fallbackY = parseInt(data.textOffsetY) || 0;

  // Base positions
  let baseY = safe.top + 60;
  const baseX = safe.left;

  // Micro position
  const microX = baseX + clampOffset(data.microOffsetX || fallbackX, -500, 500);
  const microY = baseY + clampOffset(data.microOffsetY || fallbackY, -800, 800);

  // Headline base position
  const headlineBaseY = baseY + microFontSize + headlineFontSize + 16;
  const headlineX = baseX + clampOffset(data.headlineOffsetX || fallbackX, -500, 500);
  const headlineY = headlineBaseY + clampOffset(data.headlineOffsetY || fallbackY, -800, 800);

  // Body base position
  const bodyBaseY = headlineBaseY + headlineLines.length * headlineFontSize * 1.25 + 30;
  const bodyX = baseX + clampOffset(data.bodyOffsetX || fallbackX, -500, 500);
  const bodyY = bodyBaseY + clampOffset(data.bodyOffsetY || fallbackY, -800, 800);

  const microSvg = svgTextLines([micro], { x: microX, startY: microY, fontSize: microFontSize, fontWeight: '700', fill: microColor, letterSpacing: '4', fontFamily });

  const highlightSvg = svgHighlightBars(headlineLines, highlight, { x: headlineX, startY: headlineY, fontSize: headlineFontSize, lineHeight: 1.25, color: highlightColor, opacity: highlightOpacity });
  const headlineSvg = svgTextLines(headlineLines, { x: headlineX, startY: headlineY, fontSize: headlineFontSize, fontWeight: 'bold', fill: textFill, lineHeight: 1.25, fontFamily });

  const bodySvg = bodyLines.length ? svgTextLines(bodyLines, { x: bodyX, startY: bodyY, fontSize: bodyFontSize, fill: subtextFill, lineHeight: 1.5, fontFamily }) : '';

  // Overlay darken (for non-background modes)
  const overlayDarken = parseFloat(data.overlayDarken) || 0;
  const darkenRect = (!baseBuffer && overlayDarken > 0) ? `<rect width="${width}" height="${height}" fill="#000" opacity="${overlayDarken}"/>` : '';

  if (baseBuffer) {
    const composites = [];
    if (overlayDarken > 0) {
      const darkenSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="#000" opacity="${overlayDarken}"/></svg>`;
      composites.push({ input: Buffer.from(darkenSvg) });
    }
    const textSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      ${microSvg}
      ${highlightSvg}
      ${headlineSvg}
      ${bodySvg}
    </svg>`;
    composites.push({ input: Buffer.from(textSvg) });
    return sharp(baseBuffer).composite(composites).png().toBuffer();
  }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="${theme.background}"/>
    ${darkenRect}
    ${microSvg}
    ${highlightSvg}
    ${headlineSvg}
    ${bodySvg}
  </svg>`;

  if (imageComposite) {
    return sharp(Buffer.from(svg)).composite([imageComposite]).png().toBuffer();
  }
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderPhoneLeft(data, brand, theme) {
  const { width, height } = getCanvasDimensions(data.aspectRatio);
  const safe = getSafeZone(height);
  const imageUsage = data.imageUsage || 'phone';
  const fontFamily = resolveFontFamily(data.fontFamily);

  const micro = data.microLabel || brand.defaultMicroLabel;
  const headline = data.headline || 'Your headline here';
  const body = data.body || '';
  const highlight = data.highlightPhrase || '';
  const highlightOpacity = data.highlightStyle === 'bold' ? 0.4 : 0.28;

  // Color overrides
  const microColor = data.microColor || theme.microColor;
  const textFill = data.textColor || (imageUsage === 'background' ? '#FFFFFF' : theme.textColor);
  const subtextFill = data.subtextColor || (imageUsage === 'background' ? 'rgba(255,255,255,0.75)' : theme.subtextColor);
  const highlightColor = data.microColor || theme.highlightColor;

  let baseBuffer = null;
  let imageComposite = null;
  let baseTextX;
  let textMaxWidth;
  const headlineFontSize = parseInt(data.headlineFontSize) || 62;
  const bodyFontSize = parseInt(data.bodyFontSize) || 30;
  const microFontSize = 22;

  if (imageUsage === 'background' && data.screenshotImage) {
    baseBuffer = await createBackgroundImage(data.screenshotImage, parseFloat(data.bgOverlayOpacity) || 0.55, width, height);
    baseTextX = safe.left;
    textMaxWidth = width - safe.left - safe.right;
  } else if (imageUsage === 'figure' && data.screenshotImage) {
    const figSizeMap = { small: 280, medium: 380, large: 500 };
    const maxW = figSizeMap[data.figureSize] || 380;
    const figBuf = await createFigureElement({
      imagePath: data.screenshotImage,
      maxWidth: maxW,
      maxHeight: Math.round(maxW * 1.5),
      borderRadius: parseInt(data.figureBorderRadius) || 24,
    });
    if (figBuf) {
      const figMeta = await sharp(figBuf).metadata();
      const pos = getFigurePosition(data.figurePosition || 'center-left', figMeta, width, height, 60);
      imageComposite = { input: figBuf, left: pos.left, top: pos.top };
      baseTextX = pos.left + (figMeta.width || maxW) + 40;
    } else {
      baseTextX = safe.left;
    }
    textMaxWidth = Math.max(width - baseTextX - safe.right, 300);
  } else {
    // Phone frame (default)
    const phoneSizeMap = { small: 340, medium: 400, large: 480 };
    const pw = phoneSizeMap[data.phoneSize] || 400;
    const ph = Math.round(pw * 2.05);
    const phoneAngle = parseInt(data.phoneAngle) || 0;

    const phoneMockup = await createPhoneMockup({
      screenshotPath: data.screenshotImage,
      brandId: brand.id,
      phoneWidth: pw,
      phoneHeight: ph,
      angle: phoneAngle,
    });
    const phoneMeta = await sharp(phoneMockup).metadata();
    const phoneLeft = safe.left - 20;
    const phoneTop = Math.round((height - (phoneMeta.height || ph)) / 2);
    imageComposite = { input: phoneMockup, left: Math.max(0, phoneLeft), top: Math.max(0, phoneTop) };
    baseTextX = (phoneMeta.width || pw) + safe.left + 40;
    textMaxWidth = Math.max(width - baseTextX - safe.right, 300);
  }

  const headlineLines = wrapText(headline, headlineFontSize, textMaxWidth, true);
  const bodyLines = body ? wrapText(body, bodyFontSize, textMaxWidth) : [];

  // Per-element offsets (fall back to legacy textOffsetX/Y)
  const fallbackX = parseInt(data.textOffsetX) || 0;
  const fallbackY = parseInt(data.textOffsetY) || 0;

  const baseY = Math.round(height * 0.30);

  const microX = baseTextX + clampOffset(data.microOffsetX || fallbackX, -500, 500);
  const microY = baseY + clampOffset(data.microOffsetY || fallbackY, -800, 800);

  const headlineBaseY = baseY + microFontSize + headlineFontSize + 12;
  const headlineX = baseTextX + clampOffset(data.headlineOffsetX || fallbackX, -500, 500);
  const headlineY = headlineBaseY + clampOffset(data.headlineOffsetY || fallbackY, -800, 800);

  const bodyBaseY = headlineBaseY + headlineLines.length * headlineFontSize * 1.25 + 20;
  const bodyX = baseTextX + clampOffset(data.bodyOffsetX || fallbackX, -500, 500);
  const bodyY = bodyBaseY + clampOffset(data.bodyOffsetY || fallbackY, -800, 800);

  const microSvg = svgTextLines([micro], { x: microX, startY: microY, fontSize: microFontSize, fontWeight: '700', fill: microColor, letterSpacing: '4', fontFamily });

  const highlightSvg = svgHighlightBars(headlineLines, highlight, { x: headlineX, startY: headlineY, fontSize: headlineFontSize, lineHeight: 1.25, color: highlightColor, opacity: highlightOpacity });
  const headlineSvg = svgTextLines(headlineLines, { x: headlineX, startY: headlineY, fontSize: headlineFontSize, fontWeight: 'bold', fill: textFill, lineHeight: 1.25, fontFamily });

  const bodySvg = bodyLines.length ? svgTextLines(bodyLines, { x: bodyX, startY: bodyY, fontSize: bodyFontSize, fill: subtextFill, lineHeight: 1.5, fontFamily }) : '';

  const overlayDarken = parseFloat(data.overlayDarken) || 0;
  const darkenRect = (!baseBuffer && overlayDarken > 0) ? `<rect width="${width}" height="${height}" fill="#000" opacity="${overlayDarken}"/>` : '';

  if (baseBuffer) {
    const composites = [];
    if (overlayDarken > 0) {
      const darkenSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="#000" opacity="${overlayDarken}"/></svg>`;
      composites.push({ input: Buffer.from(darkenSvg) });
    }
    const textSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      ${microSvg}
      ${highlightSvg}
      ${headlineSvg}
      ${bodySvg}
    </svg>`;
    composites.push({ input: Buffer.from(textSvg) });
    return sharp(baseBuffer).composite(composites).png().toBuffer();
  }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="${theme.background}"/>
    ${darkenRect}
    ${microSvg}
    ${highlightSvg}
    ${headlineSvg}
    ${bodySvg}
  </svg>`;

  if (imageComposite) {
    return sharp(Buffer.from(svg)).composite([imageComposite]).png().toBuffer();
  }
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderTextStatement(data, brand, theme) {
  const { width, height } = getCanvasDimensions(data.aspectRatio);
  const safe = getSafeZone(height);
  const imageUsage = data.imageUsage || 'none';
  const fontFamily = resolveFontFamily(data.fontFamily);

  const micro = data.microLabel || brand.defaultMicroLabel;
  const headline = data.headline || 'Your headline here';
  const body = data.body || '';
  const highlight = data.highlightPhrase || '';
  const highlightOpacity = data.highlightStyle === 'bold' ? 0.5 : 0.3;

  // Color overrides
  const microColor = data.microColor || theme.microColor;
  const textFill = data.textColor || (imageUsage === 'background' ? '#FFFFFF' : theme.textColor);
  const subtextFill = data.subtextColor || (imageUsage === 'background' ? 'rgba(255,255,255,0.75)' : theme.subtextColor);
  const highlightColor = data.microColor || theme.highlightColor;

  let baseBuffer = null;
  let imageComposite = null;

  if (imageUsage === 'background' && data.screenshotImage) {
    baseBuffer = await createBackgroundImage(data.screenshotImage, parseFloat(data.bgOverlayOpacity) || 0.6, width, height);
  } else if (imageUsage === 'figure' && data.screenshotImage) {
    const figSizeMap = { small: 240, medium: 340, large: 460 };
    const maxW = figSizeMap[data.figureSize] || 340;
    const figBuf = await createFigureElement({
      imagePath: data.screenshotImage,
      maxWidth: maxW,
      maxHeight: maxW,
      borderRadius: parseInt(data.figureBorderRadius) || 24,
    });
    if (figBuf) {
      const figMeta = await sharp(figBuf).metadata();
      const pos = getFigurePosition(data.figurePosition || 'bottom-right', figMeta, width, height, 80);
      imageComposite = { input: figBuf, left: pos.left, top: pos.top };
    }
  }

  const textMaxWidth = width - safe.left - safe.right;
  const headlineFontSize = parseInt(data.headlineFontSize) || 82;
  const bodyFontSize = parseInt(data.bodyFontSize) || 34;
  const microFontSize = 24;

  const headlineLines = wrapText(headline, headlineFontSize, textMaxWidth, true);
  const bodyLines = body ? wrapText(body, bodyFontSize, textMaxWidth) : [];

  const headlineBlockH = headlineLines.length * headlineFontSize * 1.25;
  const bodyBlockH = bodyLines.length ? bodyLines.length * bodyFontSize * 1.5 + 30 : 0;
  const microBlockH = microFontSize + headlineFontSize + 16;
  const totalH = microBlockH + headlineBlockH + bodyBlockH;

  // Per-element offsets (fall back to legacy textOffsetX/Y)
  const fallbackX = parseInt(data.textOffsetX) || 0;
  const fallbackY = parseInt(data.textOffsetY) || 0;

  const baseY = Math.round((height - totalH) / 2);
  const baseX = safe.left;

  const microX = baseX + clampOffset(data.microOffsetX || fallbackX, -500, 500);
  const microY = baseY + clampOffset(data.microOffsetY || fallbackY, -800, 800);

  const headlineBaseY = baseY + microBlockH;
  const headlineX = baseX + clampOffset(data.headlineOffsetX || fallbackX, -500, 500);
  const headlineY = headlineBaseY + clampOffset(data.headlineOffsetY || fallbackY, -800, 800);

  const bodyBaseY = headlineBaseY + headlineBlockH + 30;
  const bodyX = baseX + clampOffset(data.bodyOffsetX || fallbackX, -500, 500);
  const bodyY = bodyBaseY + clampOffset(data.bodyOffsetY || fallbackY, -800, 800);

  const microSvg = svgTextLines([micro], { x: microX, startY: microY, fontSize: microFontSize, fontWeight: '700', fill: microColor, letterSpacing: '5', fontFamily });

  const highlightSvg = svgHighlightBars(headlineLines, highlight, { x: headlineX, startY: headlineY, fontSize: headlineFontSize, lineHeight: 1.25, color: highlightColor, opacity: highlightOpacity });
  const headlineSvg = svgTextLines(headlineLines, { x: headlineX, startY: headlineY, fontSize: headlineFontSize, fontWeight: 'bold', fill: textFill, lineHeight: 1.25, fontFamily });

  const bodySvg = bodyLines.length ? svgTextLines(bodyLines, { x: bodyX, startY: bodyY, fontSize: bodyFontSize, fill: subtextFill, lineHeight: 1.5, fontFamily }) : '';

  const overlayDarken = parseFloat(data.overlayDarken) || 0;
  const darkenRect = (!baseBuffer && overlayDarken > 0) ? `<rect width="${width}" height="${height}" fill="#000" opacity="${overlayDarken}"/>` : '';

  if (baseBuffer) {
    const composites = [];
    if (overlayDarken > 0) {
      const darkenSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="#000" opacity="${overlayDarken}"/></svg>`;
      composites.push({ input: Buffer.from(darkenSvg) });
    }
    const textSvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      ${microSvg}
      ${highlightSvg}
      ${headlineSvg}
      ${bodySvg}
    </svg>`;
    composites.push({ input: Buffer.from(textSvg) });
    if (imageComposite) composites.push(imageComposite);
    return sharp(baseBuffer).composite(composites).png().toBuffer();
  }

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="${theme.background}"/>
    ${darkenRect}
    ${microSvg}
    ${highlightSvg}
    ${headlineSvg}
    ${bodySvg}
  </svg>`;

  if (imageComposite) {
    return sharp(Buffer.from(svg)).composite([imageComposite]).png().toBuffer();
  }
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Composite text overlay onto an existing image buffer (for hybrid photo slides)
async function compositeTextOverlay(imageBuffer, data, brand) {
  const theme = MOCKUP_THEMES.dark(brand);
  const { width, height } = { width: 1080, height: 1920 };
  const safe = getSafeZone(height);
  const fontFamily = resolveFontFamily(data.fontFamily);

  const micro = data.microLabel || brand.defaultMicroLabel;
  const headline = data.headline || '';
  const body = data.body || '';
  const highlight = data.highlightPhrase || '';
  const highlightOpacity = 0.3;

  if (!headline && !micro) return imageBuffer;

  const textMaxWidth = width - safe.left - safe.right;
  const headlineFontSize = parseInt(data.headlineFontSize) || 82;
  const bodyFontSize = parseInt(data.bodyFontSize) || 34;
  const microFontSize = 24;

  const headlineLines = headline ? wrapText(headline, headlineFontSize, textMaxWidth, true) : [];
  const bodyLines = body ? wrapText(body, bodyFontSize, textMaxWidth) : [];

  const headlineBlockH = headlineLines.length * headlineFontSize * 1.25;
  const bodyBlockH = bodyLines.length ? bodyLines.length * bodyFontSize * 1.5 + 30 : 0;
  const microBlockH = micro ? microFontSize + headlineFontSize + 16 : 0;
  const totalH = microBlockH + headlineBlockH + bodyBlockH;

  // Position text in lower portion of image for photo slides
  const overlayPlacement = data.overlayPlacement || 'bottom third';
  let baseY;
  if (overlayPlacement === 'bottom third') {
    baseY = Math.max(height - totalH - safe.bottom - 40, Math.round(height * 0.55));
  } else {
    baseY = Math.round((height - totalH) / 2);
  }
  const baseX = safe.left;

  // Build text SVG elements
  const textFill = '#FFFFFF';
  const subtextFill = 'rgba(255,255,255,0.75)';
  const microColor = brand.colors.accent;
  const highlightColor = brand.colors.accent;

  const microSvg = micro ? svgTextLines([micro], { x: baseX, startY: baseY, fontSize: microFontSize, fontWeight: '700', fill: microColor, letterSpacing: '5', fontFamily }) : '';

  const headlineY = baseY + microBlockH;
  const highlightSvg = highlight ? svgHighlightBars(headlineLines, highlight, { x: baseX, startY: headlineY, fontSize: headlineFontSize, lineHeight: 1.25, color: highlightColor, opacity: highlightOpacity }) : '';
  const headlineSvg = headlineLines.length ? svgTextLines(headlineLines, { x: baseX, startY: headlineY, fontSize: headlineFontSize, fontWeight: 'bold', fill: textFill, lineHeight: 1.25, fontFamily }) : '';

  const bodyY = headlineY + headlineBlockH + 30;
  const bodySvg = bodyLines.length ? svgTextLines(bodyLines, { x: baseX, startY: bodyY, fontSize: bodyFontSize, fill: subtextFill, lineHeight: 1.5, fontFamily }) : '';

  // Add gradient overlay for text readability
  const gradientSvg = `<defs>
    <linearGradient id="textGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="40%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.7"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#textGrad)"/>`;

  const overlaySvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    ${gradientSvg}
    ${microSvg}
    ${highlightSvg}
    ${headlineSvg}
    ${bodySvg}
  </svg>`;

  // Resize base image to canvas dimensions if needed
  let baseBuffer = imageBuffer;
  const meta = await sharp(imageBuffer).metadata();
  if (meta.width !== width || meta.height !== height) {
    baseBuffer = await sharp(imageBuffer).resize(width, height, { fit: 'cover' }).png().toBuffer();
  }

  return sharp(baseBuffer)
    .composite([{ input: Buffer.from(overlaySvg) }])
    .png()
    .toBuffer();
}

// Generate a transparent PNG text overlay for compositing onto video frames
async function generateVideoTextOverlay(data, brand) {
  if (!data.videoTextOverlay) return null;

  const { width, height } = { width: 1080, height: 1920 };
  const safe = getSafeZone(height);
  const fontFamily = resolveFontFamily(data.fontFamily);

  const micro = data.microLabel || brand.defaultMicroLabel;
  const headline = data.headline || '';
  const body = data.body || '';
  const highlight = data.highlightPhrase || '';
  const highlightOpacity = 0.3;

  if (!headline && !micro && !body) return null;

  const textMaxWidth = width - safe.left - safe.right;
  const headlineFontSize = parseInt(data.headlineFontSize) || 82;
  const bodyFontSize = parseInt(data.bodyFontSize) || 34;
  const microFontSize = 24;

  const headlineLines = headline ? wrapText(headline, headlineFontSize, textMaxWidth, true) : [];
  const bodyLines = body ? wrapText(body, bodyFontSize, textMaxWidth) : [];

  const headlineBlockH = headlineLines.length * headlineFontSize * 1.25;
  const bodyBlockH = bodyLines.length ? bodyLines.length * bodyFontSize * 1.5 + 30 : 0;
  const microBlockH = micro ? microFontSize + headlineFontSize + 16 : 0;
  const totalH = microBlockH + headlineBlockH + bodyBlockH;

  const baseY = Math.max(height - totalH - safe.bottom - 40, Math.round(height * 0.55));
  const baseX = safe.left;

  const textFill = '#FFFFFF';
  const subtextFill = 'rgba(255,255,255,0.75)';
  const microColor = brand.colors?.accent || '#FFFFFF';
  const highlightColor = brand.colors?.accent || '#FFFFFF';

  const microSvg = micro ? svgTextLines([micro], { x: baseX, startY: baseY, fontSize: microFontSize, fontWeight: '700', fill: microColor, letterSpacing: '5', fontFamily }) : '';

  const headlineY = baseY + microBlockH;
  const highlightSvg = highlight ? svgHighlightBars(headlineLines, highlight, { x: baseX, startY: headlineY, fontSize: headlineFontSize, lineHeight: 1.25, color: highlightColor, opacity: highlightOpacity }) : '';
  const headlineSvg = headlineLines.length ? svgTextLines(headlineLines, { x: baseX, startY: headlineY, fontSize: headlineFontSize, fontWeight: 'bold', fill: textFill, lineHeight: 1.25, fontFamily }) : '';

  const bodyY = headlineY + headlineBlockH + 30;
  const bodySvg = bodyLines.length ? svgTextLines(bodyLines, { x: baseX, startY: bodyY, fontSize: bodyFontSize, fill: subtextFill, lineHeight: 1.5, fontFamily }) : '';

  const gradientSvg = `<defs>
    <linearGradient id="textGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="40%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.7"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#textGrad)"/>`;

  const overlaySvg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    ${gradientSvg}
    ${microSvg}
    ${highlightSvg}
    ${headlineSvg}
    ${bodySvg}
  </svg>`;

  return sharp(Buffer.from(overlaySvg)).png().toBuffer();
}

// Composite a transparent PNG overlay onto a video using ffmpeg
async function overlayPngOnVideo(videoBuffer, overlayPngBuffer, outputPath) {
  const videoTmp = path.join(outputDir, `tmp_vid_${crypto.randomUUID().slice(0, 8)}.mp4`);
  const overlayTmp = path.join(outputDir, `tmp_ovl_${crypto.randomUUID().slice(0, 8)}.png`);

  try {
    await fs.writeFile(videoTmp, videoBuffer);
    await fs.writeFile(overlayTmp, overlayPngBuffer);

    await new Promise((resolve, reject) => {
      const args = [
        '-i', videoTmp,
        '-i', overlayTmp,
        '-filter_complex', '[1:v]scale2ref[ovl][base];[base][ovl]overlay=0:0',
        '-codec:a', 'copy',
        '-codec:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '18',
        '-y', outputPath,
      ];
      const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      });
      proc.on('error', reject);
    });
  } finally {
    await fs.unlink(videoTmp).catch(() => {});
    await fs.unlink(overlayTmp).catch(() => {});
  }
}

async function generateMockupSlide(data, brand) {
  const themeFn = MOCKUP_THEMES[data.mockupTheme] || MOCKUP_THEMES.dark;
  const theme = themeFn(brand);
  const layout = data.mockupLayout || 'text-statement';

  let buffer;
  switch (layout) {
    case 'phone-right':
      buffer = await renderPhoneRight(data, brand, theme);
      break;
    case 'phone-left':
      buffer = await renderPhoneLeft(data, brand, theme);
      break;
    case 'text-statement':
    default:
      buffer = await renderTextStatement(data, brand, theme);
      break;
  }

  if (data.includeOwl) {
    buffer = await addAppIconOverlay(buffer, data.owlPosition, brand, {
      iconOffsetX: data.iconOffsetX,
      iconOffsetY: data.iconOffsetY,
    });
  }

  return buffer;
}

// --- End Mockup Helpers ---

function buildMockupBackgroundPrompt(data, brand) {
  const c = brand.colors;
  const setting = data.aiBgSetting || 'abstract premium background';
  const mood = data.aiBgMood || 'clean, modern';

  return [
    `Create a background image (1080x1920, 9:16) for a mobile app showcase slide.`,
    `Scene: ${setting}. Mood: ${mood}.`,
    `Color palette hint: primary ${c.primary}, accent ${c.accent}, secondary ${c.secondary}.`,
    `This is ONLY a background — do NOT include any text, logos, phone mockups, UI elements, or people.`,
    `The image should work as a backdrop with text and a phone frame composited on top.`,
    `Keep the center area relatively uncluttered so overlaid content remains readable.`,
    `Style: high quality, slightly blurred/bokeh where appropriate, professional.`,
  ].join('\n\n');
}

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
  const safeHeadline = headline || '';
  const safeBody = body || '';
  const safeBackground = backgroundStyle || brand.defaultBackground;
  const safeLayout = layoutTemplate || 'Layout A - Classic Left Lane';

  const textBlocks = [
    `Micro-label (EXACT text):\n"${safeMicro}"`,
  ];

  if (safeHeadline) {
    textBlocks.push(`Headline (EXACT, verbatim, include line breaks exactly as shown):\n"${safeHeadline}"`);
  }

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
    `Create a TikTok carousel slide (1080x1920, 9:16) for ${brand.name}.`,
    `Visual style: ${brand.imageStyle || 'Minimalist and clean with plenty of negative space.'}`,
    `Background: ${safeBackground} using brand palette primary ${c.primary}, accent ${c.accent}, white ${c.white}, secondary ${c.secondary}, CTA color ${c.cta} (CTA only).`,
    `Composition: ${safeLayout}. Large left-aligned text block within safe zones (top 180px, bottom 320px, sides 90px). Plenty of negative space.`,
    textBlocks.join('\n\n'),
    `Typography constraints: modern sans-serif like Inter/SF Pro, headline extra-bold at approximately ${data.headlineFontSize || 82}pt with tight line-height, body regular at approximately ${data.bodyFontSize || 34}pt with comfortable line-height, clean kerning, high readability.`,
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
  const safeSport = sport || 'person';
  const safeSetting = setting || 'professional setting';
  const safeAction = action || 'looking confident and engaged';
  const safeMood = mood || 'confident, professional';
  const safeOverlayStyle = overlayStyle || 'dark gradient';
  const safeOverlayPlacement = overlayPlacement || 'bottom third';
  const safeMicro = microLabel || brand.defaultMicroLabel;
  const safeHeadline = headline || '';
  const safeBody = body || '';

  const trickyLine = buildTrickyWordsLine(trickyWords);

  return [
    `Create a photo for a TikTok carousel slide (1080x1920, 9:16) for ${brand.name}.`,
    `Visual style: ${brand.imageStyle || 'Clean and professional photography with natural lighting.'}`,
    `Scene: ${safeSport} in ${safeSetting}, ${safeAction}.`,
    `Mood: ${safeMood}.`,
    `Composition: simple, clean background. Leave negative space for text overlay in the ${safeOverlayPlacement}. No brand logos on subject.`,
    `Add a subtle ${safeOverlayStyle} behind text for readability; image stays dominant and uncluttered.`,
    'Overlay text (EXACT, verbatim):',
    `Micro-label: "${safeMicro}"`,
    safeHeadline ? `Headline: "${safeHeadline}"` : null,
    highlightPhrase ? `Highlight ONLY: "${highlightPhrase}" in accent ${c.accent}` : null,
    safeBody ? `Body: "${safeBody}"` : null,
    `Typography: modern sans-serif like Inter/SF Pro, headline bold at approximately ${data.headlineFontSize || 82}pt, body regular at approximately ${data.bodyFontSize || 34}pt, clean kerning.`,
    `Brand palette accents only (accent ${c.accent}, CTA color ${c.cta} for CTA only).`,
    trickyLine || null,
    'Hard constraints: no extra text beyond quoted. no watermarks. no random logos. no distorted faces/hands. no nonsense text. no perfect/flawless skin. no ultra-smooth rendering. no heavy retouching look.',
  ]
    .filter(Boolean)
    .join('\n');
}

// Text-free version for hybrid rendering (AI image + Sharp text overlay)
function buildPhotoImagePrompt(data, brand) {
  const safeSport = data.sport || 'person';
  const safeSetting = data.setting || 'professional setting';
  const safeAction = data.action || 'looking confident and engaged';
  const safeMood = data.mood || 'confident, professional';
  const overlayPlacement = data.overlayPlacement || 'bottom third';

  return [
    `Create a photo for a TikTok carousel slide (1080x1920, 9:16) for ${brand.name}.`,
    `Visual style: ${brand.imageStyle || 'Clean and professional photography with natural lighting.'}`,
    `Scene: ${safeSport} in ${safeSetting}, ${safeAction}.`,
    `Mood: ${safeMood}.`,
    `Composition: simple, clean background. Leave clear negative space in the ${overlayPlacement} for text overlay — keep this area relatively clean/dark so overlaid text is readable.`,
    data.personId ? 'Feature the person from the reference photo(s), preserve their face and identity accurately.' : null,
    'Do NOT include any text, labels, typography, watermarks, or logos in the image. The image should be purely photographic with no text elements whatsoever.',
    'Hard constraints: no text. no watermarks. no logos. no distorted faces/hands. no perfect/flawless skin. no ultra-smooth rendering. no heavy retouching look.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildMemePrompt(data, brand) {
  const { description, aspectRatio } = data;

  const dimensions = {
    '1:1': { w: 1080, h: 1080, label: 'square' },
    '9:16': { w: 1080, h: 1920, label: 'vertical (Stories/TikTok)' },
    '16:9': { w: 1920, h: 1080, label: 'landscape (Twitter/YouTube)' },
  }[aspectRatio] || { w: 1080, h: 1080, label: 'square' };

  const c = brand.colors || {};

  return [
    `Create a meme image (${dimensions.w}x${dimensions.h}, ${dimensions.label}).`,
    '',
    `CONCEPT: ${description}`,
    '',
    'FORMAT & STYLE:',
    '- This is an internet MEME — not a polished ad, not a carousel slide, not a brand graphic.',
    '- If the concept references a meme format (two-panel approval/disapproval, expanding brain tiers, "nobody:" reaction, POV, side-by-side comparison, etc.), follow that format\'s visual structure and panel layout. Do NOT depict real celebrities or identifiable public figures — use generic illustrated or cartoon characters instead.',
    '- The aesthetic must feel native to social media — raw, authentic, shareable. Not over-produced.',
    '- Fill the entire canvas. No safe zones, no padding, no decorative borders.',
    '',
    'TEXT RENDERING (CRITICAL):',
    '- All text must be rendered EXACTLY as written — no extra words, no modifications.',
    '- Use bold, high-contrast typography: Impact font style, white fill with thick black outline/stroke.',
    '- Place text in clear, readable positions — typically top and/or bottom of image.',
    '- Text must be large enough to read at thumbnail size on mobile.',
    '- Spell every word correctly.',
    '',
    `BRAND CONTEXT (subtle — do NOT let this override the meme format):`,
    `Brand: ${brand.name}`,
    `Voice: ${brand.systemPrompt || 'Friendly and relatable'}`,
    c.accent ? `Brand accent color (use sparingly, NOT as dominant color): ${c.accent}` : '',
    '',
    'CONSTRAINTS:',
    '- No watermarks, no logos (brand icon is added separately after generation)',
    '- No AI artifacts — this should look like a real meme someone would share',
    '- Avoid these AI-tell words in the visual style: "perfect", "flawless", "ultra-detailed", "8K", "hyper-realistic", "masterpiece"',
    '- Keep composition simple and punchy — memes are quick to read and understand',
  ].filter(Boolean).join('\n');
}

function buildPersonalizedPrompt(data, brand) {
  const sport = data.sport;
  const setting = data.setting || 'professional environment';
  const action = data.action || 'looking confident and engaged';
  const mood = data.mood || 'confident professionalism';

  const subjectLine = sport
    ? `Create a professional photo featuring the person from the reference image as a ${sport} professional.`
    : `Create a professional photo featuring the person from the reference image.`;

  return [
    subjectLine,
    `Setting: ${setting}. The person is ${action}.`,
    `Mood: ${mood}. Photorealistic, natural lighting, shallow depth of field.`,
    `The person's face, features, and identity must be clearly preserved from the reference photo.`,
    `Shot on iPhone 15 Pro, 50mm equivalent. Natural skin texture, no brand logos.`,
    `Leave space in the bottom third for text overlay.`,
    brand.id !== 'generic' ? `Brand: ${brand.name}.` : '',
  ].filter(Boolean).join('\n');
}

async function addAppIconOverlay(baseBuffer, configKey = 'bottom-right', brand = GENERIC_BRAND, { iconOffsetX = 0, iconOffsetY = 0 } = {}) {
  const cfg = ICON_OVERLAY_CONFIGS[configKey] || ICON_OVERLAY_CONFIGS['bottom-right'];
  const brandId = brand.id || 'generic';
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
  const ofsX = clampOffset(iconOffsetX, -500, 500);
  const ofsY = clampOffset(iconOffsetY, -500, 500);
  const iconLeft = pos.left + Math.round((totalWidth - iconSize) / 2) + ofsX;
  const textLeft = pos.left + Math.round((totalWidth - textMeta.width) / 2) + ofsX;
  const iconTop = pos.top + ofsY;

  const composed = await base
    .composite([
      {
        input: iconBuffer,
        left: Math.max(0, iconLeft),
        top: Math.max(0, iconTop),
      },
      {
        input: textBuffer,
        left: Math.max(0, textLeft),
        top: Math.max(0, iconTop + iconSize + textGap),
      },
    ])
    .png()
    .toBuffer();

  return composed;
}

// --- Claude Prompt Refinement ---

const MEME_REFINEMENT_INSTRUCTIONS = `Your job: Refine this meme image prompt for gpt-image-1.5.

TEXT RENDERING (your #1 priority):
- Put all rendered text in QUOTES and ALL CAPS in the prompt
- Add explicit font/size/placement constraints: "Impact font, white fill, thick black outline, centered"
- For tricky words or brand names, spell them letter-by-letter as a hint
- Demand verbatim rendering: "no extra characters, exactly as written"

MEME FORMAT:
- Preserve the meme template structure (e.g. two-panel approval/disapproval, tier list, comparison grid)
- CRITICAL: Replace any references to real people (Drake, celebrities, public figures) with generic characters — OpenAI will reject prompts depicting real people
- Do NOT turn it into a polished brand ad or carousel slide
- Keep the raw, authentic, internet-native aesthetic
- Fill the entire canvas — no safe zones, no padding

STYLE:
- Keep composition simple and punchy
- Avoid AI-tell words: "perfect", "flawless", "ultra-smooth", "ultra-detailed", "8K", "hyper-realistic", "masterpiece"
- The result should look like a real meme someone would share, not an AI-generated image

Return ONLY the refined prompt text. No preamble, no explanation, no markdown.`;

const BASE_REFINEMENT_INSTRUCTIONS = `Your job: Take a raw image-generation prompt and refine it for gpt-image-1.5. Your refinements should:
- Strengthen text legibility instructions (exact spelling, letter spacing for tricky words, font weight)
- Ensure safe zones are respected (top 180px, bottom 320px, sides 90px for TikTok 9:16)
- Keep backgrounds clean, simple, and uncluttered — avoid overly dramatic or staged-looking scenes
- Reinforce correct spelling of all words
- Optimize composition cues for the AI image model
- Preserve ALL exact text content from the original — never change the user's words
- Keep the prompt concise and direct — no fluff, no markdown, no explanation

CRITICAL: Respect the brand's visual style direction. Do not override it with generic realism instructions. Adapt your refinements to match the brand's stated aesthetic.
- AVOID these words that make images look AI-generated: "perfect", "flawless", "ultra-smooth", "ultra-detailed", "8K", "hyper-realistic", "masterpiece"
- Backgrounds should be simple and believable — not epic dramatic locations with god rays

Return ONLY the refined prompt text. No preamble, no explanation, no markdown formatting.`;

const VIDEO_REFINEMENT_INSTRUCTIONS = `Your job: Transform a raw video brief into an optimized prompt for Kling 3.0 AI video generation.

PROMPT STRUCTURE (follow this order):
1. Scene & environment — describe the setting, lighting, time of day
2. Subject & appearance — who/what is in frame, what they look like, what they wear
3. Action & motion — describe what HAPPENS over time ("starts with... transitions to... ends with..."). Video needs change — never describe a static scene.
4. Camera movement — use cinematic terms: tracking shot, dolly-in, dolly-out, crane shot, pan, tilt, orbit, steadicam, handheld, push-in, low-angle, FPV drone. Describe movement relative to the subject.
5. Atmosphere — lighting quality (golden hour, volumetric, Rembrandt, soft studio), depth of field, color grading feel

KLING 3.0 BEST PRACTICES:
- Think like a Director of Photography — describe time, space, and intent
- Use ++double plus++ markers around the most important visual element to emphasize it
- Add motion/physics details: dust kicked up, hair flowing, fabric rippling, light rays shifting — Kling handles these well
- Use speed modifiers for camera: "slowly," "smoothly," "rapidly"
- Keep to one camera movement per shot — simultaneous complex movements cause warping
- Describe colors as natural language ("warm amber tones", "deep navy atmosphere", "electric orange accents") — never use hex codes
- 50-150 words is the sweet spot — shorter lacks detail, longer introduces conflicts

AVOID:
- Hex color codes (#FF6B35) — the model doesn't understand them
- Static descriptions with no motion or change over time
- Conflicting instructions (e.g. "golden hour" + "studio lighting")
- Abstract quality words alone ("beautiful", "amazing", "cinematic") — pair with specifics
- Any text, watermarks, or logos in the video — text is overlaid separately afterward
- AI-tell words: "perfect", "flawless", "ultra-detailed", "8K", "hyper-realistic", "masterpiece"
- Mentioning aspect ratio or duration — these are set as API parameters

BRAND ADAPTATION:
- Translate the brand's visual identity into natural language that Kling understands
- Match the brand's energy level and aesthetic (premium vs playful, minimal vs bold)
- Use the brand's color palette as atmospheric/lighting direction, not literal color instructions

Return ONLY the refined prompt. No preamble, no explanation, no markdown.`;

async function refinePromptWithClaude(rawPrompt, slideType, formData, brand, req) {
  try {
    const refinementInstructions = slideType === 'meme'
      ? MEME_REFINEMENT_INSTRUCTIONS
      : slideType === 'video'
        ? VIDEO_REFINEMENT_INSTRUCTIONS
        : BASE_REFINEMENT_INSTRUCTIONS;
    const systemPrompt = `${brand.systemPrompt}\n\n${refinementInstructions}`;
    let context;
    if (slideType === 'meme') {
      context = `This is a MEME for ${brand.name}. It must look like a genuine internet meme — informal, humorous, culturally aware. Do NOT apply carousel rules (no safe zones, no TikTok composition, no professional typography). Preserve the meme format and humor. Only refine for text legibility and spelling accuracy. Keep the raw, authentic meme aesthetic. CRITICAL: If the user prompt mentions real people by name (Drake, celebrities, public figures), replace them with generic characters — OpenAI will reject prompts depicting real people.`;
    } else if (slideType === 'video') {
      context = `This is a VIDEO prompt for ${brand.name} using Kling 3.0 AI video generation. Transform the brief below into a cinematic prompt optimized for Kling 3.0. The brand's colors are: ${Object.entries(brand.colors || {}).map(([k,v]) => `${k}: ${v}`).join(', ')} — translate these into natural atmospheric/lighting descriptions, never pass hex codes to Kling.`;
    } else if (slideType === 'photo') {
      context = `This is a photo-led slide for ${brand.name} featuring a ${formData.sport || 'person in action'} scene with text overlay.`;
    } else {
      context = `This is a text-only minimalist slide for ${brand.name} with a ${formData.backgroundStyle || 'dark premium'} background.`;
    }

    // If reference image is being used, tell Claude the model can see it directly
    if (rawPrompt.includes('Reference image provided:')) {
      context += `\n\nIMPORTANT: A reference image will be passed directly to the image model via the edit API. The model can SEE the image — do NOT describe what might be in the reference image. Instead, instruct the model on HOW to use the reference (e.g. "match the color palette", "use the same composition style", "incorporate the background elements").`;
    }

    const refined = await generateText({
      model: req.body?.textModel,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `${context}\n\nRefine this ${slideType === 'video' ? 'video' : 'image'}-generation prompt:\n\n${rawPrompt}`,
        },
      ],
      maxTokens: 1024,
      req,
    });
    if (refined) {
      console.log(`[Text] Prompt refined for ${brand.name}`);
      return refined;
    }
    return null;
  } catch (err) {
    console.warn('[Text] Refinement failed, using raw prompt:', err.message);
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

// Firebase client config (unauthenticated — needed before auth is available)
app.get('/api/firebase-config', (req, res) => {
  const apiKey = process.env.FIREBASE_API_KEY?.trim();
  if (!apiKey) return res.json({ available: false });
  res.json({
    available: true,
    apiKey,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN?.trim(),
    projectId: process.env.FIREBASE_PROJECT_ID?.trim(),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET?.trim(),
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID?.trim(),
    appId: process.env.FIREBASE_APP_ID?.trim(),
  });
});

// List available brands (hardcoded for admins only + user's Firestore brands)
app.get('/api/brands', requireAuth, async (req, res) => {
  try {
    let brands = [];
    if (db && req.user?.uid) {
      try {
        const snap = await db.collection('carousel_brands')
          .where('createdBy', '==', req.user.uid)
          .get();
        brands = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        brands.sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
      } catch (fsErr) {
        console.error('[Brands] Firestore query failed:', fsErr.message);
      }
    } else if (!db && req.user?.uid) {
      const all = await readLocalBrands();
      brands = Object.entries(all)
        .filter(([, b]) => b.createdBy === req.user.uid)
        .map(([id, b]) => ({ id, ...b }));
      brands.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    res.json({ brands });
  } catch (err) {
    console.error('[Brands]', err);
    res.status(200).json({ brands: [] });
  }
});

// Create a new brand
app.post('/api/brands', requireAuth, async (req, res) => {
  try {
    const { name, website, colors, systemPrompt, defaultMicroLabel, defaultBackground, iconOverlayText, contentPillars, contentIdeaPrompt } = req.body;
    if (!name || !colors) return res.status(400).json({ error: 'Name and colors are required' });
    if (name.length > 100) return res.status(400).json({ error: 'Name too long (max 100 chars)' });
    if (systemPrompt && systemPrompt.length > 5000) return res.status(400).json({ error: 'System prompt too long (max 5000 chars)' });
    if (website && website.length > 200) return res.status(400).json({ error: 'Website too long (max 200 chars)' });
    if (defaultMicroLabel && defaultMicroLabel.length > 500) return res.status(400).json({ error: 'Micro label too long (max 500 chars)' });
    if (defaultBackground && defaultBackground.length > 500) return res.status(400).json({ error: 'Background description too long (max 500 chars)' });
    if (iconOverlayText && iconOverlayText.length > 500) return res.status(400).json({ error: 'Icon overlay text too long (max 500 chars)' });
    const id = slugify(name) + '-' + crypto.randomUUID().slice(0, 6);
    const brand = {
      name,
      website: website || '',
      colors: {
        primary: colors.primary || GENERIC_BRAND.colors.primary,
        accent: colors.accent || GENERIC_BRAND.colors.accent,
        white: colors.white || GENERIC_BRAND.colors.white,
        secondary: colors.secondary || GENERIC_BRAND.colors.secondary,
        cta: colors.cta || GENERIC_BRAND.colors.cta,
      },
      systemPrompt: systemPrompt || '',
      defaultMicroLabel: defaultMicroLabel || name.toUpperCase(),
      defaultBackground: defaultBackground || GENERIC_BRAND.defaultBackground,
      iconOverlayText: iconOverlayText || website || '',
      contentPillars: contentPillars || [],
      contentIdeaPrompt: contentIdeaPrompt || '',
      createdBy: req.user.uid,
    };
    if (db) {
      brand.createdAt = admin.firestore.FieldValue.serverTimestamp();
      await db.collection('carousel_brands').doc(id).set(brand);
    } else {
      brand.createdAt = Date.now();
      const brands = await readLocalBrands();
      brands[id] = brand;
      await writeLocalBrands(brands);
    }
    res.json({ ok: true, brand: { id, ...brand } });
  } catch (err) {
    console.error('[Create Brand]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Update a brand
app.put('/api/brands/:id', requireAuth, async (req, res) => {
  try {
    if (req.body.name && req.body.name.length > 100) return res.status(400).json({ error: 'Name too long (max 100 chars)' });
    if (req.body.systemPrompt && req.body.systemPrompt.length > 5000) return res.status(400).json({ error: 'System prompt too long (max 5000 chars)' });
    if (req.body.website && req.body.website.length > 200) return res.status(400).json({ error: 'Website too long (max 200 chars)' });
    if (req.body.defaultMicroLabel && req.body.defaultMicroLabel.length > 500) return res.status(400).json({ error: 'Micro label too long (max 500 chars)' });
    if (req.body.defaultBackground && req.body.defaultBackground.length > 500) return res.status(400).json({ error: 'Background description too long (max 500 chars)' });
    if (req.body.iconOverlayText && req.body.iconOverlayText.length > 500) return res.status(400).json({ error: 'Icon overlay text too long (max 500 chars)' });
    const allowedKeys = ['name', 'website', 'colors', 'systemPrompt', 'defaultMicroLabel', 'defaultBackground', 'iconOverlayText', 'contentPillars', 'contentIdeaPrompt'];
    if (db) {
      const doc = await db.collection('carousel_brands').doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Brand not found' });
      if (doc.data().createdBy !== req.user.uid) return res.status(403).json({ error: 'Not your brand' });
      const updates = {};
      for (const key of allowedKeys) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }
      await db.collection('carousel_brands').doc(req.params.id).update(updates);
    } else {
      const brands = await readLocalBrands();
      const brand = brands[req.params.id];
      if (!brand) return res.status(404).json({ error: 'Brand not found' });
      if (brand.createdBy !== req.user.uid) return res.status(403).json({ error: 'Not your brand' });
      for (const key of allowedKeys) {
        if (req.body[key] !== undefined) brand[key] = req.body[key];
      }
      await writeLocalBrands(brands);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Update Brand]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Delete a brand
app.delete('/api/brands/:id', requireAuth, async (req, res) => {
  try {
    let facePhotos = [];
    if (db) {
      const doc = await db.collection('carousel_brands').doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Brand not found' });
      if (doc.data().createdBy !== req.user.uid) return res.status(403).json({ error: 'Not your brand' });
      facePhotos = doc.data().facePhotos || [];
      await db.collection('carousel_brands').doc(req.params.id).delete();
    } else {
      const brands = await readLocalBrands();
      const brand = brands[req.params.id];
      if (!brand) return res.status(404).json({ error: 'Brand not found' });
      if (brand.createdBy !== req.user.uid) return res.status(403).json({ error: 'Not your brand' });
      facePhotos = brand.facePhotos || [];
      delete brands[req.params.id];
      await writeLocalBrands(brands);
    }
    // Clean up face photos from storage
    if (bucket && facePhotos.length > 0) {
      for (const photo of facePhotos) {
        try { await bucket.file(photo.storagePath).delete(); } catch (e) { /* ignore */ }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Delete Brand]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Delete user account and all associated data
app.delete('/api/account', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;

    // Delete all user's brands from Firestore or local storage (+ face photos)
    if (db) {
      const brands = await db.collection('carousel_brands').where('createdBy', '==', uid).get();
      // Clean up face photos from storage
      if (bucket) {
        for (const doc of brands.docs) {
          const photos = doc.data().facePhotos || [];
          for (const photo of photos) {
            try { await bucket.file(photo.storagePath).delete(); } catch (e) { /* ignore */ }
          }
        }
      }
      const batch = db.batch();
      brands.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    } else {
      const allBrands = await readLocalBrands();
      for (const [id, brand] of Object.entries(allBrands)) {
        if (brand.createdBy === uid) delete allBrands[id];
      }
      await writeLocalBrands(allBrands);
    }

    // Delete all user's persons + their photos
    if (db) {
      const persons = await db.collection('carousel_persons').where('userId', '==', uid).get();
      if (bucket) {
        for (const doc of persons.docs) {
          const photos = doc.data().photos || [];
          for (const photo of photos) {
            try { await bucket.file(photo.storagePath).delete(); } catch (e) { /* ignore */ }
          }
        }
      }
      const personBatch = db.batch();
      persons.forEach(doc => personBatch.delete(doc.ref));
      await personBatch.commit();
    }

    // Delete the Firebase Auth user (only when Firebase admin is available)
    if (admin.apps.length) {
      await admin.auth().deleteUser(uid);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[Delete Account]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- Shared brand config prompt builder ---
function buildBrandConfigPrompt({ url, pageTitle, metaDesc, ogSiteName, ogImage, themeColor, extractedColors, textContent, name, description }) {
  const contextLines = [];
  if (url) contextLines.push(`Page URL: ${url}`);
  if (pageTitle) contextLines.push(`Page title: ${pageTitle}`);
  if (metaDesc) contextLines.push(`Meta description: ${metaDesc}`);
  if (ogSiteName) contextLines.push(`OG site name: ${ogSiteName}`);
  contextLines.push(`OG image: ${ogImage || 'none'}`);
  contextLines.push(`Theme color: ${themeColor || 'none'}`);
  if (name) contextLines.push(`Brand name: ${name}`);
  if (description) contextLines.push(`Brand description: ${description}`);
  if (extractedColors?.length) {
    contextLines.push(`CSS colors extracted from the website (sorted by frequency, most used first): ${extractedColors.join(', ')}`);
  }
  if (textContent) contextLines.push(`Page text (first 3000 chars): ${textContent}`);

  return `Analyze this brand/website and generate a brand configuration for a social media carousel creation tool.

${contextLines.join('\n')}

COLOR RULES — STRICTLY FOLLOW THESE:
1. ${extractedColors?.length ? 'You MUST pick colors ONLY from the "CSS colors extracted" list above. Copy the exact hex values.' : 'Choose colors that match the brand description and any theme color provided.'}
2. Do NOT invent random hex codes. ${extractedColors?.length ? 'Every color in your response must appear in the extracted list.' : 'Use reasonable defaults matching the brand.'}
3. Map the colors to roles:
   - primary: the dominant dark/background color
   - accent: the most prominent brand/highlight color
   - white: the main text color (often #ffffff or a light color — you MAY use #ffffff)
   - secondary: an alternate background color
   - cta: the button/action color
4. If fewer than 5 colors exist, you may reuse colors across roles or use #ffffff for white.
${extractedColors?.length ? '5. If the CSS colors list is empty, use the theme-color and make reasonable guesses from the page content.' : ''}

Return ONLY valid JSON (no markdown, no code fences) with:
- name: brand name (short, clean)
- description: 1-2 sentence brand description
- colors: { primary, accent, white, secondary, cta } — hex codes
- systemPrompt: 150-200 word brand brief for AI content generation describing tone, audience, content pillars, visual style
- defaultBackground: one-line visual description for slide backgrounds matching the brand aesthetic
- imageStyle: 2-4 sentence visual/photography direction for AI image generation (lighting, composition, mood, camera feel — NOT colors)
- tone: 2-3 word tone description (e.g. "bold, energetic")
- microLabel: short uppercase label for slides (e.g. "MYBRAND")
- watermarkText: website domain for watermark (e.g. "mybrand.com")
- contentPillars: array of 4-5 content theme strings suited to this brand`;
}

// --- Shared content ideas prompt builder ---
function buildContentIdeasPrompt({ brand, microLabel, websiteUrl, pageTitle, metaDesc, websiteText, numIdeas, slidesPerIdea }) {
  const count = numIdeas || 5;
  const slideCount = (slidesPerIdea >= 2 && slidesPerIdea <= 12) ? `exactly ${slidesPerIdea}` : '7 (5-6 if the topic is simple, 8-9 only if more depth is truly needed)';
  return `Based on this website content, generate ${count} carousel content ideas for ${brand.name}'s social media (TikTok/Instagram).

Website: ${websiteUrl}
Page title: ${pageTitle}
Description: ${metaDesc}
Website text: ${websiteText}

Generate exactly ${count} carousel concepts. Each should have ${slideCount} slides and be based on real content/features/value props from the website.

Return ONLY valid JSON (no markdown, no code fences) with this structure:
{
  "ideas": [
    {
      "title": "Short carousel title",
      "caption": "Instagram/TikTok caption with hashtags",
      "slides": [
        {
          "number": 1,
          "label": "Hook",
          "type": "photo, text, mockup, or video",
          "microLabel": "${microLabel}",
          "headline": "Main headline text",
          "body": "Supporting body text (1-2 sentences)",
          "highlight": "key phrase to highlight",
          "sport": "for photo - subject shown",
          "setting": "for photo - environment",
          "action": "for photo - what they're doing",
          "mood": "for photo - emotional tone",
          "overlayStyle": "for photo - dark gradient, light gradient, or cinematic",
          "overlayPlacement": "for photo - bottom third, top third, or center",
          "backgroundStyle": "for text - visual description of background",
          "mockupLayout": "for mockup - phone-right, phone-left, or text-statement",
          "mockupTheme": "for mockup - dark or light",
          "imageUsage": "for mockup - phone, ai-background, or none",
          "aiBgSetting": "for mockup with ai-background - scene description",
          "aiBgMood": "for mockup with ai-background - mood/tone",
          "scene": "for video - describe what happens visually",
          "videoMood": "for video - energetic and dynamic, calm and serene, dramatic and intense, etc.",
          "cameraMove": "for video - slow tracking shot, smooth dolly-in, cinematic pan, handheld follow, drone aerial pullback, static wide angle",
          "duration": "for video - 5 or 10"
        }
      ]
    }
  ]
}

Rules:
- Each idea MUST include a "caption" field: a ready-to-post Instagram/TikTok caption in the brand's voice. Caption structure:
  * LINE 1 — HOOK (under 125 chars, this is all that shows before "...more"). Use one of these proven formulas:
    - Question: "Are you still doing X wrong?"
    - Stat: "X% of people miss this about Y"
    - Promise: "Save this: everything you need to know about X"
    - Mistake: "Stop doing X if you want Y"
    - Curiosity: "I didn't expect slide 5..."
  * LINES 2-3 — VALUE: expand on the carousel's key takeaway using natural keywords (algorithms rank keywords over hashtags)
  * LAST LINE — CTA: use a SPECIFIC call-to-action (specific CTAs get 3x more engagement than generic ones). Best formats:
    - Save-driven: "Save this for when you need it"
    - Comment-driven: "Comment which tip you're trying first" (prompts 5+ word replies, weighted heavier by algorithm)
    - Share-driven: "Send this to someone who needs to hear it"
    - Choice-driven: "A or B? Drop your pick below"
    - AVOID generic CTAs like "thoughts?" or "let me know"
  * End with 3-5 relevant hashtags (quality over quantity)
  * Total length: 150-200 words ideal for Instagram, works on TikTok too
- Each idea should cover a DISTINCTLY different angle — avoid repeating the same theme or structure across ideas.
- Default to 7 slides per idea. Only go to 5-6 if the topic is simple, or 8-9 if it genuinely needs more depth. Always bias toward 7.
- Strategically choose slide types based on content purpose:
  * HOOK slides (slide 1): Use "photo" for visual impact — choose a compelling subject, setting, and action
  * INFORMATION slides: Use "text" for data/stats/lists, "photo" when emotion matters more than text
  * APP SHOWCASE / CTA slides (usually last): Use "mockup" with imageUsage "phone" to show the app, or "ai-background" for a premium feel
  * BOLD STATEMENT slides: Use "mockup" with layout "text-statement" and imageUsage "none"
- For photo slides: ALWAYS include sport, setting, action, mood, overlayStyle, overlayPlacement
- For text slides: ALWAYS include backgroundStyle (a vivid 1-line visual description matching the brand's mood)
- For mockup slides: ALWAYS include mockupLayout, mockupTheme, imageUsage. If imageUsage is "ai-background", also include aiBgSetting and aiBgMood
- For video slides: ALWAYS include scene (vivid 1-2 sentence visual description with motion), videoMood, cameraMove, duration. Video slides work best for: hooks, emotional moments, product demos, before/after reveals. A video idea typically has just 1 slide.
- Video ideas should have 1 slide (the video clip) with headline/body for optional text overlay
- NOT every slide needs an AI-generated image — text slides and mockup slides with imageUsage "none" or "phone" are fast and effective
- Vary the mix: a typical 7-slide carousel might be photo → text → text → mockup → photo → text → mockup(CTA)
- Headlines: punchy, under 15 words — avoid repeating similar phrasing across ideas
- Body: 1-2 sentences max
- Content should be based on REAL information from the website, not generic filler
- Make each idea feel like a completely different post — vary the tone, angle, and structure`;
}

const BRAND_STRATEGIST_SYSTEM = 'You are a brand strategist for social media carousel content. Return only valid JSON.';

// AI brand setup — generate colors, system prompt, etc. from description
app.post('/api/brands/ai-setup', requireAuth, async (req, res) => {
  try {
    const { name, description, websiteUrl } = req.body;
    if (!name || !description) return res.status(400).json({ error: 'Name and description required' });

    let websiteContent = '';
    if (websiteUrl) {
      try {
        const url = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
        if (!isUrlSafe(url)) throw new Error('URL not allowed');
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
        if (contentLength > 1024 * 1024) throw new Error('Response too large');
        const html = await resp.text();
        // Basic HTML to text extraction
        websiteContent = html.replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3000);
      } catch (e) {
        console.warn('[AI Setup] Could not fetch website:', e.message);
      }
    }

    const text = await generateText({
      model: req.body?.textModel,
      system: BRAND_STRATEGIST_SYSTEM,
      messages: [{
        role: 'user',
        content: buildBrandConfigPrompt({ name, description, textContent: websiteContent }),
      }],
      maxTokens: 1024,
      req,
    });

    // Try to parse JSON from the response
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Try extracting JSON from possible markdown wrapping
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    if (!parsed) return res.status(500).json({ error: 'Failed to parse AI response' });
    res.json({ ok: true, suggestion: parsed });
  } catch (err) {
    console.error('[AI Setup]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- Full brand setup (SSE streaming pipeline) ---
app.post('/api/brands/full-setup', requireAuth, async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function sendSSE(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    let { url } = req.body;
    if (!url) { sendSSE('error', { message: 'URL required' }); res.end(); return; }

    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (!isUrlSafe(url)) { sendSSE('error', { message: 'URL not allowed' }); res.end(); return; }

    // Step 1: Fetch website
    sendSSE('status', { step: 'fetch', message: 'Analyzing website...' });

    let html, finalUrl;
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarouselStudio/1.0)' },
        redirect: 'follow',
      });
      finalUrl = resp.url;
      const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
      if (contentLength > 1024 * 1024) { sendSSE('error', { message: 'Website too large' }); res.end(); return; }
      html = await resp.text();
    } catch (e) {
      sendSSE('error', { message: `Could not reach website: ${e.message}` }); res.end(); return;
    }

    // Step 2: Extract brand info
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

    const metaTag = (name) => {
      const re = new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
      const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i');
      return (html.match(re)?.[1] || html.match(re2)?.[1] || '').trim();
    };

    const metaDesc = metaTag('description') || metaTag('og:description');
    const ogImage = metaTag('og:image');
    const ogSiteName = metaTag('og:site_name');
    const themeColor = metaTag('theme-color');

    const brandName = ogSiteName || pageTitle.split(/[|\-–—]/)[0]?.trim() || new URL(finalUrl).hostname.replace(/^www\./, '');
    sendSSE('brand-info', { name: brandName, description: metaDesc });

    // Step 3: Extract colors from CSS
    sendSSE('status', { step: 'colors', message: 'Extracting colors...' });

    const hexRegex = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
    const rgbRegex = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)/g;
    const styleBlocks = html.match(/<style[\s\S]*?<\/style>/gi) || [];
    const inlineStyles = html.match(/style=["'][^"']*["']/gi) || [];
    const customPropRegex = /--[\w-]+:\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b)/g;

    // Fetch external CSS
    let externalCssText = '';
    try {
      const cssLinkRegex = /<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi;
      const cssLinkRegex2 = /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/gi;
      const cssUrls = [];
      let cssMatch;
      while ((cssMatch = cssLinkRegex.exec(html)) !== null) cssUrls.push(cssMatch[1]);
      while ((cssMatch = cssLinkRegex2.exec(html)) !== null) {
        if (!cssUrls.includes(cssMatch[1])) cssUrls.push(cssMatch[1]);
      }
      const cssBaseUrl = new URL(finalUrl);
      const sameDomain = cssUrls.filter(u => {
        try {
          const parsed = new URL(u, cssBaseUrl);
          return parsed.hostname === cssBaseUrl.hostname || cssBaseUrl.hostname.endsWith(parsed.hostname) || parsed.hostname.endsWith(cssBaseUrl.hostname);
        } catch { return false; }
      }).slice(0, 3);
      for (const cssSrc of sameDomain) {
        try {
          const cssUrl = new URL(cssSrc, cssBaseUrl).href;
          const cssResp = await fetch(cssUrl, {
            signal: AbortSignal.timeout(3000),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarouselStudio/1.0)' },
          });
          if (cssResp.ok) externalCssText += ' ' + await cssResp.text();
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }

    const allCssSources = styleBlocks.join(' ') + ' ' + inlineStyles.join(' ') + ' ' + externalCssText;

    // Extract hex colors
    const colorFreq = {};
    for (const m of allCssSources.matchAll(hexRegex)) {
      let c = m[0].toLowerCase();
      // Expand 3-char hex to 6-char
      if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
      if (c === '#ffffff' || c === '#000000') continue;
      colorFreq[c] = (colorFreq[c] || 0) + 1;
    }
    // Extract CSS custom properties
    for (const m of allCssSources.matchAll(customPropRegex)) {
      let c = (m[1] || m[0]).toLowerCase();
      if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
      if (c === '#ffffff' || c === '#000000') continue;
      colorFreq[c] = (colorFreq[c] || 0) + 1;
    }
    // Extract rgb/rgba and convert to hex
    for (const m of allCssSources.matchAll(rgbRegex)) {
      const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      if (r === 255 && g === 255 && b === 255) continue;
      if (r === 0 && g === 0 && b === 0) continue;
      const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
      colorFreq[hex] = (colorFreq[hex] || 0) + 1;
    }

    const extractedColors = Object.entries(colorFreq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([c]) => c);
    if (themeColor && !extractedColors.includes(themeColor.toLowerCase())) {
      extractedColors.unshift(themeColor.toLowerCase());
    }
    sendSSE('colors', { extracted: extractedColors.slice(0, 10) });

    // Step 4: Fetch icon
    sendSSE('status', { step: 'icon', message: 'Finding icon...' });

    const faviconMatch = html.match(/<link[^>]*rel=["'](?:apple-touch-icon)["'][^>]*href=["']([^"']*)["']/i)
      || html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["'](?:apple-touch-icon)["']/i)
      || html.match(/<link[^>]*rel=["'](?:icon|shortcut icon)["'][^>]*href=["']([^"']*)["']/i)
      || html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["'](?:icon|shortcut icon)["']/i);
    const baseUrl = new URL(finalUrl);
    const resolveUrl = (src) => {
      if (!src || src.startsWith('data:')) return null;
      try { return new URL(src, baseUrl).href; } catch { return null; }
    };
    let iconUrl = faviconMatch ? resolveUrl(faviconMatch[1]) : `${baseUrl.origin}/favicon.ico`;
    sendSSE('icon', { url: iconUrl });

    // Step 5: Discover images (with Next.js /_next/image fix)
    sendSSE('status', { step: 'images', message: 'Finding images...' });

    const rawImages = [];
    const imgRegex = /<img[^>]*src=["']([^"']+)["']/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(html)) !== null) rawImages.push(imgMatch[1]);
    const lazySrcRegex = /(?:data-src|data-lazy-src|data-original)=["']([^"']+)["']/gi;
    while ((imgMatch = lazySrcRegex.exec(html)) !== null) rawImages.push(imgMatch[1]);
    const srcsetRegex = /srcset=["']([^"']+)["']/gi;
    while ((imgMatch = srcsetRegex.exec(html)) !== null) {
      for (const entry of imgMatch[1].split(',')) {
        const srcUrl = entry.trim().split(/\s+/)[0];
        if (srcUrl) rawImages.push(srcUrl);
      }
    }
    const bgImageRegex = /background-image:\s*url\(["']?([^"')]+)["']?\)/gi;
    while ((imgMatch = bgImageRegex.exec(html)) !== null) rawImages.push(imgMatch[1]);
    const anyImageUrlRegex = /["']((?:https?:\/\/[^"'\s]+|\/[^"'\s]+)\.(?:png|jpg|jpeg|webp|avif))(?:\?[^"']*)?\b/gi;
    while ((imgMatch = anyImageUrlRegex.exec(html)) !== null) rawImages.push(imgMatch[1]);

    // Scan JS bundles
    try {
      const scriptSrcRegex = /<script[^>]*src=["']([^"']+\.js)["']/gi;
      const bundleUrls = [];
      let scriptMatch;
      while ((scriptMatch = scriptSrcRegex.exec(html)) !== null) {
        const src = scriptMatch[1];
        if (/^https?:\/\//i.test(src)) {
          try {
            const scriptHost = new URL(src).hostname;
            const pageHost = new URL(finalUrl).hostname;
            if (!scriptHost.endsWith(pageHost) && !pageHost.endsWith(scriptHost)) continue;
          } catch { continue; }
        }
        bundleUrls.push(src);
        if (bundleUrls.length >= 2) break;
      }
      const baseForResolve = new URL(finalUrl);
      for (const bundleSrc of bundleUrls) {
        try {
          const bundleUrl = new URL(bundleSrc, baseForResolve).href;
          const bundleResp = await fetch(bundleUrl, {
            signal: AbortSignal.timeout(3000),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarouselStudio/1.0)' },
          });
          if (!bundleResp.ok) continue;
          const jsText = await bundleResp.text();
          const jsImageRegex = /["']((?:https?:\/\/[^"'\s]+|\/[^"'\s]+)\.(?:png|jpg|jpeg|webp|avif))["']/gi;
          let jsMatch;
          while ((jsMatch = jsImageRegex.exec(jsText)) !== null) rawImages.push(jsMatch[1]);
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }

    // Process images: resolve URLs, filter junk, fix /_next/image URLs
    const seenUrls = new Set();
    const images = [];
    if (ogImage) {
      const resolved = resolveUrl(ogImage);
      if (resolved) { images.push({ url: resolved, type: 'og:image' }); seenUrls.add(resolved); }
    }
    for (let src of rawImages) {
      // Fix Next.js /_next/image URLs — extract the raw url parameter
      if (src.includes('/_next/image')) {
        try {
          const parsed = new URL(src, baseUrl);
          const rawUrl = parsed.searchParams.get('url');
          if (rawUrl) src = rawUrl;
        } catch { /* keep original */ }
      }
      const resolved = resolveUrl(src);
      if (!resolved || seenUrls.has(resolved)) continue;
      if (/\.svg(\?|$)/i.test(resolved)) continue;
      if (/\b(pixel|tracking|spacer|blank|1x1)\b/i.test(resolved)) continue;
      if (/\.(gif)(\?|$)/i.test(resolved) && !/\.(gifv)(\?|$)/i.test(resolved)) continue;
      // Skip remaining /_next/image optimization URLs
      if (resolved.includes('/_next/image')) continue;
      seenUrls.add(resolved);
      images.push({ url: resolved, type: 'img' });
      if (images.length >= 20) break;
    }
    sendSSE('images', images.slice(0, 12));

    // Step 6: Claude generates brand config
    sendSSE('status', { step: 'config', message: 'Generating brand profile...' });

    const textContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);

    let brandText;
    try {
      brandText = await generateText({
        model: req.body?.textModel,
        system: BRAND_STRATEGIST_SYSTEM,
        messages: [{
          role: 'user',
          content: buildBrandConfigPrompt({ url: finalUrl, pageTitle, metaDesc, ogSiteName, ogImage, themeColor, extractedColors, textContent }),
        }],
        maxTokens: 1024,
        req,
      });
    } catch (e) {
      sendSSE('error', { message: e.message }); res.end(); return;
    }
    let brandConfig;
    try {
      brandConfig = JSON.parse(brandText);
    } catch {
      const match = brandText.match(/\{[\s\S]*\}/);
      brandConfig = match ? JSON.parse(match[0]) : null;
    }
    if (!brandConfig) { sendSSE('error', { message: 'Failed to parse AI response' }); res.end(); return; }

    sendSSE('brand-config', brandConfig);

    // Step 7: Save brand to DB
    sendSSE('status', { step: 'saving', message: 'Saving brand...' });

    const brandData = {
      name: brandConfig.name || brandName,
      website: new URL(finalUrl).hostname.replace(/^www\./, ''),
      colors: {
        primary: brandConfig.colors?.primary || GENERIC_BRAND.colors.primary,
        accent: brandConfig.colors?.accent || GENERIC_BRAND.colors.accent,
        white: brandConfig.colors?.white || GENERIC_BRAND.colors.white,
        secondary: brandConfig.colors?.secondary || GENERIC_BRAND.colors.secondary,
        cta: brandConfig.colors?.cta || GENERIC_BRAND.colors.cta,
      },
      systemPrompt: brandConfig.systemPrompt || '',
      imageStyle: brandConfig.imageStyle || '',
      defaultMicroLabel: brandConfig.microLabel || (brandConfig.name || brandName).toUpperCase(),
      defaultBackground: brandConfig.defaultBackground || GENERIC_BRAND.defaultBackground,
      iconOverlayText: brandConfig.watermarkText || new URL(finalUrl).hostname.replace(/^www\./, ''),
      contentPillars: brandConfig.contentPillars || [],
      createdBy: req.user.uid,
    };

    const brandId = slugify(brandData.name) + '-' + crypto.randomUUID().slice(0, 6);
    if (db) {
      brandData.createdAt = admin.firestore.FieldValue.serverTimestamp();
      await db.collection('carousel_brands').doc(brandId).set(brandData);
    } else {
      brandData.createdAt = Date.now();
      const allBrands = await readLocalBrands();
      allBrands[brandId] = brandData;
      await writeLocalBrands(allBrands);
    }

    // Upload icon from website
    if (iconUrl) {
      try {
        const iconResp = await fetch(iconUrl, { signal: AbortSignal.timeout(3000) });
        if (iconResp.ok) {
          const iconBuffer = Buffer.from(await iconResp.arrayBuffer());
          const brandDir = path.join(rootDir, 'brands', brandId, 'assets');
          await fs.mkdir(brandDir, { recursive: true });
          await fs.writeFile(path.join(brandDir, 'app-icon.png'), iconBuffer);
        }
      } catch { /* skip icon */ }
    }

    sendSSE('brand-saved', { id: brandId, name: brandData.name });

    // Step 8: Generate content ideas
    sendSSE('status', { step: 'content-ideas', message: 'Creating content ideas...' });

    let contentIdeas = [];
    try {
      const websiteUrl = finalUrl;
      const microLabel = brandData.defaultMicroLabel;
      const brandContext = [
        brandData.systemPrompt || '',
        `Brand: ${brandData.name}`,
        brandData.website ? `Website: ${brandData.website}` : '',
        brandData.contentPillars?.length ? `Content pillars: ${brandData.contentPillars.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      const ideasText = await generateText({
        model: req.body?.textModel,
        system: brandContext,
        messages: [{
          role: 'user',
          content: buildContentIdeasPrompt({ brand: brandData, microLabel, websiteUrl, pageTitle, metaDesc, websiteText: textContent }),
        }],
        maxTokens: 4096,
        req,
      });

      if (ideasText) {
        const jsonMatch = ideasText.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : ideasText);
        contentIdeas = parsed.ideas || [];
      }
    } catch (e) {
      console.warn('[Full Setup] Content ideas generation failed:', e.message);
    }

    if (contentIdeas.length > 0) {
      // Send ideas individually so they appear progressively in the UI
      const formattedIdeas = contentIdeas.map((idea, i) => ({
        id: `AI-${i + 1}`,
        title: idea.title,
        caption: idea.caption || '',
        slides: (idea.slides || []).map((s, si) => ({
          ...s,
          number: s.number || si + 1,
          type: s.type || 'text',
        })),
      }));
      for (const idea of formattedIdeas) {
        sendSSE('content-idea', idea);
      }
      // Also send the full batch for contentData storage
      sendSSE('content-ideas', formattedIdeas);

      // Persist so ideas survive refresh/brand-switch (Firestore in prod, local JSON in dev)
      // Also seed generation history from initial ideas
      const initialHistory = contentIdeas.map(idea => ({
        type: 'idea',
        title: idea.title,
        headlines: (idea.slides || []).map(s => s.headline).filter(Boolean),
        ts: Date.now(),
      }));
      await updateBrandFields(brandId, { contentIdeas: formattedIdeas, generationHistory: trimGenerationHistory(initialHistory) });
    }

    // Step 9: Generate first carousel slides (slide 1 = AI, rest = mockup)
    sendSSE('status', { step: 'carousel', message: 'Generating first carousel...' });

    const brand = { id: brandId, ...brandData };
    const hasImageKey = getOpenAI(req) || getGemini(req);
    if (contentIdeas.length > 0 && hasImageKey) {
      const firstIdea = contentIdeas[0];
      const slides = firstIdea.slides || [];
      for (let i = 0; i < Math.min(slides.length, 5); i++) {
        const slide = slides[i];
        try {
          if (i === 0 && slide.type === 'photo') {
            // AI-generated first slide
            const rawPrompt = buildPhotoPrompt({
              sport: '', setting: '', action: '', mood: '',
              microLabel: slide.microLabel || brandData.defaultMicroLabel,
              headline: slide.headline || '',
              body: slide.body || '',
              highlightPhrase: slide.highlight || '',
              overlayStyle: 'dark gradient',
              overlayPlacement: 'bottom third',
            }, brand);
            const refinedPrompt = await refinePromptWithClaude(rawPrompt, 'photo', slide, brand, req);
            const prompt = refinedPrompt || rawPrompt;
            try {
              let buffer = await generateImage({
                model: req.body?.imageModel,
                prompt,
                size: '1024x1536',
                quality: 'high',
                req,
              });
              buffer = await addAppIconOverlay(buffer, 'bottom-right', brand);
              const slug = crypto.randomUUID().slice(0, 8);
              const filename = `carousel_${brandId}_setup_s${i + 1}_${slug}.png`;
              const slideUrl = await uploadToStorage(buffer, filename);
              saveImageRecord({ userId: req.user.uid, brandId, filename, type: 'carousel' });
              sendSSE('slide', { index: i, imageUrl: slideUrl, type: 'ai' });
            } catch (imgErr) {
              console.warn(`[Full Setup] Slide ${i + 1} image failed:`, imgErr.message);
            }
          } else {
            // Mockup slide
            const mockupData = {
              slideType: 'mockup',
              mockupLayout: 'text-statement',
              mockupTheme: 'dark',
              microLabel: slide.microLabel || brandData.defaultMicroLabel,
              headline: slide.headline || '',
              body: slide.body || '',
              highlightPhrase: slide.highlight || '',
              highlightStyle: 'subtle',
              includeOwl: true,
              owlPosition: 'bottom-right',
            };
            const mockupBuffer = await generateMockupSlide(mockupData, brand);
            const slug = crypto.randomUUID().slice(0, 8);
            const filename = `carousel_${brandId}_setup_s${i + 1}_${slug}.png`;
            const slideUrl = await uploadToStorage(mockupBuffer, filename);
            saveImageRecord({ userId: req.user.uid, brandId, filename, type: 'carousel' });
            sendSSE('slide', { index: i, imageUrl: slideUrl, type: 'mockup' });
          }
        } catch (slideErr) {
          console.warn(`[Full Setup] Slide ${i + 1} failed:`, slideErr.message);
          sendSSE('slide-error', { index: i, message: slideErr.message });
        }
      }
    }

    sendSSE('done', { brandId });
    res.end();
  } catch (err) {
    console.error('[Full Setup]', err);
    try { sendSSE('error', { message: safeErrorMessage(err) }); } catch { /* headers sent */ }
    res.end();
  }
});

// Analyze website — fetch HTML, extract meta/images/colors, generate brand config
app.post('/api/brands/analyze-website', requireAuth, async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // Normalize URL
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    // Validate URL against SSRF
    if (!isUrlSafe(url)) return res.status(400).json({ error: 'URL not allowed' });

    // Fetch HTML
    let html, finalUrl;
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarouselStudio/1.0)' },
        redirect: 'follow',
      });
      finalUrl = resp.url;
      const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
      if (contentLength > 1024 * 1024) return res.status(400).json({ error: 'Website response too large' });
      html = await resp.text();
    } catch (e) {
      return res.status(400).json({ error: `Could not reach website: ${e.message}` });
    }

    // Extract structured data from HTML
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

    const metaTag = (name) => {
      const re = new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
      const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i');
      return (html.match(re)?.[1] || html.match(re2)?.[1] || '').trim();
    };

    const metaDesc = metaTag('description') || metaTag('og:description');
    const ogImage = metaTag('og:image');
    const ogSiteName = metaTag('og:site_name');
    const themeColor = metaTag('theme-color');

    // Extract favicon
    const faviconMatch = html.match(/<link[^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon)["'][^>]*href=["']([^"']*)["']/i)
      || html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["'](?:icon|shortcut icon|apple-touch-icon)["']/i);
    let favicon = faviconMatch ? faviconMatch[1] : '';

    // Extract images from multiple sources
    const rawImages = [];

    // 1. Standard <img src="...">
    const imgRegex = /<img[^>]*src=["']([^"']+)["']/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(html)) !== null) {
      rawImages.push(imgMatch[1]);
    }

    // 2. srcset, data-src, <source srcset>, background-image
    const lazySrcRegex = /(?:data-src|data-lazy-src|data-original)=["']([^"']+)["']/gi;
    while ((imgMatch = lazySrcRegex.exec(html)) !== null) {
      rawImages.push(imgMatch[1]);
    }
    const srcsetRegex = /srcset=["']([^"']+)["']/gi;
    while ((imgMatch = srcsetRegex.exec(html)) !== null) {
      // srcset has "url size, url size" format — extract each URL
      for (const entry of imgMatch[1].split(',')) {
        const srcUrl = entry.trim().split(/\s+/)[0];
        if (srcUrl) rawImages.push(srcUrl);
      }
    }
    const bgImageRegex = /background-image:\s*url\(["']?([^"')]+)["']?\)/gi;
    while ((imgMatch = bgImageRegex.exec(html)) !== null) {
      rawImages.push(imgMatch[1]);
    }

    // 3. Broad scan: any quoted URL with image extension anywhere in HTML
    const anyImageUrlRegex = /["']((?:https?:\/\/[^"'\s]+|\/[^"'\s]+)\.(?:png|jpg|jpeg|webp|avif))(?:\?[^"']*)?\b/gi;
    while ((imgMatch = anyImageUrlRegex.exec(html)) !== null) {
      rawImages.push(imgMatch[1]);
    }

    // 4. Scan JS bundles for image URLs (catches SPAs like Vite/React/Next)
    try {
      const scriptSrcRegex = /<script[^>]*src=["']([^"']+\.js)["']/gi;
      const bundleUrls = [];
      let scriptMatch;
      while ((scriptMatch = scriptSrcRegex.exec(html)) !== null) {
        const src = scriptMatch[1];
        // Skip CDN/external scripts
        if (/^https?:\/\//i.test(src)) {
          try {
            const scriptHost = new URL(src).hostname;
            const pageHost = new URL(finalUrl).hostname;
            if (!scriptHost.endsWith(pageHost) && !pageHost.endsWith(scriptHost)) continue;
          } catch { continue; }
        }
        bundleUrls.push(src);
        if (bundleUrls.length >= 2) break;
      }
      const baseForResolve = new URL(finalUrl);
      for (const bundleSrc of bundleUrls) {
        try {
          const bundleUrl = new URL(bundleSrc, baseForResolve).href;
          const bundleResp = await fetch(bundleUrl, {
            signal: AbortSignal.timeout(3000),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarouselStudio/1.0)' },
          });
          if (!bundleResp.ok) continue;
          const jsText = await bundleResp.text();
          const jsImageRegex = /["']((?:https?:\/\/[^"'\s]+|\/[^"'\s]+)\.(?:png|jpg|jpeg|webp|avif))["']/gi;
          let jsMatch;
          while ((jsMatch = jsImageRegex.exec(jsText)) !== null) {
            rawImages.push(jsMatch[1]);
          }
        } catch { /* timeout or fetch error — skip */ }
      }
    } catch { /* ignore bundle scanning errors */ }

    // Fetch external CSS files for color extraction (catches Tailwind, Vite, etc.)
    let externalCssText = '';
    try {
      const cssLinkRegex = /<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi;
      const cssLinkRegex2 = /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/gi;
      const cssUrls = [];
      let cssMatch;
      while ((cssMatch = cssLinkRegex.exec(html)) !== null) cssUrls.push(cssMatch[1]);
      while ((cssMatch = cssLinkRegex2.exec(html)) !== null) {
        if (!cssUrls.includes(cssMatch[1])) cssUrls.push(cssMatch[1]);
      }
      const cssBaseUrl = new URL(finalUrl);
      const sameDomain = cssUrls.filter(u => {
        try {
          const parsed = new URL(u, cssBaseUrl);
          return parsed.hostname === cssBaseUrl.hostname || cssBaseUrl.hostname.endsWith(parsed.hostname) || parsed.hostname.endsWith(cssBaseUrl.hostname);
        } catch { return false; }
      }).slice(0, 3);
      for (const cssSrc of sameDomain) {
        try {
          const cssUrl = new URL(cssSrc, cssBaseUrl).href;
          const cssResp = await fetch(cssUrl, {
            signal: AbortSignal.timeout(3000),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarouselStudio/1.0)' },
          });
          if (cssResp.ok) externalCssText += ' ' + await cssResp.text();
        } catch { /* timeout or fetch error — skip */ }
      }
    } catch { /* ignore CSS fetch errors */ }

    // Extract CSS colors (hex + rgb/rgba from style blocks, inline styles, and external CSS)
    const colorRegex = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
    const rgbRegex = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\s*\)/g;
    const styleBlocks = html.match(/<style[\s\S]*?<\/style>/gi) || [];
    const inlineStyles = html.match(/style=["'][^"']*["']/gi) || [];
    const customPropRegex = /--[\w-]+:\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b)/g;
    const allCssSources = styleBlocks.join(' ') + ' ' + inlineStyles.join(' ') + ' ' + externalCssText;
    const colorFreq = {};
    // Extract hex colors
    for (const m of allCssSources.matchAll(colorRegex)) {
      let c = m[0].toLowerCase();
      if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
      if (c === '#ffffff' || c === '#000000') continue;
      colorFreq[c] = (colorFreq[c] || 0) + 1;
    }
    // Extract CSS custom properties
    for (const m of allCssSources.matchAll(customPropRegex)) {
      let c = (m[1] || m[0]).toLowerCase();
      if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
      if (c === '#ffffff' || c === '#000000') continue;
      colorFreq[c] = (colorFreq[c] || 0) + 1;
    }
    // Extract rgb/rgba and convert to hex
    for (const m of allCssSources.matchAll(rgbRegex)) {
      const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      if (r === 255 && g === 255 && b === 255) continue;
      if (r === 0 && g === 0 && b === 0) continue;
      const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
      colorFreq[hex] = (colorFreq[hex] || 0) + 1;
    }
    const extractedColors = Object.entries(colorFreq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([c]) => c);

    // Extract text content
    const textContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);

    // Resolve relative URLs
    const baseUrl = new URL(finalUrl);
    const resolveUrl = (src) => {
      if (!src || src.startsWith('data:')) return null;
      try {
        return new URL(src, baseUrl).href;
      } catch { return null; }
    };

    favicon = resolveUrl(favicon) || `${baseUrl.origin}/favicon.ico`;

    // Process images: resolve URLs, filter junk, fix /_next/image URLs
    const seenUrls = new Set();
    const images = [];
    // Add og:image first
    if (ogImage) {
      const resolved = resolveUrl(ogImage);
      if (resolved) {
        images.push({ url: resolved, type: 'og:image' });
        seenUrls.add(resolved);
      }
    }
    for (let src of rawImages) {
      // Fix Next.js /_next/image URLs — extract the raw url parameter
      if (src.includes('/_next/image')) {
        try {
          const parsed = new URL(src, baseUrl);
          const rawUrl = parsed.searchParams.get('url');
          if (rawUrl) src = rawUrl;
        } catch { /* keep original */ }
      }
      const resolved = resolveUrl(src);
      if (!resolved || seenUrls.has(resolved)) continue;
      // Filter out tiny tracking pixels, svgs, data URIs
      if (/\.svg(\?|$)/i.test(resolved)) continue;
      if (/\b(pixel|tracking|spacer|blank|1x1)\b/i.test(resolved)) continue;
      if (/\.(gif)(\?|$)/i.test(resolved) && !/\.(gifv)(\?|$)/i.test(resolved)) continue;
      // Skip remaining /_next/image optimization URLs
      if (resolved.includes('/_next/image')) continue;
      seenUrls.add(resolved);
      images.push({ url: resolved, type: 'img' });
      if (images.length >= 20) break;
    }

    // 5. Fallback: probe common image paths if we found very few images
    if (images.length < 3) {
      const commonPaths = [
        '/og-image.png', '/og-image.jpg',
        '/logo.png', '/logo.svg',
        '/apple-touch-icon.png',
        '/images/logo.png', '/img/logo.png',
        '/assets/logo.png',
      ];
      const probePromises = commonPaths
        .map(p => `${baseUrl.origin}${p}`)
        .filter(u => !seenUrls.has(u))
        .map(async (probeUrl) => {
          try {
            const resp = await fetch(probeUrl, {
              method: 'HEAD',
              signal: AbortSignal.timeout(2000),
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarouselStudio/1.0)' },
            });
            if (resp.ok && (resp.headers.get('content-type') || '').startsWith('image/')) {
              return probeUrl;
            }
          } catch { /* ignore */ }
          return null;
        });
      const probeResults = await Promise.all(probePromises);
      for (const found of probeResults) {
        if (found && !seenUrls.has(found)) {
          seenUrls.add(found);
          images.push({ url: found, type: 'probe' });
        }
      }
    }

    // Send to AI for brand analysis
    const text = await generateText({
      model: req.body?.textModel,
      system: BRAND_STRATEGIST_SYSTEM,
      messages: [{
        role: 'user',
        content: buildBrandConfigPrompt({ url: finalUrl, pageTitle, metaDesc, ogSiteName, ogImage, themeColor, extractedColors, textContent }),
      }],
      maxTokens: 1024,
      req,
    });
    let brand;
    try {
      brand = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      brand = match ? JSON.parse(match[0]) : null;
    }

    if (!brand) return res.status(500).json({ error: 'Failed to parse AI response' });

    // Find best icon: apple-touch-icon > favicon > og:image
    const appleTouchMatch = html.match(/<link[^>]*rel=["']apple-touch-icon["'][^>]*href=["']([^"']*)["']/i)
      || html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']apple-touch-icon["']/i);
    const bestIconUrl = appleTouchMatch ? resolveUrl(appleTouchMatch[1]) : favicon;

    res.json({
      ok: true,
      brand,
      images,
      favicon,
      iconUrl: bestIconUrl || favicon,
      pageTitle,
    });
  } catch (err) {
    console.error('[Analyze Website]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Get content ideas for a brand
app.get('/api/content-ideas', requireAuth, async (req, res) => {
  try {
    const brandId = req.query.brand;
    // Only hardcoded brands have content-ideas.md files
    const brand = brandId ? await getBrandAsync(brandId, req.user?.uid) : GENERIC_BRAND;
    // Try loading content-ideas.md from disk (works for brands with local markdown files)
    const mdPath = path.join(rootDir, 'brands', brandId || 'generic', 'content-ideas.md');
    try {
      const markdown = await fs.readFile(mdPath, 'utf-8');
      const appData = parseContentIdeas(markdown, brandId || 'generic', brand.name);
      return res.json({ apps: [appData] });
    } catch {
      // No content-ideas.md — use contentIdeas from brand data (works for both Firestore and local storage)
      const stored = brand.contentIdeas;
      if (stored && stored.length > 0) {
        return res.json({ apps: [{ appName: brand.name, brandId, categories: [{ name: 'AI-Generated Ideas', ideas: stored }] }] });
      }
      return res.json({ apps: [{ appName: brand.name, brandId: brandId || 'generic', categories: [] }] });
    }
  } catch (error) {
    console.error('[Content Ideas]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// Upload reference image
app.post('/api/upload-reference', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }
    await validateImageFile(req.file);

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
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// Generate single slide
app.post('/api/generate', requireAuth, generationLimiter, async (req, res) => {
  try {
    const data = req.body || {};
    const brandId = data.brand;
    if (!brandId) return res.status(400).json({ error: 'Missing brand' });
    const brand = await getBrandAsync(brandId, req.user?.uid);

    if (!data.slideType) {
      return res.status(400).json({ error: 'Missing slideType' });
    }

    // Mockup slides: render with Sharp (optionally with AI-generated background)
    if (data.slideType === 'mockup') {
      let bgPrompt = null;
      let refinedBgPrompt = null;

      // AI background: generate background image first, then composite mockup on top
      if (data.imageUsage === 'ai-background') {
        bgPrompt = buildMockupBackgroundPrompt(data, brand);
        refinedBgPrompt = await refinePromptWithClaude(bgPrompt, 'photo', data, brand, req);
        const prompt = refinedBgPrompt || bgPrompt;

        console.log(`[Generate] ${brand.name} | AI background for mockup | ${refinedBgPrompt ? 'refined' : 'raw'}`);

        const aiBgBuffer = await generateImage({
          model: data.imageModel,
          prompt,
          size: '1024x1536',
          quality: data.quality || 'high',
          req,
        });

        // Save AI background to temp file so createBackgroundImage() can use it
        const tempName = `aibg_${crypto.randomUUID().slice(0, 8)}.png`;
        const tempPath = path.join(uploadsDir, tempName);
        await fs.writeFile(tempPath, aiBgBuffer);

        // Set as screenshot image for the mockup render pipeline
        data.screenshotImage = tempName;
        data.imageUsage = 'background';

        try {
          const buffer = await generateMockupSlide(data, brand);
          const slug = crypto.randomUUID().slice(0, 8);
          const filename = `slide_${brandId}_mockup_${Date.now()}_${slug}.png`;
          const url = await uploadToStorage(buffer, filename);
          saveImageRecord({ userId: req.user?.uid, brandId, filename, type: 'slide' });
          return res.json({ ok: true, filename, url, prompt: bgPrompt, refinedPrompt: refinedBgPrompt, usedRefined: Boolean(refinedBgPrompt) });
        } finally {
          // Clean up temp AI background file
          await fs.unlink(tempPath).catch(() => {});
        }
      }

      const buffer = await generateMockupSlide(data, brand);
      const slug = crypto.randomUUID().slice(0, 8);
      const filename = `slide_${brandId}_mockup_${Date.now()}_${slug}.png`;
      const url = await uploadToStorage(buffer, filename);
      saveImageRecord({ userId: req.user?.uid, brandId, filename, type: 'slide' });
      return res.json({ ok: true, filename, url, prompt: null, refinedPrompt: null, usedRefined: false });
    }

    // Meme generation
    if (data.slideType === 'meme') {

      // Auto-generate meme concept from brand website if no description provided
      if (!data.description || !data.description.trim()) {
        if (!brand.website) {
          return res.status(400).json({ error: 'No website set for this brand. Add a website URL in brand settings, or describe the meme manually.' });
        }

        let websiteUrl = brand.website.trim();
        if (!/^https?:\/\//i.test(websiteUrl)) websiteUrl = `https://${websiteUrl}`;
        if (!isUrlSafe(websiteUrl)) return res.status(400).json({ error: 'Website URL not allowed' });

        let websiteText;
        try {
          const resp = await fetch(websiteUrl, {
            signal: AbortSignal.timeout(8000),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarouselStudio/1.0)' },
            redirect: 'follow',
          });
          const html = await resp.text();
          websiteText = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 3000);
        } catch (e) {
          return res.status(400).json({ error: `Could not reach website: ${e.message}` });
        }

        data.description = await generateText({
          model: data.textModel,
          maxTokens: 300,
          messages: [{
            role: 'user',
            content: `You are a meme creator. Based on this brand's website content, generate ONE specific meme concept.

Brand: ${brand.name}
Website: ${websiteUrl}
Website content: ${websiteText}

Requirements:
- Pick a specific meme format (two-panel approval/disapproval, expanding brain tiers, comparison, "nobody:" reaction, POV, etc.) — do NOT reference real celebrities like Drake or specific actors
- The joke should be about the brand's actual product, features, or industry — something their audience would relate to
- Include exact text for each panel/section of the meme
- Keep it funny, relatable, and shareable — not corporate or salesy
- The meme should make sense even to people who don't know the brand

Return ONLY the meme description (no explanation, no preamble). Vary the format — here are examples:
- "Expanding brain meme — Level 1: Using spreadsheets to track inventory, Level 2: Using basic software, Level 3: Using [brand]'s AI-powered system, Level 4: [brand] auto-managing everything while you sleep"
- "Nobody: ... [brand] users: (description of enthusiastic/relatable behavior)"
- "POV: You just discovered [brand] — (description of the reaction/scenario)"
- "Two-panel approval meme — top (disapproval): old way of doing X, bottom (approval): using [brand] to do X better"
- "Side-by-side comparison — Left: struggling without [brand], Right: thriving with [brand]"

Pick a DIFFERENT format each time. Do NOT default to two-panel approval.`,
          }],
          req,
        });
        if (!data.description) {
          return res.status(500).json({ error: 'Failed to generate meme concept from website' });
        }
        console.log(`[Meme] Auto-generated concept for ${brand.name}: ${data.description.slice(0, 100)}...`);
      }

      const sizeMap = {
        '1:1': '1024x1024',
        '9:16': '1024x1536',
        '16:9': '1536x1024',
      };
      const openaiSize = sizeMap[data.aspectRatio] || '1024x1024';

      const rawPrompt = buildMemePrompt(data, brand);
      const refinedPrompt = await refinePromptWithClaude(rawPrompt, 'meme', data, brand, req);
      const prompt = refinedPrompt || rawPrompt;

      console.log(`[Meme] ${brand.name} | ${refinedPrompt ? 'refined' : 'raw'} | ${data.aspectRatio || '1:1'}`);

      let buffer;
      try {
        buffer = await generateImage({
          model: data.imageModel,
          prompt,
          size: openaiSize,
          quality: data.quality || 'high',
          req,
        });
      } catch (genErr) {
        if (genErr.message?.includes('safety') || genErr.status === 400) {
          console.warn(`[Meme] Safety rejection, retrying with sanitized prompt`);
          const safePrompt = await generateText({
            model: data.textModel,
            maxTokens: 1024,
            messages: [{ role: 'user', content: `This image prompt was rejected by the safety system. Rewrite it to avoid depicting real people, celebrities, or copyrighted characters. Keep the same meme concept and humor but use generic/illustrated characters instead.\n\nOriginal prompt:\n${prompt}` }],
            req,
          });
          if (!safePrompt) throw genErr;
          buffer = await generateImage({
            model: data.imageModel,
            prompt: safePrompt,
            size: openaiSize,
            quality: data.quality || 'high',
            req,
          });
        } else {
          throw genErr;
        }
      }

      if (data.includeOwl) {
        buffer = await addAppIconOverlay(buffer, data.owlPosition, brand);
      }

      const slug = crypto.randomUUID().slice(0, 8);
      const filename = `meme_${brandId}_${Date.now()}_${slug}.png`;
      const url = await uploadToStorage(buffer, filename);
      saveImageRecord({ userId: req.user?.uid, brandId, filename, type: 'meme' });

      return res.json({
        ok: true, filename, url,
        prompt: rawPrompt,
        refinedPrompt: refinedPrompt || null,
        usedRefined: Boolean(refinedPrompt),
      });
    }

    // Video generation (Kling 3.0 via fal.ai)
    if (data.slideType === 'video') {
      if (!isFalEnabled(req)) return res.status(400).json({ error: 'Fal.ai API key required for video generation. Add it in Settings.' });
      console.log(`[Generate] ${brand.name} | Video clip | ${data.duration || 5}s`);
      const rawPrompt = buildVideoPrompt(data, brand);
      const refinedPrompt = await refinePromptWithClaude(rawPrompt, 'video', data, brand, req);
      const prompt = refinedPrompt || rawPrompt;

      const videoUrl = await generateVideoSlide(prompt, {
        duration: data.duration || 5,
        aspectRatio: '9:16',
        audio: data.audio || false,
        falKey: req.headers['x-fal-key'],
      });

      const videoRes = await fetch(videoUrl);
      if (!videoRes.ok) throw new Error('Failed to download generated video');
      let videoBuffer = Buffer.from(await videoRes.arrayBuffer());

      // Apply text overlay if enabled
      try {
        const overlayPng = await generateVideoTextOverlay(data, brand);
        if (overlayPng) {
          let overlay = overlayPng;
          if (data.includeOwl) overlay = await addAppIconOverlay(overlay, data.owlPosition, brand);
          const outPath = path.join(outputDir, `tmp_final_${crypto.randomUUID().slice(0, 8)}.mp4`);
          await overlayPngOnVideo(videoBuffer, overlay, outPath);
          videoBuffer = await fs.readFile(outPath);
          await fs.unlink(outPath).catch(() => {});
        }
      } catch (overlayErr) {
        console.error('[Video overlay] Failed, returning raw video:', overlayErr.message);
      }

      const slug = crypto.randomUUID().slice(0, 8);
      const filename = `video_${brandId}_${Date.now()}_${slug}.mp4`;
      const url = await uploadVideoToStorage(videoBuffer, filename);
      saveImageRecord({ userId: req.user?.uid, brandId, filename, type: 'video' });

      return res.json({
        ok: true, filename, url, isVideo: true,
        prompt: rawPrompt,
        refinedPrompt: refinedPrompt || null,
        usedRefined: Boolean(refinedPrompt),
      });
    }

    // --- Hybrid photo generation: AI image (optionally with person) + Sharp text overlay ---
    if (data.slideType === 'photo' && data.personId) {
      let personTempFiles = [];
      try {
        const person = await getPersonById(data.personId, req.user?.uid);
        if (!person || !person.photos?.length) {
          return res.status(400).json({ error: 'Person not found or has no photos' });
        }

        const rawPrompt = buildPhotoImagePrompt(data, brand);
        const refinedPrompt = await refinePromptWithClaude(rawPrompt, 'photo', data, brand, req);
        const prompt = refinedPrompt || rawPrompt;

        let buffer;
        if (person.loraStatus === 'ready' && person.loraUrl && isFalEnabled(req)) {
          // LoRA inference — trained person model, no need to download photos
          const loraPrompt = `${person.loraTriggerWord} ${prompt}`;
          console.log(`[Generate] ${brand.name} | LoRA photo with person "${person.name}" (${person.loraModel}) | ${refinedPrompt ? 'Claude-refined' : 'raw'}`);
          buffer = await generateWithLoRA(person.loraUrl, loraPrompt, {
            loraModel: person.loraModel,
            falKey: req.headers['x-fal-key'],
          });
        } else {
          personTempFiles = await downloadPersonPhotosToTemp(person);
          console.log(`[Generate] ${brand.name} | Hybrid photo with person "${person.name}" | ${refinedPrompt ? 'Claude-refined' : 'raw'}`);

          if (isFalEnabled(req) && personTempFiles.length > 0) {
            // Flux multi-ref for person consistency
            buffer = await generateWithFlux(personTempFiles, prompt, { falKey: req.headers['x-fal-key'] });
          } else {
            // GPT fallback — single reference
            const refBuffer = await fs.readFile(personTempFiles[0]);
            buffer = await generateImage({
              model: data.imageModel,
              prompt,
              size: '1024x1536',
              quality: data.quality || 'high',
              referenceImage: refBuffer,
              req,
            });
          }
        }

        // Resize to exact canvas dimensions
        const meta = await sharp(buffer).metadata();
        if (meta.width !== 1080 || meta.height !== 1920) {
          buffer = await sharp(buffer).resize(1080, 1920, { fit: 'cover' }).png().toBuffer();
        }

        // Composite text overlay with Sharp
        buffer = await compositeTextOverlay(buffer, data, brand);

        if (data.includeOwl) {
          buffer = await addAppIconOverlay(buffer, data.owlPosition, brand);
        }

        await cleanupTempFiles(personTempFiles);

        const slug = crypto.randomUUID().slice(0, 8);
        const filename = `slide_${brandId}_photo_${Date.now()}_${slug}.png`;
        const url = await uploadToStorage(buffer, filename);
        saveImageRecord({ userId: req.user?.uid, brandId, filename, type: 'slide' });

        return res.json({
          ok: true, filename, url,
          prompt: rawPrompt,
          refinedPrompt: refinedPrompt || null,
          usedRefined: Boolean(refinedPrompt),
          hybrid: true,
        });
      } catch (error) {
        await cleanupTempFiles(personTempFiles);
        throw error;
      }
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
      brand,
      req
    );
    const prompt = refinedPrompt || (rawPrompt + referenceInstruction);

    console.log(`[Generate] ${brand.name} | ${refinedPrompt ? 'refined' : 'raw'} prompt`);

    // Generate image (handles reference images, routes to correct provider)
    let refBuffer = null;
    if (data.referenceImage) {
      const refPath = path.join(uploadsDir, path.basename(data.referenceImage));
      try {
        await fs.access(refPath);
        refBuffer = await fs.readFile(refPath);
      } catch (err) {
        if (err.code === 'ENOENT' || err.message?.includes('no such file')) {
          console.warn('[Generate] Reference image not found, generating without it');
        } else {
          throw err;
        }
      }
    }

    let buffer = await generateImage({
      model: data.imageModel,
      prompt,
      size: '1024x1536',
      quality: data.quality || 'high',
      referenceImage: refBuffer,
      req,
    });

    if (data.includeOwl) {
      buffer = await addAppIconOverlay(buffer, data.owlPosition, brand);
    }

    const slug = crypto.randomUUID().slice(0, 8);
    const filename = `slide_${brandId}_${data.slideType}_${Date.now()}_${slug}.png`;

    const url = await uploadToStorage(buffer, filename);
    saveImageRecord({ userId: req.user?.uid, brandId, filename, type: 'slide' });

    res.json({
      ok: true,
      filename,
      url,
      prompt: rawPrompt,
      refinedPrompt: refinedPrompt || null,
      usedRefined: Boolean(refinedPrompt),
    });
  } catch (error) {
    console.error(error);
    const isSafety = error.message?.includes('safety') || error.message?.includes('rejected');
    const msg = isSafety
      ? 'OpenAI rejected this prompt — try avoiding references to real people or celebrities.'
      : safeErrorMessage(error, 'Generation failed');
    res.status(isSafety ? 422 : 500).json({ error: msg });
  }
});

// --- Edit existing slide image ---
app.post('/api/edit-slide', requireAuth, async (req, res) => {
  try {
    const { imageUrl, instructions, quality, imageModel, brand: brandId } = req.body;
    if (!imageUrl || !instructions) return res.status(400).json({ error: 'Missing imageUrl or instructions' });

    const brand = await getBrandAsync(brandId, req.user?.uid);

    // Fetch existing image — handle relative paths (local dev) and full URLs
    let imgBuffer;
    if (imageUrl.startsWith('/output/')) {
      const localPath = path.join(outputDir, path.basename(imageUrl));
      imgBuffer = await fs.readFile(localPath);
    } else {
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error('Failed to fetch source image');
      imgBuffer = Buffer.from(await imgRes.arrayBuffer());
    }

    const c = brand.colors;
    const editPrompt = [
      `Edit this carousel slide for ${brand.name}.`,
      `Change: ${instructions}.`,
      `Brand colors: primary ${c.primary}, accent ${c.accent}, text ${c.white}, CTA ${c.cta}.`,
      brand.imageStyle ? `Visual style: ${brand.imageStyle}` : '',
      `Safe zones: top 120px, bottom 200px, sides 90px. Keep text within these bounds.`,
      `Keep everything else the same. Do not add new text or logos.`,
    ].filter(Boolean).join(' ');

    let buffer = await generateImage({
      model: imageModel,
      prompt: editPrompt,
      size: '1024x1536',
      quality: quality || 'high',
      referenceImage: imgBuffer,
      req,
    });
    const slug = crypto.randomUUID().slice(0, 8);
    const filename = `edit_${brandId}_${Date.now()}_${slug}.png`;
    const url = await uploadToStorage(buffer, filename);
    saveImageRecord({ userId: req.user?.uid, brandId, filename, type: 'edit' });

    res.json({ ok: true, filename, url });
  } catch (error) {
    console.error('[Edit Slide]', error);
    res.status(500).json({ error: safeErrorMessage(error, 'Edit failed') });
  }
});

// Batch carousel generation
const carouselJobs = new Map();

app.post('/api/generate-carousel', requireAuth, generationLimiter, async (req, res) => {
  const { slides, includeOwl, owlPosition, quality, brand: brandId, imageModel, referenceImage, referenceUsage, referenceInstructions } = req.body || {};
  if (!slides || !Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: 'Missing slides array' });
  }
  if (slides.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 slides per batch' });
  }

  if (!brandId) return res.status(400).json({ error: 'Missing brand' });
  const brand = await getBrandAsync(brandId, req.user?.uid);

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
        // Mockup slides: render with Sharp (optionally with AI background)
        if (slideData.slideType === 'mockup') {
          if (slideData.imageUsage === 'ai-background') {
            console.log(`[Carousel ${jobId}] ${brand.name} | Slide ${i + 1}/${slides.length} (mockup + AI bg)`);
            const bgPrompt = buildMockupBackgroundPrompt(slideData, brand);
            const refined = await refinePromptWithClaude(bgPrompt, 'photo', slideData, brand, req);
            const bgBuffer = await generateImage({
              model: slideData.imageModel,
              prompt: refined || bgPrompt,
              size: '1024x1536',
              quality: slideData.quality || 'high',
              req,
            });
            const tempName = `aibg_${crypto.randomUUID().slice(0, 8)}.png`;
            const tempPath = path.join(uploadsDir, tempName);
            await fs.writeFile(tempPath, bgBuffer);
            slideData.screenshotImage = tempName;
            slideData.imageUsage = 'background';
            try {
              const mockupBuffer = await generateMockupSlide(slideData, brand);
              const slug = crypto.randomUUID().slice(0, 8);
              const filename = `carousel_${brand.id}_${jobId}_s${i + 1}_${slug}.png`;
              const slideUrl = await uploadToStorage(mockupBuffer, filename);
              saveImageRecord({ userId: req.user?.uid, brandId: brand.id, filename, type: 'carousel' });
              job.slides.push({ slideNumber: i + 1, url: slideUrl, filename, ok: true });
            } finally {
              await fs.unlink(tempPath).catch(() => {});
            }
          } else {
            console.log(`[Carousel ${jobId}] ${brand.name} | Slide ${i + 1}/${slides.length} (mockup)`);
            const mockupBuffer = await generateMockupSlide(slideData, brand);
            const slug = crypto.randomUUID().slice(0, 8);
            const filename = `carousel_${brand.id}_${jobId}_s${i + 1}_${slug}.png`;
            const slideUrl = await uploadToStorage(mockupBuffer, filename);
            saveImageRecord({ userId: req.user?.uid, brandId: brand.id, filename, type: 'carousel' });
            job.slides.push({ slideNumber: i + 1, url: slideUrl, filename, ok: true });
          }
          job.completed = i + 1;
          continue;
        }

        // Video slides: Kling 3.0 via fal.ai
        if (slideData.slideType === 'video') {
          if (!isFalEnabled(req)) throw new Error('Fal.ai API key required for video generation');
          console.log(`[Carousel ${jobId}] ${brand.name} | Slide ${i + 1}/${slides.length} (video)`);
          const rawPrompt = buildVideoPrompt(slideData, brand);
          const refined = await refinePromptWithClaude(rawPrompt, 'video', slideData, brand, req);
          const prompt = refined || rawPrompt;

          const videoUrl = await generateVideoSlide(prompt, {
            duration: slideData.duration || 5,
            aspectRatio: '9:16',
            audio: slideData.audio || false,
            falKey: req.headers['x-fal-key'],
          });

          // Download video to local storage
          const videoRes = await fetch(videoUrl);
          if (!videoRes.ok) throw new Error('Failed to download generated video');
          let videoBuffer = Buffer.from(await videoRes.arrayBuffer());

          // Apply text overlay if enabled
          try {
            const overlayPng = await generateVideoTextOverlay(slideData, brand);
            if (overlayPng) {
              let overlay = overlayPng;
              if (slideData.includeOwl) overlay = await addAppIconOverlay(overlay, slideData.owlPosition, brand);
              const outPath = path.join(outputDir, `tmp_final_${crypto.randomUUID().slice(0, 8)}.mp4`);
              await overlayPngOnVideo(videoBuffer, overlay, outPath);
              videoBuffer = await fs.readFile(outPath);
              await fs.unlink(outPath).catch(() => {});
            }
          } catch (overlayErr) {
            console.error(`[Carousel ${jobId}] Video overlay failed, using raw video:`, overlayErr.message);
          }

          const slug = crypto.randomUUID().slice(0, 8);
          const filename = `carousel_${brand.id}_${jobId}_s${i + 1}_${slug}.mp4`;
          const slideUrl = await uploadVideoToStorage(videoBuffer, filename);
          saveImageRecord({ userId: req.user?.uid, brandId: brand.id, filename, type: 'carousel-video' });

          job.slides.push({ slideNumber: i + 1, url: slideUrl, filename, ok: true, isVideo: true });
          job.completed = i + 1;
          continue;
        }

        // Hybrid photo generation: AI image with person + Sharp text overlay
        if (slideData.slideType === 'photo' && slideData.personId) {
          let personTempFiles = [];
          try {
            const person = await getPersonById(slideData.personId, req.user?.uid);
            if (person && person.photos?.length > 0) {
              const rawPrompt = buildPhotoImagePrompt(slideData, brand);
              const refined = await refinePromptWithClaude(rawPrompt, 'photo', slideData, brand, req);
              const prompt = refined || rawPrompt;

              let buffer;
              if (person.loraStatus === 'ready' && person.loraUrl && isFalEnabled(req)) {
                const loraPrompt = `${person.loraTriggerWord} ${prompt}`;
                console.log(`[Carousel ${jobId}] ${brand.name} | Slide ${i + 1}/${slides.length} (LoRA + person "${person.name}")`);
                buffer = await generateWithLoRA(person.loraUrl, loraPrompt, {
                  loraModel: person.loraModel,
                  falKey: req.headers['x-fal-key'],
                });
              } else {
                personTempFiles = await downloadPersonPhotosToTemp(person);
                console.log(`[Carousel ${jobId}] ${brand.name} | Slide ${i + 1}/${slides.length} (hybrid + person "${person.name}")`);

                if (isFalEnabled(req) && personTempFiles.length > 0) {
                  buffer = await generateWithFlux(personTempFiles, prompt, { falKey: req.headers['x-fal-key'] });
                } else {
                  const refBuffer = await fs.readFile(personTempFiles[0]);
                  buffer = await generateImage({
                    model: imageModel,
                    prompt,
                    size: '1024x1536',
                    quality: slideData.quality || 'high',
                    referenceImage: refBuffer,
                    req,
                  });
                }
              }

              const meta = await sharp(buffer).metadata();
              if (meta.width !== 1080 || meta.height !== 1920) {
                buffer = await sharp(buffer).resize(1080, 1920, { fit: 'cover' }).png().toBuffer();
              }

              buffer = await compositeTextOverlay(buffer, slideData, brand);

              if (slideData.includeOwl) {
                buffer = await addAppIconOverlay(buffer, slideData.owlPosition, brand);
              }

              await cleanupTempFiles(personTempFiles);

              const slug = crypto.randomUUID().slice(0, 8);
              const filename = `carousel_${brand.id}_${jobId}_s${i + 1}_${slug}.png`;
              const slideUrl = await uploadToStorage(buffer, filename);
              saveImageRecord({ userId: req.user?.uid, brandId: brand.id, filename, type: 'carousel' });
              job.slides.push({ slideNumber: i + 1, url: slideUrl, filename, ok: true });
              job.completed = i + 1;
              continue;
            }
          } catch (personErr) {
            await cleanupTempFiles(personTempFiles);
            throw personErr;
          }
        }

        const rawPrompt =
          slideData.slideType === 'photo'
            ? buildPhotoPrompt(slideData, brand)
            : buildTextPrompt(slideData, brand);

        // Per-slide reference image takes priority over global
        const slideRefImage = slideData.referenceImage || referenceImage;
        const slideRefUsage = slideData.referenceUsage || referenceUsage;
        const slideRefInstructions = slideData.referenceInstructions || referenceInstructions;

        // Append reference instruction if provided
        let carouselRefInstruction = '';
        if (slideRefImage) {
          carouselRefInstruction = `\n\nReference image provided: Use it as ${slideRefUsage || 'background inspiration'}. ${slideRefInstructions || ''}`;
        }

        const refinedPrompt = await refinePromptWithClaude(rawPrompt + carouselRefInstruction, slideData.slideType, slideData, brand, req);
        const prompt = refinedPrompt || (rawPrompt + carouselRefInstruction);

        console.log(`[Carousel ${jobId}] ${brand.name} | Slide ${i + 1}/${slides.length}${slideRefImage ? ' (ref image)' : ''}`);

        let refBuffer = null;
        if (slideRefImage) {
          const refPath = path.join(uploadsDir, path.basename(slideRefImage));
          try {
            await fs.access(refPath);
            refBuffer = await fs.readFile(refPath);
          } catch (refErr) {
            if (refErr.code === 'ENOENT' || refErr.message?.includes('no such file')) {
              console.warn(`[Carousel ${jobId}] Reference image not found, generating without it`);
            } else {
              throw refErr;
            }
          }
        }

        let buffer = await generateImage({
          model: imageModel,
          prompt,
          size: '1024x1536',
          quality: slideData.quality || 'high',
          referenceImage: refBuffer,
          req,
        });
        if (slideData.includeOwl) {
          buffer = await addAppIconOverlay(buffer, slideData.owlPosition, brand);
        }

        const slug = crypto.randomUUID().slice(0, 8);
        const filename = `carousel_${brand.id}_${jobId}_s${i + 1}_${slug}.png`;
        const slideUrl = await uploadToStorage(buffer, filename);
        saveImageRecord({ userId: req.user?.uid, brandId: brand.id, filename, type: 'carousel' });

        job.slides.push({
          slideNumber: i + 1,
          url: slideUrl,
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
  })().catch(err => { job.status = 'error'; job.error = err.message; });
});

app.get('/api/carousel-status/:jobId', requireAuth, (req, res) => {
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
app.post('/api/generate-freeform', requireAuth, generationLimiter, async (req, res) => {
  try {
    const { prompt: userPrompt, brand: brandId, slideCount } = req.body || {};
    if (!userPrompt) {
      return res.status(400).json({ error: 'Missing prompt' });
    }
    if (!brandId) {
      return res.status(400).json({ error: 'Missing brand' });
    }

    const brand = await getBrandAsync(brandId, req.user?.uid);
    const numSlides = Math.min(Math.max(parseInt(slideCount) || 7, 1), 20);

    const freeformSystemPrompt = `${brand.systemPrompt}

You are generating carousel slide content for ${brand.name} social media (TikTok/Instagram).

Given a freeform prompt from the user, generate exactly ${numSlides} slides for a carousel post.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "title": "Short carousel title",
  "caption": "Ready-to-post Instagram/TikTok caption",
  "slides": [
    {
      "number": 1,
      "label": "Hook",
      "type": "photo, text, or mockup",
      "microLabel": "BRAND LABEL",
      "headline": "Main headline text",
      "body": "Supporting body text",
      "highlight": "key phrase to highlight in accent color",
      "sport": "only for photo type - sport shown",
      "setting": "only for photo type - location",
      "action": "only for photo type - what the person is doing",
      "mood": "only for photo type - emotional tone",
      "mockupLayout": "only for mockup type - phone-right, phone-left, or text-statement",
      "mockupTheme": "only for mockup type - dark or light"
    }
  ]
}

Rules:
- Include a "caption" field with this structure: (1) HOOK line under 125 chars using a proven formula — question, stat, promise, mistake, or curiosity pattern. (2) 1-2 VALUE sentences expanding on the carousel takeaway with natural keywords. (3) SPECIFIC CTA — "save this for later", "comment which tip you'll try", "send this to someone who needs it", or a choice question. Avoid generic CTAs like "thoughts?". (4) 3-5 hashtags at the end.
- First slide should be a strong hook (usually photo type)
- Last slide should be a CTA with "${brand.name} — link in bio"
- Mix photo, text, and mockup types for visual variety
- Use mockup type with text-statement layout for bold statement slides (no screenshot needed)
- Use mockup type with phone-right or phone-left for app screenshot slides (user provides screenshot after)
- Headlines should be punchy, under 15 words
- Body text should be 1-2 sentences max
- Highlight the most impactful phrase in each slide
- Use ${brand.defaultMicroLabel} as default micro-label
- For photo slides, include sport/setting/action/mood fields
- Content should match the brand's tone and content pillars`;

    // Inject generation history for cross-session dedup
    const historySection = buildHistoryPromptSection(brand.generationHistory);
    const systemWithHistory = historySection ? freeformSystemPrompt + '\n' + historySection : freeformSystemPrompt;

    const text = await generateText({
      model: req.body?.textModel,
      system: systemWithHistory,
      messages: [
        { role: 'user', content: userPrompt },
      ],
      maxTokens: 2048,
      req,
    });

    if (!text) {
      throw new Error('No response from AI');
    }

    // Parse JSON from response (handle potential markdown wrapping)
    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      throw new Error('Failed to parse AI response as JSON');
    }

    // Record in generation history for cross-session dedup
    if (brandId && parsed.title) {
      const entry = {
        type: 'freeform',
        title: parsed.title,
        headlines: (parsed.slides || []).map(s => s.headline).filter(Boolean),
        ts: Date.now(),
      };
      const updatedHistory = trimGenerationHistory([...(brand.generationHistory || []), entry]);
      await updateBrandFields(brandId, { generationHistory: updatedHistory });
    }

    console.log(`[Freeform] ${brand.name} | Generated ${parsed.slides?.length || 0} slides`);
    res.json({ ok: true, ...parsed });
  } catch (error) {
    console.error('[Freeform]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// --- Auto-Generate Content Ideas from Website ---
app.post('/api/generate-content-ideas', requireAuth, async (req, res) => {
  try {
    const { brand: brandId, existingTitles, numIdeas, startIndex, userTopic, slidesPerIdea, format } = req.body || {};
    if (!brandId) return res.status(400).json({ error: 'Missing brand' });

    const brand = await getBrandAsync(brandId, req.user?.uid);
    if (!brand.website) {
      return res.status(400).json({ error: 'No website set for this brand. Edit your brand and add a website URL first.' });
    }

    // Fetch website HTML
    let websiteUrl = brand.website.trim();
    if (!/^https?:\/\//i.test(websiteUrl)) websiteUrl = `https://${websiteUrl}`;
    if (!isUrlSafe(websiteUrl)) return res.status(400).json({ error: 'Website URL not allowed' });

    let html;
    try {
      const resp = await fetch(websiteUrl, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarouselStudio/1.0)' },
        redirect: 'follow',
      });
      const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
      if (contentLength > 1024 * 1024) throw new Error('Response too large');
      html = await resp.text();
    } catch (e) {
      return res.status(400).json({ error: `Could not reach website: ${e.message}` });
    }

    // Extract text content
    const websiteText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

    const metaTag = (name) => {
      const re = new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
      const re2 = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i');
      return (html.match(re)?.[1] || html.match(re2)?.[1] || '').trim();
    };
    const metaDesc = metaTag('description') || metaTag('og:description');

    const brandContext = [
      brand.systemPrompt || '',
      `Brand: ${brand.name}`,
      brand.website ? `Website: ${brand.website}` : '',
      brand.contentPillars?.length ? `Content pillars: ${brand.contentPillars.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const microLabel = brand.defaultMicroLabel || brand.name.toUpperCase();
    const count = numIdeas || 5;
    let userPrompt;
    if (brand.contentIdeaPrompt) {
      userPrompt = brand.contentIdeaPrompt
        .replace(/\{\{brand_name\}\}/g, brand.name)
        .replace(/\{\{website_url\}\}/g, websiteUrl)
        .replace(/\{\{page_title\}\}/g, pageTitle)
        .replace(/\{\{meta_description\}\}/g, metaDesc)
        .replace(/\{\{website_text\}\}/g, websiteText)
        .replace(/\{\{micro_label\}\}/g, microLabel);
    } else if (format === 'video') {
      userPrompt = `Based on this website content, generate ${count} short-form VIDEO content idea(s) for ${brand.name}'s social media (TikTok/Instagram Reels).

Website: ${websiteUrl}
Page title: ${pageTitle}
Description: ${metaDesc}
Website text: ${websiteText}

Each idea must have EXACTLY 1 slide with type "video". This is NOT a carousel — it's a single AI-generated video clip (5-10 seconds) with text overlay.

Return ONLY valid JSON (no markdown, no code fences) with this structure:
{
  "ideas": [
    {
      "title": "Short video title",
      "caption": "Instagram/TikTok caption with hashtags (150-200 words, hook line first)",
      "slides": [
        {
          "number": 1,
          "label": "Video",
          "type": "video",
          "microLabel": "${microLabel}",
          "headline": "Bold headline for text overlay (under 10 words)",
          "body": "One supporting sentence",
          "highlight": "key phrase to highlight",
          "scene": "Vivid 1-2 sentence visual description with motion — what the viewer sees happening",
          "videoMood": "energetic and dynamic, calm and serene, dramatic and intense, etc.",
          "cameraMove": "slow tracking shot, smooth dolly-in, cinematic pan, handheld follow, drone aerial pullback, or static wide angle",
          "duration": "5 or 10"
        }
      ]
    }
  ]
}

Rules:
- EXACTLY 1 slide per idea with type "video" — never more
- Scene: describe vivid motion and action, not static images. Think cinematic B-roll
- Headline: punchy, under 10 words — this overlays the video
- Body: 1 short sentence max
- Caption: hook line first (under 125 chars), then value, then CTA, then 3-5 hashtags
- Content must be based on REAL information from the website`;
    } else {
      userPrompt = buildContentIdeasPrompt({ brand, microLabel, websiteUrl, pageTitle, metaDesc, websiteText, numIdeas: count, slidesPerIdea });
    }

    // When generating more, tell Claude to avoid repeating existing topics
    if (existingTitles?.length) {
      userPrompt += `\n\nIMPORTANT: The following ideas already exist. Generate COMPLETELY DIFFERENT topics — do NOT repeat or rephrase any of these:\n${existingTitles.map(t => `- ${t}`).join('\n')}`;
    }

    // Inject persistent generation history for cross-session dedup
    const historySection = buildHistoryPromptSection(brand.generationHistory);
    if (historySection) {
      userPrompt += '\n' + historySection;
    }

    // Freeform user topic to guide idea generation
    if (userTopic?.trim()) {
      userPrompt += `\n\nUSER REQUEST: The user specifically wants this idea to be about: "${userTopic.trim()}". Generate content that directly addresses this topic using the brand's real information.`;
    }

    const text = await generateText({
      model: req.body?.textModel,
      system: brandContext,
      messages: [{
        role: 'user',
        content: userPrompt,
      }],
      maxTokens: 4096,
      req,
    });

    if (!text) throw new Error('No response from AI');

    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      throw new Error('Failed to parse AI response as JSON');
    }

    let ideas = parsed.ideas || [];
    // Enforce video type when format=video (LLM may not always set it)
    if (format === 'video') {
      ideas = ideas.map(idea => ({
        ...idea,
        slides: (idea.slides || []).map(s => ({ ...s, type: 'video' })),
      }));
    }
    console.log(`[Content Ideas] ${brand.name} | Generated ${ideas.length} ideas | format=${format || 'carousel'}`);

    // Persist so ideas survive refresh/brand-switch
    const idStart = startIndex || 0;
    if (brandId) {
      const formatted = ideas.map((idea, i) => ({
        id: `AI-${idStart + i + 1}`,
        title: idea.title,
        caption: idea.caption || '',
        slides: (idea.slides || []).map((s, si) => ({ ...s, number: s.number || si + 1, type: s.type || 'text' })),
      }));

      // Build generation history entries from new ideas
      const newHistoryEntries = ideas.map(idea => ({
        type: 'idea',
        title: idea.title,
        headlines: (idea.slides || []).map(s => s.headline).filter(Boolean),
        ts: Date.now(),
      }));
      const updatedHistory = trimGenerationHistory([...(brand.generationHistory || []), ...newHistoryEntries]);

      if (idStart > 0) {
        // Append to existing ideas
        const freshBrand = await getBrandAsync(brandId, req.user?.uid);
        const existing = freshBrand.contentIdeas || [];
        await updateBrandFields(brandId, { contentIdeas: [...existing, ...formatted], generationHistory: updatedHistory });
      } else {
        await updateBrandFields(brandId, { contentIdeas: formatted, generationHistory: updatedHistory });
      }
    }

    res.json({ ok: true, ideas });
  } catch (error) {
    console.error('[Content Ideas]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// --- Personalized Scenario Generation ---

const personalizeScenarioCache = new Map();

app.post('/api/personalize-scenarios', requireAuth, async (req, res) => {
  try {
    const brandId = req.body?.brand;
    if (!brandId) return res.status(400).json({ error: 'Missing brand' });

    const brand = await getBrandAsync(brandId, req.user?.uid);

    // Check cache
    const cached = personalizeScenarioCache.get(brand.id);
    if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
      return res.json({ scenarios: cached.scenarios });
    }

    const brandContext = [
      `Brand: ${brand.name}`,
      brand.website ? `Website: ${brand.website}` : '',
      brand.systemPrompt ? `About: ${brand.systemPrompt}` : '',
      brand.defaultBackground ? `Visual style: ${brand.defaultBackground}` : '',
    ].filter(Boolean).join('\n');

    const text = await generateText({
      model: req.body?.textModel,
      system: BRAND_STRATEGIST_SYSTEM,
      messages: [{
        role: 'user',
        content: `Given this brand:\n${brandContext}\n\nGenerate exactly 8 photo scenarios for personalized images featuring a person (the user). Each scenario should be relevant to this brand's industry, niche, and identity.\n\nReturn a JSON array with exactly 8 objects, each having:\n- id: URL-safe slug (e.g. "morning-routine")\n- title: 2-3 word title\n- category: 1 word category\n- setting: scene/environment description (10-20 words)\n- action: what the person is doing (5-10 words)\n- mood: emotional tone (2-4 words)\n\nRespond with ONLY the JSON array, no other text.`
      }],
      maxTokens: 1024,
      req,
    });

    let scenarios;
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      scenarios = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      throw new Error('Failed to parse scenario response');
    }

    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      throw new Error('Invalid scenario response');
    }

    // Cache for 30 minutes
    personalizeScenarioCache.set(brand.id, { scenarios, ts: Date.now() });
    setTimeout(() => personalizeScenarioCache.delete(brand.id), 30 * 60 * 1000);

    console.log(`[Scenarios] Generated ${scenarios.length} scenarios for ${brand.name}`);
    res.json({ scenarios });
  } catch (error) {
    console.error('[Scenarios]', error);
    res.status(500).json({ error: safeErrorMessage(error, 'Scenario generation failed') });
  }
});

// --- Personalized Image Generation (Face + Scenario) ---

app.post('/api/generate-personalized', requireAuth, upload.array('faceImages', 5), async (req, res) => {
  let downloadedTempFiles = [];
  try {
    const data = req.body || {};
    const brandId = data.brand;
    if (!brandId) return res.status(400).json({ error: 'Missing brand' });

    const brand = await getBrandAsync(brandId, req.user?.uid);
    const model = data.model || 'flux';

    // Check for LoRA-trained person first
    let loraUsed = false;
    let person = null;
    if (data.personId) {
      person = await getPersonById(data.personId, req.user?.uid);
    }

    const scenarioPrompt = data.prompt || buildPersonalizedPrompt(data, brand);
    const refined = await refinePromptWithClaude(scenarioPrompt, 'photo', data, brand, req);
    const finalPrompt = refined || scenarioPrompt;

    let buffer;
    if (person && person.loraStatus === 'ready' && person.loraUrl && isFalEnabled(req)) {
      // LoRA inference — trained person model
      const loraPrompt = `${person.loraTriggerWord} ${finalPrompt}`;
      console.log(`[Personalized] LoRA inference for "${person.name}" (${person.loraModel})`);
      buffer = await generateWithLoRA(person.loraUrl, loraPrompt, {
        loraModel: person.loraModel,
        falKey: req.headers['x-fal-key'],
      });
      loraUsed = true;
    } else {
      // Fallback: raw reference photos
      let faceImagePaths;
      if (req.files && req.files.length > 0) {
        faceImagePaths = req.files.map(f => f.path);
      } else if (person && person.photos?.length > 0) {
        downloadedTempFiles = await downloadPersonPhotosToTemp(person);
        faceImagePaths = downloadedTempFiles;
      } else if (brand.facePhotos && brand.facePhotos.length > 0) {
        downloadedTempFiles = await downloadFacePhotosToTemp(brand);
        faceImagePaths = downloadedTempFiles;
      } else {
        return res.status(400).json({ error: 'No face photos. Select a person or upload photos.' });
      }

      if (model === 'flux' && isFalEnabled(req)) {
        buffer = await generateWithFlux(faceImagePaths, finalPrompt, { falKey: req.headers['x-fal-key'] });
      } else {
        // GPT fallback — use first image only (doesn't support multi-ref)
        const refBuffer = await fs.readFile(faceImagePaths[0]);
        buffer = await generateImage({
          model: data.imageModel,
          prompt: finalPrompt,
          size: '1024x1536',
          quality: data.quality || 'high',
          referenceImage: refBuffer,
          req,
        });
      }
    }

    // Resize to exact dimensions if needed
    const meta = await sharp(buffer).metadata();
    if (meta.width !== 1024 || meta.height !== 1536) {
      buffer = await sharp(buffer).resize(1024, 1536, { fit: 'cover' }).png().toBuffer();
    }

    if (data.includeOwl === 'true' || data.includeOwl === true) {
      buffer = await addAppIconOverlay(buffer, data.owlPosition, brand);
    }

    const slug = crypto.randomUUID().slice(0, 8);
    const filename = `personalized_${brandId}_${Date.now()}_${slug}.png`;
    const url = await uploadToStorage(buffer, filename);
    saveImageRecord({ userId: req.user?.uid, brandId, filename, type: 'personalized' });

    if (downloadedTempFiles.length > 0) await cleanupTempFiles(downloadedTempFiles);
    res.json({ ok: true, url, filename, model: loraUsed ? 'lora' : model === 'flux' && isFalEnabled(req) ? 'flux' : 'gpt' });
  } catch (error) {
    if (downloadedTempFiles.length > 0) await cleanupTempFiles(downloadedTempFiles);
    console.error('[Personalized]', error);
    res.status(500).json({ error: safeErrorMessage(error, 'Personalized generation failed') });
  }
});

app.post('/api/generate-personalized-carousel', requireAuth, upload.array('faceImages', 5), async (req, res) => {
  let { slides, includeOwl, owlPosition, quality, brand: brandId, model } = req.body || {};
  if (typeof slides === 'string') {
    try { slides = JSON.parse(slides); } catch { return res.status(400).json({ error: 'Invalid slides JSON' }); }
  }
  if (!slides || !Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: 'Missing slides array' });
  }
  if (!brandId) return res.status(400).json({ error: 'Missing brand' });

  const brand = await getBrandAsync(brandId, req.user?.uid);
  const personId = req.body?.personId;

  // Check for LoRA-trained person
  let loraPerson = null;
  let faceImagePaths;
  let downloadedTempFiles = [];
  if (personId) {
    const person = await getPersonById(personId, req.user?.uid);
    if (person && person.loraStatus === 'ready' && person.loraUrl && isFalEnabled(req)) {
      loraPerson = person;
    } else if (person && person.photos?.length > 0) {
      downloadedTempFiles = await downloadPersonPhotosToTemp(person);
      faceImagePaths = downloadedTempFiles;
    } else {
      return res.status(400).json({ error: 'Person not found or has no photos.' });
    }
  } else if (req.files && req.files.length > 0) {
    faceImagePaths = req.files.map(f => f.path);
  } else if (brand.facePhotos && brand.facePhotos.length > 0) {
    downloadedTempFiles = await downloadFacePhotosToTemp(brand);
    faceImagePaths = downloadedTempFiles;
  } else {
    return res.status(400).json({ error: 'No face photos. Select a person or upload photos.' });
  }
  const useFlux = (model || 'flux') === 'flux' && isFalEnabled(req);

  const jobId = crypto.randomUUID().slice(0, 12);
  const job = { id: jobId, brandId: brand.id, total: slides.length, completed: 0, current: 0, slides: [], status: 'running', error: null };
  carouselJobs.set(jobId, job);
  res.json({ jobId, total: slides.length });

  (async () => {
    for (let i = 0; i < slides.length; i++) {
      job.current = i + 1;
      const slideData = slides[i];
      try {
        const scenarioPrompt = slideData.prompt || buildPersonalizedPrompt(slideData, brand);
        const refined = await refinePromptWithClaude(scenarioPrompt, 'photo', slideData, brand, req);
        const finalPrompt = refined || scenarioPrompt;

        let buffer;
        if (loraPerson) {
          const loraPrompt = `${loraPerson.loraTriggerWord} ${finalPrompt}`;
          buffer = await generateWithLoRA(loraPerson.loraUrl, loraPrompt, {
            loraModel: loraPerson.loraModel,
            falKey: req.headers['x-fal-key'],
          });
        } else if (useFlux) {
          buffer = await generateWithFlux(faceImagePaths, finalPrompt, { falKey: req.headers['x-fal-key'] });
        } else {
          const refBuffer = await fs.readFile(faceImagePaths[0]);
          buffer = await generateImage({
            model,
            prompt: finalPrompt,
            size: '1024x1536',
            quality: quality || 'high',
            referenceImage: refBuffer,
            req,
          });
        }

        // Resize to exact dimensions if needed
        const meta = await sharp(buffer).metadata();
        if (meta.width !== 1024 || meta.height !== 1536) {
          buffer = await sharp(buffer).resize(1024, 1536, { fit: 'cover' }).png().toBuffer();
        }

        if (includeOwl === 'true' || includeOwl === true) {
          buffer = await addAppIconOverlay(buffer, owlPosition, brand);
        }
        const slug = crypto.randomUUID().slice(0, 8);
        const filename = `personalized_${brand.id}_${jobId}_s${i + 1}_${slug}.png`;
        const url = await uploadToStorage(buffer, filename);
        saveImageRecord({ userId: req.user?.uid, brandId: brand.id, filename, type: 'personalized' });
        job.slides.push({ slideNumber: i + 1, url, filename, ok: true });
        job.completed = i + 1;
      } catch (err) {
        console.error(`[Personalized Carousel ${jobId}] Slide ${i + 1} failed:`, err.message);
        job.slides.push({ slideNumber: i + 1, url: null, error: err.message, ok: false });
        job.completed = i + 1;
      }
    }
    job.status = 'done';
    if (downloadedTempFiles.length > 0) await cleanupTempFiles(downloadedTempFiles);
    console.log(`[Personalized Carousel ${jobId}] Complete — ${job.slides.filter((s) => s.ok).length}/${job.total} succeeded`);
    setTimeout(() => carouselJobs.delete(jobId), 30 * 60 * 1000);
  })().catch(err => {
    job.status = 'error'; job.error = err.message;
    if (downloadedTempFiles.length > 0) cleanupTempFiles(downloadedTempFiles);
  });
});

// --- App Icon Upload ---
app.post('/api/upload-icon', requireAuth, upload.single('icon'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No icon uploaded' });
    }
    try {
      await validateImageFile(req.file);
    } catch (err) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Uploaded file is not a valid image' });
    }

    const brandId = req.body.brand;
    if (!brandId) return res.status(400).json({ error: 'Missing brand' });
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
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// --- Face Photo Management ---

// Upload face photos to brand profile
app.post('/api/brands/:id/face-photos', requireAuth, upload.array('photos', 5), async (req, res) => {
  try {
    const brandId = req.params.id;

    // Validate brand ownership
    let brand;
    if (db) {
      const doc = await db.collection('carousel_brands').doc(brandId).get();
      if (!doc.exists) return res.status(404).json({ error: 'Brand not found' });
      if (doc.data().createdBy !== req.user.uid) return res.status(403).json({ error: 'Not your brand' });
      brand = { id: brandId, ...doc.data() };
    } else {
      const brands = await readLocalBrands();
      if (!brands[brandId]) return res.status(404).json({ error: 'Brand not found' });
      if (brands[brandId].createdBy !== req.user.uid) return res.status(403).json({ error: 'Not your brand' });
      brand = { id: brandId, ...brands[brandId] };
    }

    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No photos uploaded' });

    const existing = brand.facePhotos || [];
    if (existing.length + req.files.length > 5) {
      // Clean up uploaded temp files
      for (const f of req.files) await fs.unlink(f.path).catch(() => {});
      return res.status(400).json({ error: `Too many photos. You have ${existing.length}, max is 5.` });
    }

    // Validate and process each photo
    const newPhotos = [];
    for (const file of req.files) {
      try {
        await validateImageFile(file);
      } catch {
        await fs.unlink(file.path).catch(() => {});
        continue;
      }

      const uuid = crypto.randomUUID().slice(0, 12);
      const storagePath = `brands/${brandId}/face-photos/${uuid}.png`;

      // Resize to 1024x1024 PNG
      const processed = await sharp(file.path)
        .resize(1024, 1024, { fit: 'cover' })
        .png()
        .toBuffer();

      if (bucket) {
        const storageFile = bucket.file(storagePath);
        await storageFile.save(processed, { metadata: { contentType: 'image/png' } });
      } else {
        // Local dev — save to output dir
        await fs.writeFile(path.join(outputDir, `${uuid}.png`), processed);
      }

      newPhotos.push({
        storagePath,
        filename: file.originalname,
        uploadedAt: new Date().toISOString(),
      });

      await fs.unlink(file.path).catch(() => {});
    }

    const allPhotos = [...existing, ...newPhotos];

    // Update brand doc
    if (db) {
      await db.collection('carousel_brands').doc(brandId).update({ facePhotos: allPhotos });
    } else {
      const brands = await readLocalBrands();
      brands[brandId].facePhotos = allPhotos;
      await writeLocalBrands(brands);
    }

    const withUrls = await getFacePhotoUrls(allPhotos);
    res.json({ ok: true, facePhotos: withUrls });
  } catch (error) {
    // Clean up temp files on error
    if (req.files) for (const f of req.files) await fs.unlink(f.path).catch(() => {});
    console.error('[Face Photo Upload]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// List face photos with fresh signed URLs
app.get('/api/brands/:id/face-photos', requireAuth, async (req, res) => {
  try {
    const brandId = req.params.id;
    const brand = await getBrandAsync(brandId, req.user.uid);
    if (!brand || brand.id === 'generic') return res.status(404).json({ error: 'Brand not found' });

    const withUrls = await getFacePhotoUrls(brand.facePhotos || []);
    res.json({ facePhotos: withUrls });
  } catch (error) {
    console.error('[Face Photo List]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// Delete a face photo by index
app.delete('/api/brands/:id/face-photos/:photoIndex', requireAuth, async (req, res) => {
  try {
    const brandId = req.params.id;
    const photoIndex = parseInt(req.params.photoIndex);

    let brand;
    if (db) {
      const doc = await db.collection('carousel_brands').doc(brandId).get();
      if (!doc.exists) return res.status(404).json({ error: 'Brand not found' });
      if (doc.data().createdBy !== req.user.uid) return res.status(403).json({ error: 'Not your brand' });
      brand = { id: brandId, ...doc.data() };
    } else {
      const brands = await readLocalBrands();
      if (!brands[brandId]) return res.status(404).json({ error: 'Brand not found' });
      if (brands[brandId].createdBy !== req.user.uid) return res.status(403).json({ error: 'Not your brand' });
      brand = { id: brandId, ...brands[brandId] };
    }

    const photos = brand.facePhotos || [];
    if (photoIndex < 0 || photoIndex >= photos.length) return res.status(400).json({ error: 'Invalid photo index' });

    const removed = photos[photoIndex];

    // Delete from storage
    if (bucket) {
      try { await bucket.file(removed.storagePath).delete(); } catch (e) { console.warn('[Face Photo Delete] Storage:', e.message); }
    } else {
      await fs.unlink(path.join(outputDir, path.basename(removed.storagePath))).catch(() => {});
    }

    photos.splice(photoIndex, 1);

    if (db) {
      await db.collection('carousel_brands').doc(brandId).update({ facePhotos: photos });
    } else {
      const brands = await readLocalBrands();
      brands[brandId].facePhotos = photos;
      await writeLocalBrands(brands);
    }

    const withUrls = await getFacePhotoUrls(photos);
    res.json({ ok: true, facePhotos: withUrls });
  } catch (error) {
    console.error('[Face Photo Delete]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// API keys are now BYOK — stored in browser localStorage, sent via headers per request.
// No server-side key storage needed.

// --- Persons CRUD (user-level face photos) ---

// List user's persons
app.get('/api/persons', requireAuth, async (req, res) => {
  try {
    if (!db) return res.json({ persons: [] });
    const snap = await db.collection('carousel_persons').where('userId', '==', req.user.uid).orderBy('createdAt', 'desc').get();
    const persons = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      const photos = await getFacePhotoUrls(data.photos || []);
      persons.push({
        id: doc.id, name: data.name, photos, createdAt: data.createdAt, updatedAt: data.updatedAt,
        loraStatus: data.loraStatus || null, loraUrl: data.loraUrl || null,
        loraTrainedAt: data.loraTrainedAt || null, loraError: data.loraError || null,
        loraModel: data.loraModel || null, loraTriggerWord: data.loraTriggerWord || null,
      });
    }
    res.json({ persons });
  } catch (error) {
    console.error('[Persons List]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// Create person
app.post('/api/persons', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    // Max 10 persons per user
    const existing = await db.collection('carousel_persons').where('userId', '==', req.user.uid).get();
    if (existing.size >= 10) return res.status(400).json({ error: 'Maximum 10 persons allowed' });

    const doc = db.collection('carousel_persons').doc();
    const person = {
      name: name.trim(),
      userId: req.user.uid,
      photos: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await doc.set(person);
    res.json({ ok: true, person: { id: doc.id, name: person.name, photos: [] } });
  } catch (error) {
    console.error('[Persons Create]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// Rename person
app.put('/api/persons/:id', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const person = await getPersonById(req.params.id, req.user.uid);
    if (!person) return res.status(404).json({ error: 'Person not found' });

    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    await db.collection('carousel_persons').doc(req.params.id).update({
      name: name.trim(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('[Persons Update]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// Delete person + photos
app.delete('/api/persons/:id', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const person = await getPersonById(req.params.id, req.user.uid);
    if (!person) return res.status(404).json({ error: 'Person not found' });

    // Delete photos from storage
    if (bucket && person.photos?.length > 0) {
      for (const photo of person.photos) {
        try { await bucket.file(photo.storagePath).delete(); } catch (e) { /* ignore */ }
      }
    }

    await db.collection('carousel_persons').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (error) {
    console.error('[Persons Delete]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// Upload photos to person
app.post('/api/persons/:id/photos', requireAuth, upload.array('photos', 20), async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const person = await getPersonById(req.params.id, req.user.uid);
    if (!person) return res.status(404).json({ error: 'Person not found' });

    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No photos uploaded' });

    const existing = person.photos || [];
    if (existing.length + req.files.length > 20) {
      for (const f of req.files) await fs.unlink(f.path).catch(() => {});
      return res.status(400).json({ error: `Too many photos. You have ${existing.length}, max is 20.` });
    }

    const newPhotos = [];
    for (const file of req.files) {
      try {
        await validateImageFile(file);
      } catch {
        await fs.unlink(file.path).catch(() => {});
        continue;
      }

      const uuid = crypto.randomUUID().slice(0, 12);
      const storagePath = `users/${req.user.uid}/persons/${req.params.id}/photos/${uuid}.png`;

      const processed = await sharp(file.path)
        .resize(1024, 1024, { fit: 'cover' })
        .png()
        .toBuffer();

      if (bucket) {
        const storageFile = bucket.file(storagePath);
        await storageFile.save(processed, { metadata: { contentType: 'image/png' } });
      } else {
        await fs.writeFile(path.join(outputDir, `${uuid}.png`), processed);
      }

      newPhotos.push({
        storagePath,
        filename: file.originalname,
        uploadedAt: new Date().toISOString(),
      });

      await fs.unlink(file.path).catch(() => {});
    }

    const allPhotos = [...existing, ...newPhotos];
    await db.collection('carousel_persons').doc(req.params.id).update({
      photos: allPhotos,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const withUrls = await getFacePhotoUrls(allPhotos);
    res.json({ ok: true, photos: withUrls });
  } catch (error) {
    if (req.files) for (const f of req.files) await fs.unlink(f.path).catch(() => {});
    console.error('[Person Photo Upload]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// Delete single photo from person
app.delete('/api/persons/:id/photos/:idx', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const person = await getPersonById(req.params.id, req.user.uid);
    if (!person) return res.status(404).json({ error: 'Person not found' });

    const photoIndex = parseInt(req.params.idx);
    const photos = person.photos || [];
    if (photoIndex < 0 || photoIndex >= photos.length) return res.status(400).json({ error: 'Invalid photo index' });

    const removed = photos[photoIndex];
    if (bucket) {
      try { await bucket.file(removed.storagePath).delete(); } catch (e) { console.warn('[Person Photo Delete]', e.message); }
    } else {
      await fs.unlink(path.join(outputDir, path.basename(removed.storagePath))).catch(() => {});
    }

    photos.splice(photoIndex, 1);
    await db.collection('carousel_persons').doc(req.params.id).update({
      photos,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const withUrls = await getFacePhotoUrls(photos);
    res.json({ ok: true, photos: withUrls });
  } catch (error) {
    console.error('[Person Photo Delete]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// --- LoRA Training ---

// Train LoRA model for a person
app.post('/api/persons/:id/train-lora', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const falKey = req.headers['x-fal-key'];
    if (!falKey) return res.status(400).json({ error: 'Fal.ai API key required for LoRA training. Add it in Settings.' });

    const person = await getPersonById(req.params.id, req.user.uid);
    if (!person) return res.status(404).json({ error: 'Person not found' });

    if (person.loraStatus === 'queued' || person.loraStatus === 'training') {
      return res.status(400).json({ error: 'Training already in progress' });
    }

    const photos = person.photos || [];
    if (photos.length < 4) {
      return res.status(400).json({ error: `Need at least 4 photos for LoRA training. You have ${photos.length}.` });
    }

    const { model } = req.body || {};
    const trainerModel = ['flux-2', 'portrait', 'fast'].includes(model) ? model : 'flux-2';

    // Download person photos to temp
    const tmpPaths = await downloadPersonPhotosToTemp(person);

    try {
      // Create zip from photos
      const zipPath = path.join(uploadsDir, `lora_${req.params.id}_${Date.now()}.zip`);
      await new Promise((resolve, reject) => {
        const output = createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        for (let i = 0; i < tmpPaths.length; i++) {
          archive.file(tmpPaths[i], { name: `photo_${i + 1}.png` });
        }
        archive.finalize();
      });

      // Upload zip to Firebase Storage
      const zipStoragePath = `users/${req.user.uid}/persons/${req.params.id}/training/photos.zip`;
      let zipUrl;
      if (bucket) {
        const zipBuffer = await fs.readFile(zipPath);
        const storageFile = bucket.file(zipStoragePath);
        await storageFile.save(zipBuffer, { metadata: { contentType: 'application/zip' } });
        await storageFile.makePublic();
        zipUrl = `https://storage.googleapis.com/${bucket.name}/${zipStoragePath}`;
      } else {
        return res.status(503).json({ error: 'Firebase Storage required for LoRA training' });
      }

      // Generate trigger word
      const triggerWord = `PERSON_${crypto.randomUUID().slice(0, 6)}`;

      // Build training request based on model
      const trainerEndpoints = {
        'flux-2': 'fal-ai/flux-2-trainer',
        'portrait': 'fal-ai/flux-lora-portrait-trainer',
        'fast': 'fal-ai/flux-lora-fast-training',
      };
      const endpoint = trainerEndpoints[trainerModel];

      let trainingInput = { images_data_url: zipUrl };
      if (trainerModel === 'flux-2') {
        trainingInput.trigger_word = triggerWord;
        trainingInput.steps = 1000;
        trainingInput.learning_rate = 0.00005;
      } else if (trainerModel === 'portrait') {
        trainingInput.trigger_word = triggerWord;
        trainingInput.steps = 2500;
        trainingInput.learning_rate = 0.00009;
        trainingInput.subject_crop = true;
      } else if (trainerModel === 'fast') {
        trainingInput.trigger_word = triggerWord;
        trainingInput.steps = 1000;
        trainingInput.is_style = false;
        trainingInput.create_masks = true;
      }

      // Submit to fal.ai queue
      const submitRes = await fetch(`https://queue.fal.run/${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(trainingInput),
      });

      if (!submitRes.ok) {
        const errText = await submitRes.text();
        throw new Error(`fal.ai training submit error (${submitRes.status}): ${errText}`);
      }

      const submitData = await submitRes.json();
      const { request_id, status_url, response_url } = submitData;
      if (!request_id) throw new Error('fal.ai did not return a request_id');

      // Store training state in Firestore
      await db.collection('carousel_persons').doc(req.params.id).update({
        loraStatus: 'queued',
        loraModel: trainerModel,
        loraTriggerWord: triggerWord,
        loraRequestId: request_id,
        loraStatusUrl: status_url,
        loraResponseUrl: response_url,
        loraError: null,
        loraUrl: null,
        loraConfigUrl: null,
        loraTrainedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`[LoRA Train] Person "${person.name}" | model=${trainerModel} | request_id=${request_id}`);

      // Cleanup
      await fs.unlink(zipPath).catch(() => {});
      await cleanupTempFiles(tmpPaths);

      res.json({ ok: true, status: 'queued', requestId: request_id });
    } catch (err) {
      await cleanupTempFiles(tmpPaths);
      throw err;
    }
  } catch (error) {
    console.error('[LoRA Train]', error);
    res.status(500).json({ error: safeErrorMessage(error, 'LoRA training failed') });
  }
});

// Poll LoRA training status
app.get('/api/persons/:id/lora-status', requireAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const falKey = req.headers['x-fal-key'];

    const person = await getPersonById(req.params.id, req.user.uid);
    if (!person) return res.status(404).json({ error: 'Person not found' });

    // If already terminal state, return cached
    if (!person.loraStatus || person.loraStatus === 'ready' || person.loraStatus === 'failed') {
      return res.json({
        status: person.loraStatus || null,
        loraUrl: person.loraUrl || null,
        loraModel: person.loraModel || null,
        loraError: person.loraError || null,
        loraTrainedAt: person.loraTrainedAt || null,
      });
    }

    // Poll fal.ai for current status
    if (!person.loraStatusUrl || !falKey) {
      return res.json({ status: person.loraStatus, loraModel: person.loraModel });
    }

    const statusRes = await fetch(person.loraStatusUrl, {
      headers: { 'Authorization': `Key ${falKey}` },
    });

    if (!statusRes.ok) {
      return res.json({ status: person.loraStatus, loraModel: person.loraModel });
    }

    const statusData = await statusRes.json();

    if (statusData.status === 'COMPLETED') {
      // Fetch the result
      const resultRes = await fetch(person.loraResponseUrl, {
        headers: { 'Authorization': `Key ${falKey}` },
      });
      if (!resultRes.ok) throw new Error('Failed to fetch training result');
      const result = await resultRes.json();

      const loraUrl = result.diffusers_lora_file?.url;
      const loraConfigUrl = result.config_file?.url;

      if (!loraUrl) throw new Error('No LoRA weights URL in training result');

      await db.collection('carousel_persons').doc(req.params.id).update({
        loraStatus: 'ready',
        loraUrl,
        loraConfigUrl: loraConfigUrl || null,
        loraTrainedAt: admin.firestore.FieldValue.serverTimestamp(),
        loraRequestId: null,
        loraStatusUrl: null,
        loraResponseUrl: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`[LoRA Train] Person "${person.name}" training complete — ${loraUrl}`);
      return res.json({ status: 'ready', loraUrl, loraModel: person.loraModel, loraTrainedAt: new Date().toISOString() });
    }

    if (statusData.status === 'FAILED') {
      const errorMsg = statusData.error || 'Training failed';
      await db.collection('carousel_persons').doc(req.params.id).update({
        loraStatus: 'failed',
        loraError: errorMsg,
        loraRequestId: null,
        loraStatusUrl: null,
        loraResponseUrl: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.error(`[LoRA Train] Person "${person.name}" training failed:`, errorMsg);
      return res.json({ status: 'failed', loraError: errorMsg, loraModel: person.loraModel });
    }

    // Still in progress
    const newStatus = statusData.status === 'IN_PROGRESS' ? 'training' : 'queued';
    if (newStatus !== person.loraStatus) {
      await db.collection('carousel_persons').doc(req.params.id).update({ loraStatus: newStatus });
    }
    return res.json({ status: newStatus, loraModel: person.loraModel });
  } catch (error) {
    console.error('[LoRA Status]', error);
    res.status(500).json({ error: safeErrorMessage(error) });
  }
});

// Return 204 for missing brand icons (avoids noisy 404 in console)
app.get('/brands/:brandId/assets/app-icon.png', async (req, res, next) => {
  const iconPath = path.join(rootDir, 'brands', req.params.brandId, 'assets', 'app-icon.png');
  try {
    await fs.access(iconPath);
    next(); // file exists, let express.static serve it
  } catch {
    res.status(204).end();
  }
});

// Serve brand assets
app.use('/brands', express.static(path.join(rootDir, 'brands')));

// --- Image Vault API ---

// List user's images with fresh signed URLs
app.get('/api/images', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;

    // Local dev fallback — list files from outputDir (no Firestore or no Storage bucket)
    if (!db || !bucket) {
      const files = await fs.readdir(outputDir).catch(() => []);
      const pngs = files.filter(f => f.endsWith('.png')).sort().reverse();
      const images = pngs.slice(0, 50).map(f => ({
        id: f,
        filename: f,
        url: `/output/${f}`,
        type: f.startsWith('meme_') ? 'meme' : f.startsWith('edit_') ? 'edit' : f.startsWith('personalized_') ? 'personalized' : f.startsWith('carousel_') ? 'carousel' : 'slide',
        createdAt: null,
      }));
      return res.json({ images, hasMore: false, nextCursor: null });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    let query = db.collection('generated_images')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(limit + 1);

    if (req.query.brand) {
      query = db.collection('generated_images')
        .where('userId', '==', userId)
        .where('brandId', '==', req.query.brand)
        .orderBy('createdAt', 'desc')
        .limit(limit + 1);
    }

    if (req.query.startAfter) {
      const cursorDoc = await db.collection('generated_images').doc(req.query.startAfter).get();
      if (cursorDoc.exists) {
        query = query.startAfter(cursorDoc);
      }
    }

    const snapshot = await query.get();
    const docs = snapshot.docs.slice(0, limit);
    const hasMore = snapshot.docs.length > limit;

    // Generate fresh signed URLs in parallel
    const images = await Promise.all(docs.map(async (doc) => {
      const data = doc.data();
      try {
        const file = bucket.file(data.storagePath);
        const [exists] = await file.exists();
        if (!exists) return null;
        const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 2 * 60 * 60 * 1000 });
        return {
          id: doc.id,
          filename: data.filename,
          url,
          brandId: data.brandId,
          type: data.type,
          createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        };
      } catch {
        return null;
      }
    }));

    const filtered = images.filter(Boolean);
    res.json({
      images: filtered,
      hasMore,
      nextCursor: hasMore && docs.length > 0 ? docs[docs.length - 1].id : null,
    });
  } catch (err) {
    console.error('[Images List]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Count user's images (single Firestore read)
app.get('/api/images/count', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;

    if (!db) {
      const files = await fs.readdir(outputDir).catch(() => []);
      return res.json({ count: files.filter(f => f.endsWith('.png')).length });
    }

    const snapshot = await db.collection('generated_images')
      .where('userId', '==', userId)
      .count()
      .get();
    res.json({ count: snapshot.data().count });
  } catch (err) {
    console.error('[Images Count]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Delete an image from vault
app.delete('/api/images/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const docId = req.params.id;

    if (!db) {
      // Local dev fallback — delete file from outputDir
      const filepath = path.join(outputDir, path.basename(docId));
      await fs.unlink(filepath).catch(() => {});
      return res.json({ ok: true });
    }

    const docRef = db.collection('generated_images').doc(docId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Image not found' });
    if (doc.data().userId !== userId) return res.status(403).json({ error: 'Not authorized' });

    // Delete from Storage
    const storagePath = doc.data().storagePath;
    if (storagePath && bucket) {
      try {
        await bucket.file(storagePath).delete();
      } catch { /* file may already be deleted */ }
    }

    // Delete Firestore record
    await docRef.delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('[Images Delete]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Migrate old localStorage vault entries to Firestore
app.post('/api/images/migrate', requireAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { filenames } = req.body || {};

    if (!db || !bucket) return res.json({ migrated: 0 });
    if (!Array.isArray(filenames) || filenames.length === 0) return res.json({ migrated: 0 });

    // Cap at 200 items
    const toMigrate = filenames.slice(0, 200);
    let migrated = 0;

    for (const filename of toMigrate) {
      const sanitized = path.basename(filename);
      const storagePath = `carousel-studio/${sanitized}`;

      // Check if file exists in Storage
      try {
        const [exists] = await bucket.file(storagePath).exists();
        if (!exists) continue;
      } catch { continue; }

      // Check if record already exists
      const existing = await db.collection('generated_images')
        .where('userId', '==', userId)
        .where('filename', '==', sanitized)
        .limit(1)
        .get();
      if (!existing.empty) continue;

      // Infer type from filename
      let type = 'slide';
      if (sanitized.startsWith('meme_')) type = 'meme';
      else if (sanitized.startsWith('edit_')) type = 'edit';
      else if (sanitized.startsWith('personalized_')) type = 'personalized';
      else if (sanitized.startsWith('carousel_')) type = 'carousel';

      // Extract brandId from filename (pattern: type_brandId_...)
      const parts = sanitized.split('_');
      const brandId = parts.length >= 2 ? parts[1] : null;

      await db.collection('generated_images').doc().set({
        userId,
        brandId,
        filename: sanitized,
        storagePath,
        type,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      migrated++;
    }

    res.json({ migrated });
  } catch (err) {
    console.error('[Images Migrate]', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Download single image
app.get('/api/download/:filename', requireAuth, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filepath = path.join(outputDir, filename);

    // Try local disk first
    try {
      await fs.access(filepath);
      return res.download(filepath, filename);
    } catch {
      // Not on local disk — try Firebase Storage
    }

    if (!bucket) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = bucket.file(`carousel-studio/${filename}`);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: 'File not found' });
    }

    const [buffer] = await file.download();
    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === '.mp4' ? 'video/mp4' : 'image/png';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[Download]', err.message);
    res.status(404).json({ error: 'File not found' });
  }
});

// Download all carousel images as zip
app.get('/api/download-carousel/:jobId', requireAuth, async (req, res) => {
  const job = carouselJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const successSlides = job.slides.filter((s) => s.ok && s.filename);
  if (successSlides.length === 0) {
    return res.status(404).json({ error: 'No generated slides found' });
  }

  const zipName = `${job.brandId || 'brand'}_carousel_${job.id}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.pipe(res);

  for (const slide of successSlides) {
    const fn = slide.filename;
    const filepath = path.join(outputDir, fn);
    const ext = slide.isVideo ? '.mp4' : '.png';
    const archiveName = `slide_${slide.slideNumber}${ext}`;
    try {
      await fs.access(filepath);
      archive.file(filepath, { name: archiveName });
    } catch {
      // Not on local disk — try Firebase Storage
      if (bucket) {
        try {
          const [buffer] = await bucket.file(`carousel-studio/${fn}`).download();
          archive.append(buffer, { name: archiveName });
        } catch {
          // skip missing files
        }
      }
    }
  }

  await archive.finalize();
});

// Download selected images as zip
app.post('/api/download-selected', requireAuth, async (req, res) => {
  const { filenames, brandId } = req.body || {};
  if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
    return res.status(400).json({ error: 'No filenames provided' });
  }

  const zipName = `${brandId || 'brand'}_slides_${Date.now()}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.pipe(res);

  for (let i = 0; i < filenames.length; i++) {
    const fn = path.basename(filenames[i]);
    const filepath = path.join(outputDir, fn);
    const ext = fn.endsWith('.mp4') ? '.mp4' : '.png';
    const archiveName = `slide_${i + 1}${ext}`;
    try {
      await fs.access(filepath);
      archive.file(filepath, { name: archiveName });
    } catch {
      // Not on local disk — try Firebase Storage
      if (bucket) {
        try {
          const [buffer] = await bucket.file(`carousel-studio/${fn}`).download();
          archive.append(buffer, { name: archiveName });
        } catch {
          // skip missing files
        }
      }
    }
  }

  await archive.finalize();
});

// --- Background Image Library ---

const backgroundJobs = new Map();

app.post('/api/backgrounds/generate-topics', requireAuth, async (req, res) => {
  const { brandId } = req.body || {};
  if (!brandId) return res.status(400).json({ error: 'Missing brandId' });

  const brand = await getBrandAsync(brandId, req.user?.uid);

  // Fetch website for product context (best-effort, don't fail if unavailable)
  let productContext = '';
  if (brand.website) {
    try {
      let url = brand.website.trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      if (!isUrlSafe(url)) throw new Error('URL not allowed');
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CarouselStudio/1.0)' },
        redirect: 'follow',
      });
      const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
      if (contentLength > 1024 * 1024) throw new Error('Response too large');
      const html = await resp.text();
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
      const metaDescMatch = html.match(/<meta[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i)
        || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i);
      const metaDesc = metaDescMatch ? metaDescMatch[1].trim() : '';
      // Extract visible text (strip tags, collapse whitespace)
      const visibleText = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      const parts = [pageTitle, metaDesc, visibleText].filter(Boolean);
      if (parts.length) productContext = parts.join(' | ');
    } catch {
      // Website fetch failed — proceed without context
    }
  }

  try {
    const rawText = await generateText({
      model: req.body?.textModel,
      maxTokens: 1024,
      messages: [{
        role: 'user',
        content: `You are generating Pinterest search queries for finding carousel slide background images.

Brand: ${brand.name}
Website: ${brand.website || 'N/A'}${productContext ? `\nProduct context: ${productContext}` : ''}
Colors: ${JSON.stringify(brand.colors)}
Brand brief: ${brand.systemPrompt || 'General brand'}

Based on the brand's product, industry, and target audience, generate 12 Pinterest search queries that would find great background images for TikTok/Instagram carousel slides.

Guidelines:
- 7-8 queries should be directly relevant to the product's domain, industry, and users (e.g. for a cooking app: "kitchen cinematic dark photography", "chef close up moody", "fresh ingredients overhead")
- 4-5 queries for aesthetic/mood backgrounds that match the brand's color palette and vibe
- Use specific, descriptive terms — avoid generic queries like "cool background", "abstract texture", or "gradient wallpaper"
- Include tone words like "dark", "moody", "cinematic", "dramatic" that match the brand colors
- Each query should be 4-7 words for best Pinterest results

Return ONLY a JSON array of 12 strings, no other text.`
      }],
      req,
    });

    const text = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const topics = JSON.parse(text);
    res.json({ topics });
  } catch (err) {
    console.error('[Generate Topics]', err);
    res.status(500).json({ error: safeErrorMessage(err, 'Failed to generate topics') });
  }
});

app.post('/api/backgrounds/download', requireAuth, async (req, res) => {
  const { brandId, topics } = req.body || {};
  if (!brandId) return res.status(400).json({ error: 'Missing brandId' });
  if (!topics || !Array.isArray(topics) || topics.length === 0) return res.status(400).json({ error: 'Missing topics array' });

  if (!galleryDlAvailable) return res.status(501).json({ error: 'gallery-dl not available. Install: brew install gallery-dl' });
  if (isVercel) return res.status(501).json({ error: 'Background download not available in production' });

  const brand = await getBrandAsync(brandId, req.user?.uid);
  const jobId = crypto.randomUUID().slice(0, 12);
  const job = {
    id: jobId,
    brandId: brand.id,
    total: topics.length,
    completed: 0,
    currentTopic: null,
    status: 'running',
    results: {},
  };
  backgroundJobs.set(jobId, job);

  res.json({ jobId, total: topics.length });

  (async () => {
    const brandDir = path.join(backgroundsDir, brand.id);
    await fs.mkdir(brandDir, { recursive: true });

    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      const topicSlug = slugify(topic);
      job.currentTopic = topic;

      const topicDir = path.join(brandDir, topicSlug);
      await fs.mkdir(topicDir, { recursive: true });

      const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(topic)}`;

      try {
        await new Promise((resolve, reject) => {
          const proc = spawn('gallery-dl', [
            '--range', '1-25',
            '--directory', topicDir,
            '--filename', '{num:>03}.{extension}',
            searchUrl,
          ]);

          let stderr = '';
          proc.stderr.on('data', d => stderr += d.toString());
          proc.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`gallery-dl exited ${code}: ${stderr.slice(0, 200)}`));
          });
          proc.on('error', reject);
        });

        // Count downloaded files
        const files = await fs.readdir(topicDir).catch(() => []);
        job.results[topicSlug] = files.length;
      } catch (err) {
        console.error(`[BG Download] Topic "${topic}" failed:`, err.message);
        job.results[topicSlug] = 0;
      }

      job.completed = i + 1;
    }

    job.status = 'done';
    job.currentTopic = null;
    setTimeout(() => backgroundJobs.delete(jobId), 30 * 60 * 1000);
  })();
});

app.get('/api/backgrounds/download-status/:jobId', requireAuth, (req, res) => {
  const job = backgroundJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    jobId: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    currentTopic: job.currentTopic,
    results: job.results,
  });
});

app.get('/api/backgrounds', requireAuth, async (req, res) => {
  const brandId = req.query.brand;
  if (!brandId) return res.status(400).json({ error: 'Missing brand query param' });

  const brand = await getBrandAsync(brandId, req.user?.uid);
  const brandDir = path.join(backgroundsDir, brand.id);

  try {
    const subdirs = await fs.readdir(brandDir, { withFileTypes: true });
    const categories = {};
    let totalImages = 0;

    for (const entry of subdirs) {
      if (!entry.isDirectory()) continue;
      const catDir = path.join(brandDir, entry.name);
      const files = await fs.readdir(catDir);
      const images = files
        .filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f))
        .map(f => `/backgrounds/${brand.id}/${entry.name}/${f}`);

      if (images.length > 0) {
        categories[entry.name] = { images, count: images.length };
        totalImages += images.length;
      }
    }

    res.json({ categories, totalImages });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ categories: {}, totalImages: 0 });
    console.error('[List Backgrounds]', err);
    res.status(500).json({ error: 'Failed to list backgrounds' });
  }
});

app.post('/api/backgrounds/select', requireAuth, async (req, res) => {
  const { backgroundPath } = req.body || {};
  if (!backgroundPath) return res.status(400).json({ error: 'Missing backgroundPath' });

  // Resolve the actual file on disk from the URL path
  const relativePath = backgroundPath.replace(/^\/backgrounds\//, '');
  const sourcePath = path.resolve(backgroundsDir, relativePath);
  if (!sourcePath.startsWith(backgroundsDir)) return res.status(400).json({ error: 'Invalid path' });

  try {
    await fs.access(sourcePath);
  } catch {
    return res.status(404).json({ error: 'Background image not found' });
  }

  const ext = path.extname(sourcePath);
  const filename = `ref_${crypto.randomUUID().slice(0, 8)}${ext}`;
  const destPath = path.join(uploadsDir, filename);

  await fs.copyFile(sourcePath, destPath);
  res.json({ ok: true, filename, url: `/uploads/${filename}` });
});

app.delete('/api/backgrounds/:brandId/:category/:filename', requireAuth, async (req, res) => {
  const { brandId, category, filename } = req.params;
  const brand = await getBrandAsync(brandId, req.user?.uid);
  if (brand.id === 'generic') return res.status(403).json({ error: 'Cannot delete generic brand backgrounds' });

  // Sanitize path components to prevent traversal
  const safeCat = path.basename(category);
  const safeFile = path.basename(filename);
  const filePath = path.join(backgroundsDir, brand.id, safeCat, safeFile);

  try {
    await fs.unlink(filePath);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    console.error('[Delete Background]', err);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// --- TikTok Integration (BYOK — users provide their own TikTok Developer App credentials) ---

function getTikTokKeys(req) {
  const clientKey = req.headers['x-tiktok-client-key'];
  const clientSecret = req.headers['x-tiktok-client-secret'];
  if (clientKey && clientSecret) return { clientKey, clientSecret };
  return null;
}

// Cache TikTok keys during OAuth flow (callback has no auth headers)
const tiktokOAuthPending = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of tiktokOAuthPending) {
    if (now - entry.createdAt > 10 * 60 * 1000) tiktokOAuthPending.delete(state);
  }
}, 5 * 60 * 1000);

function getTikTokRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/tiktok/callback`;
}

async function getTikTokTokens(userId) {
  if (!db) return null;
  const doc = await db.collection('tiktok_tokens').doc(userId).get();
  return doc.exists ? doc.data() : null;
}

async function saveTikTokTokens(userId, tokens) {
  if (!db) return;
  await db.collection('tiktok_tokens').doc(userId).set(tokens, { merge: true });
}

async function deleteTikTokTokens(userId) {
  if (!db) return;
  await db.collection('tiktok_tokens').doc(userId).delete();
}

async function refreshTikTokToken(userId, clientKey, clientSecret) {
  const tokens = await getTikTokTokens(userId);
  if (!tokens?.refresh_token) throw new Error('No refresh token available');

  const resp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });

  const data = await resp.json();
  if (data.error || !data.access_token) {
    throw new Error(data.error_description || 'Token refresh failed');
  }

  const updated = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    open_id: data.open_id || tokens.open_id,
    expires_at: Date.now() + (data.expires_in * 1000),
  };
  await saveTikTokTokens(userId, updated);
  return updated;
}

async function getValidTikTokToken(userId, clientKey, clientSecret) {
  let tokens = await getTikTokTokens(userId);
  if (!tokens) throw new Error('TikTok not connected');

  // Refresh if expired or expiring within 5 minutes
  if (tokens.expires_at && tokens.expires_at < Date.now() + 300000) {
    console.log('[TikTok] Token expired, refreshing...');
    tokens = await refreshTikTokToken(userId, clientKey, clientSecret);
  }

  return tokens;
}

// OAuth: Redirect to TikTok authorization
app.get('/api/tiktok/auth', requireAuth, (req, res) => {
  const keys = getTikTokKeys(req);
  if (!keys) return res.status(400).json({ error: 'TikTok Client Key and Secret required. Add them in Settings.' });

  const csrfState = crypto.randomUUID();
  const redirectUri = getTikTokRedirectUri(req);

  // Cache keys for the callback (which arrives as a redirect with no headers)
  tiktokOAuthPending.set(csrfState, {
    clientKey: keys.clientKey,
    clientSecret: keys.clientSecret,
    userId: req.user?.uid,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    client_key: keys.clientKey,
    scope: 'user.info.basic,video.publish',
    response_type: 'code',
    redirect_uri: redirectUri,
    state: csrfState,
  });

  res.json({ url: `https://www.tiktok.com/v2/auth/authorize/?${params}` });
});

// OAuth: Callback — exchange code for token
app.get('/api/tiktok/callback', async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const postMessageOrigin = process.env.FRONTEND_URL || `${proto}://${host}`;

  const { code, state, error, error_description } = req.query;
  if (error) {
    if (state) tiktokOAuthPending.delete(state);
    return res.send(`<script>window.opener?.postMessage(${JSON.stringify({type:'tiktok-error',error: error_description || error})},${JSON.stringify(postMessageOrigin)});window.close();</script>`);
  }
  if (!code || !state) {
    return res.send(`<script>window.opener?.postMessage(${JSON.stringify({type:'tiktok-error',error:'No authorization code'})},${JSON.stringify(postMessageOrigin)});window.close();</script>`);
  }

  const pending = tiktokOAuthPending.get(state);
  if (!pending) {
    return res.send(`<script>window.opener?.postMessage(${JSON.stringify({type:'tiktok-error',error:'OAuth session expired. Please try again.'})},${JSON.stringify(postMessageOrigin)});window.close();</script>`);
  }
  tiktokOAuthPending.delete(state);

  try {
    const redirectUri = getTikTokRedirectUri(req);
    const tokenResp = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: pending.clientKey,
        client_secret: pending.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResp.json();
    if (tokenData.error || !tokenData.access_token) {
      throw new Error(tokenData.error_description || 'Token exchange failed');
    }

    // Fetch TikTok user info
    let tiktokUsername = '';
    try {
      const userResp = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=display_name,username', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userResp.json();
      tiktokUsername = userData.data?.user?.display_name || userData.data?.user?.username || '';
    } catch { /* ignore — username is optional */ }

    // Return HTML that posts message to opener with token data for storage
    const successPayload = {
      type: 'tiktok-success',
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      open_id: tokenData.open_id,
      expires_in: tokenData.expires_in,
      username: tiktokUsername,
    };
    res.send(`<script>window.opener?.postMessage(${JSON.stringify(successPayload)},${JSON.stringify(postMessageOrigin)});window.close();</script>`);
  } catch (err) {
    console.error('[TikTok] Callback error:', err);
    res.send(`<script>window.opener?.postMessage(${JSON.stringify({type:'tiktok-error',error:err.message})},${JSON.stringify(postMessageOrigin)});window.close();</script>`);
  }
});

// Save tokens from frontend (after popup callback)
app.post('/api/tiktok/save-tokens', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.uid;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { access_token, refresh_token, open_id, expires_in, username } = req.body;
    if (!access_token) return res.status(400).json({ error: 'Missing access_token' });

    await saveTikTokTokens(userId, {
      access_token,
      refresh_token,
      open_id,
      expires_at: Date.now() + (expires_in * 1000),
      tiktok_username: username || '',
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[TikTok] Save tokens error:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Account status
app.get('/api/tiktok/status', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.uid;
    const keys = getTikTokKeys(req);
    if (!userId) return res.json({ connected: false, enabled: !!keys });

    if (!keys) return res.json({ connected: false, enabled: false });

    const tokens = await getTikTokTokens(userId);
    if (!tokens?.access_token) return res.json({ connected: false, enabled: true });

    // Try to get fresh user info
    let username = tokens.tiktok_username || '';
    try {
      const validTokens = await getValidTikTokToken(userId, keys.clientKey, keys.clientSecret);
      const userResp = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=display_name,username', {
        headers: { Authorization: `Bearer ${validTokens.access_token}` },
      });
      const userData = await userResp.json();
      username = userData.data?.user?.display_name || userData.data?.user?.username || username;

      if (username && username !== tokens.tiktok_username) {
        await saveTikTokTokens(userId, { tiktok_username: username });
      }
    } catch { /* use cached username */ }

    res.json({ connected: true, enabled: true, username });
  } catch (err) {
    console.error('[TikTok] Status error:', err);
    res.json({ connected: false, enabled: !!getTikTokKeys(req) });
  }
});

// Disconnect TikTok
app.post('/api/tiktok/disconnect', requireAuth, async (req, res) => {
  try {
    const userId = req.user?.uid;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    await deleteTikTokTokens(userId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[TikTok] Disconnect error:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Post carousel to TikTok
app.post('/api/tiktok/post', requireAuth, async (req, res) => {
  const keys = getTikTokKeys(req);
  if (!keys) return res.status(400).json({ error: 'TikTok Client Key and Secret required. Add them in Settings.' });

  try {
    const userId = req.user?.uid;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { imageUrls, caption, privacyLevel, autoAddMusic, disableComment, disableDuet, disableStitch, brandContentToggle, brandOrganicToggle } = req.body;

    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.status(400).json({ error: 'No images provided' });
    }
    if (imageUrls.length > 35) {
      return res.status(400).json({ error: 'TikTok supports max 35 images per photo post' });
    }

    const tokens = await getValidTikTokToken(userId, keys.clientKey, keys.clientSecret);

    // Convert PNG images to JPG
    console.log(`[TikTok] Converting ${imageUrls.length} images to JPG...`);
    const jpgBuffers = [];
    for (const url of imageUrls) {
      const imgRes = await fetch(url);
      if (!imgRes.ok) throw new Error(`Failed to fetch image: ${url}`);
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
      const jpgBuffer = await sharp(imgBuffer).jpeg({ quality: 95 }).toBuffer();
      jpgBuffers.push(jpgBuffer);
    }

    // Initialize photo post on TikTok
    console.log('[TikTok] Initializing photo post...');
    const postInfo = {
      title: caption || '',
      privacy_level: privacyLevel || 'SELF_ONLY',
      disable_comment: disableComment || false,
      disable_duet: disableDuet || false,
      disable_stitch: disableStitch || false,
      auto_add_music: autoAddMusic !== false,
    };

    if (brandContentToggle) postInfo.brand_content_toggle = true;
    if (brandOrganicToggle) postInfo.brand_organic_toggle = true;

    const publishResp = await fetch('https://open.tiktokapis.com/v2/post/publish/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: postInfo,
        source_info: {
          source: 'FILE_UPLOAD',
          photo_cover_index: 0,
          photo_images: jpgBuffers.map((_, i) => `image_${i}`),
        },
        media_type: 'PHOTO',
        post_mode: 'DIRECT_POST',
      }),
    });

    const publishData = await publishResp.json();
    console.log('[TikTok] Publish response:', JSON.stringify(publishData));

    if (publishData.error?.code) {
      throw new Error(publishData.error.message || `TikTok API error: ${publishData.error.code}`);
    }

    const publishId = publishData.data?.publish_id;
    const uploadUrl = publishData.data?.upload_url;

    if (!publishId) {
      throw new Error('No publish_id returned from TikTok');
    }

    // Upload images to TikTok
    if (uploadUrl) {
      console.log(`[TikTok] Uploading ${jpgBuffers.length} images...`);
      for (let i = 0; i < jpgBuffers.length; i++) {
        const uploadResp = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': 'image/jpeg',
            'Content-Range': `bytes 0-${jpgBuffers[i].length - 1}/${jpgBuffers[i].length}`,
          },
          body: jpgBuffers[i],
        });
        if (!uploadResp.ok) {
          console.error(`[TikTok] Image ${i + 1} upload failed:`, uploadResp.status);
        }
      }
    }

    // Save post record to Firestore
    if (db) {
      await db.collection('tiktok_posts').doc(publishId).set({
        userId,
        publishId,
        status: 'processing',
        slideCount: imageUrls.length,
        caption: caption || '',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json({ ok: true, publishId });
  } catch (err) {
    console.error('[TikTok] Post error:', err);
    res.status(500).json({ error: safeErrorMessage(err, 'Post failed') });
  }
});

// Poll post status
app.get('/api/tiktok/post-status/:publishId', requireAuth, async (req, res) => {
  const keys = getTikTokKeys(req);
  if (!keys) return res.status(400).json({ error: 'TikTok Client Key and Secret required. Add them in Settings.' });

  try {
    const userId = req.user?.uid;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const tokens = await getValidTikTokToken(userId, keys.clientKey, keys.clientSecret);

    const statusResp = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publish_id: req.params.publishId }),
    });

    const statusData = await statusResp.json();

    // Update Firestore record
    const status = statusData.data?.status;
    if (db && status) {
      await db.collection('tiktok_posts').doc(req.params.publishId).update({ status: status.toLowerCase() }).catch(() => {});
    }

    res.json({
      publishId: req.params.publishId,
      status: status || 'PROCESSING_UPLOAD',
      failReason: statusData.data?.fail_reason,
    });
  } catch (err) {
    console.error('[TikTok] Status check error:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});
// Start server (only when run directly, not on Vercel)
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`Carousel Studio running on http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
export default app;
