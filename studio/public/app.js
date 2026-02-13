// --- Firebase Auth ---
async function getIdToken() {
  const user = firebase.auth().currentUser;
  if (!user) return null;
  return user.getIdToken();
}

async function authFetch(url, opts = {}) {
  const token = await getIdToken();
  if (!opts.headers) opts.headers = {};
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (!opts.headers['Content-Type'] && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
  }
  // FormData sets its own Content-Type with boundary
  if (opts.body instanceof FormData) {
    delete opts.headers['Content-Type'];
  }
  return fetch(url, opts);
}

// Auth state listener
firebase.auth().onAuthStateChanged(async (user) => {
  const overlay = document.getElementById('login-overlay');
  const appShell = document.getElementById('app-shell');

  if (user) {
    overlay.style.display = 'none';
    appShell.style.display = 'flex';
    // Init app
    loadApiKeysFromStorage();
    try {
      const res = await authFetch('/api/brands');
      const data = await res.json();
      brands = data.brands || [];
      renderBrandSelector();
    } catch (err) {
      console.error('Failed to load brands:', err);
    }
    await loadContentIdeas();
    updateIconPreview();
  } else {
    overlay.style.display = 'flex';
    appShell.style.display = 'none';
  }
});

// Login / Create Account toggle
let isSignUp = false;
const loginBtn = document.getElementById('login-btn');
const authToggleBtn = document.getElementById('auth-toggle-btn');
const authToggleText = document.getElementById('auth-toggle-text');
const loginSubtitle = document.getElementById('login-subtitle');

authToggleBtn.addEventListener('click', () => {
  isSignUp = !isSignUp;
  loginBtn.textContent = isSignUp ? 'Create Account' : 'Sign In';
  authToggleBtn.textContent = isSignUp ? 'Sign In' : 'Create Account';
  authToggleText.textContent = isSignUp ? 'Already have an account?' : "Don't have an account?";
  loginSubtitle.textContent = isSignUp ? 'Create a new account.' : 'Sign in to continue.';
  document.getElementById('login-error').textContent = '';
});

// Login handlers
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  errEl.textContent = '';
  try {
    if (isSignUp) {
      await firebase.auth().createUserWithEmailAndPassword(email, password);
    } else {
      await firebase.auth().signInWithEmailAndPassword(email, password);
    }
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('google-login-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await firebase.auth().signInWithPopup(provider);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('sign-out-btn').addEventListener('click', async () => {
  await firebase.auth().signOut();
});

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
let screenshotImageFilename = null;

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
const mockupFields = document.getElementById('mockup-fields');
const mockupLayoutSelect = document.getElementById('mockupLayout');
const mockupThemeSelect = document.getElementById('mockupTheme');
const mockupPhoneOptions = document.getElementById('mockup-phone-options');
const mockupFigureOptions = document.getElementById('mockup-figure-options');
const mockupBgOptions = document.getElementById('mockup-bg-options');
const mockupImageUploadSection = document.getElementById('mockup-image-upload-section');
const imageUsageSelect = document.getElementById('imageUsage');
const screenshotImageInput = document.getElementById('screenshot-image-input');
const screenshotUploadBtn = document.getElementById('screenshot-upload-btn');
const screenshotFilename = document.getElementById('screenshot-filename');
const screenshotClearBtn = document.getElementById('screenshot-clear-btn');
const screenshotPreview = document.getElementById('screenshot-preview');
const screenshotWarning = document.getElementById('screenshot-warning');
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

// --- Init (handled by onAuthStateChanged above) ---

// --- API Key Settings ---
function loadApiKeysFromStorage() {
  const openai = localStorage.getItem('carousel_openai_key') || '';
  const anthropic = localStorage.getItem('carousel_anthropic_key') || '';
  settingsOpenaiKey.value = openai;
  settingsAnthropicKey.value = anthropic;
}

// Headers are now handled by authFetch — these are kept for localStorage key storage only
function getHeaders() {
  return { 'Content-Type': 'application/json' };
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
    const res = await authFetch('/api/settings', {
      method: 'POST',
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
    const res = await authFetch(`/api/content-ideas?brand=${currentBrand}`);
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
    const typeIcon = s.type === 'photo' ? 'P' : s.type === 'mockup' ? 'M' : 'T';
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

  // Mockup fields
  mockupLayoutSelect.value = slide.mockupLayout || 'phone-right';
  mockupThemeSelect.value = slide.mockupTheme || 'dark';
  imageUsageSelect.value = slide.imageUsage || 'phone';
  if (form.elements.phoneAngle) form.elements.phoneAngle.value = slide.phoneAngle || '-8';
  if (form.elements.phoneSize) form.elements.phoneSize.value = slide.phoneSize || 'medium';
  if (form.elements.highlightStyle) form.elements.highlightStyle.value = slide.highlightStyle || 'subtle';
  if (form.elements.figurePosition) form.elements.figurePosition.value = slide.figurePosition || 'center-right';
  if (form.elements.figureSize) form.elements.figureSize.value = slide.figureSize || 'medium';
  if (form.elements.figureBorderRadius) form.elements.figureBorderRadius.value = slide.figureBorderRadius || '24';
  if (form.elements.bgOverlayOpacity) form.elements.bgOverlayOpacity.value = slide.bgOverlayOpacity || '0.55';

  // Restore screenshot state
  if (slide.screenshotImage) {
    screenshotImageFilename = slide.screenshotImage;
    screenshotFilename.textContent = slide.screenshotImage;
    screenshotClearBtn.style.display = 'inline-block';
  } else {
    screenshotImageFilename = null;
    screenshotFilename.textContent = 'No screenshot';
    screenshotPreview.style.display = 'none';
    screenshotClearBtn.style.display = 'none';
  }

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
  } else if (slide.type === 'mockup') {
    slide.mockupLayout = mockupLayoutSelect.value;
    slide.mockupTheme = mockupThemeSelect.value;
    slide.imageUsage = imageUsageSelect.value;
    slide.phoneAngle = form.elements.phoneAngle?.value || '-8';
    slide.phoneSize = form.elements.phoneSize?.value || 'medium';
    slide.highlightStyle = form.elements.highlightStyle?.value || 'subtle';
    slide.figurePosition = form.elements.figurePosition?.value || 'center-right';
    slide.figureSize = form.elements.figureSize?.value || 'medium';
    slide.figureBorderRadius = form.elements.figureBorderRadius?.value || '24';
    slide.bgOverlayOpacity = form.elements.bgOverlayOpacity?.value || '0.55';
    slide.screenshotImage = screenshotImageFilename || null;
  }
}

function toggleTypeFields() {
  const type = slideTypeSelect.value;
  photoFields.style.display = type === 'photo' ? 'block' : 'none';
  textFields.style.display = type === 'text' ? 'block' : 'none';
  mockupFields.style.display = type === 'mockup' ? 'block' : 'none';
  if (type === 'mockup') toggleMockupPhoneOptions();
}

function toggleMockupPhoneOptions() {
  const usage = imageUsageSelect.value;
  const needsImage = usage !== 'none';

  mockupPhoneOptions.style.display = usage === 'phone' ? 'block' : 'none';
  mockupFigureOptions.style.display = usage === 'figure' ? 'block' : 'none';
  mockupBgOptions.style.display = usage === 'background' ? 'block' : 'none';
  mockupImageUploadSection.style.display = needsImage ? 'block' : 'none';
  screenshotWarning.style.display = needsImage && !screenshotImageFilename ? 'block' : 'none';
}

slideTypeSelect.addEventListener('change', () => {
  toggleTypeFields();
  updatePreviewMockup();
});

mockupLayoutSelect.addEventListener('change', () => {
  toggleMockupPhoneOptions();
  updatePreviewMockup();
});

mockupThemeSelect.addEventListener('change', updatePreviewMockup);

imageUsageSelect.addEventListener('change', () => {
  toggleMockupPhoneOptions();
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

  const isMockup = (form.elements.slideType?.value || slide.type) === 'mockup';

  // Update mockup background based on type
  if (isPhoto) {
    previewMockup.classList.add('photo-type');
    previewMockup.style.background = '';
    mockupPhotoPlaceholder.style.display = 'flex';
  } else if (isMockup) {
    previewMockup.classList.remove('photo-type');
    const mockupTheme = mockupThemeSelect.value || 'dark';
    previewMockup.style.background = mockupTheme === 'light' ? '#F5F3EF' : primaryColor;
    mockupPhotoPlaceholder.style.display = 'none';
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
    const res = await authFetch('/api/upload-icon', { method: 'POST', body: fd });
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
    const res = await authFetch('/api/upload-reference', { method: 'POST', body: fd });
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
  } else if (payload.slideType === 'mockup') {
    payload.mockupLayout = slide.mockupLayout || mockupLayoutSelect.value || 'phone-right';
    payload.mockupTheme = slide.mockupTheme || mockupThemeSelect.value || 'dark';
    payload.imageUsage = slide.imageUsage || imageUsageSelect.value || 'phone';
    payload.phoneAngle = slide.phoneAngle || form.elements.phoneAngle?.value || '-8';
    payload.phoneSize = slide.phoneSize || form.elements.phoneSize?.value || 'medium';
    payload.highlightStyle = slide.highlightStyle || form.elements.highlightStyle?.value || 'subtle';
    payload.figurePosition = slide.figurePosition || form.elements.figurePosition?.value || 'center-right';
    payload.figureSize = slide.figureSize || form.elements.figureSize?.value || 'medium';
    payload.figureBorderRadius = slide.figureBorderRadius || form.elements.figureBorderRadius?.value || '24';
    payload.bgOverlayOpacity = slide.bgOverlayOpacity || form.elements.bgOverlayOpacity?.value || '0.55';
    payload.screenshotImage = slide.screenshotImage || screenshotImageFilename || null;
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
    const res = await authFetch('/api/generate', {
      method: 'POST',
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

  const res = await authFetch('/api/download-selected', {
    method: 'POST',
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
    const res = await authFetch('/api/generate-carousel', {
      method: 'POST',
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
    const res = await authFetch(`/api/carousel-status/${batchJobId}`);
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

// --- Screenshot Upload (Mockup) ---
screenshotUploadBtn.addEventListener('click', () => screenshotImageInput.click());

screenshotImageInput.addEventListener('change', async () => {
  const file = screenshotImageInput.files[0];
  if (!file) return;

  screenshotFilename.textContent = 'Uploading...';
  const fd = new FormData();
  fd.append('image', file);

  try {
    const res = await authFetch('/api/upload-reference', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.ok) {
      screenshotImageFilename = data.filename;
      screenshotFilename.textContent = file.name;
      screenshotPreview.src = data.url;
      screenshotPreview.style.display = 'block';
      screenshotClearBtn.style.display = 'inline-block';
      screenshotWarning.style.display = 'none';
    } else {
      screenshotFilename.textContent = 'Upload failed';
    }
  } catch {
    screenshotFilename.textContent = 'Upload error';
  }
});

screenshotClearBtn.addEventListener('click', () => {
  screenshotImageFilename = null;
  screenshotFilename.textContent = 'No screenshot';
  screenshotPreview.style.display = 'none';
  screenshotClearBtn.style.display = 'none';
  screenshotImageInput.value = '';
  toggleMockupPhoneOptions();
});

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
    const res = await authFetch('/api/generate-freeform', {
      method: 'POST',
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
