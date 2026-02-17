import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import admin from 'firebase-admin';
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const anthropic = new Anthropic();
const openai = new OpenAI();

// --- Firebase Storage setup (for public URLs that Fal can access) ---
let bucket = null;
try {
  const rawSA = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  const cleanedSA = (rawSA || '{}').replace(/\\"/g, '"').replace(/\n/g, '\\n').replace(/\r/g, '');
  const serviceAccount = JSON.parse(cleanedSA);
  if (serviceAccount.project_id) {
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    const storageBucketName = process.env.FIREBASE_STORAGE_BUCKET?.trim();
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      ...(storageBucketName && { storageBucket: storageBucketName }),
    });
    if (storageBucketName) {
      bucket = admin.storage().bucket();
      console.log('[Firebase] Storage bucket ready:', storageBucketName);
    }
  }
} catch (err) {
  console.warn('[Firebase] Init failed — uploads will fail:', err.message);
}

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const FAL_API_KEY = process.env.FAL_API_KEY;

const brandInfo = {
  name: 'TrackSpeed',
  systemPrompt: 'TrackSpeed is an iPhone app that turns your phone into a professional sprint timing system with ~4ms accuracy. No extra hardware needed — just your phone camera. Used by Olympic athletes, college programs, and high school coaches. Target audience: competitive sprinters, coaches, and track athletes ages 16-30. Brand voice: confident, tech-savvy, performance-focused.'
};

const script = `These timing gates cost three thousand dollars. And they're only accurate to about ten milliseconds. Your iPhone shoots at 120 frames per second — that's a frame every 8 milliseconds. TrackSpeed uses that to time your sprints down to around 4 milliseconds. No gates. No hardware. No setup. Just prop your phone at the finish line and run. It's free.`;

const systemMessage = `You generate image prompts for TikTok talking-head thumbnails. The image becomes the base frame for AI lip-sync video.

CRITICAL REALISM RULES — this must look like a REAL phone selfie, NOT a professional photo:
- Shot on a front-facing phone camera — slight wide-angle distortion, imperfect framing
- Background stays sharp and detailed — iPhone front cameras keep everything in focus, the whole scene is crisp
- Normal phone-camera lighting (not cinematic, not golden hour unless truly natural)
- Messy, real environments — not styled or aesthetically perfect
- Think "screenshot from someone's Instagram story" not "portrait photography"

SETTINGS — pick ONE based on brand + script energy:

EVERYDAY (default for most content):
- Parked car, driver seat, daylight through windows
- Walking on a sidewalk or parking lot
- Gym floor or weight room (messy, real gym — not a photoshoot gym)
- Bedroom, kitchen, or living room (normal messy room)
- Coffee shop or fast food spot

ELEVATED (for energetic brands, motivational scripts):
- Car at night, dashboard lights on face, city through windshield
- Rooftop or balcony (casual, leaning on railing — not posed)
- Beach or pool (casual, like they just pulled out their phone)
- Airport gate or airplane seat
- Locker room or backstage (gritty, real — not clean)

HIGH-IMPACT (only for truly bold/shocking content):
- Inside a helicopter or small plane (headset on, window view)
- Edge of a cliff or mountain trail
- On a boat or jet ski
- Standing in rain (genuinely wet, not artistic rain)

SELECTION: Conservative brands → Everyday only. Energetic brands → mix Everyday + Elevated. Bold scripts → can use High-Impact. Default to Everyday.

PERSON:
- Very attractive — symmetrical face, clear skin, bright eyes, well-groomed
- But CASUAL, not posed — slight smile or mouth slightly open mid-sentence
- Framed from mid-chest up (like holding phone at arm's length) — NOT a tight face close-up
- Show head, neck, shoulders, and upper chest — similar to a FaceTime call framing
- Looking directly at camera lens
- Match to brand audience (age, style, attire) but aspirational
- Normal skin texture — not airbrushed or overly smooth

TECHNICAL:
- Front-facing phone camera perspective (NOT a DSLR or professional camera)
- Everything in the frame is sharp and in focus — f/2.2 iPhone front camera, deep depth of field, crisp background details
- 9:16 vertical frame
- Photorealistic with normal phone-camera quality — slight noise/grain is OK
- No text, logos, overlays, watermarks
- Do NOT describe the scene poetically — use plain, direct language
- Return ONLY the prompt, nothing else`;

// --- Helper: Upload to Firebase Storage and get public URL ---
async function uploadToStorage(buffer, filename, contentType) {
  if (!bucket) throw new Error('Firebase Storage not configured — cannot get public URLs for Fal');
  const file = bucket.file(`carousel-studio/test/${filename}`);
  await file.save(buffer, { metadata: { contentType } });
  await file.makePublic();
  return `https://storage.googleapis.com/${bucket.name}/carousel-studio/test/${filename}`;
}

// --- Helper: List ElevenLabs voices ---
async function listElevenLabsVoices() {
  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY },
  });
  if (!res.ok) throw new Error(`ElevenLabs voices fetch failed (${res.status})`);
  const data = await res.json();
  return (data.voices || []).map(v => ({
    id: v.voice_id,
    name: v.name,
    provider: 'elevenlabs',
    labels: v.labels || {},
    description: v.description || null,
    category: v.category || null,
  }));
}

// --- Helper: ElevenLabs TTS ---
async function generateSpeechElevenLabs(text, voiceId) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// --- Helper: OpenAI TTS fallback ---
async function generateSpeechOpenAI(text) {
  const mp3 = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: 'echo',
    input: text,
    response_format: 'mp3',
  });
  return Buffer.from(await mp3.arrayBuffer());
}

// --- Helper: Fal lip-sync with polling ---
async function generateTalkingFace(imageUrl, audioUrl) {
  console.log('  Submitting to Fal Fabric lip-sync...');
  const submitRes = await fetch('https://queue.fal.run/veed/fabric-1.0', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ image_url: imageUrl, audio_url: audioUrl, resolution: '720p' }),
  });
  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`Fal submit failed (${submitRes.status}): ${errText}`);
  }
  const { request_id, status_url, response_url } = await submitRes.json();
  if (!request_id) throw new Error('Fal did not return a request_id');
  console.log(`  Request ID: ${request_id}`);

  // Poll until complete
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(status_url, {
      headers: { 'Authorization': `Key ${FAL_API_KEY}` },
    });
    if (!statusRes.ok) {
      console.warn(`  Poll returned ${statusRes.status}, retrying...`);
      continue;
    }
    const statusData = await statusRes.json();
    console.log(`  Status: ${statusData.status}`);
    if (statusData.status === 'COMPLETED') {
      const resultRes = await fetch(response_url, {
        headers: { 'Authorization': `Key ${FAL_API_KEY}` },
      });
      const resultData = await resultRes.json();
      const videoUrl = resultData.video?.url || resultData.video_url;
      if (!videoUrl) throw new Error('No video URL in Fal response: ' + JSON.stringify(resultData));
      return videoUrl;
    }
    if (statusData.status === 'FAILED') {
      throw new Error('Fal lip-sync failed: ' + JSON.stringify(statusData));
    }
  }
  throw new Error('Fal lip-sync timed out after 10 minutes');
}

async function run() {
  // ====== Step 1: Generate avatar prompt via Claude ======
  console.log('Step 1: Generating avatar prompt via Claude Sonnet...\n');
  const promptResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 300,
    system: systemMessage,
    messages: [{ role: 'user', content: `Brand: ${brandInfo.name}\n${brandInfo.systemPrompt}\n\nScript: ${script}` }]
  });
  const avatarPrompt = promptResponse.content[0].text.trim();
  console.log('Avatar prompt:\n' + avatarPrompt + '\n');

  // ====== Step 2: Generate avatar image via GPT Image 1.5 ======
  console.log('Step 2: Generating avatar image via GPT Image 1.5...');
  const imageResponse = await openai.images.generate({
    model: 'gpt-image-1.5',
    prompt: avatarPrompt,
    size: '1024x1536',
    quality: 'high',
    output_format: 'png',
  });
  const b64 = imageResponse.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image returned');
  const imageBuffer = Buffer.from(b64, 'base64');

  const avatarPath = '/tmp/trackspeed-avatar.png';
  await fs.writeFile(avatarPath, imageBuffer);
  console.log(`Avatar saved to: ${avatarPath}\n`);

  // ====== Step 3: Select voice via ElevenLabs + Claude matching ======
  console.log('Step 3: Selecting voice...');
  let voiceId = null;
  let voiceProvider = 'openai';

  if (ELEVENLABS_API_KEY) {
    try {
      const voices = await listElevenLabsVoices();
      const voiceDescriptions = voices.slice(0, 40).map(v => {
        const l = v.labels || {};
        const traits = [l.gender, l.age, l.accent, l.description, l.use_case].filter(Boolean).join(', ');
        return `- ${v.name} (id:${v.id}) — ${traits || 'no description'}`;
      }).join('\n');

      const voicePick = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        system: `You are a voice casting director for TikTok/Reels talking-head videos. Pick a voice that matches the presenter's CHARACTER — gender, age, ethnicity, personality, and the script's tone.

Available ElevenLabs voices (higher quality, more natural):
${voiceDescriptions}

Also available — OpenAI voices: alloy (neutral), ash (warm male), coral (warm female), echo (smooth male), fable (expressive British), nova (energetic female), onyx (deep male), sage (calm wise), shimmer (soft female).

Prefer ElevenLabs when they match well. Reply with ONLY: provider:id (e.g. "elevenlabs:JBFqnCBsd6RMkjVDRZzb" or "openai:echo"). Nothing else.`,
        messages: [{ role: 'user', content: `Brand: ${brandInfo.name} — ${brandInfo.systemPrompt}\n\nScript: ${script}\n\nAvatar prompt: ${avatarPrompt}` }]
      });

      const picked = voicePick.content[0].text.trim();
      console.log(`  AI picked voice: ${picked}`);
      const [prov, id] = picked.includes(':') ? picked.split(':', 2) : ['openai', picked];
      if (prov === 'elevenlabs' && id) {
        voiceId = id;
        voiceProvider = 'elevenlabs';
      } else {
        voiceId = id || 'echo';
        voiceProvider = 'openai';
      }
    } catch (err) {
      console.warn('  ElevenLabs voice selection failed, falling back to OpenAI:', err.message);
      voiceId = 'echo';
      voiceProvider = 'openai';
    }
  } else {
    console.log('  No ELEVENLABS_API_KEY — using OpenAI echo voice');
    voiceId = 'echo';
  }
  console.log(`  Using: ${voiceProvider}:${voiceId}\n`);

  // ====== Step 4: Generate TTS audio ======
  console.log('Step 4: Generating TTS audio...');
  let audioBuffer;
  try {
    if (voiceProvider === 'elevenlabs' && ELEVENLABS_API_KEY) {
      audioBuffer = await generateSpeechElevenLabs(script, voiceId);
    } else {
      audioBuffer = await generateSpeechOpenAI(script);
    }
  } catch (err) {
    console.warn(`  ${voiceProvider} TTS failed, trying OpenAI fallback:`, err.message);
    audioBuffer = await generateSpeechOpenAI(script);
    voiceProvider = 'openai';
  }

  const audioPath = '/tmp/trackspeed-audio.mp3';
  await fs.writeFile(audioPath, audioBuffer);
  console.log(`  Audio saved to: ${audioPath} (${(audioBuffer.length / 1024).toFixed(0)} KB)\n`);

  // ====== Step 5: Upload avatar + audio to Firebase Storage ======
  console.log('Step 5: Uploading to Firebase Storage for public URLs...');
  if (!bucket) {
    console.error('  Firebase Storage not configured. Cannot generate public URLs for Fal.');
    console.log('  Set FIREBASE_SERVICE_ACCOUNT and FIREBASE_STORAGE_BUCKET in .env');
    process.exit(1);
  }
  const timestamp = Date.now();
  const imageUrl = await uploadToStorage(imageBuffer, `avatar-${timestamp}.png`, 'image/png');
  const audioUrl = await uploadToStorage(audioBuffer, `audio-${timestamp}.mp3`, 'audio/mpeg');
  console.log(`  Image URL: ${imageUrl}`);
  console.log(`  Audio URL: ${audioUrl}\n`);

  // ====== Step 6: Fal Fabric lip-sync ======
  console.log('Step 6: Running Fal Fabric lip-sync...');
  if (!FAL_API_KEY) {
    console.error('  No FAL_API_KEY set in .env');
    process.exit(1);
  }
  const videoUrl = await generateTalkingFace(imageUrl, audioUrl);
  console.log(`  Video URL: ${videoUrl}\n`);

  // ====== Step 7: Download video and open ======
  console.log('Step 7: Downloading video...');
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`Failed to download video: ${videoRes.status}`);
  const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

  const videoPath = '/tmp/trackspeed-talking-head.mp4';
  await fs.writeFile(videoPath, videoBuffer);
  console.log(`  Video saved to: ${videoPath} (${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

  // Open on macOS
  try {
    execSync(`open "${videoPath}"`);
    console.log('  Opened video in default player');
  } catch {
    console.log('  Could not auto-open — open manually:', videoPath);
  }

  console.log('\nDone! Full pipeline complete.');
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
