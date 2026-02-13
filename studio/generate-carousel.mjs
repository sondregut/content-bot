// Generate a 6-slide TikTok carousel: "Why Elite Athletes Visualize"
const BASE = 'http://localhost:4545';

const slides = [
  {
    slideType: 'photo',
    sport: 'track',
    setting: 'Olympic stadium at dawn, empty track with lane markings',
    action: 'standing still with eyes closed, hands at sides, deep breath',
    mood: 'intense focus, calm power, pre-race stillness',
    overlayStyle: 'dark gradient',
    overlayPlacement: 'bottom third',
    microLabel: 'ATHLETE MINDSET',
    headline: '93% of Olympic\nathletes do this\nbefore competing',
    highlightPhrase: 'do this',
    body: '',
    quality: 'high',
    includeOwl: true,
    owlPosition: 'bottom-right',
  },
  {
    slideType: 'text',
    backgroundStyle: 'deep navy near-black with very subtle grain texture',
    layoutTemplate: 'Layout A - Classic Left Lane',
    microLabel: 'ATHLETE MINDSET • EVIDENCE-BASED',
    headline: 'It is called\nmental rehearsal',
    highlightPhrase: 'mental rehearsal',
    body: 'Elite performers mentally simulate their race, routine, or play — in vivid detail — before they physically execute it.',
    quality: 'high',
    includeOwl: true,
    owlPosition: 'bottom-right',
    trickyWords: 'rehearsal',
  },
  {
    slideType: 'text',
    backgroundStyle: 'deep navy near-black with very subtle grain texture',
    layoutTemplate: 'Layout B - High Hook',
    microLabel: 'THE SCIENCE',
    headline: 'Visualization activates\nthe same neural\npathways as\nphysical practice',
    highlightPhrase: 'same neural pathways',
    body: 'Your brain cannot fully distinguish between a vividly imagined movement and a real one.',
    citation: 'Neuropsychologia, 2014',
    quality: 'high',
    includeOwl: true,
    owlPosition: 'bottom-right',
    trickyWords: 'visualization, Neuropsychologia',
  },
  {
    slideType: 'photo',
    sport: 'basketball',
    setting: 'practice gym with dramatic side lighting',
    action: 'at the free throw line, ball in hands, eyes closed visualizing the shot',
    mood: 'deep concentration, quiet confidence',
    overlayStyle: 'dark gradient',
    overlayPlacement: 'bottom third',
    microLabel: 'THE RESULTS',
    headline: 'Athletes who visualize\nshow 13.5% greater\nperformance gains',
    highlightPhrase: '13.5%',
    body: 'Compared to physical practice alone.',
    quality: 'high',
    includeOwl: true,
    owlPosition: 'bottom-right',
    trickyWords: 'visualize',
  },
  {
    slideType: 'text',
    backgroundStyle: 'deep navy near-black with very subtle grain texture',
    layoutTemplate: 'Layout A - Classic Left Lane',
    microLabel: 'THE PROBLEM',
    headline: 'A sports psychologist\ncosts $200/hour.\n\nMost athletes\nnever get access.',
    highlightPhrase: '$200/hour',
    body: '',
    quality: 'high',
    includeOwl: true,
    owlPosition: 'bottom-right',
    trickyWords: 'psychologist',
  },
  {
    slideType: 'text',
    backgroundStyle: 'deep navy near-black with very subtle grain texture',
    layoutTemplate: 'Layout C - Center Weighted',
    microLabel: 'ATHLETE MINDSET',
    headline: 'Your AI mental\nperformance coach.\n\nTry free today.',
    highlightPhrase: 'Try free today.',
    body: 'Science-backed visualization, breathwork, and voice coaching — built for athletes.',
    quality: 'high',
    includeOwl: true,
    owlPosition: 'bottom-right',
    trickyWords: 'athletemindset, visualization',
  },
];

async function generate(slide, index) {
  console.log(`[Slide ${index + 1}] Sending to API...`);
  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slide),
  });
  const data = await res.json();
  if (data.ok) {
    console.log(`[Slide ${index + 1}] ✓ ${data.filename} | Claude refined: ${data.usedRefined}`);
  } else {
    console.error(`[Slide ${index + 1}] ✗ ${data.error}`);
  }
  return data;
}

console.log('Generating 6-slide carousel: "Why Elite Athletes Visualize"\n');

const results = await Promise.all(slides.map((s, i) => generate(s, i)));

console.log('\n--- Summary ---');
results.forEach((r, i) => {
  if (r.ok) {
    console.log(`Slide ${i + 1}: ${BASE}${r.url}`);
  } else {
    console.log(`Slide ${i + 1}: FAILED — ${r.error}`);
  }
});
