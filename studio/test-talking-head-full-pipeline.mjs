#!/usr/bin/env node
/**
 * Full Talking-Head Pipeline Test
 *
 * Tests the complete end-to-end talking-head video generation:
 * 1. Generate script using viral framework (~40-45 words for 15 seconds)
 * 2. Use existing avatar image
 * 3. Generate 15-second video with Kling 3.0 native-audio lip-sync (single API call)
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import sharp from 'sharp';
import crypto from 'crypto';

const AVATAR_PATH = '/tmp/athlete-mindset-avatar-preview.png';

// --- Helper: Generate text with Claude ---
async function generateScript(topic, brandName = 'Athlete Mindset', targetWords = 35) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemMsg = `You write scripts for talking-head social media videos for ${brandName}.

HOOK (first 1-2 sentences):
- Must land in under 3 seconds spoken
- Use one of: bold/controversial statement, surprising number, myth-bust ("You've been doing X wrong"), direct call-out ("If you're still doing X..."), or results-first proof
- Never start with greetings ("Hey guys"), yes/no questions, or generic intros
- Hook must connect directly to the content — no random shock

STRUCTURE — pick one per script:
- PAS (Problem → Agitate → Solve) — for pain-point products
- Bold Claim → Education → Payoff — for "did you know" / myth-busting
- Before/After → Bridge — for transformation/results content

PACING & LANGUAGE:
- Short sentences: 5-12 words each, 6th-grade reading level
- Concrete numbers beat vague claims ("4ms accuracy" not "incredibly precise")
- Vary cadence: fast-fast-fast then pause before key reveals
- One main point per script — not three, not five, one
- ~${targetWords} words for ~12-13 seconds at natural speaking pace (keeps video under 15 seconds)

ENDING:
- End on strongest value statement or surprise
- No generic CTAs ("follow for more") — the content itself should make them follow
- "It's free" / specific price / specific result = strongest closers

AVOID:
- No filler ("kind of", "pretty much", "actually")
- No stage directions, formatting, or emojis
- No "pick me" energy — assume the viewer already respects you
- Don't pitch — educate. The product is the natural answer to the problem
- Don't sound like an ad — sound like someone sharing something they discovered

Return ONLY the script text.`;

  const userMsg = `Write a talking-head video script for ${brandName} about: ${topic}`;

  console.log('\n🎬 Generating script with viral framework...');
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: systemMsg,
    messages: [{ role: 'user', content: userMsg }],
  });

  const script = response.content[0].text.trim();
  const wordCount = script.split(/\s+/).length;
  console.log(`✅ Script generated (${wordCount} words)\n`);
  console.log('--- SCRIPT ---');
  console.log(script);
  console.log('--- END SCRIPT ---\n');

  return script;
}

// --- Helper: Upload image to fal.ai storage ---
async function uploadImageToFal(imageBuffer, filename) {
  const FAL_KEY = process.env.FAL_API_KEY;
  if (!FAL_KEY) throw new Error('FAL_API_KEY not set');

  console.log('📤 Uploading avatar to fal.ai storage...');
  const formData = new FormData();
  formData.append('file', new Blob([imageBuffer]), filename);

  const uploadRes = await fetch('https://fal.run/storage/upload', {
    method: 'POST',
    headers: { 'Authorization': `Key ${FAL_KEY}` },
    body: formData,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`fal.ai upload failed (${uploadRes.status}): ${errText}`);
  }

  const { url } = await uploadRes.json();
  console.log(`✅ Avatar uploaded: ${url.slice(0, 60)}...\n`);
  return url;
}

// --- Helper: Poll fal.ai job ---
async function pollFalJob(statusUrl, responseUrl, falKey, modelName) {
  console.log(`⏳ Polling ${modelName} job (max 10 minutes)...`);
  let consecutiveErrors = 0;
  const deadline = Date.now() + 600_000; // 10 minutes

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000)); // Poll every 5 seconds

    let statusRes;
    try {
      statusRes = await fetch(statusUrl, {
        headers: { 'Authorization': `Key ${falKey}` },
      });
    } catch (fetchErr) {
      consecutiveErrors++;
      console.warn(`[Poll] Fetch error (${consecutiveErrors}): ${fetchErr.message}`);
      if (consecutiveErrors >= 5) throw new Error(`Polling failed after ${consecutiveErrors} consecutive network errors`);
      continue;
    }

    if (!statusRes.ok) {
      consecutiveErrors++;
      const errText = await statusRes.text().catch(() => '');
      console.warn(`[Poll] Status ${statusRes.status} (${consecutiveErrors}): ${errText.slice(0, 200)}`);
      if (consecutiveErrors >= 5) throw new Error(`Polling returned ${statusRes.status} ${consecutiveErrors} times`);
      continue;
    }

    consecutiveErrors = 0;
    const status = await statusRes.json();
    console.log(`[Poll] Status: ${status.status}, Queue position: ${status.queue_position ?? 'n/a'}`);

    if (status.status === 'COMPLETED') {
      const result = status.response || await (async () => {
        const resultRes = await fetch(responseUrl, {
          headers: { 'Authorization': `Key ${falKey}` },
        });
        if (!resultRes.ok) throw new Error(`Result fetch failed (${resultRes.status})`);
        return resultRes.json();
      })();

      const videoUrl = result.video?.url;
      if (!videoUrl) throw new Error('API returned success but no video URL');
      console.log(`✅ Video generated: ${videoUrl.slice(0, 60)}...\n`);
      return videoUrl;
    }

    if (status.status === 'FAILED') {
      throw new Error(`Video generation failed: ${status.error || JSON.stringify(status).slice(0, 300)}`);
    }
  }

  throw new Error('Video generation timed out after 10 minutes');
}

// --- Kling 3.0 Video Generation (15 seconds, single call) ---
async function generateKling3Video(avatarUrl, script) {
  const FAL_KEY = process.env.FAL_API_KEY;
  if (!FAL_KEY) throw new Error('FAL_API_KEY not set');

  console.log('🎥 Submitting to Kling 3.0 (15-second generation)...');
  const endpoint = 'https://queue.fal.run/fal-ai/kling-video/v3/standard/image-to-video';
  const prompt = `A person speaking naturally to camera, delivering a monologue. They say: "${script.slice(0, 500)}"`;

  const submitRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      image_url: avatarUrl,
      duration: '15',
      aspect_ratio: '9:16',
      generate_audio: true,
    }),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`Kling 3.0 submit failed (${submitRes.status}): ${errText}`);
  }

  const { request_id, status_url, response_url } = await submitRes.json();
  if (!request_id) throw new Error('Kling 3.0 did not return a request_id');

  // Poll for completion
  const videoUrl = await pollFalJob(status_url, response_url, FAL_KEY, 'Kling 3.0');

  // Download video
  console.log('📥 Downloading video...');
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`Video download failed (${videoRes.status})`);

  const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
  const outputPath = `/tmp/kling3_talking_${crypto.randomUUID().slice(0, 8)}.mp4`;
  await fs.writeFile(outputPath, videoBuffer);
  console.log(`✅ Video downloaded: ${outputPath}\n`);

  return outputPath;
}

// --- Main Test ---
async function main() {
  try {
    console.log('='.repeat(60));
    console.log('TALKING-HEAD FULL PIPELINE TEST');
    console.log('='.repeat(60));
    console.log('Model: Kling 3.0 (native-audio, 15 seconds, 4K@60fps)');
    console.log('Avatar: Athlete Mindset track athlete');
    console.log('='.repeat(60));

    // Step 1: Generate script (~35 words for 12-13 seconds, staying under 15 sec limit)
    const topic = 'mental training techniques for pole vaulters';
    const script = await generateScript(topic, 'Athlete Mindset', 35);

    // Step 2: Prepare avatar
    console.log('📸 Loading avatar image...');
    const avatarExists = await fs.access(AVATAR_PATH).then(() => true).catch(() => false);
    if (!avatarExists) {
      throw new Error(`Avatar not found at ${AVATAR_PATH}. Generate it first with test-avatar-generation.mjs`);
    }

    let avatarBuffer = await fs.readFile(AVATAR_PATH);
    const stats = await fs.stat(AVATAR_PATH);
    console.log(`✅ Avatar loaded (${(stats.size / 1024).toFixed(1)} KB)\n`);

    // Resize to 1024x1024 for optimal processing
    avatarBuffer = await sharp(avatarBuffer)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();

    // Upload to fal.ai storage
    const avatarUrl = await uploadImageToFal(avatarBuffer, 'avatar.png');

    // Step 3: Generate 15-second video with Kling 3.0 (single call!)
    const videoPath = await generateKling3Video(avatarUrl, script);

    console.log('='.repeat(60));
    console.log('✅ TEST COMPLETE!');
    console.log('='.repeat(60));
    console.log('Script:', script.split(/\s+/).length, 'words');
    console.log('Avatar:', AVATAR_PATH);
    console.log('Video:', videoPath);
    console.log('Duration: 15 seconds (single API call)');
    console.log('='.repeat(60));

  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
