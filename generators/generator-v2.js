#!/usr/bin/env node
/**
 * TikTok Slideshow Generator v2 - Clean Infographic Style
 * Uses DALL-E 3 with ultra-simple prompts for text-based slides
 */

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load API key
const API_KEY_PATH = path.join(process.env.HOME, '.openclaw/credentials/openai-tiktok.key');
const API_KEY = (await fs.readFile(API_KEY_PATH, 'utf-8')).trim();

const openai = new OpenAI({ apiKey: API_KEY });

// Clean infographic-style carousel concepts
const CONCEPTS = {
  'psych-cost': {
    name: 'Sports Psych Costs $200',
    slides: [
      {
        text: 'My sports psychologist charges $200 per session',
        prompt: 'Vertical mobile infographic slide (9:16). Large bold text "$200 per session" centered on solid dark navy background. Minimal clean design. Text only, no people or complex graphics.',
      },
      {
        text: 'I need it to compete at my best',
        prompt: 'Vertical mobile infographic slide (9:16). Bold white text "I need mental training" on gradient background (dark blue to purple). Clean minimalist design.',
      },
      {
        text: "But I can't afford $800/month",
        prompt: 'Vertical mobile infographic slide (9:16). Large text "$800/month" crossed out, solid red background. Simple infographic style.',
      },
      {
        text: 'Then I found an AI alternative',
        prompt: 'Vertical mobile infographic slide (9:16). Text "AI Alternative" with phone icon, clean gradient background (teal to blue). Minimalist infographic.',
      },
      {
        text: 'Same mental training, 24/7 access',
        prompt: 'Vertical mobile infographic slide (9:16). "24/7" in huge bold letters, dark background. Clean typography-focused design.',
      },
      {
        text: 'For $8.33 per month',
        prompt: 'Vertical mobile infographic slide (9:16). "$8.33/month" in large text, bright green background. Simple price tag style infographic.',
      },
      {
        text: 'Try Athlete Mindset free',
        prompt: 'Vertical mobile infographic slide (9:16). "Try Free" in bold text with "athletemindset.app" below, solid purple background. Call-to-action style.',
      },
    ],
  },

  'breakthrough': {
    name: 'Mental Breakthrough Story',
    slides: [
      {
        text: 'I kept choking in competition',
        prompt: 'Vertical mobile infographic slide (9:16). Bold text "CHOKE" in large letters, dark red background. Dramatic minimal design.',
      },
      {
        text: 'Perfect in practice, but not in the moment',
        prompt: 'Vertical mobile infographic slide (9:16). Split screen design: "Practice ✓" vs "Competition ✗", simple two-tone background.',
      },
      {
        text: 'My mind was holding me back',
        prompt: 'Vertical mobile infographic slide (9:16). Text "Mental Block" with simple brain icon outline, gray gradient background.',
      },
      {
        text: 'I tried visualization for 5 minutes daily',
        prompt: 'Vertical mobile infographic slide (9:16). "5 min/day" in huge text, calming blue background. Clean timer-style infographic.',
      },
      {
        text: 'Everything changed',
        prompt: 'Vertical mobile infographic slide (9:16). "BREAKTHROUGH" in bold letters, bright yellow/gold background. Celebratory minimal style.',
      },
      {
        text: 'Your mental game is holding you back',
        prompt: 'Vertical mobile infographic slide (9:16). Question mark symbol with "Your Mental Game?" text, dark background. Provocative simple design.',
      },
      {
        text: 'athletemindset.app',
        prompt: 'Vertical mobile infographic slide (9:16). "athletemindset.app" in clean typography, gradient purple background. Website URL style.',
      },
    ],
  },

  'science': {
    name: '90% of Olympians',
    slides: [
      {
        text: '90% of Olympic athletes use visualization',
        prompt: 'Vertical mobile infographic slide (9:16). "90%" in massive bold numbers, Olympic rings colors gradient background. Data-driven clean design.',
      },
      {
        text: '16% performance improvement',
        prompt: 'Vertical mobile infographic slide (9:16). Up arrow with "+16%" text, green gradient background. Simple stats infographic.',
      },
      {
        text: 'It activates the same brain regions',
        prompt: 'Vertical mobile infographic slide (9:16). Simple brain icon with "Same Activation" text, blue scientific gradient.',
      },
      {
        text: 'But most athletes never learn how',
        prompt: 'Vertical mobile infographic slide (9:16). "Most athletes:" with X symbol, dark background. Problem statement style.',
      },
      {
        text: 'Sports psychologists cost $150-300/session',
        prompt: 'Vertical mobile infographic slide (9:16). "$150-300" in large text with barrier/lock icon, expensive red background.',
      },
      {
        text: 'Now there\'s an AI coach for everyone',
        prompt: 'Vertical mobile infographic slide (9:16). "AI Coach" text with smartphone icon, accessible green background.',
      },
      {
        text: 'athletemindset.app - Start free trial',
        prompt: 'Vertical mobile infographic slide (9:16). "Start Free Trial" in bold, purple gradient with "athletemindset.app" below.',
      },
    ],
  },

  'elite-secret': {
    name: 'Elite Athlete Secret',
    slides: [
      {
        text: 'What separates elite from everyone else?',
        prompt: 'Vertical mobile infographic slide (9:16). Question "Elite vs Everyone?" in bold text, dark mysterious gradient.',
      },
      {
        text: "It's not more physical training",
        prompt: 'Vertical mobile infographic slide (9:16). "Physical Training" crossed out with X, simple red background.',
      },
      {
        text: "It's not genetics or talent",
        prompt: 'Vertical mobile infographic slide (9:16). "Genetics" crossed out, "Talent" crossed out, minimal design.',
      },
      {
        text: "It's mental training",
        prompt: 'Vertical mobile infographic slide (9:16). "MENTAL TRAINING" in huge bold letters with checkmark, bright blue background.',
      },
      {
        text: 'Every pro has a sports psychologist',
        prompt: 'Vertical mobile infographic slide (9:16). "Every Pro" with trophy icon, gold gradient background.',
      },
      {
        text: 'But most athletes can\'t access it',
        prompt: 'Vertical mobile infographic slide (9:16). Lock/barrier icon with "Locked Out" text, dark background.',
      },
      {
        text: 'Until now - athletemindset.app',
        prompt: 'Vertical mobile infographic slide (9:16). "Unlocked" with open lock icon, bright green background, URL below.',
      },
    ],
  },

  'before-after': {
    name: 'Before vs After',
    slides: [
      {
        text: 'BEFORE Mental Training',
        prompt: 'Vertical mobile infographic slide (9:16). "BEFORE" in huge letters, dark red/gray gradient. Header style.',
      },
      {
        text: 'Nervous before competitions',
        prompt: 'Vertical mobile infographic slide (9:16). Stress/anxiety symbol with "Nervous" text, dark anxious colors.',
      },
      {
        text: 'Inconsistent performances',
        prompt: 'Vertical mobile infographic slide (9:16). Jagged graph line going up and down, red background.',
      },
      {
        text: 'AFTER Mental Training',
        prompt: 'Vertical mobile infographic slide (9:16). "AFTER" in huge letters, bright green gradient. Header style.',
      },
      {
        text: 'Confident and focused',
        prompt: 'Vertical mobile infographic slide (9:16). "Confident" with strong icon, empowering blue background.',
      },
      {
        text: 'Consistent peak performance',
        prompt: 'Vertical mobile infographic slide (9:16). Smooth upward graph line, green success background.',
      },
      {
        text: 'The difference? 5 minutes a day',
        prompt: 'Vertical mobile infographic slide (9:16). "5 min/day" in huge text, simple clock icon, motivating purple.',
      },
      {
        text: 'Get Athlete Mindset',
        prompt: 'Vertical mobile infographic slide (9:16). "Get Started" CTA with "athletemindset.app", bold purple gradient.',
      },
    ],
  },
};

/**
 * Generate a single slide
 */
async function generateSlide(slideData, index, conceptName) {
  console.log(`Generating slide ${index + 1}: "${slideData.text.substring(0, 50)}..."`);

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt: slideData.prompt,
    n: 1,
    size: '1024x1792', // 9:16 ratio
    quality: 'standard',
  });

  return response.data[0].url;
}

/**
 * Download image
 */
async function downloadImage(url, filepath) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  await fs.writeFile(filepath, Buffer.from(buffer));
}

/**
 * Generate complete slideshow
 */
async function generateSlideshow(conceptKey) {
  const concept = CONCEPTS[conceptKey];
  if (!concept) {
    console.error(`Unknown concept: ${conceptKey}`);
    console.log('Available concepts:', Object.keys(CONCEPTS).join(', '));
    process.exit(1);
  }

  console.log(`\n🎬 Generating: ${concept.name}`);
  console.log(`📊 Slides: ${concept.slides.length}\n`);

  const outputDir = path.join(__dirname, 'output-v2', conceptKey);
  await fs.mkdir(outputDir, { recursive: true });

  for (let i = 0; i < concept.slides.length; i++) {
    try {
      const url = await generateSlide(concept.slides[i], i, concept.name);
      
      const filename = `slide_${String(i + 1).padStart(2, '0')}.png`;
      const filepath = path.join(outputDir, filename);
      await downloadImage(url, filepath);
      
      console.log(`✅ Saved: ${filename}`);
      
      if (i < concept.slides.length - 1) {
        console.log('⏳ Waiting 3s...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (error) {
      console.error(`❌ Error on slide ${i + 1}:`, error.message);
      throw error;
    }
  }

  const metadata = {
    concept: concept.name,
    conceptKey,
    generatedAt: new Date().toISOString(),
    slideCount: concept.slides.length,
    slides: concept.slides.map((slide, i) => ({
      index: i + 1,
      text: slide.text,
      filename: `slide_${String(i + 1).padStart(2, '0')}.png`,
    })),
  };

  await fs.writeFile(
    path.join(outputDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  console.log(`\n✨ Complete! Saved to: ${outputDir}\n`);
}

const conceptKey = process.argv[2];

if (!conceptKey) {
  console.log('Usage: node generator-v2.js <concept-key>\n');
  console.log('Available concepts:');
  Object.entries(CONCEPTS).forEach(([key, concept]) => {
    console.log(`  ${key.padEnd(20)} - ${concept.name} (${concept.slides.length} slides)`);
  });
  process.exit(1);
}

generateSlideshow(conceptKey);
