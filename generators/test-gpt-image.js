#!/usr/bin/env node
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';

const API_KEY_PATH = path.join(process.env.HOME, '.openclaw/credentials/openai-tiktok.key');
const API_KEY = (await fs.readFile(API_KEY_PATH, 'utf-8')).trim();

const openai = new OpenAI({ apiKey: API_KEY });

console.log('Testing gpt-image-1.5...\n');

try {
  const response = await openai.images.generate({
    model: 'gpt-image-1.5',
    prompt: 'Vertical infographic: "$200" in huge bold text, solid navy background',
    n: 1,
    size: '1024x1536',
    quality: 'high',
  });
  
  console.log('Success! Response structure:');
  console.log(JSON.stringify(response, null, 2));
} catch (error) {
  console.error('Error:', error.message);
  console.error('\nFull error:', error);
}
