#!/usr/bin/env node
/**
 * Two-step carousel generation:
 * 1. Claude Opus 4.6 writes detailed image prompts
 * 2. GPT Image 1.5 generates the images
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load API keys
const OPENAI_KEY_PATH = path.join(process.env.HOME, '.openclaw/credentials/openai-tiktok.key');
const OPENAI_KEY = (await fs.readFile(OPENAI_KEY_PATH, 'utf-8')).trim();

// Anthropic key from environment or default location
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_KEY });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// Carousel concepts (content only - Opus will create prompts)
const CONCEPTS = {
  'psych-cost': {
    name: 'Sports Psych $200 vs $8',
    slides: [
      { content: 'Hook: Sports psychologist charges $200 per session', style: 'shocking price reveal' },
      { content: 'I need mental training to compete', style: 'athlete pain point' },
      { content: 'But $800/month is too expensive', style: 'barrier/problem' },
      { content: 'Found AI alternative', style: 'solution discovery' },
      { content: '24/7 access anytime', style: 'benefit highlight' },
      { content: 'Only $8.33 per month', style: 'price comparison win' },
      { content: 'Try Athlete Mindset free - athletemindset.app', style: 'CTA' },
    ],
  },
  
  'breakthrough': {
    name: 'Mental Breakthrough Story',
    slides: [
      { content: 'I kept choking in competition', style: 'relatable problem' },
      { content: 'Perfect in practice, fail in games', style: 'contrast/frustration' },
      { content: 'Mental block holding me back', style: 'diagnosis' },
      { content: '5 minutes daily visualization', style: 'simple solution' },
      { content: 'Finally broke through', style: 'transformation moment' },
      { content: 'Your mental game needs training', style: 'direct call-out' },
      { content: 'athletemindset.app - start now', style: 'CTA' },
    ],
  },
  
  'science': {
    name: '90% of Olympians Use This',
    slides: [
      { content: '90% of Olympic athletes use mental imagery', style: 'authority stat' },
      { content: '16% performance improvement proven', style: 'data/results' },
      { content: 'Activates same brain regions as physical practice', style: 'science explanation' },
      { content: 'But most athletes never learn it', style: 'missed opportunity' },
      { content: 'Sports psychologists cost $150-300/session', style: 'barrier' },
      { content: 'AI coach makes it accessible', style: 'solution' },
      { content: 'Start free trial - athletemindset.app', style: 'CTA' },
    ],
  },
};

const BRAND_GUIDELINES = `
## Athlete Mindset Brand Context
- Target: Athletes (all sports, college to pro level)
- Value prop: AI sports psychologist, $8.33/mo vs $200/session
- Tone: Authoritative but accessible, performance-focused
- Colors: Purple/blue gradients, navy, athletic bold colors
- Founder: Sondre Guttormsen (Olympic pole vaulter)

## TikTok Carousel Best Practices
- Format: 1024x1536 vertical (9:16 ratio)
- Style: Bold infographic, clean minimalist
- Text: Large, readable, high contrast
- One key message per slide
- Hook in first 3 slides
- 5-7 slides optimal

## Design Rules
- Bold readable typography as PRIMARY element
- Simple solid colors or clean gradients
- Minimal icons/graphics (support text, don't distract)
- Professional but engaging aesthetic
- Text must be crystal clear on mobile
- Each slide = one powerful statement
`;

async function generatePromptsWithOpus(concept) {
  console.log(`\n🧠 Claude Opus 4.6 creating prompts for: ${concept.name}\n`);
  
  const userMessage = `Create detailed image generation prompts for a ${concept.slides.length}-slide TikTok carousel about "${concept.name}".

Each slide should be a vertical mobile infographic (1024x1536) following these content/style pairs:

${concept.slides.map((s, i) => `${i + 1}. ${s.content} (${s.style})`).join('\n')}

${BRAND_GUIDELINES}

For each slide, write a detailed prompt for GPT Image 1.5 that describes:
- The exact text to display (large, bold, readable)
- Background (solid color or gradient with specific colors)
- Any minimal icons/graphics (simple, supporting)
- Typography style (bold, size, placement)
- Overall mood/emotion

Make the text MORE prominent and detailed than a typical infographic. Each slide needs 1-2 key phrases in huge bold letters.

Format your response as JSON:
{
  "prompts": [
    "slide 1 detailed prompt here",
    "slide 2 detailed prompt here",
    ...
  ]
}`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-20250514',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: userMessage,
    }],
  });
  
  const text = response.content[0].text;
  
  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*"prompts"[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to extract JSON from Opus response');
  }
  
  const parsed = JSON.parse(jsonMatch[0]);
  return parsed.prompts;
}

async function generateImage(prompt, outputPath) {
  const response = await openai.images.generate({
    model: 'gpt-image-1.5',
    prompt: prompt,
    n: 1,
    size: '1024x1536',
    quality: 'high',
  });
  
  const b64Data = response.data[0].b64_json;
  const buffer = Buffer.from(b64Data, 'base64');
  await fs.writeFile(outputPath, buffer);
}

async function generateCarousel(conceptKey, slideNum = null) {
  const concept = CONCEPTS[conceptKey];
  if (!concept) {
    console.error(`Unknown concept: ${conceptKey}`);
    console.log('Available:', Object.keys(CONCEPTS).join(', '));
    process.exit(1);
  }
  
  // Step 1: Opus creates prompts
  const prompts = await generatePromptsWithOpus(concept);
  
  console.log(`✅ Opus created ${prompts.length} prompts\n`);
  
  // Save prompts for reference
  const outputDir = path.join(__dirname, 'output', conceptKey);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'prompts.json'),
    JSON.stringify({ concept: concept.name, prompts }, null, 2)
  );
  
  // Step 2: Generate specific slide or all
  if (slideNum !== null) {
    // Single slide
    const idx = slideNum - 1;
    if (idx < 0 || idx >= prompts.length) {
      console.error(`Invalid slide number. Concept has ${prompts.length} slides.`);
      process.exit(1);
    }
    
    console.log(`🎨 Generating slide ${slideNum}/${prompts.length}...\n`);
    const filename = `slide_${String(slideNum).padStart(2, '0')}.png`;
    const filepath = path.join(outputDir, filename);
    await generateImage(prompts[idx], filepath);
    console.log(`✅ ${filepath}\n`);
    
    // Open it
    const { exec } = await import('child_process');
    exec(`open "${filepath}"`);
    
    if (slideNum < prompts.length) {
      console.log(`📋 Next: node generate-with-opus.js ${conceptKey} ${slideNum + 1}\n`);
    } else {
      console.log(`🎉 All done! Add owl: python3 add-owl-overlay.py output/${conceptKey}\n`);
    }
  } else {
    // All slides
    console.log(`🎨 Generating all ${prompts.length} slides...\n`);
    for (let i = 0; i < prompts.length; i++) {
      const filename = `slide_${String(i + 1).padStart(2, '0')}.png`;
      const filepath = path.join(outputDir, filename);
      await generateImage(prompts[i], filepath);
      console.log(`✅ ${filename}`);
      
      if (i < prompts.length - 1) {
        console.log('⏳ 3s...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    console.log(`\n🦉 Add owl: python3 add-owl-overlay.py output/${conceptKey}\n`);
  }
}

const conceptKey = process.argv[2];
const slideNum = process.argv[3] ? parseInt(process.argv[3]) : null;

if (!conceptKey) {
  console.log('Usage: node generate-with-opus.js <concept> [slide-number]\n');
  console.log('Examples:');
  console.log('  node generate-with-opus.js psych-cost 1     # Generate slide 1');
  console.log('  node generate-with-opus.js psych-cost       # Generate all slides\n');
  console.log('Available concepts:');
  Object.entries(CONCEPTS).forEach(([key, c]) => {
    console.log(`  ${key.padEnd(15)} - ${c.name} (${c.slides.length} slides)`);
  });
  process.exit(1);
}

generateCarousel(conceptKey, slideNum);
