#!/usr/bin/env node
/**
 * TikTok Slideshow Generator for Athlete Mindset
 * Generates carousel-style slides using OpenAI Image API
 * 
 * Usage: node generator.js <concept-name>
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

// Slideshow concepts (viral hook formulas)
const CONCEPTS = {
  'sports-psych-cost': {
    name: 'Sports Psych Costs $200/Session',
    slides: [
      {
        text: 'My sports psychologist charges $200 per session',
        style: 'bold white text on dark background, dramatic lighting',
      },
      {
        text: 'I need mental training to compete at my best',
        style: 'athlete looking stressed, training environment',
      },
      {
        text: 'But I can\'t afford $800/month for weekly sessions',
        style: 'calculator showing expensive costs, money stress',
      },
      {
        text: 'Then I found an AI sports psychologist...',
        style: 'phone showing Athlete Mindset app, hopeful lighting',
      },
      {
        text: 'Same visualization & mental training',
        style: 'split screen: real psych session vs app interface',
      },
      {
        text: 'Available 24/7 whenever I need it',
        style: 'athlete using app at different times/places',
      },
      {
        text: 'For $8.33 per month',
        style: 'price comparison: $200 vs $8.33, clear savings',
      },
      {
        text: 'Every athlete deserves access to mental training',
        style: 'diverse athletes training mentally, inspiring tone',
      },
      {
        text: 'Try Athlete Mindset free for 3 days',
        style: 'app logo, call-to-action, athletemindset.app text',
      },
    ],
  },
  
  'visualization-science': {
    name: '90% of Olympians Use This',
    slides: [
      {
        text: '90% of Olympic athletes use mental imagery',
        style: 'Olympic rings, statistics overlay, authoritative',
      },
      {
        text: 'It activates the same brain regions as physical practice',
        style: 'brain scan showing activation, scientific visual',
      },
      {
        text: '16% performance improvement when added to training',
        style: 'graph showing performance increase, data-driven',
      },
      {
        text: 'But most athletes never learn how to do it properly',
        style: 'confused athlete, missed opportunity feeling',
      },
      {
        text: 'Sports psychologists teach visualization...',
        style: 'professional psych session, expensive vibe',
      },
      {
        text: 'But cost $150-300 per session',
        style: 'price tag, barrier to entry',
      },
      {
        text: 'Now there\'s an AI coach that guides you through it',
        style: 'phone with Athlete Mindset, accessible technology',
      },
      {
        text: 'Sport-specific visualization scripts',
        style: 'examples: track, basketball, swimming visualizations',
      },
      {
        text: 'Built by an Olympian who uses it himself',
        style: 'Sondre competing (if you have photos), credibility',
      },
      {
        text: 'Start training your mind today - athletemindset.app',
        style: 'app logo, strong call-to-action',
      },
    ],
  },
  
  'breakthrough-story': {
    name: 'I Finally Broke Through',
    slides: [
      {
        text: 'I kept choking in competition',
        style: 'athlete looking defeated after competition',
      },
      {
        text: 'My training was perfect, but my mind wasn\'t',
        style: 'training footage vs competition stress',
      },
      {
        text: 'I\'d psych myself out before big moments',
        style: 'anxious athlete, mental struggle visualization',
      },
      {
        text: 'My coach said I needed a sports psychologist',
        style: 'coach talking to athlete, serious conversation',
      },
      {
        text: 'But sessions were $200 and weeks out',
        style: 'calendar showing wait time, expensive invoice',
      },
      {
        text: 'I tried Athlete Mindset instead',
        style: 'phone showing app, moment of hope',
      },
      {
        text: '5 minutes of visualization before competing',
        style: 'athlete doing mental training with app',
      },
      {
        text: 'I finally performed the way I knew I could',
        style: 'athlete succeeding in competition, breakthrough moment',
      },
      {
        text: 'Your mental game is holding you back',
        style: 'direct message, bold statement',
      },
      {
        text: 'Train it like you train your body',
        style: 'app logo, athletemindset.app, empowering tone',
      },
    ],
  },
  
  'elite-secret': {
    name: 'The Elite Athlete Secret',
    slides: [
      {
        text: 'What separates elite athletes from everyone else?',
        style: 'Olympic podium, championship moment, epic',
      },
      {
        text: 'It\'s not more physical training',
        style: 'athlete training hard, already at peak',
      },
      {
        text: 'It\'s not genetics or talent',
        style: 'cross out genetics/talent, dispelling myth',
      },
      {
        text: 'It\'s mental training',
        style: 'athlete in focused meditation/visualization',
      },
      {
        text: 'Every pro athlete I know has a sports psychologist',
        style: 'professional athlete with mental coach',
      },
      {
        text: 'Because your mind is your competitive advantage',
        style: 'brain highlighted, competitive edge visual',
      },
      {
        text: 'But most athletes can\'t access this',
        style: 'locked door, expensive barrier',
      },
      {
        text: 'Until now',
        style: 'door opening, breakthrough moment',
      },
      {
        text: 'AI-powered mental training for every athlete',
        style: 'Athlete Mindset app interface, accessible',
      },
      {
        text: 'Start your 3-day free trial - athletemindset.app',
        style: 'app logo, clear CTA',
      },
    ],
  },
  
  'before-after': {
    name: 'Before vs After Mental Training',
    slides: [
      {
        text: 'BEFORE mental training:',
        style: 'bold header, red/negative color scheme',
      },
      {
        text: 'Nervous before competitions',
        style: 'anxious athlete, stressed body language',
      },
      {
        text: 'Inconsistent performances',
        style: 'graph showing up and down results',
      },
      {
        text: 'Overthinking during competition',
        style: 'athlete distracted, in their head',
      },
      {
        text: 'AFTER mental training:',
        style: 'bold header, green/positive color scheme',
      },
      {
        text: 'Confident and focused',
        style: 'athlete calm and ready, controlled energy',
      },
      {
        text: 'Consistent peak performance',
        style: 'graph showing steady high performance',
      },
      {
        text: 'In the zone when it matters',
        style: 'athlete in flow state, competing well',
      },
      {
        text: 'The difference? 5 minutes a day',
        style: 'phone with app, simple commitment',
      },
      {
        text: 'Get Athlete Mindset - athletemindset.app',
        style: 'app logo, strong finish',
      },
    ],
  },
};

/**
 * Generate a single slide image
 */
async function generateSlide(slideData, index, conceptName) {
  const prompt = `
Create a TikTok-style vertical slide (1080x1920px) for a sports mental training app called "Athlete Mindset".

Text to display: "${slideData.text}"

Visual style: ${slideData.style}

Design requirements:
- Vertical format optimized for TikTok (9:16 ratio)
- Bold, high-contrast text that's readable on mobile
- Professional but engaging aesthetic
- Sports/athletic theme
- Modern minimalist design
- Text should be primary focus and extremely legible
- Background should complement but not distract from text
- Use athletic imagery, gradients, or abstract backgrounds
- Include subtle Athlete Mindset branding if appropriate

This is slide ${index + 1} in a sequence about: ${conceptName}
`.trim();

  console.log(`Generating slide ${index + 1}: "${slideData.text.substring(0, 40)}..."`);

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt: prompt,
    n: 1,
    size: '1024x1792', // Closest to 9:16 ratio
    quality: 'standard',
  });

  return response.data[0].url;
}

/**
 * Download image from URL
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

  console.log(`\n🎬 Generating slideshow: ${concept.name}`);
  console.log(`📊 Total slides: ${concept.slides.length}\n`);

  // Create output directory
  const outputDir = path.join(__dirname, 'output', conceptKey);
  await fs.mkdir(outputDir, { recursive: true });

  // Generate each slide
  const urls = [];
  for (let i = 0; i < concept.slides.length; i++) {
    try {
      const url = await generateSlide(concept.slides[i], i, concept.name);
      urls.push(url);
      
      // Download image
      const filename = `slide_${String(i + 1).padStart(2, '0')}.png`;
      const filepath = path.join(outputDir, filename);
      await downloadImage(url, filepath);
      
      console.log(`✅ Saved: ${filename}`);
      
      // Rate limiting (DALL-E has limits)
      if (i < concept.slides.length - 1) {
        console.log('⏳ Waiting 2s before next slide...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) {
      console.error(`❌ Error generating slide ${i + 1}:`, error.message);
      throw error;
    }
  }

  // Save metadata
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

  console.log(`\n✨ Complete! Slides saved to: ${outputDir}`);
  console.log(`📝 Upload these ${concept.slides.length} images to TikTok in order\n`);
}

// CLI
const conceptKey = process.argv[2];

if (!conceptKey) {
  console.log('Usage: node generator.js <concept-key>\n');
  console.log('Available concepts:');
  Object.entries(CONCEPTS).forEach(([key, concept]) => {
    console.log(`  ${key.padEnd(20)} - ${concept.name}`);
  });
  process.exit(1);
}

generateSlideshow(conceptKey);
