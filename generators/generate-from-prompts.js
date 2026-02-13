#!/usr/bin/env node
/**
 * Generate images from pre-written prompts
 * Prompts created by Claude Opus 4.6, images by GPT Image 1.5
 */

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY_PATH = path.join(process.env.HOME, '.openclaw/credentials/openai-tiktok.key');
const API_KEY = (await fs.readFile(API_KEY_PATH, 'utf-8')).trim();

const openai = new OpenAI({ apiKey: API_KEY });

async function generateSlide(promptsFile, slideNum) {
  // Load prompts
  const data = JSON.parse(await fs.readFile(promptsFile, 'utf-8'));
  const prompts = data.prompts;
  
  if (slideNum < 1 || slideNum > prompts.length) {
    console.error(`Invalid slide number. File has ${prompts.length} prompts.`);
    process.exit(1);
  }
  
  const prompt = prompts[slideNum - 1];
  
  console.log(`\n🎨 Generating slide ${slideNum}/${prompts.length}`);
  console.log(`📝 ${data.concept}\n`);
  
  // Generate image
  const response = await openai.images.generate({
    model: 'gpt-image-1.5',
    prompt: prompt,
    n: 1,
    size: '1024x1536',
    quality: 'high',
  });
  
  // Save
  const b64Data = response.data[0].b64_json;
  const buffer = Buffer.from(b64Data, 'base64');
  
  const conceptKey = path.basename(promptsFile, '.json').replace('prompts-', '');
  const outputDir = path.join(__dirname, 'output', conceptKey);
  await fs.mkdir(outputDir, { recursive: true });
  
  const filename = `slide_${String(slideNum).padStart(2, '0')}.png`;
  const filepath = path.join(outputDir, filename);
  await fs.writeFile(filepath, buffer);
  
  console.log(`✅ Saved: ${filepath}\n`);
  
  // Open
  const { exec } = await import('child_process');
  exec(`open "${filepath}"`);
  
  // Next command
  if (slideNum < prompts.length) {
    console.log(`📋 Next: node generate-from-prompts.js ${path.basename(promptsFile)} ${slideNum + 1}\n`);
  } else {
    console.log(`🎉 All done! Add owl:\n`);
    console.log(`   python3 add-owl-overlay.py output/${conceptKey}\n`);
  }
}

const promptsFile = process.argv[2];
const slideNum = parseInt(process.argv[3]);

if (!promptsFile || !slideNum) {
  console.log('Usage: node generate-from-prompts.js <prompts-file.json> <slide-number>\n');
  console.log('Example:');
  console.log('  node generate-from-prompts.js prompts-psych-cost.json 1\n');
  process.exit(1);
}

generateSlide(path.join(__dirname, promptsFile), slideNum);
