#!/usr/bin/env node
/**
 * Generate ONE slide at a time for verification
 * Usage: node generate-one.js <concept> <slide-number>
 */

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY_PATH = path.join(process.env.HOME, '.openclaw/credentials/openai-tiktok.key');
const API_KEY = (await fs.readFile(API_KEY_PATH, 'utf-8')).trim();

const openai = new OpenAI({ apiKey: API_KEY });

// Slide prompts
const CONCEPTS = {
  'psych-cost': [
    'Vertical mobile infographic (1024x1536): "$200 per session" in huge bold white text centered on solid dark navy blue background. Minimalist clean design, text only.',
    'Vertical mobile infographic (1024x1536): "Mental Training" in bold white text with simple brain icon outline, purple to blue gradient background.',
    'Vertical mobile infographic (1024x1536): "$800/month" in large text with red X crossed through it, solid dark red background.',
    'Vertical mobile infographic (1024x1536): "AI Alternative" in bold text with simple smartphone icon, teal to blue gradient.',
    'Vertical mobile infographic (1024x1536): "24/7" in massive bold numbers, solid dark background, modern minimalist.',
    'Vertical mobile infographic (1024x1536): "$8.33/month" in large green text, bright green background, price tag style.',
    'Vertical mobile infographic (1024x1536): "Try Free" in bold white text, "athletemindset.app" below, purple gradient, CTA style.',
  ],
  
  'breakthrough': [
    'Vertical mobile infographic (1024x1536): "CHOKE" in huge dramatic bold letters, dark red background.',
    'Vertical mobile infographic (1024x1536): Split design "Practice ✓" on left vs "Game ✗" on right, two-tone background.',
    'Vertical mobile infographic (1024x1536): "Mental Block" text with simple brain outline icon, gray gradient.',
    'Vertical mobile infographic (1024x1536): "5 min/day" in huge bold text, calming blue background, timer style.',
    'Vertical mobile infographic (1024x1536): "BREAKTHROUGH" in bold letters, bright yellow/gold celebration background.',
    'Vertical mobile infographic (1024x1536): "Your Mental Game?" with large question mark, dark provocative background.',
    'Vertical mobile infographic (1024x1536): "athletemindset.app" in clean typography, gradient purple background.',
  ],
  
  'science': [
    'Vertical mobile infographic (1024x1536): "90%" in massive bold numbers, Olympic rings inspired gradient.',
    'Vertical mobile infographic (1024x1536): "+16%" with large up arrow, green success background.',
    'Vertical mobile infographic (1024x1536): Simple brain icon with "Same Activation" text, scientific blue.',
    'Vertical mobile infographic (1024x1536): "Most athletes:" with large X symbol, dark problem statement.',
    'Vertical mobile infographic (1024x1536): "$150-300" in large text with lock icon, expensive red barrier.',
    'Vertical mobile infographic (1024x1536): "AI Coach" with smartphone icon, accessible green background.',
    'Vertical mobile infographic (1024x1536): "Start Free Trial" bold text, "athletemindset.app" below, purple gradient.',
  ],
};

async function generateOneSlide(concept, slideNum) {
  const slides = CONCEPTS[concept];
  if (!slides) {
    console.error(`Unknown concept: ${concept}`);
    console.log('Available:', Object.keys(CONCEPTS).join(', '));
    process.exit(1);
  }
  
  if (slideNum < 1 || slideNum > slides.length) {
    console.error(`Invalid slide number. Concept has ${slides.length} slides.`);
    process.exit(1);
  }
  
  const prompt = slides[slideNum - 1];
  
  console.log(`\n🎨 Generating slide ${slideNum}/${slides.length}`);
  console.log(`📝 Concept: ${concept}\n`);
  
  const response = await openai.images.generate({
    model: 'gpt-image-1.5',
    prompt: prompt,
    n: 1,
    size: '1024x1536',
    quality: 'high',
  });
  
  // Decode base64 and save
  const b64Data = response.data[0].b64_json;
  const buffer = Buffer.from(b64Data, 'base64');
  
  const outputDir = path.join(__dirname, 'output', concept);
  await fs.mkdir(outputDir, { recursive: true });
  
  const filename = `slide_${String(slideNum).padStart(2, '0')}.png`;
  const filepath = path.join(outputDir, filename);
  await fs.writeFile(filepath, buffer);
  
  console.log(`✅ Saved: ${filepath}\n`);
  console.log(`💰 Cost: ~$0.08 per image\n`);
  
  // Open the file
  const { exec } = await import('child_process');
  exec(`open "${filepath}"`);
  
  console.log(`👀 Check the image!`);
  console.log(`\n📋 Next command:`);
  if (slideNum < slides.length) {
    console.log(`   node generate-one.js ${concept} ${slideNum + 1}\n`);
  } else {
    console.log(`   🎉 All slides complete! Now add owl overlay:\n`);
    console.log(`   python3 add-owl-overlay.py output/${concept}\n`);
  }
}

const concept = process.argv[2];
const slideNum = parseInt(process.argv[3]);

if (!concept || !slideNum) {
  console.log('Usage: node generate-one.js <concept> <slide-number>\n');
  console.log('Examples:');
  console.log('  node generate-one.js psych-cost 1');
  console.log('  node generate-one.js breakthrough 1');
  console.log('  node generate-one.js science 1\n');
  console.log('Available concepts:');
  Object.entries(CONCEPTS).forEach(([key, slides]) => {
    console.log(`  ${key.padEnd(15)} - ${slides.length} slides`);
  });
  process.exit(1);
}

generateOneSlide(concept, slideNum);
