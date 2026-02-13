// --- State ---
let brands = [];
let currentBrand = 'athlete-mindset';
let contentData = null;
let selectedIdea = null;
let currentSlideIndex = 0;
let slideEdits = [];
let generatedImages = {};
let batchJobId = null;
let pollTimer = null;
let referenceImageFilename = null;

// --- DOM refs ---
const brandSelector = document.getElementById('brand-selector');
const sidebar = document.getElementById('ideas-list');
const ideaCount = document.getElementById('idea-count');
const emptyState = document.getElementById('empty-state');
const editorArea = document.getElementById('editor-area');
const ideaBadge = document.getElementById('idea-badge');
const ideaTitle = document.getElementById('idea-title');
const slideTabs = document.getElementById('slide-tabs');
const form = document.getElementById('slide-form');
const slideTypeSelect = document.getElementById('slideType');
const photoFields = document.getElementById('photo-fields');
const textFields = document.getElementById('text-fields');
const statusEl = document.getElementById('status');
const previewImg = document.getElementById('preview-image');
const generateAllBtn = document.getElementById('generate-all-btn');
const gallerySection = document.getElementById('gallery-section');
const galleryStrip = document.getElementById('gallery-strip');
const progressSection = document.getElementById('progress-section');
const progressLabel = document.getElementById('progress-label');
const progressFill = document.getElementById('progress-fill');
const downloadButtons = document.getElementById('download-buttons');
const downloadSingleBtn = document.getElementById('download-single-btn');
const downloadAllBtn = document.getElementById('download-all-btn');
const refImageInput = document.getElementById('ref-image-input');
const refUploadBtn = document.getElementById('ref-upload-btn');
const refFilename = document.getElementById('ref-filename');
const refClearBtn = document.getElementById('ref-clear-btn');
const refPreview = document.getElementById('ref-preview');
const refOptions = document.getElementById('ref-options');
const freeformInput = document.getElementById('freeform-input');
const freeformGenerateBtn = document.getElementById('freeform-generate-btn');
const freeformStatus = document.getElementById('freeform-status');
const freeformSlideCount = document.getElementById('freeform-slide-count');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsClose = document.getElementById('settings-close');
const settingsSaveBtn = document.getElementById('settings-save-btn');
const settingsStatus = document.getElementById('settings-status');
const settingsOpenaiKey = document.getElementById('settings-openai-key');
const settingsAnthropicKey = document.getElementById('settings-anthropic-key');
const iconPreviewImg = document.getElementById('icon-preview-img');
const iconUploadBtn = document.getElementById('icon-upload-btn');
const iconFileInput = document.getElementById('icon-file-input');
const cornerPicker = document.getElementById('corner-picker');
const owlPositionInput = document.getElementById('owlPosition');

// Loading spinner refs
const loadingSpinner = document.getElementById('loading-spinner');
const spinnerText = document.getElementById('spinner-text');

// Preview mockup refs
const previewMockup = document.getElementById('preview-mockup');
const mockupMicro = document.getElementById('mockup-micro');
const mockupHeadline = document.getElementById('mockup-headline');
const mockupBody = document.getElementById('mockup-body');
const mockupPhotoPlaceholder = document.getElementById('mockup-photo-placeholder');
const mockupIconImg = document.getElementById('mockup-icon-img');

// --- Init ---
window.addEventListener('load', async () => {
  loadApiKeysFromStorage();
  try {
    const res = await fetch('/api/brands', { headers: getAuthHeaders() });
    if (res.status === 401) { window.location.href = '/login'; return; }
    const data = await res.json();
    brands = data.brands || [];
    renderBrandSelector();
  } catch (err) {
    console.error('Failed to load brands:', err);
  }
  await loadContentIdeas();
  updateIconPreview();
});

// --- API Key Settings ---
function loadApiKeysFromStorage() {
  const openai = localStorage.getItem('carousel_openai_key') || '';
  const anthropic = localStorage.getItem('carousel_anthropic_key') || '';
  settingsOpenaiKey.value = openai;
  settingsAnthropicKey.value = anthropic;
}

function getHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const authToken = localStorage.getItem('carousel_auth_token');
  if (authToken) headers['x-auth-token'] = authToken;
  const openaiKey = localStorage.getItem('carousel_openai_key');
  const anthropicKey = localStorage.getItem('carousel_anthropic_key');
  if (openaiKey) headers['x-openai-key'] = openaiKey;
  if (anthropicKey) headers['x-anthropic-key'] = anthropicKey;
  return headers;
}

function getAuthHeaders() {
  const headers = {};
  const authToken = localStorage.getItem('carousel_auth_token');
  if (authToken) headers['x-auth-token'] = authToken;
  return headers;
}

settingsBtn.addEventListener('click', () => {
  settingsModal.style.display = 'flex';
  settingsStatus.textContent = '';
  settingsStatus.className = 'settings-status';
});

settingsClose.addEventListener('click', () => {
  settingsModal.style.display = 'none';
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.style.display = 'none';
});

settingsSaveBtn.addEventListener('click', async () => {
  const openaiKey = settingsOpenaiKey.value.trim();
  const anthropicKey = settingsAnthropicKey.value.trim();

  if (openaiKey) localStorage.setItem('carousel_openai_key', openaiKey);
  else localStorage.removeItem('carousel_openai_key');

  if (anthropicKey) localStorage.setItem('carousel_anthropic_key', anthropicKey);
  else localStorage.removeItem('carousel_anthropic_key');

  // Send to server to update .env
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openaiKey, anthropicKey }),
    });
    const data = await res.json();
    if (data.ok) {
      settingsStatus.textContent = 'Keys saved and applied!';
      settingsStatus.className = 'settings-status success';
      setTimeout(() => { settingsModal.style.display = 'none'; }, 1200);
    } else {
      settingsStatus.textContent = data.error || 'Failed to save';
      settingsStatus.className = 'settings-status error';
    }
  } catch {
    // Still saved to localStorage
    settingsStatus.textContent = 'Saved to browser (server unreachable).';
    settingsStatus.className = 'settings-status success';
  }
});

// --- Brand Selector ---
function renderBrandSelector() {
  brandSelector.innerHTML = brands
    .map((b) => `<option value="${b.id}" ${b.id === currentBrand ? 'selected' : ''}>${b.name}</option>`)
    .join('');
}

brandSelector.addEventListener('change', async () => {
  currentBrand = brandSelector.value;
  selectedIdea = null;
  currentSlideIndex = 0;
  generatedImages = {};
  slideEdits = [];
  editorArea.style.display = 'none';
  emptyState.style.display = 'flex';
  await loadContentIdeas();
  updateIconPreview();
});

async function loadContentIdeas() {
  try {
    sidebar.innerHTML = '<div class="sidebar-loading">Loading ideas...</div>';
    const res = await fetch(`/api/content-ideas?brand=${currentBrand}`, { headers: getAuthHeaders() });
    contentData = await res.json();
    renderSidebar();
  } catch (err) {
    sidebar.innerHTML = '<div class="sidebar-error">Failed to load content ideas.</div>';
  }
}

// --- Sidebar ---
function renderSidebar() {
  const app = contentData.apps[0];
  if (!app) {
    sidebar.innerHTML = '<div class="sidebar-error">No content ideas found.</div>';
    ideaCount.textContent = '0 ideas';
    return;
  }

  let totalIdeas = 0;
  let html = '';

  for (const cat of app.categories) {
    html += `<div class="category-group">`;
    html += `<div class="category-header">${cat.name}</div>`;
    for (const idea of cat.ideas) {
      totalIdeas++;
      html += `<div class="idea-item" data-idea-id="${idea.id}">`;
      html += `<span class="idea-id">${idea.id}</span>`;
      html += `<span class="idea-name">${idea.title}</span>`;
      html += `<span class="idea-slides-count">${idea.slides.length}s</span>`;
      html += `</div>`;
    }
    html += `</div>`;
  }

  sidebar.innerHTML = html;
  ideaCount.textContent = `${totalIdeas} ideas`;

  sidebar.querySelectorAll('.idea-item').forEach((el) => {
    el.addEventListener('click', () => selectIdea(el.dataset.ideaId));
  });
}

// --- Idea Selection ---
function selectIdea(ideaId) {
  const app = contentData.apps[0];
  let idea = null;
  for (const cat of app.categories) {
    idea = cat.ideas.find((i) => i.id === ideaId);
    if (idea) break;
  }
  if (!idea) return;

  sidebar.querySelectorAll('.idea-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.ideaId === ideaId);
  });

  selectedIdea = idea;
  currentSlideIndex = 0;
  generatedImages = {};
  batchJobId = null;

  slideEdits = idea.slides.map((slide) => ({ ...slide }));

  emptyState.style.display = 'none';
  editorArea.style.display = 'block';

  ideaBadge.textContent = idea.id;
  ideaTitle.textContent = idea.title;

  renderSlideTabs();
  loadSlideIntoForm(0);
  updatePreviewMockup();
  updateGallery();
  progressSection.style.display = 'none';
}

// --- Load freeform-generated content as idea ---
function loadFreeformContent(data) {
  selectedIdea = {
    id: 'AI',
    title: data.title || 'Freeform Carousel',
    slides: data.slides,
  };

  currentSlideIndex = 0;
  generatedImages = {};
  batchJobId = null;

  slideEdits = data.slides.map((slide) => ({ ...slide }));

  sidebar.querySelectorAll('.idea-item').forEach((el) => el.classList.remove('active'));

  emptyState.style.display = 'none';
  editorArea.style.display = 'block';

  ideaBadge.textContent = 'AI';
  ideaTitle.textContent = data.title || 'Freeform Carousel';

  renderSlideTabs();
  loadSlideIntoForm(0);
  updatePreviewMockup();
  updateGallery();
  progressSection.style.display = 'none';
}

// --- Slide Tabs ---
function renderSlideTabs() {
  let html = '';
  for (let i = 0; i < slideEdits.length; i++) {
    const s = slideEdits[i];
    const active = i === currentSlideIndex ? 'active' : '';
    const generated = generatedImages[i] ? 'generated' : '';
    const typeIcon = s.type === 'photo' ? 'P' : 'T';
    html += `<button class="slide-tab ${active} ${generated}" data-index="${i}">`;
    html += `<span class="tab-num">${s.number}</span>`;
    html += `<span class="tab-type">${typeIcon}</span>`;
    html += `<span class="tab-label">${s.label || ''}</span>`;
    html += `</button>`;
  }
  slideTabs.innerHTML = html;

  slideTabs.querySelectorAll('.slide-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      saveCurrentSlideEdits();
      const idx = parseInt(tab.dataset.index);
      currentSlideIndex = idx;
      renderSlideTabs();
      loadSlideIntoForm(idx);
      updatePreviewMockup();
    });
  });
}

// --- Form <-> Slide Data ---
function loadSlideIntoForm(index) {
  const slide = slideEdits[index];
  if (!slide) return;

  slideTypeSelect.value = slide.type || 'text';
  form.elements.slideLabel.value = slide.label || '';
  form.elements.microLabel.value = slide.microLabel || '';
  form.elements.headline.value = slide.headline || '';
  form.elements.body.value = slide.body || '';
  form.elements.highlightPhrase.value = slide.highlight || '';

  form.elements.sport.value = slide.sport || '';
  form.elements.setting.value = slide.setting || '';
  form.elements.action.value = slide.action || '';
  form.elements.mood.value = slide.mood || '';

  toggleTypeFields();

  if (generatedImages[index]) {
    previewImg.src = generatedImages[index].url;
    previewImg.style.display = 'block';
    downloadButtons.style.display = 'flex';
    statusEl.textContent = `Slide ${index + 1} generated.`;
  } else {
    previewImg.style.display = 'none';
    downloadButtons.style.display = 'none';
    statusEl.textContent = 'Ready.';
  }
}

function saveCurrentSlideEdits() {
  const slide = slideEdits[currentSlideIndex];
  if (!slide) return;

  slide.type = slideTypeSelect.value;
  slide.label = form.elements.slideLabel.value;
  slide.microLabel = form.elements.microLabel.value;
  slide.headline = form.elements.headline.value;
  slide.body = form.elements.body.value;
  slide.highlight = form.elements.highlightPhrase.value;

  if (slide.type === 'photo') {
    slide.sport = form.elements.sport.value;
    slide.setting = form.elements.setting.value;
    slide.action = form.elements.action.value;
    slide.mood = form.elements.mood.value;
  }
}

function toggleTypeFields() {
  const isPhoto = slideTypeSelect.value === 'photo';
  photoFields.style.display = isPhoto ? 'block' : 'none';
  textFields.style.display = isPhoto ? 'none' : 'block';
}

slideTypeSelect.addEventListener('change', () => {
  toggleTypeFields();
  updatePreviewMockup();
});

// Live preview update on form input
['microLabel', 'headline', 'body', 'highlightPhrase', 'slideLabel'].forEach((name) => {
  const el = form.elements[name];
  if (el) el.addEventListener('input', updatePreviewMockup);
});

// --- Preview Mockup ---
function updatePreviewMockup() {
  const slide = slideEdits[currentSlideIndex];
  if (!slide) return;

  // Get current form values
  const microLabel = form.elements.microLabel?.value || slide.microLabel || '';
  const headline = form.elements.headline?.value || slide.headline || '';
  const body = form.elements.body?.value || slide.body || '';
  const highlight = form.elements.highlightPhrase?.value || slide.highlight || '';
  const isPhoto = (form.elements.slideType?.value || slide.type) === 'photo';

  // Get brand colors
  const brand = brands.find((b) => b.id === currentBrand);
  const accentColor = brand?.colors?.accent || '#73a6d1';
  const primaryColor = brand?.colors?.primary || '#072f57';

  // Update mockup background based on type
  if (isPhoto) {
    previewMockup.classList.add('photo-type');
    previewMockup.style.background = '';
    mockupPhotoPlaceholder.style.display = 'flex';
  } else {
    previewMockup.classList.remove('photo-type');
    previewMockup.style.background = primaryColor;
    mockupPhotoPlaceholder.style.display = 'none';
  }

  // Update text content
  mockupMicro.textContent = microLabel;
  mockupMicro.style.color = accentColor;

  // Headline with highlight
  if (highlight && headline.includes(highlight)) {
    const parts = headline.split(highlight);
    mockupHeadline.innerHTML = parts[0] +
      `<span class="highlight" style="color:${accentColor}">${highlight}</span>` +
      (parts[1] || '');
  } else {
    mockupHeadline.textContent = headline;
  }

  mockupBody.textContent = body;

  // Icon position
  const mockupIcon = document.getElementById('mockup-icon');
  const pos = owlPositionInput.value;
  mockupIcon.style.top = pos.includes('top') ? '8px' : '';
  mockupIcon.style.bottom = pos.includes('bottom') ? '8px' : '';
  mockupIcon.style.left = pos.includes('left') ? '8px' : '';
  mockupIcon.style.right = pos.includes('right') ? '8px' : '';
}

// --- Icon Upload & Corner Picker ---
function updateIconPreview() {
  const iconUrl = `/brands/${currentBrand}/assets/app-icon.png?t=${Date.now()}`;
  iconPreviewImg.src = iconUrl;
  mockupIconImg.src = iconUrl;

  // Handle missing icon gracefully
  iconPreviewImg.onerror = () => { iconPreviewImg.style.display = 'none'; };
  iconPreviewImg.onload = () => { iconPreviewImg.style.display = 'block'; };
  mockupIconImg.onerror = () => { mockupIconImg.style.display = 'none'; };
  mockupIconImg.onload = () => { mockupIconImg.style.display = 'block'; };
}

iconUploadBtn.addEventListener('click', () => iconFileInput.click());

iconFileInput.addEventListener('change', async () => {
  const file = iconFileInput.files[0];
  if (!file) return;

  const fd = new FormData();
  fd.append('icon', file);
  fd.append('brand', currentBrand);

  try {
    const res = await fetch('/api/upload-icon', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.ok) {
      updateIconPreview();
    }
  } catch (err) {
    console.error('Icon upload failed:', err);
  }
  iconFileInput.value = '';
});

// Corner picker
cornerPicker.querySelectorAll('.corner-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    cornerPicker.querySelectorAll('.corner-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    owlPositionInput.value = btn.dataset.pos;
    updatePreviewMockup();
  });
});

// --- Reference Image Upload ---
refUploadBtn.addEventListener('click', () => refImageInput.click());

refImageInput.addEventListener('change', async () => {
  const file = refImageInput.files[0];
  if (!file) return;

  refFilename.textContent = 'Uploading...';
  const fd = new FormData();
  fd.append('image', file);

  try {
    const res = await fetch('/api/upload-reference', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.ok) {
      referenceImageFilename = data.filename;
      refFilename.textContent = file.name;
      refPreview.src = data.url;
      refPreview.style.display = 'block';
      refClearBtn.style.display = 'inline-block';
      refOptions.style.display = 'block';
    } else {
      refFilename.textContent = 'Upload failed';
    }
  } catch {
    refFilename.textContent = 'Upload error';
  }
});

refClearBtn.addEventListener('click', () => {
  referenceImageFilename = null;
  refFilename.textContent = 'No image';
  refPreview.style.display = 'none';
  refClearBtn.style.display = 'none';
  refOptions.style.display = 'none';
  refImageInput.value = '';
});

// --- Build payload ---
function buildSlidePayload(slide) {
  const payload = {
    slideType: slide.type || 'text',
    microLabel: slide.microLabel || '',
    headline: slide.headline || '',
    body: slide.body || '',
    highlightPhrase: slide.highlight || '',
    includeOwl: form.elements.includeOwl.checked,
    owlPosition: owlPositionInput.value,
    quality: form.elements.quality.value,
    brand: currentBrand,
  };

  if (payload.slideType === 'photo') {
    payload.sport = slide.sport || 'track';
    payload.setting = slide.setting || 'empty stadium at dusk';
    payload.action = slide.action || 'head down, slow breathing';
    payload.mood = slide.mood || 'calm intensity, disciplined';
    payload.overlayStyle = form.elements.overlayStyle?.value || 'dark gradient';
    payload.overlayPlacement = form.elements.overlayPlacement?.value || 'bottom third';
  } else {
    payload.backgroundStyle = form.elements.backgroundStyle?.value || 'dark premium navy/near-black with very subtle grain';
    payload.layoutTemplate = form.elements.layoutTemplate?.value || 'Layout A - Classic Left Lane';
  }

  if (referenceImageFilename) {
    payload.referenceImage = referenceImageFilename;
    payload.referenceUsage = form.elements.referenceUsage?.value || 'background inspiration';
    payload.referenceInstructions = form.elements.referenceInstructions?.value || '';
  }

  return payload;
}

// --- Generate Single Slide ---
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  saveCurrentSlideEdits();

  const slide = slideEdits[currentSlideIndex];
  const payload = buildSlidePayload(slide);

  statusEl.textContent = `Generating slide ${currentSlideIndex + 1}...`;
  previewImg.style.display = 'none';
  downloadButtons.style.display = 'none';
  loadingSpinner.classList.add('active');
  spinnerText.textContent = `Generating slide ${currentSlideIndex + 1}...`;

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');

    generatedImages[currentSlideIndex] = { url: data.url, filename: data.filename };
    previewImg.src = data.url;
    previewImg.style.display = 'block';
    downloadButtons.style.display = 'flex';
    statusEl.textContent = data.usedRefined
      ? `Slide ${currentSlideIndex + 1} done (Claude-refined).`
      : `Slide ${currentSlideIndex + 1} done.`;

    renderSlideTabs();
    updateGallery();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    loadingSpinner.classList.remove('active');
  }
});

// --- Download Single ---
downloadSingleBtn.addEventListener('click', () => {
  const gen = generatedImages[currentSlideIndex];
  if (!gen) return;
  const a = document.createElement('a');
  a.href = `/api/download/${gen.filename}`;
  a.download = gen.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

// --- Download All as ZIP ---
downloadAllBtn.addEventListener('click', async () => {
  const filenames = [];
  for (let i = 0; i < slideEdits.length; i++) {
    if (generatedImages[i]?.filename) {
      filenames.push(generatedImages[i].filename);
    }
  }
  if (filenames.length === 0) return;

  if (batchJobId) {
    window.location.href = `/api/download-carousel/${batchJobId}`;
    return;
  }

  const res = await fetch('/api/download-selected', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames, brandId: currentBrand }),
  });
  if (!res.ok) return;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentBrand}_carousel.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// --- Generate All Slides (batch) ---
generateAllBtn.addEventListener('click', async () => {
  if (!selectedIdea || slideEdits.length === 0) return;
  saveCurrentSlideEdits();

  const slides = slideEdits.map((s) => buildSlidePayload(s));
  const payload = {
    slides,
    includeOwl: form.elements.includeOwl.checked,
    owlPosition: owlPositionInput.value,
    quality: form.elements.quality.value,
    brand: currentBrand,
  };

  progressSection.style.display = 'block';
  progressFill.style.width = '0%';
  progressLabel.textContent = `Starting batch generation (${slides.length} slides)...`;
  generateAllBtn.disabled = true;

  try {
    const res = await fetch('/api/generate-carousel', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Batch start failed');

    batchJobId = data.jobId;
    startPolling();
  } catch (err) {
    statusEl.textContent = `Batch error: ${err.message}`;
    generateAllBtn.disabled = false;
    progressSection.style.display = 'none';
  }
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollBatchStatus, 2000);
}

async function pollBatchStatus() {
  if (!batchJobId) return;

  try {
    const res = await fetch(`/api/carousel-status/${batchJobId}`);
    const job = await res.json();

    const pct = job.total > 0 ? Math.round((job.completed / job.total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
    progressLabel.textContent = `Generating slide ${job.current} of ${job.total}... (${job.completed} done)`;

    for (const slide of job.slides) {
      if (slide.ok && slide.url) {
        const idx = slide.slideNumber - 1;
        generatedImages[idx] = { url: slide.url, filename: slide.filename };
      }
    }
    renderSlideTabs();
    updateGallery();

    if (generatedImages[currentSlideIndex]) {
      previewImg.src = generatedImages[currentSlideIndex].url;
      previewImg.style.display = 'block';
      downloadButtons.style.display = 'flex';
    }

    if (job.status === 'done') {
      clearInterval(pollTimer);
      pollTimer = null;
      generateAllBtn.disabled = false;

      const succeeded = job.slides.filter((s) => s.ok).length;
      progressLabel.textContent = `Done! ${succeeded}/${job.total} slides generated.`;
      statusEl.textContent = `Batch complete: ${succeeded}/${job.total} slides.`;

      setTimeout(() => { progressSection.style.display = 'none'; }, 5000);
    }
  } catch (err) {
    console.error('Poll error:', err);
  }
}

// --- Gallery ---
function updateGallery() {
  const keys = Object.keys(generatedImages);
  if (keys.length === 0) {
    gallerySection.style.display = 'none';
    return;
  }

  gallerySection.style.display = 'block';
  let html = '';
  for (let i = 0; i < slideEdits.length; i++) {
    const gen = generatedImages[i];
    if (gen) {
      html += `<div class="gallery-thumb ${i === currentSlideIndex ? 'active' : ''}" data-index="${i}">`;
      html += `<img src="${gen.url}" alt="Slide ${i + 1}" />`;
      html += `<span class="thumb-num">${i + 1}</span>`;
      html += `<button class="thumb-download" data-filename="${gen.filename}" title="Download">&#8681;</button>`;
      html += `</div>`;
    } else {
      html += `<div class="gallery-thumb empty" data-index="${i}">`;
      html += `<span class="thumb-num">${i + 1}</span>`;
      html += `</div>`;
    }
  }
  galleryStrip.innerHTML = html;

  galleryStrip.querySelectorAll('.gallery-thumb').forEach((thumb) => {
    thumb.addEventListener('click', (e) => {
      if (e.target.classList.contains('thumb-download')) return;
      saveCurrentSlideEdits();
      const idx = parseInt(thumb.dataset.index);
      currentSlideIndex = idx;
      renderSlideTabs();
      loadSlideIntoForm(idx);
      updatePreviewMockup();
    });
  });

  galleryStrip.querySelectorAll('.thumb-download').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const filename = btn.dataset.filename;
      const a = document.createElement('a');
      a.href = `/api/download/${filename}`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  });
}

// --- Freeform AI Generation ---
freeformGenerateBtn.addEventListener('click', async () => {
  const prompt = freeformInput.value.trim();
  if (!prompt) {
    freeformStatus.textContent = 'Please enter a description.';
    return;
  }

  freeformGenerateBtn.disabled = true;
  freeformStatus.textContent = 'Generating slide content with Claude...';

  try {
    const res = await fetch('/api/generate-freeform', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        prompt,
        brand: currentBrand,
        slideCount: freeformSlideCount.value,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');

    freeformStatus.textContent = `Generated ${data.slides?.length || 0} slides. Loading into editor...`;

    // Load the AI-generated content into the editor
    loadFreeformContent(data);

    freeformStatus.textContent = '';
  } catch (err) {
    freeformStatus.textContent = `Error: ${err.message}`;
  } finally {
    freeformGenerateBtn.disabled = false;
  }
});
