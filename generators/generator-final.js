#!/usr/bin/env node
/**
 * TikTok Carousel Generator with Owl Overlay
 * Generates clean infographic slides + adds brand mascot
 */

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load API key
const API_KEY_PATH = path.join(process.env.HOME, '.openclaw/credentials/openai-tiktok.key');
const API_KEY = (await fs.readFile(API_KEY_PATH, 'utf-8')).trim();

const openai = new OpenAI({ apiKey: API_KEY });

// Carousel concepts
const CONCEPTS = {
  'psych-cost': {
    name: 'Sports Psych $200 vs $8',
    slides: [
      'Vertical infographic: "$200 per session" in huge bold text, solid dark navy background',
      'Vertical infographic: "Mental Training" text with brain icon, purple gradient',
      'Vertical infographic: "$800/month" crossed out in red, dramatic background',
      'Vertical infographic: "AI Alternative" with smartphone, teal gradient',
      'Vertical infographic: "24/7" in massive numbers, dark modern background',
      'Vertical infographic: "$8.33/month" in green, price tag style',
      'Vertical infographic: "Try Free" bold text, purple CTA background',
    ],
  },

  'breakthrough': {
    name: 'Mental Breakthrough',
    slides: [
      'Vertical infographic: "CHOKE" in dramatic bold letters, dark red',
      'Vertical infographic: Split "Practice ✓" vs "Game ✗", two-tone',
      'Vertical infographic: "Mental Block" with simple brain outline, gray',
      'Vertical infographic: "5 min/day" huge text, calming blue timer style',
      'Vertical infographic: "BREAKTHROUGH" bold, bright yellow celebration',
      'Vertical infographic: "Your Mental Game?" question mark, provocative dark',
      'Vertical infographic: "athletemindset.app" clean typography, gradient',
    ],
  },

  'science': {
    name: '90% of Olympians',
    slides: [
      'Vertical infographic: "90%" massive numbers, Olympic colors gradient',
      'Vertical infographic: "+16%" with up arrow, green success background',
      'Vertical infographic: Brain icon "Same Activation", scientific blue',
      'Vertical infographic: "Most athletes:" with X, problem statement dark',
      'Vertical infographic: "$150-300" with lock, expensive barrier red',
      'Vertical infographic: "AI Coach" with phone icon, accessible green',
      'Vertical infographic: "Start Free Trial" bold purple, athletemindset.app',
    ],
  },

  'elite-secret': {
    name: 'Elite Secret',
    slides: [
      'Vertical infographic: "Elite vs Everyone?" bold question, mysterious dark',
      'Vertical infographic: "Physical Training" crossed out with X, red',
      'Vertical infographic: "Genetics" and "Talent" both crossed out',
      'Vertical infographic: "MENTAL TRAINING" huge with checkmark, bright blue',
      'Vertical infographic: "Every Pro" with trophy, gold gradient',
      'Vertical infographic: Lock icon "Locked Out", dark barrier',
      'Vertical infographic: "Unlocked" open lock, bright green, athletemindset.app',
    ],
  },

  'before-after': {
    name: 'Before vs After',
    slides: [
      'Vertical infographic: "BEFORE" huge header, dark red gradient',
      'Vertical infographic: "Nervous" with stress symbol, anxious dark',
      'Vertical infographic: Jagged graph line up and down, red inconsistent',
      'Vertical infographic: "AFTER" huge header, bright green gradient',
      'Vertical infographic: "Confident" with strong symbol, empowering blue',
      'Vertical infographic: Smooth upward graph, green success',
      'Vertical infographic: "5 min/day" with clock, motivating purple',
      'Vertical infographic: "Get Started" CTA athletemindset.app, bold purple',
    ],
  },
};

async function generateSlide(prompt, index) {
  console.log(`Generating slide ${index + 1}...`);
  
  const fullPrompt = `${prompt}. 
  
Design rules:
- 9:16 vertical mobile format (1080x1920)
- Minimalist clean infographic style
- Bold readable typography as primary element
- Simple solid colors or clean gradients
- No complex illustrations, keep it simple
- Text must be crystal clear and readable
- Professional but engaging aesthetic`;

  const response = await openai.images.generate({
    model: 'gpt-image-1.5',
    prompt: fullPrompt,
    n: 1,
    size: '1024x1536', // Closest to 9:16 ratio for TikTok
    quality: 'high',
  });

  return response.data[0].url;
}

async function downloadImage(url, filepath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  await fs.writeFile(filepath, Buffer.from(buffer));
}

async function generateSlideshow(conceptKey, owlConfig = 'bottom-right') {
  const concept = CONCEPTS[conceptKey];
  if (!concept) {
    console.error(`Unknown concept: ${conceptKey}`);
    console.log('Available:', Object.keys(CONCEPTS).join(', '));
    process.exit(1);
  }

  console.log(`\n🎬 ${concept.name}`);
  console.log(`📊 ${concept.slides.length} slides\n`);

  const outputDir = path.join(__dirname, 'output', conceptKey);
  await fs.mkdir(outputDir, { recursive: true });

  // Generate all slides
  for (let i = 0; i < concept.slides.length; i++) {
    try {
      const url = await generateSlide(concept.slides[i], i);
      const filename = `slide_${String(i + 1).padStart(2, '0')}.png`;
      const filepath = path.join(outputDir, filename);
      await downloadImage(url, filepath);
      console.log(`✅ ${filename}`);
      
      if (i < concept.slides.length - 1) {
        console.log('⏳ 3s...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (error) {
      console.error(`❌ Slide ${i + 1}:`, error.message);
      // Continue with next slide instead of failing
      continue;
    }
  }

  // Add owl overlay
  console.log(`\n🦉 Adding owl overlay (${owlConfig})...`);
  try {
    const { stdout } = await exec(
      `python3 "${path.join(__dirname, 'add-owl-overlay.py')}" "${outputDir}" ${owlConfig}`
    );
    console.log(stdout);
  } catch (error) {
    console.error('⚠️  Owl overlay failed:', error.message);
    console.log('   Slides saved without owl overlay');
  }

  console.log(`\n✨ Complete! Check: ${outputDir}-with-owl/\n`);
}

const conceptKey = process.argv[2];
const owlPosition = process.argv[3] || 'bottom-right';

if (!conceptKey) {
  console.log('Usage: node generator-final.js <concept> [owl-position]\n');
  console.log('Concepts:');
  Object.entries(CONCEPTS).forEach(([key, c]) => {
    console.log(`  ${key.padEnd(15)} - ${c.name} (${c.slides.length} slides)`);
  });
  console.log('\nOwl positions: bottom-right, bottom-left, top-right, mid-right');
  process.exit(1);
}

generateSlideshow(conceptKey, owlPosition);
