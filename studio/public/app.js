// --- Image lightbox ---
function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = `<img src="${src}" class="lightbox-img" />`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

// --- HTML escaping for safe innerHTML ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Slide AI detection ---
function slideNeedsAI(slideType, imageUsage) {
  if (slideType === 'photo' || slideType === 'video') return true;
  if (slideType === 'mockup' && imageUsage === 'ai-background') return true;
  return false;
}

// --- Focus trapping for modals ---
function trapFocus(modal) {
  const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable.length === 0) return null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const previousFocus = document.activeElement;
  first.focus();
  function handler(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  modal.addEventListener('keydown', handler);
  return { restore() { modal.removeEventListener('keydown', handler); if (previousFocus) previousFocus.focus(); } };
}

let _activeFocusTrap = null;

// --- Hex to RGB for highlight bars ---
function hexToRgb(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

// --- Default brand values (must match GENERIC_BRAND in server.mjs) ---
const DEFAULT_BRAND_COLORS = { primary: '#1A1A2E', accent: '#E94560', white: '#FFFFFF', secondary: '#16213E', cta: '#0F3460' };
const DEFAULT_BACKGROUND = 'dark premium background with subtle grain';

// --- Firebase Auth ---
async function getIdToken() {
  if (!firebase.apps.length) return null;
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
  // BYOK: send user's API keys from localStorage (scoped per user)
  const _prefix = getKeyPrefix();
  const openaiKey = localStorage.getItem(_prefix + 'openai_key');
  const anthropicKey = localStorage.getItem(_prefix + 'anthropic_key');
  const falKey = localStorage.getItem(_prefix + 'fal_key');
  const tiktokClientKey = localStorage.getItem(_prefix + 'tiktok_client_key');
  const tiktokClientSecret = localStorage.getItem(_prefix + 'tiktok_client_secret');
  if (openaiKey) opts.headers['X-OpenAI-Key'] = openaiKey;
  if (anthropicKey) opts.headers['X-Anthropic-Key'] = anthropicKey;
  if (falKey) opts.headers['X-Fal-Key'] = falKey;
  if (tiktokClientKey) opts.headers['X-TikTok-Client-Key'] = tiktokClientKey;
  if (tiktokClientSecret) opts.headers['X-TikTok-Client-Secret'] = tiktokClientSecret;
  return fetch(url, opts);
}

// Auth state listener — wait for Firebase config to load from server
(window.__firebaseReady || Promise.resolve()).then(() => {
  if (!firebase.apps.length) {
    // Firebase not configured (local dev without env vars) — show app without auth
    document.getElementById('login-overlay').classList.remove('visible');
    document.getElementById('app-shell').style.display = 'flex';
    return;
  }
  firebase.auth().onAuthStateChanged(async (user) => {
  const overlay = document.getElementById('login-overlay');
  const appShell = document.getElementById('app-shell');

  if (user) {
    overlay.classList.remove('visible');
    appShell.style.display = 'flex';
    // Reset state from any previous user session
    resetAppState();
    // Migrate legacy un-scoped API keys to this user (one-time)
    migrateApiKeys(user.uid);
    // Init app
    loadApiKeysFromStorage();
    try {
      const res = await authFetch('/api/brands');
      const data = await res.json();
      brands = data.brands || [];
      if (brands.length > 0) {
        currentBrand = brands[0].id;
      } else {
        currentBrand = null;
      }
      renderBrandSelector();
      // Auto-open brand creation for new users with no brands
      if (brands.length === 0 && typeof openBrandCreationSidebar === 'function') {
        setTimeout(() => openBrandCreationSidebar(), 300);
      }
    } catch (err) {
      console.error('Failed to load brands:', err);
      brands = [];
      currentBrand = null;
    }
    if (currentBrand) {
      await loadContentIdeas();
      restoreSession();
    } else {
      renderEmptySidebar();
    }
    updateIconPreview();
    checkTikTokStatus();
    updateVaultCount();
    loadUserPersons();
  } else {
    resetAppState();
    overlay.classList.add('visible');
    appShell.style.display = 'none';
  }
  });
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
    if (!firebase.apps.length) throw new Error('Firebase not configured');
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
    if (!firebase.apps.length) throw new Error('Firebase not configured');
    const provider = new firebase.auth.GoogleAuthProvider();
    await firebase.auth().signInWithPopup(provider);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('sign-out-btn').addEventListener('click', async () => {
  resetAppState();
  // Clear API key fields so next user doesn't see them
  settingsOpenaiKey.value = '';
  settingsAnthropicKey.value = '';
  if (settingsFalKey) settingsFalKey.value = '';
  if (settingsTiktokClientKey) settingsTiktokClientKey.value = '';
  if (settingsTiktokClientSecret) settingsTiktokClientSecret.value = '';
  // Close settings modal
  document.getElementById('settings-modal').style.display = 'none';
  if (firebase.apps.length) {
    await firebase.auth().signOut();
  } else {
    // No Firebase — manually show login overlay
    document.getElementById('login-overlay').classList.add('visible');
    document.getElementById('app-shell').style.display = 'none';
  }
});

document.getElementById('delete-account-btn').addEventListener('click', async () => {
  if (!confirm('Are you sure you want to delete your account? This will permanently remove your account and all your brands. This cannot be undone.')) return;
  const deleteConfirm = prompt('Type DELETE to confirm you want to delete everything:');
  if (deleteConfirm !== 'DELETE') return;
  try {
    const res = await authFetch('/api/account', { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      clearSession();
      alert('Your account has been deleted.');
      if (firebase.apps.length) {
        await firebase.auth().signOut();
      } else {
        window.location.reload();
      }
    } else {
      alert(data.error || 'Failed to delete account');
    }
  } catch (err) {
    alert('Error deleting account: ' + err.message);
  }
});

// --- State ---
let brands = [];
let currentBrand = null;
let contentData = null;
let selectedIdea = null;
let pendingContentPillars = null;
let pendingIconUrl = null;
let currentSlideIndex = 0;
let slideEdits = [];
let generatedImages = {};
let batchJobId = null;
let pollTimer = null;
let referenceImageFilename = null;
let screenshotImageFilename = null;
let slideReferenceImages = {}; // { slideIndex: { filename, displayName } }
let generateAbort = null; // AbortController for in-flight single-slide generation
let userPersons = []; // User-level persons for face-consistent photo generation

function resetAppState() {
  // Core brand/content state
  brands = [];
  currentBrand = null;
  contentData = null;
  selectedIdea = null;
  pendingContentPillars = null;
  pendingIconUrl = null;
  currentSlideIndex = 0;
  slideEdits = [];
  generatedImages = {};

  // Generation state
  batchJobId = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (generateAbort) { generateAbort.abort(); generateAbort = null; }

  // Vault state
  vaultImages = [];
  vaultHasMore = false;
  vaultNextCursor = null;
  vaultLoading = false;
  const vaultCountEl = document.getElementById('vault-count');
  if (vaultCountEl) vaultCountEl.textContent = '0';

  // Persons
  userPersons = [];

  // Reference images
  referenceImageFilename = null;
  screenshotImageFilename = null;
  slideReferenceImages = {};

  // Brand creation/editing
  editingBrandId = null;
  if (brandCreationEventSource) { brandCreationEventSource.close(); brandCreationEventSource = null; }
  if (brandCreationAbort) { brandCreationAbort.abort(); brandCreationAbort = null; }

  // Website analysis
  if (analysisDebounce) { clearTimeout(analysisDebounce); analysisDebounce = null; }
  if (analysisAbort) { analysisAbort.abort(); analysisAbort = null; }
  analysisStepsCollapsed = false;
  analysisCompleteCount = 0;

  // Canvas/element state
  elementOffsets = { headline: {x:0,y:0}, body: {x:0,y:0}, micro: {x:0,y:0}, highlight: {x:0,y:0}, cta: {x:0,y:0} };
  selectedElement = 'headline';

  // Meme generator
  personalizedScenarios = [];
  faceImageFiles = [];
  storedFacePhotos = [];
  selectedScenario = null;
  personalizeResults = [];
  memeFilename = null;

  // TikTok
  tiktokConnected = false;
  tiktokUsername = '';
  if (tiktokPostPollTimer) { clearInterval(tiktokPostPollTimer); tiktokPostPollTimer = null; }

  // Background generator
  bgTopics = [];
  if (bgPollTimer) { clearInterval(bgPollTimer); bgPollTimer = null; }

  // Session storage
  clearSession();

  // Clear DOM immediately to prevent stale UI flash on account switch
  renderBrandSelector();
  renderEmptySidebar();
}

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
const videoFields = document.getElementById('video-fields');
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
const previewVideo = document.getElementById('preview-video');
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
const slideRefInput = document.getElementById('slide-ref-input');
const slideRefBtn = document.getElementById('slide-ref-btn');
const slideRefFilename = document.getElementById('slide-ref-filename');
const slideRefClear = document.getElementById('slide-ref-clear');
const slideRefPreview = document.getElementById('slide-ref-preview');
const freeformInput = document.getElementById('freeform-input');
const freeformGenerateBtn = document.getElementById('freeform-generate-btn');
const freeformStatus = document.getElementById('freeform-status');
const freeformSlideCount = document.getElementById('freeform-slide-count');
const autoGenerateBtn = document.getElementById('auto-generate-btn');
const autoGenerateStatus = document.getElementById('auto-generate-status');
const autoGenerateSection = document.getElementById('auto-generate-section');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsClose = document.getElementById('settings-close');
const settingsSaveBtn = document.getElementById('settings-save-btn');
const settingsStatus = document.getElementById('settings-status');
const settingsOpenaiKey = document.getElementById('settings-openai-key');
const settingsAnthropicKey = document.getElementById('settings-anthropic-key');
const promptSettingsToggle = document.getElementById('prompt-settings-toggle');
const promptSettingsSection = document.getElementById('prompt-settings-section');
const settingsContentPrompt = document.getElementById('settings-content-prompt');
const promptBrandName = document.getElementById('prompt-brand-name');
const promptResetBtn = document.getElementById('prompt-reset-btn');
const promptSaveBtn = document.getElementById('prompt-save-btn');
const promptSaveStatus = document.getElementById('prompt-save-status');

const DEFAULT_CONTENT_IDEA_PROMPT = `Based on this website content, generate 5 carousel content ideas for {{brand_name}}'s social media (TikTok/Instagram).

Website: {{website_url}}
Page title: {{page_title}}
Description: {{meta_description}}
Website text: {{website_text}}

Generate exactly 5 carousel concepts. Each should have 6-7 slides and be based on real content/features/value props from the website.

Return ONLY valid JSON (no markdown, no code fences) with this structure:
{
  "ideas": [
    {
      "title": "Short carousel title",
      "caption": "Instagram/TikTok caption with hashtags",
      "slides": [
        {
          "number": 1,
          "label": "Hook",
          "type": "photo, text, or mockup",
          "microLabel": "{{micro_label}}",
          "headline": "Main headline text",
          "body": "Supporting body text (1-2 sentences)",
          "highlight": "key phrase to highlight"
        }
      ]
    }
  ]
}

Rules:
- Each idea MUST include a "caption" field: a ready-to-post Instagram/TikTok caption (2-3 engaging sentences + 5-8 relevant hashtags). Write in the brand's voice.
- Each idea should cover a DISTINCTLY different angle — avoid repeating the same theme or structure across ideas. Use varied approaches: features, benefits, how-to, comparison, social proof, behind-the-scenes, myth-busting, user stories, etc.
- First slide of each idea: strong hook (usually photo or text type) — each hook must be unique and attention-grabbing in a different way
- Last slide: CTA with "{{brand_name}} — link in bio" or similar
- Mix photo, text, and mockup types within each idea
- Use mockup with text-statement layout for bold statement slides
- Headlines: punchy, under 15 words — avoid repeating similar phrasing across ideas
- Body: 1-2 sentences max
- Content should be based on REAL information from the website, not generic filler
- Make each idea feel like a completely different post — vary the tone, angle, and structure`;
const iconPreviewImg = document.getElementById('icon-preview-img');
const iconUploadBtn = document.getElementById('icon-upload-btn');
const iconFileInput = document.getElementById('icon-file-input');
const cornerPicker = document.getElementById('corner-picker');
const owlPositionInput = document.getElementById('owlPosition');

// Image model selector
const imageModelSelect = document.getElementById('image-model-select');
function getSelectedImageModel() {
  return imageModelSelect ? imageModelSelect.value : 'gpt-image-1.5';
}

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
const mockupTextGroup = document.getElementById('mockup-text-group');
const mockupTextReset = document.getElementById('mockup-text-reset');

// Preview image overlay refs
const previewImageOverlay = document.getElementById('preview-image-overlay');
const previewOverlayEmpty = document.getElementById('preview-overlay-empty');
const previewOverlayActions = document.getElementById('preview-overlay-actions');
const previewOverlayLabel = document.getElementById('preview-overlay-label');
const previewOverlayLibraryLink = document.getElementById('preview-overlay-library-link');
const previewOverlayReplace = document.getElementById('preview-overlay-replace');
const previewOverlayLibrary = document.getElementById('preview-overlay-library');
const previewOverlayRemove = document.getElementById('preview-overlay-remove');
const previewImageBadge = document.getElementById('preview-image-badge');
const previewBadgeImg = document.getElementById('preview-badge-img');

// Unified preview refs
const previewContainer = document.getElementById('preview-container');
const livePreviewWrapper = document.getElementById('live-preview-wrapper');
const generatedPreviewWrapper = document.getElementById('generated-preview-wrapper');

// --- Preview mode switching ---
let currentPreviewMode = 'live'; // 'live' or 'generated'

function setPreviewMode(mode) {
  currentPreviewMode = mode;
  livePreviewWrapper.style.display = mode === 'live' ? 'flex' : 'none';
  generatedPreviewWrapper.style.display = mode === 'generated' ? 'block' : 'none';
  if (mode === 'live') scaleLivePreview();
  // Update button text based on mode
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn) {
    const slide = slideEdits[currentSlideIndex];
    const type = slideTypeSelect.value || slide?.type || 'text';
    const usage = imageUsageSelect.value || slide?.imageUsage || 'phone';
    submitBtn.textContent = slideNeedsAI(type, usage) ? 'Generate This Slide' : 'Render Preview';
  }
}

function scaleLivePreview() {
  if (!livePreviewWrapper || livePreviewWrapper.style.display === 'none') return;
  const wrapperRect = livePreviewWrapper.getBoundingClientRect();
  if (wrapperRect.width === 0) return;
  const mockupW = 216;
  const mockupH = previewMockup.offsetHeight || 384;
  const availW = wrapperRect.width - 32; // account for padding
  const availH = wrapperRect.height > 100 ? wrapperRect.height - 32 : 600;
  const scale = Math.min(availW / mockupW, availH / mockupH, 3);
  previewMockup.style.transform = `scale(${scale})`;
  // Set wrapper height to fit scaled mockup
  livePreviewWrapper.style.height = (mockupH * scale + 32) + 'px';
}

// ResizeObserver for live preview scaling
if (typeof ResizeObserver !== 'undefined') {
  const previewResizeObserver = new ResizeObserver(() => {
    if (currentPreviewMode === 'live') scaleLivePreview();
  });
  if (livePreviewWrapper) previewResizeObserver.observe(livePreviewWrapper);
}

// --- Per-element Text Offsets (drag to move) ---
let elementOffsets = {
  micro: { x: 0, y: 0 },
  headline: { x: 0, y: 0 },
  body: { x: 0, y: 0 },
  icon: { x: 0, y: 0 },
};
let selectedElement = 'headline'; // which element is selected for dragging

// --- Init (handled by onAuthStateChanged above) ---

// --- API Key Settings ---
const settingsFalKey = document.getElementById('settings-fal-key');
const settingsTiktokClientKey = document.getElementById('settings-tiktok-client-key');
const settingsTiktokClientSecret = document.getElementById('settings-tiktok-client-secret');

function getKeyPrefix() {
  const user = firebase.apps.length ? firebase.auth().currentUser : null;
  return user ? `carousel_${user.uid}_` : 'carousel_local_';
}

function migrateApiKeys(uid) {
  const prefix = `carousel_${uid}_`;
  // Migrate any legacy un-scoped keys that don't have a scoped equivalent yet
  const oldKeys = ['carousel_openai_key', 'carousel_anthropic_key', 'carousel_fal_key'];
  const newSuffixes = ['openai_key', 'anthropic_key', 'fal_key'];
  let migrated = false;
  oldKeys.forEach((oldKey, i) => {
    const val = localStorage.getItem(oldKey);
    if (val && !localStorage.getItem(prefix + newSuffixes[i])) {
      localStorage.setItem(prefix + newSuffixes[i], val);
      migrated = true;
    }
    if (val) localStorage.removeItem(oldKey);
  });
  if (migrated) console.log('[API Keys] Migrated legacy keys to user-scoped storage');
}

function loadApiKeysFromStorage() {
  const prefix = getKeyPrefix();
  const openai = localStorage.getItem(prefix + 'openai_key') || '';
  const anthropic = localStorage.getItem(prefix + 'anthropic_key') || '';
  const fal = localStorage.getItem(prefix + 'fal_key') || '';
  const tiktokKey = localStorage.getItem(prefix + 'tiktok_client_key') || '';
  const tiktokSecret = localStorage.getItem(prefix + 'tiktok_client_secret') || '';
  settingsOpenaiKey.value = openai;
  settingsAnthropicKey.value = anthropic;
  if (settingsFalKey) settingsFalKey.value = fal;
  if (settingsTiktokClientKey) settingsTiktokClientKey.value = tiktokKey;
  if (settingsTiktokClientSecret) settingsTiktokClientSecret.value = tiktokSecret;
}

// API key show/hide toggles
document.querySelectorAll('.api-key-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.querySelectorAll('.eye-open').forEach(el => el.style.display = showing ? '' : 'none');
    btn.querySelectorAll('.eye-closed').forEach(el => el.style.display = showing ? 'none' : '');
  });
});

// Headers are now handled by authFetch — these are kept for localStorage key storage only
function getHeaders() {
  return { 'Content-Type': 'application/json' };
}

settingsBtn.addEventListener('click', () => {
  settingsModal.style.display = 'flex';
  _activeFocusTrap = trapFocus(settingsModal);
  settingsStatus.textContent = '';
  settingsStatus.className = 'settings-status';
  const user = firebase.apps.length ? firebase.auth().currentUser : null;
  if (user) {
    const email = user.email || '';
    document.getElementById('settings-email').textContent = email;
    document.getElementById('settings-uid').textContent = user.uid;
    document.getElementById('settings-avatar').textContent = email.charAt(0).toUpperCase();
  }
  populatePromptSettings();
});

settingsClose.addEventListener('click', () => {
  settingsModal.style.display = 'none';
  if (_activeFocusTrap) { _activeFocusTrap.restore(); _activeFocusTrap = null; }
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) { settingsModal.style.display = 'none'; if (_activeFocusTrap) { _activeFocusTrap.restore(); _activeFocusTrap = null; } }
});

settingsSaveBtn.addEventListener('click', async () => {
  const openaiKey = settingsOpenaiKey.value.trim();
  const anthropicKey = settingsAnthropicKey.value.trim();
  const falKey = settingsFalKey ? settingsFalKey.value.trim() : '';

  const prefix = getKeyPrefix();
  if (openaiKey) localStorage.setItem(prefix + 'openai_key', openaiKey);
  else localStorage.removeItem(prefix + 'openai_key');

  if (anthropicKey) localStorage.setItem(prefix + 'anthropic_key', anthropicKey);
  else localStorage.removeItem(prefix + 'anthropic_key');

  if (falKey) localStorage.setItem(prefix + 'fal_key', falKey);
  else localStorage.removeItem(prefix + 'fal_key');

  const tiktokKey = settingsTiktokClientKey ? settingsTiktokClientKey.value.trim() : '';
  const tiktokSecret = settingsTiktokClientSecret ? settingsTiktokClientSecret.value.trim() : '';
  if (tiktokKey) localStorage.setItem(prefix + 'tiktok_client_key', tiktokKey);
  else localStorage.removeItem(prefix + 'tiktok_client_key');
  if (tiktokSecret) localStorage.setItem(prefix + 'tiktok_client_secret', tiktokSecret);
  else localStorage.removeItem(prefix + 'tiktok_client_secret');

  // Keys are stored in browser only — sent via headers on each API request
  settingsStatus.textContent = 'Keys saved! They will be used for all AI requests.';
  settingsStatus.className = 'settings-status success';
  setTimeout(() => { settingsModal.style.display = 'none'; }, 1200);

  // Re-check TikTok status with new keys
  checkTikTokStatus();
});

// --- Persons Management ---
const personsSettingsToggle = document.getElementById('persons-settings-toggle');
const personsSettingsSection = document.getElementById('persons-settings-section');
const personsList = document.getElementById('persons-list');
const addPersonBtn = document.getElementById('add-person-btn');

if (personsSettingsToggle) {
  personsSettingsToggle.addEventListener('click', () => {
    const isOpen = personsSettingsSection.style.display !== 'none';
    personsSettingsSection.style.display = isOpen ? 'none' : 'block';
    personsSettingsToggle.classList.toggle('open', !isOpen);
  });
}

async function loadUserPersons() {
  try {
    const res = await authFetch('/api/persons');
    const data = await res.json();
    userPersons = data.persons || [];
    renderPersonsList();
    populatePersonSelectors();
  } catch (err) {
    console.error('Failed to load persons:', err);
    userPersons = [];
  }
}

function renderPersonsList() {
  if (!personsList) return;
  personsList.innerHTML = '';
  if (userPersons.length === 0) {
    personsList.innerHTML = '<p class="field-hint">No people added yet.</p>';
    return;
  }
  for (const person of userPersons) {
    const card = document.createElement('div');
    card.className = 'person-card';
    const photoCount = person.photos?.length || 0;
    card.innerHTML = `
      <div class="person-card-header">
        <input type="text" value="${escapeHtml(person.name)}" data-person-id="${person.id}" class="person-name-input" />
        <button type="button" class="person-delete-btn" data-person-id="${person.id}">Delete</button>
      </div>
      <div class="person-photos-grid" data-person-id="${person.id}">
        ${(person.photos || []).map((p, idx) =>
          p.url ? `<div class="face-photo-thumb"><img src="${p.url}" alt="Photo" /><button class="face-photo-remove" data-person-id="${person.id}" data-idx="${idx}" title="Remove">&times;</button></div>` : ''
        ).join('')}
        ${photoCount < 5 ? `<button type="button" class="face-add-btn person-photo-add" data-person-id="${person.id}" title="Add photo">+</button>` : ''}
      </div>
      <div class="person-photo-count">${photoCount} / 5 photos</div>
    `;
    personsList.appendChild(card);
  }

  // Name edit handlers (blur = save)
  personsList.querySelectorAll('.person-name-input').forEach(input => {
    input.addEventListener('blur', async () => {
      const personId = input.dataset.personId;
      const newName = input.value.trim();
      if (!newName) return;
      try {
        await authFetch(`/api/persons/${personId}`, {
          method: 'PUT',
          body: JSON.stringify({ name: newName }),
        });
        const person = userPersons.find(p => p.id === personId);
        if (person) person.name = newName;
        populatePersonSelectors();
      } catch { /* ignore */ }
    });
  });

  // Delete person handlers
  personsList.querySelectorAll('.person-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const personId = btn.dataset.personId;
      if (!confirm('Delete this person and all their photos?')) return;
      try {
        await authFetch(`/api/persons/${personId}`, { method: 'DELETE' });
        userPersons = userPersons.filter(p => p.id !== personId);
        renderPersonsList();
        populatePersonSelectors();
      } catch (err) {
        console.error('Failed to delete person:', err);
      }
    });
  });

  // Delete individual photo handlers
  personsList.querySelectorAll('.face-photo-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const personId = btn.dataset.personId;
      const idx = btn.dataset.idx;
      try {
        const res = await authFetch(`/api/persons/${personId}/photos/${idx}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          const person = userPersons.find(p => p.id === personId);
          if (person) person.photos = data.photos;
          renderPersonsList();
        }
      } catch (err) {
        console.error('Failed to delete photo:', err);
      }
    });
  });

  // Add photo handlers
  personsList.querySelectorAll('.person-photo-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const personId = btn.dataset.personId;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.addEventListener('change', async () => {
        if (!input.files?.length) return;
        const fd = new FormData();
        for (const f of input.files) fd.append('photos', f);
        btn.textContent = '...';
        btn.disabled = true;
        try {
          const res = await authFetch(`/api/persons/${personId}/photos`, { method: 'POST', body: fd });
          const data = await res.json();
          if (data.ok) {
            const person = userPersons.find(p => p.id === personId);
            if (person) person.photos = data.photos;
            renderPersonsList();
          } else {
            alert(data.error || 'Upload failed');
          }
        } catch (err) {
          alert('Upload failed: ' + err.message);
        }
      });
      input.click();
    });
  });
}

function populatePersonSelectors() {
  const selectors = [
    document.getElementById('person-select'),
    document.getElementById('personalize-person-select'),
  ].filter(Boolean);

  for (const select of selectors) {
    const currentVal = select.value;
    const firstOption = select.querySelector('option');
    const defaultText = firstOption?.textContent || 'None';
    select.innerHTML = `<option value="">${escapeHtml(defaultText)}</option>`;
    for (const person of userPersons) {
      const photoCount = person.photos?.length || 0;
      const opt = document.createElement('option');
      opt.value = person.id;
      opt.textContent = `${person.name} (${photoCount} photo${photoCount !== 1 ? 's' : ''})`;
      if (photoCount === 0) opt.disabled = true;
      select.appendChild(opt);
    }
    if (currentVal && userPersons.some(p => p.id === currentVal)) {
      select.value = currentVal;
    }
  }
}

if (addPersonBtn) {
  addPersonBtn.addEventListener('click', async () => {
    const name = prompt('Person name:');
    if (!name?.trim()) return;
    try {
      const res = await authFetch('/api/persons', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        userPersons.unshift(data.person);
        renderPersonsList();
        populatePersonSelectors();
      } else {
        alert(data.error || 'Failed to create person');
      }
    } catch (err) {
      alert('Failed to create person: ' + err.message);
    }
  });
}

// --- AI Prompt Settings ---
if (promptSettingsToggle) {
  promptSettingsToggle.addEventListener('click', () => {
    const section = promptSettingsSection;
    const isOpen = section.style.display !== 'none';
    section.style.display = isOpen ? 'none' : 'block';
    promptSettingsToggle.classList.toggle('open', !isOpen);
  });
}

function populatePromptSettings() {
  const brand = brands.find((b) => b.id === currentBrand);
  if (promptBrandName) promptBrandName.textContent = brand ? brand.name : '—';
  if (settingsContentPrompt) {
    settingsContentPrompt.value = (brand && brand.contentIdeaPrompt) || DEFAULT_CONTENT_IDEA_PROMPT;
  }
  if (promptSaveStatus) {
    promptSaveStatus.textContent = '';
    promptSaveStatus.className = 'settings-status';
  }
}

if (promptSaveBtn) {
  promptSaveBtn.addEventListener('click', async () => {
    if (!currentBrand) return;
    promptSaveStatus.textContent = 'Saving...';
    promptSaveStatus.className = 'settings-status';
    try {
      const res = await authFetch(`/api/brands/${currentBrand}`, {
        method: 'PUT',
        body: JSON.stringify({ contentIdeaPrompt: settingsContentPrompt.value.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        const brand = brands.find((b) => b.id === currentBrand);
        if (brand) brand.contentIdeaPrompt = settingsContentPrompt.value.trim();
        promptSaveStatus.textContent = 'Prompt saved!';
        promptSaveStatus.className = 'settings-status success';
      } else {
        promptSaveStatus.textContent = data.error || 'Failed to save';
        promptSaveStatus.className = 'settings-status error';
      }
    } catch {
      promptSaveStatus.textContent = 'Failed to save prompt.';
      promptSaveStatus.className = 'settings-status error';
    }
  });
}

if (promptResetBtn) {
  promptResetBtn.addEventListener('click', async () => {
    settingsContentPrompt.value = DEFAULT_CONTENT_IDEA_PROMPT;
    if (!currentBrand) return;
    promptSaveStatus.textContent = 'Resetting...';
    promptSaveStatus.className = 'settings-status';
    try {
      const res = await authFetch(`/api/brands/${currentBrand}`, {
        method: 'PUT',
        body: JSON.stringify({ contentIdeaPrompt: '' }),
      });
      const data = await res.json();
      if (data.ok) {
        const brand = brands.find((b) => b.id === currentBrand);
        if (brand) brand.contentIdeaPrompt = '';
        promptSaveStatus.textContent = 'Reset to default!';
        promptSaveStatus.className = 'settings-status success';
      } else {
        promptSaveStatus.textContent = data.error || 'Failed to reset';
        promptSaveStatus.className = 'settings-status error';
      }
    } catch {
      promptSaveStatus.textContent = 'Failed to reset prompt.';
      promptSaveStatus.className = 'settings-status error';
    }
  });
}

// --- Brand Selector ---
function renderBrandSelector() {
  if (brands.length === 0) {
    brandSelector.innerHTML = '<option value="" disabled selected>No brands yet</option>';
  } else {
    brandSelector.innerHTML = brands
      .map((b) => `<option value="${escapeHtml(b.id)}" ${b.id === currentBrand ? 'selected' : ''}>${escapeHtml(b.name)}</option>`)
      .join('');
  }
  const editBtn = document.getElementById('edit-brand-btn');
  if (editBtn) editBtn.style.display = currentBrand ? 'flex' : 'none';
}

brandSelector.addEventListener('change', async () => {
  if (generateAbort) generateAbort.abort();
  loadingSpinner.classList.remove('active');
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

  currentBrand = brandSelector.value;
  selectedIdea = null;
  currentSlideIndex = 0;
  generatedImages = {};
  slideEdits = [];
  editorArea.style.display = 'none';
  personalizeView.style.display = 'none';
  if (document.getElementById('meme-view')) document.getElementById('meme-view').style.display = 'none';
  emptyState.style.display = 'flex';
  renderBrandSelector(); // update edit button visibility
  await loadContentIdeas();
  updateIconPreview();
  loadPersonalizeScenarios(currentBrand);
});

// --- Brand Creation / Edit Modal ---
const brandModal = document.getElementById('brand-modal');
const brandModalTitle = document.getElementById('brand-modal-title');
const brandNameInput = document.getElementById('brand-name');
const brandWebsiteInput = document.getElementById('brand-website');
const brandDescInput = document.getElementById('brand-description');
const brandAiBtn = document.getElementById('brand-ai-setup-btn');
const brandAiStatus = document.getElementById('brand-ai-status');
const brandSaveBtn = document.getElementById('brand-save-btn');
const brandDeleteBtn = document.getElementById('brand-delete-btn');
const brandModalStatus = document.getElementById('brand-modal-status');
const colorInputs = {
  primary: document.getElementById('brand-color-primary'),
  accent: document.getElementById('brand-color-accent'),
  white: document.getElementById('brand-color-white'),
  secondary: document.getElementById('brand-color-secondary'),
  cta: document.getElementById('brand-color-cta'),
};
let editingBrandId = null;

// Sync hex labels with color pickers
for (const [key, input] of Object.entries(colorInputs)) {
  const hexLabel = document.getElementById(`brand-color-${key}-hex`);
  input.addEventListener('input', () => { hexLabel.textContent = input.value.toUpperCase(); });
}

function openBrandModal(brand = null) {
  editingBrandId = brand ? brand.id : null;
  brandModalTitle.textContent = brand ? 'Edit Brand' : 'Create Brand';
  brandNameInput.value = brand?.name || '';
  brandWebsiteInput.value = brand?.website || '';
  brandDescInput.value = '';
  document.getElementById('brand-system-prompt').value = brand?.systemPrompt || '';
  document.getElementById('brand-image-style').value = brand?.imageStyle || '';
  document.getElementById('brand-micro-label').value = brand?.defaultMicroLabel || '';
  document.getElementById('brand-watermark').value = brand?.iconOverlayText || '';
  document.getElementById('brand-bg-desc').value = brand?.defaultBackground || '';
  brandModalStatus.textContent = '';
  brandAiStatus.textContent = brand ? '' : 'Paste a URL to auto-setup';
  brandDeleteBtn.style.display = brand ? 'inline-block' : 'none';

  // Reset analysis UI and pending icon
  pendingIconUrl = null;
  if (analysisAbort) analysisAbort.abort();
  clearTimeout(analysisDebounce);
  const analysisEl = document.getElementById('brand-analysis-section');
  if (analysisEl) analysisEl.style.display = 'none';

  const colors = brand?.colors || DEFAULT_BRAND_COLORS;
  for (const [key, input] of Object.entries(colorInputs)) {
    input.value = colors[key] || '#000000';
    document.getElementById(`brand-color-${key}-hex`).textContent = input.value.toUpperCase();
  }

  // Face photos section — only show for existing brands
  const faceSection = document.getElementById('brand-face-photos-section');
  if (brand) {
    faceSection.style.display = '';
    loadBrandFacePhotos(brand.id);
  } else {
    faceSection.style.display = 'none';
    renderBrandFacePhotos([]);
  }

  brandModal.style.display = 'flex';
  _activeFocusTrap = trapFocus(brandModal);
}

function closeBrandModal() {
  brandModal.style.display = 'none';
  editingBrandId = null;
  if (_activeFocusTrap) { _activeFocusTrap.restore(); _activeFocusTrap = null; }
}

// --- Brand Face Photos Management ---
let brandFacePhotos = []; // current photos in brand modal

async function loadBrandFacePhotos(brandId) {
  renderBrandFacePhotos([]);
  const status = document.getElementById('brand-face-photo-status');
  status.textContent = 'Loading face photos...';
  try {
    const res = await authFetch(`/api/brands/${brandId}/face-photos`);
    const data = await res.json();
    brandFacePhotos = data.facePhotos || [];
    renderBrandFacePhotos(brandFacePhotos);
    status.textContent = '';
  } catch (err) {
    status.textContent = 'Could not load face photos.';
    brandFacePhotos = [];
  }
}

function renderBrandFacePhotos(photos) {
  const grid = document.getElementById('brand-face-photos-grid');
  const addBtn = document.getElementById('brand-face-photo-add');
  const countEl = document.getElementById('brand-face-photo-count');

  grid.querySelectorAll('.face-photo-thumb').forEach(el => el.remove());

  photos.forEach((photo, idx) => {
    if (!photo.url) return;
    const thumb = document.createElement('div');
    thumb.className = 'face-photo-thumb';
    thumb.innerHTML = `
      <img src="${photo.url}" alt="Face ${idx + 1}" />
      <button class="face-photo-remove" data-idx="${idx}" title="Remove">&times;</button>
      <span class="saved-badge">Saved</span>
    `;
    grid.insertBefore(thumb, addBtn);
  });

  countEl.textContent = `${photos.length} / 5`;
  addBtn.style.display = photos.length >= 5 ? 'none' : 'flex';

  // Attach remove handlers
  grid.querySelectorAll('.face-photo-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      if (!editingBrandId) return;
      btn.disabled = true;
      const status = document.getElementById('brand-face-photo-status');
      status.textContent = 'Removing...';
      try {
        const res = await authFetch(`/api/brands/${editingBrandId}/face-photos/${idx}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Delete failed');
        brandFacePhotos = data.facePhotos || [];
        renderBrandFacePhotos(brandFacePhotos);
        status.textContent = 'Photo removed.';
        setTimeout(() => { if (status.textContent === 'Photo removed.') status.textContent = ''; }, 2000);
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });
  });
}

document.getElementById('brand-face-photo-add').addEventListener('click', () => {
  document.getElementById('brand-face-photo-input').click();
});

document.getElementById('brand-face-photo-input').addEventListener('change', async () => {
  const input = document.getElementById('brand-face-photo-input');
  const files = Array.from(input.files);
  input.value = '';
  if (!files.length || !editingBrandId) return;

  const remaining = 5 - brandFacePhotos.length;
  const toUpload = files.slice(0, remaining);
  if (toUpload.length === 0) return;

  const status = document.getElementById('brand-face-photo-status');
  status.textContent = `Uploading ${toUpload.length} photo${toUpload.length > 1 ? 's' : ''}...`;

  const fd = new FormData();
  toUpload.forEach(f => fd.append('photos', f));

  try {
    const res = await authFetch(`/api/brands/${editingBrandId}/face-photos`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    brandFacePhotos = data.facePhotos || [];
    renderBrandFacePhotos(brandFacePhotos);
    status.textContent = 'Photos saved!';
    setTimeout(() => { if (status.textContent === 'Photos saved!') status.textContent = ''; }, 2000);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
});

// --- Sidebar Brand Creation ---
let brandCreationEventSource = null;
let brandCreationAbort = null;

function openBrandCreationSidebar() {
  // Switch sidebar mode
  document.getElementById('sidebar-ideas-mode').style.display = 'none';
  document.getElementById('sidebar-creation-mode').style.display = 'flex';
  // Show creation output in main area, hide others
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('editor-area').style.display = 'none';
  document.getElementById('brand-creation-output').style.display = 'block';
  try { document.getElementById('content-plan-view').style.display = 'none'; } catch {}
  try { document.getElementById('personalize-view').style.display = 'none'; } catch {}
  try { document.getElementById('meme-view').style.display = 'none'; } catch {}
  // Reset form state
  document.getElementById('brand-creation-url').value = '';
  document.getElementById('brand-creation-url').focus();
  document.getElementById('brand-creation-error').style.display = 'none';
  document.getElementById('brand-creation-progress').style.display = 'none';
  document.getElementById('brand-creation-footer').style.display = 'none';
  document.getElementById('brand-creation-generate-btn').disabled = false;
  document.querySelectorAll('.creation-section').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.creation-step').forEach(el => el.className = 'creation-step');
  // Reset output header
  const header = document.querySelector('.brand-creation-output-header');
  if (header) {
    header.querySelector('h2').textContent = 'Setting up your brand...';
    header.querySelector('p').textContent = 'Results will appear below as we analyze your website.';
  }
}

function closeBrandCreationSidebar() {
  // Abort any in-flight request
  if (brandCreationAbort) {
    brandCreationAbort.abort();
    brandCreationAbort = null;
  }
  if (brandCreationEventSource) {
    brandCreationEventSource.close();
    brandCreationEventSource = null;
  }
  // Switch sidebar back
  document.getElementById('sidebar-creation-mode').style.display = 'none';
  document.getElementById('sidebar-ideas-mode').style.display = 'flex';
  // Switch main area back
  document.getElementById('brand-creation-output').style.display = 'none';
  document.getElementById('empty-state').style.display = '';
}

document.getElementById('sidebar-creation-close').addEventListener('click', closeBrandCreationSidebar);
document.getElementById('brand-creation-generate-btn').addEventListener('click', () => {
  const url = document.getElementById('brand-creation-url').value.trim();
  if (!url) return;
  startBrandGeneration(url);
});
document.getElementById('brand-creation-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('brand-creation-generate-btn').click();
  }
});

document.getElementById('brand-creation-continue').addEventListener('click', async () => {
  closeBrandCreationSidebar();
  // Refresh brands list and select the new one
  try {
    const res = await authFetch('/api/brands');
    const data = await res.json();
    brands = data.brands || [];
    renderBrandSelector();
    if (currentBrand) {
      // If content ideas were already generated during brand creation, use them directly
      const hasIdeas = contentData?.apps?.[0]?.categories?.some(c => c.ideas?.length > 0);
      if (hasIdeas) {
        renderSidebar();
      } else {
        await loadContentIdeas();
      }
      updateIconPreview();
    }
  } catch (err) {
    console.error('Failed to refresh brands:', err);
  }
});

async function startBrandGeneration(url) {
  const generateBtn = document.getElementById('brand-creation-generate-btn');
  const errorEl = document.getElementById('brand-creation-error');
  const progressEl = document.getElementById('brand-creation-progress');
  const footerEl = document.getElementById('brand-creation-footer');

  generateBtn.disabled = true;
  errorEl.style.display = 'none';
  progressEl.style.display = 'block';
  footerEl.style.display = 'none';

  // Reset all sections and progress
  document.querySelectorAll('.creation-section').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.creation-step').forEach(el => el.className = 'creation-step');

  const token = await getIdToken();
  brandCreationAbort = new AbortController();

  // Use fetch with streaming for SSE (EventSource doesn't support POST)
  const _prefix = getKeyPrefix();
  try {
    const response = await fetch('/api/brands/full-setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(localStorage.getItem(_prefix + 'openai_key') ? { 'X-OpenAI-Key': localStorage.getItem(_prefix + 'openai_key') } : {}),
        ...(localStorage.getItem(_prefix + 'anthropic_key') ? { 'X-Anthropic-Key': localStorage.getItem(_prefix + 'anthropic_key') } : {}),
        ...(localStorage.getItem(_prefix + 'fal_key') ? { 'X-Fal-Key': localStorage.getItem(_prefix + 'fal_key') } : {}),
      },
      body: JSON.stringify({ url }),
      signal: brandCreationAbort.signal,
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      let currentEvent = null;
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ') && currentEvent) {
          try {
            const data = JSON.parse(line.slice(6));
            handleCreationEvent(currentEvent, data);
          } catch { /* skip parse errors */ }
          currentEvent = null;
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // User cancelled
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
    generateBtn.disabled = false;
  }
}

function setCreationStep(stepName, state) {
  const step = document.querySelector(`.creation-step[data-step="${stepName}"]`);
  if (!step) return;
  step.className = 'creation-step ' + state;
}

function handleCreationEvent(event, data) {
  const errorEl = document.getElementById('brand-creation-error');

  switch (event) {
    case 'status': {
      // Mark previous steps as done, current as active
      const steps = ['fetch', 'colors', 'icon', 'images', 'config', 'saving', 'content-ideas', 'carousel'];
      const idx = steps.indexOf(data.step);
      for (let i = 0; i < steps.length; i++) {
        const el = document.querySelector(`.creation-step[data-step="${steps[i]}"]`);
        if (!el) continue;
        if (i < idx) el.className = 'creation-step done';
        else if (i === idx) el.className = 'creation-step active';
      }
      // Show content ideas section with loading indicator when step starts
      if (data.step === 'content-ideas') {
        const section = document.getElementById('creation-section-ideas');
        const list = document.getElementById('creation-ideas-list');
        list.innerHTML = '<div class="creation-ideas-loading">Generating ideas...</div>';
        section.style.display = 'block';
      }
      // Show carousel section with loading indicator when step starts
      if (data.step === 'carousel') {
        const section = document.getElementById('creation-section-carousel');
        section.style.display = 'block';
      }
      break;
    }

    case 'brand-info': {
      const section = document.getElementById('creation-section-brand');
      document.getElementById('creation-brand-name').textContent = data.name || '';
      document.getElementById('creation-brand-desc').textContent = data.description || '';
      section.style.display = 'block';
      break;
    }

    case 'colors': {
      const section = document.getElementById('creation-section-colors');
      const container = document.getElementById('creation-color-swatches');
      container.innerHTML = '';
      (data.extracted || []).forEach(hex => {
        const swatch = document.createElement('div');
        swatch.className = 'creation-swatch';
        swatch.innerHTML = `<div class="creation-swatch-circle" style="background:${hex}"></div><span class="creation-swatch-hex">${hex}</span>`;
        container.appendChild(swatch);
      });
      section.style.display = 'block';
      break;
    }

    case 'icon': {
      if (data.url) {
        const section = document.getElementById('creation-section-icon');
        const img = document.getElementById('creation-icon-preview');
        img.src = data.url;
        img.style.cursor = 'pointer';
        img.onclick = () => openLightbox(data.url);
        img.onerror = () => { section.style.display = 'none'; };
        section.style.display = 'block';
      }
      break;
    }

    case 'images': {
      if (Array.isArray(data) && data.length > 0) {
        const section = document.getElementById('creation-section-images');
        const grid = document.getElementById('creation-images-grid');
        grid.innerHTML = '';
        data.forEach(img => {
          const el = document.createElement('img');
          el.src = img.url;
          el.loading = 'lazy';
          el.style.cursor = 'pointer';
          el.onclick = () => openLightbox(img.url);
          el.onerror = () => el.remove();
          grid.appendChild(el);
        });
        section.style.display = 'block';
      }
      break;
    }

    case 'brand-config': {
      const section = document.getElementById('creation-section-config');
      const content = document.getElementById('creation-config-content');

      // Update color swatches with the assigned brand colors
      if (data.colors) {
        const container = document.getElementById('creation-color-swatches');
        container.innerHTML = '';
        const colorEntries = Object.entries(data.colors);
        colorEntries.forEach(([role, hex]) => {
          const swatch = document.createElement('div');
          swatch.className = 'creation-swatch';
          swatch.innerHTML = `<div class="creation-swatch-circle" style="background:${hex}"></div><span class="creation-swatch-label">${role}</span><span class="creation-swatch-hex">${hex}</span>`;
          container.appendChild(swatch);
        });
      }

      let html = '';
      if (data.tone) html += `<div class="config-field"><span class="config-label">Tone</span>${data.tone}</div>`;
      if (data.imageStyle) html += `<div class="config-field"><span class="config-label">Image Style</span>${data.imageStyle}</div>`;
      if (data.defaultBackground) html += `<div class="config-field"><span class="config-label">Background</span>${data.defaultBackground}</div>`;
      if (data.contentPillars?.length) html += `<div class="config-field"><span class="config-label">Content Pillars</span>${data.contentPillars.join(' &middot; ')}</div>`;
      content.innerHTML = html;
      section.style.display = 'block';
      break;
    }

    case 'brand-saved': {
      currentBrand = data.id;
      // Mark config steps done
      setCreationStep('config', 'done');
      break;
    }

    case 'content-idea': {
      // Individual idea arriving progressively
      const section = document.getElementById('creation-section-ideas');
      const list = document.getElementById('creation-ideas-list');
      // Remove loading indicator if present
      const loader = list.querySelector('.creation-ideas-loading');
      if (loader) loader.remove();
      section.style.display = 'block';
      const count = list.children.length + 1;
      const item = document.createElement('div');
      item.className = 'creation-idea-item';
      item.innerHTML = `<span class="creation-idea-num">${count}</span><span class="creation-idea-title">${escapeHtml(data.title)}</span><span class="creation-idea-slides">${data.slides?.length || 0} slides</span>`;
      list.appendChild(item);
      break;
    }

    case 'content-ideas': {
      // Full batch — store for studio use
      if (Array.isArray(data) && data.length > 0) {
        contentData = {
          apps: [{
            appName: currentBrand,
            brandId: currentBrand,
            categories: [{
              name: 'AI-Generated Ideas',
              ideas: data,
            }],
          }],
        };
      }
      break;
    }

    case 'slide': {
      const section = document.getElementById('creation-section-carousel');
      const strip = document.getElementById('creation-carousel-strip');
      section.style.display = 'block';
      if (data.imageUrl) {
        const img = document.createElement('img');
        img.src = data.imageUrl;
        img.loading = 'lazy';
        strip.appendChild(img);
      }
      break;
    }

    case 'slide-error':
      // Non-critical; just skip
      break;

    case 'done': {
      // Mark all steps done
      document.querySelectorAll('.creation-step').forEach(el => {
        if (!el.classList.contains('error')) el.className = 'creation-step done';
      });
      document.getElementById('brand-creation-generate-btn').disabled = false;
      // Update output header briefly, then auto-navigate to studio
      const doneHeader = document.querySelector('.brand-creation-output-header');
      if (doneHeader) {
        doneHeader.querySelector('h2').textContent = 'Your brand is ready!';
        doneHeader.querySelector('p').textContent = 'Opening studio...';
      }
      // Auto-continue to studio after a short delay so user sees completion
      setTimeout(async () => {
        closeBrandCreationSidebar();
        try {
          const res = await authFetch('/api/brands');
          const bData = await res.json();
          brands = bData.brands || [];
          renderBrandSelector();
          if (currentBrand) {
            const hasIdeas = contentData?.apps?.[0]?.categories?.some(c => c.ideas?.length > 0);
            if (hasIdeas) {
              renderSidebar();
            } else {
              await loadContentIdeas();
            }
            updateIconPreview();
          }
        } catch (err) {
          console.error('Failed to refresh brands:', err);
        }
      }, 1200);
      break;
    }

    case 'error': {
      errorEl.textContent = data.message || 'Something went wrong';
      errorEl.style.display = 'block';
      document.getElementById('brand-creation-generate-btn').disabled = false;
      // Mark current active step as error
      document.querySelectorAll('.creation-step.active').forEach(el => el.className = 'creation-step error');
      break;
    }
  }
}

document.getElementById('create-brand-btn').addEventListener('click', () => openBrandCreationSidebar());
document.getElementById('edit-brand-btn').addEventListener('click', () => {
  const brand = brands.find((b) => b.id === currentBrand);
  if (brand) openBrandModal(brand);
});
document.getElementById('brand-modal-close').addEventListener('click', closeBrandModal);
document.getElementById('brand-modal-cancel').addEventListener('click', closeBrandModal);
brandModal.addEventListener('click', (e) => { if (e.target === brandModal) closeBrandModal(); });

// --- Website Analysis (auto-trigger on URL input) ---
const brandAnalysisSection = document.getElementById('brand-analysis-section');
const brandAnalysisSteps = document.getElementById('brand-analysis-steps');
const brandPreviewRow = document.getElementById('brand-preview-row');
const brandPreviewThumb = document.getElementById('brand-preview-thumb');
const brandPreviewName = document.getElementById('brand-preview-name');
const brandPreviewDesc = document.getElementById('brand-preview-desc');
const brandImagesSection = document.getElementById('brand-images-section');
const brandImagesGrid = document.getElementById('brand-images-grid');
const brandImagesCount = document.getElementById('brand-images-count');
const analysisCount = document.getElementById('analysis-count');
const analysisChevron = document.getElementById('analysis-chevron');
const analysisHeader = document.getElementById('analysis-header');
const analysisStatusLine = document.getElementById('analysis-status-line');
const analysisStatusText = document.getElementById('analysis-status-text');
let analysisDebounce = null;
let analysisAbort = null;
let analysisStepsCollapsed = false;
let analysisCompleteCount = 0;

function setAnalysisStep(stepName, state) {
  const step = brandAnalysisSteps.querySelector(`[data-step="${stepName}"]`);
  if (!step) return;
  const wasNotDone = !step.classList.contains('done');
  step.className = 'analysis-step' + (state !== 'waiting' ? ` ${state}` : '');
  const icon = step.querySelector('.step-icon');
  if (state === 'done') icon.textContent = '\u2713';
  else if (state === 'error') icon.textContent = '\u2717';
  else icon.textContent = '';

  // Update completed count
  if (state === 'done' && wasNotDone) {
    analysisCompleteCount = Math.min(analysisCompleteCount + 1, 4);
  }
  analysisCount.textContent = `${analysisCompleteCount} of 4 completed`;
}

function resetAnalysisUI() {
  brandPreviewRow.style.display = 'none';
  brandImagesSection.style.display = 'none';
  brandImagesGrid.innerHTML = '';
  analysisCompleteCount = 0;
  analysisCount.textContent = '0 of 4 completed';
  analysisStepsCollapsed = false;
  brandAnalysisSteps.classList.remove('collapsed');
  analysisChevron.classList.remove('collapsed');
  analysisStatusLine.style.display = 'none';
  brandAnalysisSteps.querySelectorAll('.analysis-step').forEach(el => {
    el.className = 'analysis-step';
    el.querySelector('.step-icon').textContent = '';
  });
}

function collapseAnalysisSteps() {
  analysisStepsCollapsed = true;
  brandAnalysisSteps.classList.add('collapsed');
  analysisChevron.classList.add('collapsed');
}

function toggleAnalysisSteps() {
  analysisStepsCollapsed = !analysisStepsCollapsed;
  brandAnalysisSteps.classList.toggle('collapsed', analysisStepsCollapsed);
  analysisChevron.classList.toggle('collapsed', analysisStepsCollapsed);
}

// Click header to toggle expand/collapse
analysisHeader.addEventListener('click', toggleAnalysisSteps);

async function analyzeWebsite(url) {
  if (analysisAbort) analysisAbort.abort();
  analysisAbort = new AbortController();
  const signal = analysisAbort.signal;

  resetAnalysisUI();
  brandAnalysisSection.style.display = 'block';
  analysisStatusLine.style.display = 'none';

  setAnalysisStep('fetch', 'active');

  const stepTimers = [];
  let responseReceived = false;

  try {
    await new Promise(r => setTimeout(r, 300));
    if (signal.aborted) return;

    const fetchPromise = authFetch('/api/brands/analyze-website', {
      method: 'POST',
      body: JSON.stringify({ url }),
      signal,
    });

    stepTimers.push(setTimeout(() => {
      if (!signal.aborted && !responseReceived) {
        setAnalysisStep('fetch', 'done');
        setAnalysisStep('analyze', 'active');
      }
    }, 1200));

    stepTimers.push(setTimeout(() => {
      if (!signal.aborted && !responseReceived) {
        setAnalysisStep('analyze', 'done');
        setAnalysisStep('images', 'active');
      }
    }, 2400));

    stepTimers.push(setTimeout(() => {
      if (!signal.aborted && !responseReceived) {
        setAnalysisStep('images', 'done');
        setAnalysisStep('generate', 'active');
        // Show "Almost ready..." during the final generate step
        analysisStatusLine.style.display = 'block';
        analysisStatusText.textContent = 'Almost ready...';
        analysisStatusLine.className = 'analysis-status-line pending';
      }
    }, 3600));

    const res = await fetchPromise;
    responseReceived = true;
    stepTimers.forEach(t => clearTimeout(t));
    if (signal.aborted) return;
    const data = await res.json();

    if (!data.ok) {
      brandAnalysisSteps.querySelectorAll('.analysis-step.active').forEach(el => {
        el.className = 'analysis-step error';
        el.querySelector('.step-icon').textContent = '\u2717';
      });
      analysisStatusLine.style.display = 'block';
      analysisStatusText.textContent = data.error || 'Analysis failed';
      analysisStatusLine.className = 'analysis-status-line error';
      return;
    }

    // All steps done
    ['fetch', 'analyze', 'images', 'generate'].forEach(s => setAnalysisStep(s, 'done'));

    // Show "All set!" status
    analysisStatusLine.style.display = 'block';
    analysisStatusText.textContent = 'All set!';
    analysisStatusLine.className = 'analysis-status-line success';

    // Auto-collapse steps after a beat
    setTimeout(() => collapseAnalysisSteps(), 600);

    const { brand, images, favicon, pageTitle } = data;

    // Store favicon for auto-icon after brand save
    if (favicon) pendingIconUrl = favicon;

    // Show preview card (prominent)
    if (favicon || (images && images.length > 0)) {
      brandPreviewThumb.src = favicon || images[0].url;
      brandPreviewThumb.onerror = () => { brandPreviewRow.style.display = 'none'; };
      brandPreviewName.textContent = brand.name || pageTitle || '';
      brandPreviewDesc.textContent = brand.description || '';
      brandPreviewRow.style.display = 'flex';
    }

    // Auto-fill brand fields
    if (!brandNameInput.value.trim() && brand.name) {
      brandNameInput.value = brand.name;
    }
    if (!brandDescInput.value.trim() && brand.description) {
      brandDescInput.value = brand.description;
    }

    // Fill colors from analysis
    if (brand.colors) {
      for (const [key, input] of Object.entries(colorInputs)) {
        if (brand.colors[key]) {
          input.value = brand.colors[key];
          document.getElementById(`brand-color-${key}-hex`).textContent = brand.colors[key].toUpperCase();
        }
      }
    }

    // Fill advanced fields
    if (brand.systemPrompt) document.getElementById('brand-system-prompt').value = brand.systemPrompt;
    if (brand.imageStyle) document.getElementById('brand-image-style').value = brand.imageStyle;
    if (brand.defaultBackground) document.getElementById('brand-bg-desc').value = brand.defaultBackground;
    if (brand.microLabel) document.getElementById('brand-micro-label').value = brand.microLabel;
    if (brand.watermarkText) document.getElementById('brand-watermark').value = brand.watermarkText;

    if (brand.tone) brandAiStatus.textContent = `Tone: ${brand.tone}`;

    // Store content pillars for saving with the brand
    if (brand.contentPillars && brand.contentPillars.length > 0) {
      pendingContentPillars = brand.contentPillars;
    }

    // Render images grid
    if (images && images.length > 0) {
      brandImagesGrid.innerHTML = '';
      brandImagesCount.textContent = `(${images.length} found)`;
      images.forEach((img) => {
        const thumb = document.createElement('img');
        thumb.className = 'brand-image-thumb';
        thumb.src = img.url;
        thumb.title = img.type || 'image';
        thumb.loading = 'lazy';
        thumb.onerror = () => thumb.remove();
        thumb.addEventListener('click', () => openLightbox(img.url));
        brandImagesGrid.appendChild(thumb);
      });
      brandImagesSection.style.display = 'block';
    }

  } catch (err) {
    responseReceived = true;
    stepTimers.forEach(t => clearTimeout(t));
    if (err.name === 'AbortError') return;
    brandAnalysisSteps.querySelectorAll('.analysis-step.active').forEach(el => {
      el.className = 'analysis-step error';
      el.querySelector('.step-icon').textContent = '\u2717';
    });
    analysisStatusLine.style.display = 'block';
    analysisStatusText.textContent = 'Could not analyze website';
    analysisStatusLine.className = 'analysis-status-line error';
    console.error('[Website Analysis]', err);
  }
}

async function selectBrandImage(thumbEl, imageUrl) {
  // Highlight selected image
  brandImagesGrid.querySelectorAll('.brand-image-thumb').forEach(t => t.classList.remove('selected'));
  thumbEl.classList.add('selected');

  // Upload as brand icon via existing upload-icon endpoint
  try {
    // Fetch image and upload as file
    const resp = await fetch(imageUrl);
    if (!resp.ok) {
      console.warn('Could not fetch image:', resp.status);
      return;
    }
    const blob = await resp.blob();
    if (!blob.type.startsWith('image/')) {
      console.warn('Fetched resource is not an image:', blob.type);
      return;
    }
    const form = new FormData();
    form.append('icon', blob, 'website-icon.png');
    form.append('brand', editingBrandId || '__pending__');
    const res = await authFetch('/api/upload-icon', { method: 'POST', body: form });
    const data = await res.json();
    if (data.ok) {
      updateIconPreview();
    }
  } catch (err) {
    console.warn('Could not set image as icon:', err.message);
  }
}

// Auto-trigger: debounced input + instant paste
function isValidUrl(str) {
  return str.includes('.') && str.length > 3 && !/\s/.test(str);
}

brandWebsiteInput.addEventListener('input', () => {
  clearTimeout(analysisDebounce);
  const val = brandWebsiteInput.value.trim();
  if (isValidUrl(val)) {
    analysisDebounce = setTimeout(() => analyzeWebsite(val), 1500);
  } else {
    brandAnalysisSection.style.display = 'none';
  }
});

brandWebsiteInput.addEventListener('paste', () => {
  clearTimeout(analysisDebounce);
  // Use setTimeout(0) to get the pasted value after it's applied
  setTimeout(() => {
    const val = brandWebsiteInput.value.trim();
    if (isValidUrl(val)) analyzeWebsite(val);
  }, 0);
});

// AI Setup (fallback manual trigger — works with URL alone or name+desc)
brandAiBtn.addEventListener('click', async () => {
  const name = brandNameInput.value.trim();
  const description = brandDescInput.value.trim();
  const websiteUrl = brandWebsiteInput.value.trim();
  if (!name && !websiteUrl) {
    brandAiStatus.textContent = 'Enter a website URL or brand name';
    return;
  }
  // If URL is provided, trigger website analysis instead
  if (websiteUrl && !description) {
    analyzeWebsite(websiteUrl);
    return;
  }
  brandAiBtn.disabled = true;
  brandAiStatus.textContent = 'Generating with AI...';
  try {
    const res = await authFetch('/api/brands/ai-setup', {
      method: 'POST',
      body: JSON.stringify({ name, description, websiteUrl: brandWebsiteInput.value.trim() }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'AI setup failed');
    const s = data.suggestion;
    if (s.colors) {
      for (const [key, input] of Object.entries(colorInputs)) {
        if (s.colors[key]) {
          input.value = s.colors[key];
          document.getElementById(`brand-color-${key}-hex`).textContent = s.colors[key].toUpperCase();
        }
      }
    }
    if (s.systemPrompt) document.getElementById('brand-system-prompt').value = s.systemPrompt;
    if (s.imageStyle) document.getElementById('brand-image-style').value = s.imageStyle;
    if (s.defaultBackground) document.getElementById('brand-bg-desc').value = s.defaultBackground;
    if (!document.getElementById('brand-micro-label').value) {
      document.getElementById('brand-micro-label').value = name.toUpperCase();
    }
    if (s.tone) brandAiStatus.textContent = `Tone: ${s.tone}`;
    else brandAiStatus.textContent = 'Done!';
  } catch (err) {
    brandAiStatus.textContent = err.message;
  } finally {
    brandAiBtn.disabled = false;
  }
});

// Save Brand
brandSaveBtn.addEventListener('click', async () => {
  const name = brandNameInput.value.trim();
  if (!name) { brandModalStatus.textContent = 'Brand name is required'; brandModalStatus.className = 'brand-modal-status error'; return; }
  const colors = {};
  for (const [key, input] of Object.entries(colorInputs)) colors[key] = input.value;
  const payload = {
    name,
    website: brandWebsiteInput.value.trim(),
    colors,
    systemPrompt: document.getElementById('brand-system-prompt').value.trim(),
    imageStyle: document.getElementById('brand-image-style').value.trim(),
    defaultMicroLabel: document.getElementById('brand-micro-label').value.trim() || name.toUpperCase(),
    defaultBackground: document.getElementById('brand-bg-desc').value.trim() || DEFAULT_BACKGROUND,
    iconOverlayText: document.getElementById('brand-watermark').value.trim() || brandWebsiteInput.value.trim(),
  };
  if (pendingContentPillars) payload.contentPillars = pendingContentPillars;
  brandSaveBtn.disabled = true;
  brandModalStatus.textContent = 'Saving...';
  brandModalStatus.className = 'brand-modal-status';
  try {
    const url = editingBrandId ? `/api/brands/${editingBrandId}` : '/api/brands';
    const method = editingBrandId ? 'PUT' : 'POST';
    const res = await authFetch(url, { method, body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    // Refresh brands
    const bRes = await authFetch('/api/brands');
    const bData = await bRes.json();
    brands = bData.brands || [];
    if (data.brand?.id) currentBrand = data.brand.id;
    pendingContentPillars = null;
    renderBrandSelector();
    await loadContentIdeas();
    updateIconPreview();
    const wasNewBrand = !editingBrandId;
    closeBrandModal();
    // Auto-set icon from website favicon for new brands
    if (wasNewBrand && pendingIconUrl) {
      try {
        const iconResp = await fetch(pendingIconUrl);
        if (!iconResp.ok) { pendingIconUrl = null; throw new Error('Fetch failed: ' + iconResp.status); }
        const blob = await iconResp.blob();
        if (!blob.type.startsWith('image/')) { pendingIconUrl = null; throw new Error('Not an image: ' + blob.type); }
        const iconForm = new FormData();
        iconForm.append('icon', blob, 'website-icon.png');
        iconForm.append('brand', currentBrand);
        await authFetch('/api/upload-icon', { method: 'POST', body: iconForm });
        updateIconPreview();
      } catch (e) { console.warn('Auto icon failed:', e.message); }
      pendingIconUrl = null;
    }
    // Auto-generate content ideas for new brands with a website
    if (wasNewBrand && payload.website) {
      autoGenerateBtn.click();
    }
  } catch (err) {
    brandModalStatus.textContent = err.message;
    brandModalStatus.className = 'brand-modal-status error';
  } finally {
    brandSaveBtn.disabled = false;
  }
});

// Delete Brand
brandDeleteBtn.addEventListener('click', async () => {
  if (!editingBrandId) return;
  if (!confirm('Delete this brand? This cannot be undone.')) return;
  try {
    const res = await authFetch(`/api/brands/${editingBrandId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const bRes = await authFetch('/api/brands');
    const bData = await bRes.json();
    brands = bData.brands || [];
    currentBrand = brands[0]?.id || null;
    // Reset editor state to avoid stale data from deleted brand
    selectedIdea = null;
    slideEdits = [];
    generatedImages = {};
    currentSlideIndex = 0;
    contentData = null;
    referenceImageFilename = null;
    screenshotImageFilename = null;
    slideReferenceImages = {};
    editorArea.style.display = 'none';
    document.getElementById('content-plan-view').style.display = 'none';
    emptyState.style.display = 'flex';
    closeBrandModal();
    if (!currentBrand) {
      renderBrandSelector();
      renderEmptySidebar();
      return;
    }
    renderBrandSelector();
    await loadContentIdeas();
    updateIconPreview();
  } catch (err) {
    brandModalStatus.textContent = err.message;
    brandModalStatus.className = 'brand-modal-status error';
  }
});

function renderEmptySidebar() {
  sidebar.innerHTML = '<div class="sidebar-loading" style="text-align:center;padding:32px 16px;opacity:0.6;">Create a brand to get started</div>';
  ideaCount.textContent = '0 ideas';
}

async function loadContentIdeas() {
  if (!currentBrand || brands.length === 0) {
    renderEmptySidebar();
    return;
  }
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
    html += `<div class="category-header">${escapeHtml(cat.name)}</div>`;
    for (const idea of cat.ideas) {
      totalIdeas++;
      html += `<div class="idea-item" data-idea-id="${escapeHtml(idea.id)}">`;
      html += `<span class="idea-id">${escapeHtml(idea.id)}</span>`;
      html += `<span class="idea-name">${escapeHtml(idea.title)}</span>`;
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

  // Add "Generate More" button for AI-generated ideas
  const hasAiIdeas = app.categories.some(c => c.ideas.some(i => i.id?.startsWith('AI-')));
  if (hasAiIdeas) {
    const moreDiv = document.createElement('div');
    moreDiv.className = 'sidebar-generate-more';
    moreDiv.innerHTML = `<input type="text" class="sidebar-prompt-input" id="sidebar-prompt-input" placeholder="e.g. explain app features..." /><div class="sidebar-prompt-row"><input type="number" class="sidebar-slides-input" id="sidebar-slides-input" min="2" max="12" placeholder="Slides" title="Number of slides (default 6-7)" /><button class="btn secondary sidebar-more-btn" id="sidebar-generate-more-btn">+ Generate Idea</button></div><div class="sidebar-more-status" id="sidebar-more-status"></div>`;
    sidebar.appendChild(moreDiv);
    document.getElementById('sidebar-generate-more-btn').addEventListener('click', generateMoreIdeas);
  }
}

async function generateMoreIdeas() {
  const btn = document.getElementById('sidebar-generate-more-btn');
  const status = document.getElementById('sidebar-more-status');
  if (!btn || !currentBrand) return;
  btn.disabled = true;
  btn.textContent = 'Generating...';
  if (status) status.textContent = '';
  try {
    const app = contentData?.apps?.[0];
    const allIdeas = app?.categories?.flatMap(c => c.ideas) || [];
    const existingTitles = allIdeas.map(i => i.title);
    const startIndex = allIdeas.length;
    const res = await authFetch('/api/generate-content-ideas', {
      method: 'POST',
      body: JSON.stringify({
        brand: currentBrand, existingTitles, numIdeas: 1, startIndex,
        userTopic: document.getElementById('sidebar-prompt-input')?.value?.trim() || '',
        slidesPerIdea: parseInt(document.getElementById('sidebar-slides-input')?.value) || 0,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');
    if (!data.ideas || data.ideas.length === 0) throw new Error('No new ideas generated.');
    const newIdeas = data.ideas.map((idea, i) => ({
      id: `AI-${startIndex + i + 1}`,
      title: idea.title,
      caption: idea.caption || '',
      slides: (idea.slides || []).map((s, si) => ({ ...s, number: s.number || si + 1, type: s.type || 'text' })),
    }));
    let aiCat = app.categories.find(c => c.name === 'AI-Generated Ideas');
    if (aiCat) {
      aiCat.ideas.push(...newIdeas);
    } else {
      app.categories.push({ name: 'AI-Generated Ideas', ideas: newIdeas });
    }
    renderSidebar();
    // Clear the prompt input (sidebar was re-rendered so the DOM element is fresh, but clear just in case)
    const promptEl = document.getElementById('sidebar-prompt-input');
    if (promptEl) promptEl.value = '';
    // Update content plan grid if visible
    const contentPlanView = document.getElementById('content-plan-view');
    if (contentPlanView && contentPlanView.style.display !== 'none') {
      const brandObj = brands.find(b => b.id === currentBrand);
      const allUpdatedIdeas = app.categories.flatMap(c => c.ideas);
      document.getElementById('content-plan-subtitle').textContent = `${allUpdatedIdeas.length} carousel ideas for ${brandObj?.name || 'Brand'}`;
      renderContentPlanGrid(allUpdatedIdeas, brandObj);
    }
  } catch (err) {
    if (status) status.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '+ Generate Idea';
  }
}

// --- Idea Selection ---
function selectIdea(ideaId) {
  if (generateAbort) generateAbort.abort();
  loadingSpinner.classList.remove('active');

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
  slideReferenceImages = {};

  slideEdits = idea.slides.map((slide) => ({ ...slide }));

  emptyState.style.display = 'none';
  personalizeView.style.display = 'none';
  if (document.getElementById('meme-view')) document.getElementById('meme-view').style.display = 'none';
  document.getElementById('content-plan-view').style.display = 'none';
  editorArea.style.display = 'block';

  ideaBadge.textContent = idea.id;
  ideaTitle.textContent = idea.title;

  // Populate caption editor
  const captionEditor = document.getElementById('caption-editor');
  const captionTextarea = document.getElementById('caption-textarea');
  if (idea.caption) {
    captionTextarea.value = idea.caption;
    captionEditor.style.display = 'block';
  } else {
    captionTextarea.value = '';
    captionEditor.style.display = 'block';
  }

  renderSlideTabs();
  loadSlideIntoForm(0);
  updatePreviewMockup();
  updateGallery();
  progressSection.style.display = 'none';
  saveSession();
}

// --- Load freeform-generated content as idea ---
function loadFreeformContent(data) {
  if (generateAbort) generateAbort.abort();
  loadingSpinner.classList.remove('active');

  selectedIdea = {
    id: 'AI',
    title: data.title || 'Freeform Carousel',
    caption: data.caption || '',
    slides: data.slides,
  };

  currentSlideIndex = 0;
  generatedImages = {};
  batchJobId = null;
  slideReferenceImages = {};

  slideEdits = data.slides.map((slide) => ({ ...slide }));

  sidebar.querySelectorAll('.idea-item').forEach((el) => el.classList.remove('active'));

  emptyState.style.display = 'none';
  personalizeView.style.display = 'none';
  if (document.getElementById('meme-view')) document.getElementById('meme-view').style.display = 'none';
  editorArea.style.display = 'block';

  ideaBadge.textContent = 'AI';
  ideaTitle.textContent = data.title || 'Freeform Carousel';

  // Populate caption editor
  const captionEditor = document.getElementById('caption-editor');
  const captionTextarea = document.getElementById('caption-textarea');
  captionTextarea.value = data.caption || '';
  captionEditor.style.display = 'block';

  renderSlideTabs();
  loadSlideIntoForm(0);
  updatePreviewMockup();
  updateGallery();
  progressSection.style.display = 'none';
  saveSession();
}

// --- Slide Tabs ---
function renderSlideTabs() {
  let html = '';
  for (let i = 0; i < slideEdits.length; i++) {
    const s = slideEdits[i];
    const active = i === currentSlideIndex ? 'active' : '';
    const generated = generatedImages[i] ? 'generated' : '';
    const typeIcon = s.type === 'photo' ? 'P' : s.type === 'mockup' ? 'M' : 'T';
    const hasSlideRef = slideReferenceImages[i] ? 'has-ref' : '';
    html += `<button class="slide-tab ${active} ${generated} ${hasSlideRef}" data-index="${i}">`;
    html += `<span class="tab-num">${s.number}</span>`;
    html += `<span class="tab-type">${typeIcon}</span>`;
    html += `<span class="tab-label">${s.label || ''}</span>`;
    if (slideReferenceImages[i]) html += `<span class="tab-ref-dot" title="Has slide image">&#128247;</span>`;
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

  // Photo overlay fields
  if (form.elements.overlayStyle) form.elements.overlayStyle.value = slide.overlayStyle || 'dark gradient';
  if (form.elements.overlayPlacement) form.elements.overlayPlacement.value = slide.overlayPlacement || 'bottom third';

  // Text background field
  if (form.elements.backgroundStyle) form.elements.backgroundStyle.value = slide.backgroundStyle || '';

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
  if (form.elements.aiBgSetting) form.elements.aiBgSetting.value = slide.aiBgSetting || '';
  if (form.elements.aiBgMood) form.elements.aiBgMood.value = slide.aiBgMood || '';

  // New mockup controls
  if (form.elements.aspectRatio) form.elements.aspectRatio.value = slide.aspectRatio || '9:16';
  if (form.elements.mockupFont) form.elements.mockupFont.value = slide.fontFamily || 'Helvetica';
  if (form.elements.overlayDarken) {
    form.elements.overlayDarken.value = Math.round((slide.overlayDarken || 0) * 100);
    const darkenLabel = document.getElementById('darkenValue');
    if (darkenLabel) darkenLabel.textContent = Math.round((slide.overlayDarken || 0) * 100) + '%';
  }
  if (form.elements.headlineFontSize) {
    form.elements.headlineFontSize.value = slide.headlineFontSize || 82;
    document.getElementById('headlineFontSizeValue').textContent = slide.headlineFontSize || 82;
  }
  if (form.elements.bodyFontSize) {
    form.elements.bodyFontSize.value = slide.bodyFontSize || 34;
    document.getElementById('bodyFontSizeValue').textContent = slide.bodyFontSize || 34;
  }

  // Video fields
  if (form.elements.videoScene) form.elements.videoScene.value = slide.scene || '';
  if (form.elements.videoMood) form.elements.videoMood.value = slide.videoMood || 'energetic and dynamic';
  if (form.elements.videoCamera) form.elements.videoCamera.value = slide.cameraMove || 'slow tracking shot';
  if (form.elements.videoDuration) form.elements.videoDuration.value = slide.duration || '5';
  if (form.elements.videoAudio) form.elements.videoAudio.checked = slide.audio || false;
  if (form.elements.videoTextOverlay) form.elements.videoTextOverlay.checked = slide.videoTextOverlay ?? true;

  // Color overrides
  const textColorEnabled = document.getElementById('mockupTextColorEnabled');
  const accentColorEnabled = document.getElementById('mockupAccentColorEnabled');
  if (textColorEnabled) textColorEnabled.checked = !!slide.textColor;
  if (accentColorEnabled) accentColorEnabled.checked = !!slide.microColor;
  if (form.elements.mockupTextColor && slide.textColor) form.elements.mockupTextColor.value = slide.textColor;
  if (form.elements.mockupAccentColor && slide.microColor) form.elements.mockupAccentColor.value = slide.microColor;

  // Restore per-element offsets
  elementOffsets = {
    micro: { x: slide.microOffsetX || 0, y: slide.microOffsetY || 0 },
    headline: { x: slide.headlineOffsetX || 0, y: slide.headlineOffsetY || 0 },
    body: { x: slide.bodyOffsetX || 0, y: slide.bodyOffsetY || 0 },
    icon: { x: slide.iconOffsetX || 0, y: slide.iconOffsetY || 0 },
  };
  selectedElement = 'headline';
  applyTextOffset();
  updateAspectRatioPreview();

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

  // Restore per-slide reference image state
  const slideRef = slideReferenceImages[index];
  if (slideRef) {
    slideRefFilename.textContent = slideRef.displayName;
    slideRefPreview.src = `/uploads/${slideRef.filename}`;
    slideRefPreview.style.display = 'block';
    slideRefClear.style.display = 'inline-block';
  } else {
    slideRefFilename.textContent = 'No image';
    slideRefPreview.style.display = 'none';
    slideRefClear.style.display = 'none';
  }

  toggleTypeFields();

  // Determine preview mode based on slide type and whether it has been generated
  const needsAI = slideNeedsAI(slide.type, slide.imageUsage);
  if (generatedImages[index]) {
    const gen = generatedImages[index];
    if (gen.isVideo) {
      previewImg.style.display = 'none';
      previewVideo.src = gen.url;
      previewVideo.style.display = 'block';
    } else {
      previewVideo.style.display = 'none';
      previewImg.src = gen.url;
      previewImg.style.display = 'block';
    }
    downloadButtons.style.display = 'flex';
    statusEl.textContent = `Slide ${index + 1} generated.`;
    setPreviewMode('generated');
  } else if (needsAI) {
    previewImg.style.display = 'none';
    previewVideo.style.display = 'none';
    downloadButtons.style.display = 'none';
    statusEl.textContent = 'Ready — click Generate to create this slide.';
    setPreviewMode('live');
  } else {
    previewImg.style.display = 'none';
    previewVideo.style.display = 'none';
    downloadButtons.style.display = 'flex';
    statusEl.textContent = 'Live preview — updates instantly.';
    setPreviewMode('live');
  }
  updateEditSection();
  updatePreviewDragOverlay();
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
    slide.overlayStyle = form.elements.overlayStyle?.value || 'dark gradient';
    slide.overlayPlacement = form.elements.overlayPlacement?.value || 'bottom third';
  } else if (slide.type === 'text') {
    slide.backgroundStyle = form.elements.backgroundStyle?.value || '';
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
    slide.aiBgSetting = form.elements.aiBgSetting?.value || '';
    slide.aiBgMood = form.elements.aiBgMood?.value || '';
    // Per-element offsets
    slide.microOffsetX = elementOffsets.micro.x;
    slide.microOffsetY = elementOffsets.micro.y;
    slide.headlineOffsetX = elementOffsets.headline.x;
    slide.headlineOffsetY = elementOffsets.headline.y;
    slide.bodyOffsetX = elementOffsets.body.x;
    slide.bodyOffsetY = elementOffsets.body.y;
    slide.iconOffsetX = elementOffsets.icon.x;
    slide.iconOffsetY = elementOffsets.icon.y;
    // New controls
    slide.aspectRatio = form.elements.aspectRatio?.value || '9:16';
    slide.fontFamily = form.elements.mockupFont?.value || 'Helvetica';
    slide.overlayDarken = (parseInt(form.elements.overlayDarken?.value) || 0) / 100;
    slide.headlineFontSize = parseInt(form.elements.headlineFontSize?.value) || 82;
    slide.bodyFontSize = parseInt(form.elements.bodyFontSize?.value) || 34;
    // Color overrides (only if enabled)
    const textColorEnabled = document.getElementById('mockupTextColorEnabled');
    const accentColorEnabled = document.getElementById('mockupAccentColorEnabled');
    slide.textColor = textColorEnabled?.checked ? form.elements.mockupTextColor?.value : null;
    slide.microColor = accentColorEnabled?.checked ? form.elements.mockupAccentColor?.value : null;
  } else if (slide.type === 'video') {
    slide.scene = form.elements.videoScene?.value || '';
    slide.videoMood = form.elements.videoMood?.value || 'energetic and dynamic';
    slide.cameraMove = form.elements.videoCamera?.value || 'slow tracking shot';
    slide.duration = parseInt(form.elements.videoDuration?.value) || 5;
    slide.audio = form.elements.videoAudio?.checked || false;
    slide.videoTextOverlay = form.elements.videoTextOverlay?.checked ?? true;
  }
}

function toggleTypeFields() {
  const type = slideTypeSelect.value;
  photoFields.style.display = type === 'photo' ? 'block' : 'none';
  textFields.style.display = type === 'text' ? 'block' : 'none';
  mockupFields.style.display = type === 'mockup' ? 'block' : 'none';
  videoFields.style.display = type === 'video' ? 'block' : 'none';
  if (type === 'mockup') toggleMockupPhoneOptions();

  // Hide mockup image upload section from sidebar — moved to preview overlay
  mockupImageUploadSection.style.display = 'none';
  screenshotWarning.style.display = 'none';

  // Hide reference sections for mockup/video (they are ignored server-side)
  const slideRefSection = document.querySelector('.slide-ref-section');
  const refSection = document.querySelector('.ref-section');
  const hideRef = type === 'mockup' || type === 'video';
  if (slideRefSection) slideRefSection.style.display = hideRef ? 'none' : '';
  if (refSection) refSection.style.display = hideRef ? 'none' : '';

  const hints = {
    photo: 'AI-generated background image with text overlay',
    text: 'Text and colors only — no background image',
    mockup: 'App screenshot in a phone frame with text overlay',
    video: 'AI-generated video clip (Kling 3.0) — 5-10 seconds',
  };
  document.getElementById('slideTypeHint').textContent = hints[type] || '';
  updatePreviewImageOverlay();

  // Switch preview mode based on whether this type needs AI
  const usage = imageUsageSelect.value;
  const hasGenerated = !!generatedImages[currentSlideIndex];
  if (hasGenerated) {
    setPreviewMode('generated');
  } else {
    setPreviewMode('live');
  }
}

function toggleMockupPhoneOptions() {
  const usage = imageUsageSelect.value;

  mockupPhoneOptions.style.display = usage === 'phone' ? 'block' : 'none';
  mockupFigureOptions.style.display = usage === 'figure' ? 'block' : 'none';
  mockupBgOptions.style.display = (usage === 'background' || usage === 'ai-background') ? 'block' : 'none';
  const aiBgOptions = document.getElementById('mockup-ai-bg-options');
  if (aiBgOptions) aiBgOptions.style.display = usage === 'ai-background' ? 'block' : 'none';
  updatePreviewImageOverlay();
}

slideTypeSelect.addEventListener('change', () => {
  toggleTypeFields();
  updatePreviewMockup();
});

// Background + Text shortcut button
const bgTextShortcutBtn = document.getElementById('bg-text-shortcut-btn');
bgTextShortcutBtn.addEventListener('click', () => {
  slideTypeSelect.value = 'mockup';
  toggleTypeFields();
  imageUsageSelect.value = 'background';
  toggleMockupPhoneOptions();
  if (!screenshotImageFilename) {
    screenshotImageInput.click();
  }
  updatePreviewMockup();
});

mockupLayoutSelect.addEventListener('change', () => {
  toggleMockupPhoneOptions();
  // Reset offsets when layout changes (each layout has different default positions)
  elementOffsets = {
    micro: { x: 0, y: 0 },
    headline: { x: 0, y: 0 },
    body: { x: 0, y: 0 },
    icon: { x: 0, y: 0 },
  };
  updatePreviewMockup();
});

mockupThemeSelect.addEventListener('change', updatePreviewMockup);

imageUsageSelect.addEventListener('change', () => {
  toggleMockupPhoneOptions();
  updatePreviewMockup();
  // Update preview mode — ai-background needs AI, others don't
  const type = slideTypeSelect.value;
  const usage = imageUsageSelect.value;
  const hasGenerated = !!generatedImages[currentSlideIndex];
  if (hasGenerated) {
    setPreviewMode('generated');
  } else {
    setPreviewMode('live');
  }
});

document.getElementById('bgOverlayOpacity').addEventListener('change', updatePreviewMockup);
document.getElementById('phoneAngle').addEventListener('change', updatePreviewMockup);
document.getElementById('phoneSize').addEventListener('change', updatePreviewMockup);
document.getElementById('figurePosition').addEventListener('change', updatePreviewMockup);
document.getElementById('figureSize').addEventListener('change', updatePreviewMockup);
document.getElementById('figureBorderRadius').addEventListener('change', updatePreviewMockup);

// New mockup controls
document.getElementById('aspectRatio').addEventListener('change', () => {
  updateAspectRatioPreview();
  updatePreviewMockup();
});
document.getElementById('mockupFont').addEventListener('change', updatePreviewMockup);
document.getElementById('overlayDarken').addEventListener('input', () => {
  const val = document.getElementById('overlayDarken').value;
  document.getElementById('darkenValue').textContent = val + '%';
  updatePreviewMockup();
});
document.getElementById('mockupTextColor').addEventListener('input', updatePreviewMockup);
document.getElementById('mockupAccentColor').addEventListener('input', updatePreviewMockup);
document.getElementById('mockupTextColorEnabled').addEventListener('change', updatePreviewMockup);
document.getElementById('mockupAccentColorEnabled').addEventListener('change', updatePreviewMockup);
form.elements.includeOwl.addEventListener('change', updatePreviewMockup);

// Font size sliders
document.getElementById('headlineFontSize').addEventListener('input', () => {
  document.getElementById('headlineFontSizeValue').textContent = document.getElementById('headlineFontSize').value;
  updatePreviewMockup();
});
document.getElementById('bodyFontSize').addEventListener('input', () => {
  document.getElementById('bodyFontSizeValue').textContent = document.getElementById('bodyFontSize').value;
  updatePreviewMockup();
});

// Caption editor saves edits back to selectedIdea
document.getElementById('caption-textarea').addEventListener('input', (e) => {
  if (selectedIdea) {
    selectedIdea.caption = e.target.value;
    saveSession();
  }
});

// Layout/highlight/overlay controls trigger preview update
if (form.elements.highlightStyle) form.elements.highlightStyle.addEventListener('change', updatePreviewMockup);
if (form.elements.layoutTemplate) form.elements.layoutTemplate.addEventListener('change', updatePreviewMockup);
if (form.elements.overlayPlacement) form.elements.overlayPlacement.addEventListener('change', updatePreviewMockup);

// Expand preview toggle
const previewExpandBtn = document.getElementById('preview-expand-btn');
previewExpandBtn.addEventListener('click', () => {
  previewFrame.classList.toggle('expanded');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewFrame.classList.contains('expanded')) {
    previewFrame.classList.remove('expanded');
  }
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

  // Get brand colors (may be overridden)
  const brand = brands.find((b) => b.id === currentBrand);
  const accentColorEnabled = document.getElementById('mockupAccentColorEnabled')?.checked;
  const textColorEnabled = document.getElementById('mockupTextColorEnabled')?.checked;
  const accentColor = accentColorEnabled ? (form.elements.mockupAccentColor?.value || '#E94560') : (brand?.colors?.accent || '#E94560');
  const primaryColor = brand?.colors?.primary || '#072f57';

  const isMockup = (form.elements.slideType?.value || slide.type) === 'mockup';

  // Update mockup background based on type
  if (isPhoto) {
    previewMockup.classList.add('photo-type');
    const slideRef = slideReferenceImages[currentSlideIndex];
    if (slideRef) {
      previewMockup.style.background = `linear-gradient(180deg, rgba(15,23,42,0.2) 0%, rgba(15,23,42,0.85) 70%), url('/uploads/${slideRef.filename}') center/cover no-repeat`;
      mockupPhotoPlaceholder.style.display = 'none';
    } else {
      previewMockup.style.background = '';
      mockupPhotoPlaceholder.style.display = 'flex';
      mockupPhotoPlaceholder.querySelector('span').textContent = '';
    }
  } else if (isMockup) {
    previewMockup.classList.remove('photo-type');
    const mockupTheme = mockupThemeSelect.value || 'dark';
    const usage = imageUsageSelect.value;
    const isBackground = usage === 'background';
    const isAiBg = usage === 'ai-background';
    if (isBackground && screenshotImageFilename) {
      const o = parseFloat(form.elements.bgOverlayOpacity?.value) || 0.55;
      previewMockup.style.background = `linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,${o*0.3}) 40%, rgba(0,0,0,${o*0.7}) 70%, rgba(0,0,0,${o}) 100%), url('/uploads/${screenshotImageFilename}') center/cover no-repeat`;
      mockupPhotoPlaceholder.style.display = 'none';
    } else if (isAiBg) {
      previewMockup.style.background = `linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%)`;
      mockupPhotoPlaceholder.style.display = 'flex';
      mockupPhotoPlaceholder.querySelector('span').textContent = 'AI will generate background';
    } else if (isBackground && !screenshotImageFilename) {
      previewMockup.style.background = `linear-gradient(135deg, #1e293b 0%, #334155 100%)`;
      mockupPhotoPlaceholder.style.display = 'flex';
      mockupPhotoPlaceholder.querySelector('span').textContent = ''; // overlay handles prompt
    } else {
      previewMockup.style.background = mockupTheme === 'light' ? '#F5F3EF' : primaryColor;
      mockupPhotoPlaceholder.style.display = 'none';
    }
  } else {
    previewMockup.classList.remove('photo-type');
    previewMockup.style.background = primaryColor;
    mockupPhotoPlaceholder.style.display = 'none';
  }

  // Phone frame / figure preview
  const phoneFrame = document.getElementById('mockup-phone-frame');
  const phoneImg = document.getElementById('mockup-phone-img');
  const figureImg = document.getElementById('mockup-figure-img');
  const mockupTextGroupEl = document.getElementById('mockup-text-group');

  if (phoneFrame) phoneFrame.style.display = 'none';
  if (figureImg) figureImg.style.display = 'none';
  if (mockupTextGroupEl) { mockupTextGroupEl.style.maxWidth = ''; mockupTextGroupEl.style.textAlign = ''; }

  // Text-statement layout: center text vertically and horizontally
  if (isMockup && mockupLayoutSelect.value === 'text-statement') {
    previewMockup.style.justifyContent = 'center';
    if (mockupTextGroupEl) mockupTextGroupEl.style.textAlign = 'center';
  } else if (isPhoto) {
    // Photo slide overlay placement
    const placement = form.elements.overlayPlacement?.value || 'bottom third';
    if (placement === 'left side') {
      previewMockup.style.justifyContent = 'flex-end';
      if (mockupTextGroupEl) { mockupTextGroupEl.style.maxWidth = '65%'; mockupTextGroupEl.style.textAlign = 'left'; }
    } else if (placement === 'lower-left') {
      previewMockup.style.justifyContent = 'flex-end';
      if (mockupTextGroupEl) mockupTextGroupEl.style.textAlign = 'left';
    } else {
      previewMockup.style.justifyContent = 'flex-end';
    }
  } else if (!isMockup) {
    // Text slide layout templates
    const layoutTpl = form.elements.layoutTemplate?.value || '';
    if (layoutTpl.includes('Layout B') || layoutTpl.includes('High Hook')) {
      previewMockup.style.justifyContent = 'flex-start';
      previewMockup.style.paddingTop = '36px';
    } else if (layoutTpl.includes('Layout C') || layoutTpl.includes('Center')) {
      previewMockup.style.justifyContent = 'center';
      if (mockupTextGroupEl) mockupTextGroupEl.style.textAlign = 'center';
    } else if (layoutTpl.includes('Layout D') || layoutTpl.includes('Bottom Emphasis')) {
      previewMockup.style.justifyContent = 'flex-end';
      if (mockupTextGroupEl) mockupTextGroupEl.style.textAlign = 'center';
    } else {
      previewMockup.style.justifyContent = 'flex-end';
      previewMockup.style.paddingTop = '';
    }
  } else {
    previewMockup.style.justifyContent = 'flex-end';
    previewMockup.style.paddingTop = '';
  }

  if (isMockup && screenshotImageFilename) {
    const usage = imageUsageSelect.value;
    const layout = mockupLayoutSelect.value;

    if (usage === 'phone') {
      const size = form.elements.phoneSize?.value || 'medium';
      const angle = form.elements.phoneAngle?.value || '-8';

      phoneFrame.style.display = 'block';
      phoneImg.src = `/uploads/${screenshotImageFilename}`;
      phoneFrame.className = 'mockup-phone-frame phone-' + size;

      if (layout === 'phone-right') {
        phoneFrame.classList.add('pos-right');
        if (mockupTextGroupEl) { mockupTextGroupEl.style.maxWidth = '55%'; }
      } else if (layout === 'phone-left') {
        phoneFrame.classList.add('pos-left');
        if (mockupTextGroupEl) { mockupTextGroupEl.style.maxWidth = '55%'; mockupTextGroupEl.style.textAlign = 'right'; }
      } else {
        phoneFrame.classList.add('pos-corner');
      }

      phoneFrame.style.transform = `rotate(${angle}deg)`;
    } else if (usage === 'figure') {
      const figSize = form.elements.figureSize?.value || 'medium';
      const figPos = form.elements.figurePosition?.value || 'center-right';
      const figRadius = form.elements.figureBorderRadius?.value || '24';

      figureImg.style.display = 'block';
      figureImg.src = `/uploads/${screenshotImageFilename}`;
      figureImg.className = 'mockup-figure-img fig-' + figSize;
      figureImg.style.borderRadius = figRadius + 'px';

      // Position
      figureImg.style.top = ''; figureImg.style.bottom = ''; figureImg.style.left = ''; figureImg.style.right = '';
      figureImg.style.margin = '';
      if (figPos.includes('top')) figureImg.style.top = '16px';
      else if (figPos.includes('bottom')) figureImg.style.bottom = '40px';
      else { figureImg.style.top = '50%'; figureImg.style.margin = '-35px 0 0'; }
      if (figPos.includes('right')) figureImg.style.right = '12px';
      else if (figPos.includes('left')) figureImg.style.left = '12px';
      else if (figPos === 'center') { figureImg.style.left = '50%'; figureImg.style.margin += ' 0 0 -35px'; }

      if (figPos.includes('right') || figPos.includes('left')) {
        if (mockupTextGroupEl) mockupTextGroupEl.style.maxWidth = '55%';
      }
    }
  }

  // Text color override
  const textColor = textColorEnabled ? (form.elements.mockupTextColor?.value || '#FFFFFF') : '';

  // Font size scaling (server renders at 1080px; preview is 216px = 1/5 ratio)
  const scaleRatio = 216 / 1080;
  const headlineFontPx = (parseInt(form.elements.headlineFontSize?.value) || 82) * scaleRatio;
  const bodyFontPx = (parseInt(form.elements.bodyFontSize?.value) || 34) * scaleRatio;
  mockupHeadline.style.fontSize = headlineFontPx + 'px';
  mockupBody.style.fontSize = bodyFontPx + 'px';

  // Update text content
  mockupMicro.textContent = microLabel;
  mockupMicro.style.color = accentColor;

  // Highlight style
  const highlightStyle = form.elements.highlightStyle?.value || 'subtle';
  const highlightOpacity = highlightStyle === 'bold' ? 0.5 : 0.3;

  // Headline with highlight bars (safe DOM construction)
  if (highlight && headline.includes(highlight)) {
    const parts = headline.split(highlight);
    mockupHeadline.textContent = '';
    mockupHeadline.appendChild(document.createTextNode(parts[0]));
    const span = document.createElement('span');
    span.className = 'highlight';
    span.style.color = accentColor;
    span.style.background = `rgba(${hexToRgb(accentColor)}, ${highlightOpacity})`;
    span.style.padding = '0 2px';
    span.style.borderRadius = '2px';
    span.textContent = highlight;
    mockupHeadline.appendChild(span);
    if (parts[1]) mockupHeadline.appendChild(document.createTextNode(parts[1]));
  } else {
    mockupHeadline.textContent = headline;
  }
  if (textColor) mockupHeadline.style.color = textColor;
  else mockupHeadline.style.color = '';

  mockupBody.textContent = body;
  if (textColor) mockupBody.style.color = textColor;
  else mockupBody.style.color = '';

  // Darken overlay on preview
  let darkenEl = previewMockup.querySelector('.mockup-darken');
  const darkenVal = parseInt(form.elements.overlayDarken?.value) || 0;
  if (isMockup && darkenVal > 0) {
    if (!darkenEl) {
      darkenEl = document.createElement('div');
      darkenEl.className = 'mockup-darken';
      darkenEl.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:0;border-radius:12px;';
      previewMockup.insertBefore(darkenEl, previewMockup.firstChild);
    }
    darkenEl.style.background = `rgba(0,0,0,${darkenVal / 100})`;
    darkenEl.style.display = 'block';
  } else if (darkenEl) {
    darkenEl.style.display = 'none';
  }

  // Font preview (apply to all slide types, not just mockup)
  const fontFamily = form.elements.mockupFont?.value || 'Helvetica';
  mockupHeadline.style.fontFamily = fontFamily + ', sans-serif';
  mockupBody.style.fontFamily = fontFamily + ', sans-serif';
  mockupMicro.style.fontFamily = fontFamily + ', sans-serif';

  // Icon position & visibility
  const mockupIcon = document.getElementById('mockup-icon');
  const showWatermark = form.elements.includeOwl.checked;
  mockupIcon.style.display = showWatermark ? '' : 'none';
  const pos = owlPositionInput.value;
  mockupIcon.style.top = pos.includes('top') ? '8px' : '';
  mockupIcon.style.bottom = pos.includes('bottom') ? '8px' : '';
  mockupIcon.style.left = pos.includes('left') ? '8px' : '';
  mockupIcon.style.right = pos.includes('right') ? '8px' : '';

  // Watermark text
  const mockupIconText = document.getElementById('mockup-icon-text');
  if (mockupIconText) {
    mockupIconText.textContent = brand?.iconOverlayText || '';
  }

  // Re-apply text offset transform
  applyTextOffset();

  // Update image overlay state
  updatePreviewImageOverlay();

  // Re-scale live preview if visible
  if (currentPreviewMode === 'live') scaleLivePreview();
}

// --- Preview Image Overlay ---
function updatePreviewImageOverlay() {
  const type = slideTypeSelect.value;
  const usage = imageUsageSelect.value;
  const isMockup = type === 'mockup';
  const hasScreenshot = !!screenshotImageFilename;
  const hasSlideRef = !!slideReferenceImages[currentSlideIndex];

  // Reset all states
  previewImageOverlay.style.display = 'none';
  previewImageBadge.style.display = 'none';
  previewOverlayEmpty.style.display = 'none';
  previewOverlayActions.style.display = 'none';
  previewOverlayLibraryLink.style.display = 'none';
  previewOverlayLibrary.style.display = 'none';

  if (isMockup) {
    if (usage === 'none' || usage === 'ai-background') return;

    const isBackground = usage === 'background';
    const isPhoneOrFigure = usage === 'phone' || usage === 'figure';

    if (!hasScreenshot) {
      // Empty state — show overlay with upload prompt
      previewImageOverlay.style.display = 'flex';
      previewOverlayEmpty.style.display = 'flex';
      previewOverlayLabel.textContent = 'Click to add image';
      previewOverlayLibraryLink.style.display = 'inline';
    } else if (isBackground) {
      // Background mode with image — show hover actions
      previewImageOverlay.style.display = 'flex';
      previewOverlayActions.style.display = 'flex';
      previewOverlayLibrary.style.display = 'inline-block';
    } else if (isPhoneOrFigure) {
      // Phone/figure mode with image — show badge thumbnail
      previewImageBadge.style.display = 'block';
      previewBadgeImg.src = `/uploads/${screenshotImageFilename}`;
    }
  } else {
    // Photo or text slide — reference image
    const hasRef = hasSlideRef;
    if (!hasRef) {
      previewImageOverlay.style.display = 'flex';
      previewOverlayEmpty.style.display = 'flex';
      previewOverlayLabel.textContent = type === 'photo' ? 'Click to add reference' : 'Optional reference image';
    } else {
      previewImageOverlay.style.display = 'flex';
      previewOverlayActions.style.display = 'flex';
    }
  }
}

// Overlay click — trigger file input based on slide type
previewImageOverlay.addEventListener('click', (e) => {
  // Don't trigger if clicking action buttons or library link
  if (e.target.closest('.preview-overlay-btn') || e.target.closest('.preview-overlay-library-link')) return;
  const type = slideTypeSelect.value;
  if (type === 'mockup') {
    screenshotImageInput.click();
  } else {
    slideRefInput.click();
  }
});

previewOverlayLibraryLink.addEventListener('click', (e) => {
  e.stopPropagation();
  openBgLibrary();
});

previewOverlayReplace.addEventListener('click', (e) => {
  e.stopPropagation();
  const type = slideTypeSelect.value;
  if (type === 'mockup') {
    screenshotImageInput.click();
  } else {
    slideRefInput.click();
  }
});

previewOverlayLibrary.addEventListener('click', (e) => {
  e.stopPropagation();
  openBgLibrary();
});

previewOverlayRemove.addEventListener('click', (e) => {
  e.stopPropagation();
  const type = slideTypeSelect.value;
  if (type === 'mockup') {
    screenshotClearBtn.click();
  } else {
    slideRefClear.click();
  }
});

// Badge click — trigger replace
previewImageBadge.addEventListener('click', () => {
  screenshotImageInput.click();
});

// --- Drag to Move Text (per-element) ---
function applyTextOffset() {
  // Preview is 5x smaller than canvas (1080/216 ≈ 5)
  const scale = 5;
  mockupMicro.style.transform = `translate(${elementOffsets.micro.x / scale}px, ${elementOffsets.micro.y / scale}px)`;
  mockupHeadline.style.transform = `translate(${elementOffsets.headline.x / scale}px, ${elementOffsets.headline.y / scale}px)`;
  mockupBody.style.transform = `translate(${elementOffsets.body.x / scale}px, ${elementOffsets.body.y / scale}px)`;
  const hasOffset = Object.values(elementOffsets).some(o => o.x !== 0 || o.y !== 0);
  mockupTextReset.style.display = hasOffset ? 'block' : 'none';
}

function resetTextOffset() {
  elementOffsets = {
    micro: { x: 0, y: 0 },
    headline: { x: 0, y: 0 },
    body: { x: 0, y: 0 },
    icon: { x: 0, y: 0 },
  };
  applyTextOffset();
  saveCurrentSlideEdits();
  saveSession();
}

function updateAspectRatioPreview() {
  const ratio = form.elements.aspectRatio?.value || '9:16';
  previewMockup.classList.remove('aspect-4-5', 'aspect-1-1');
  if (ratio === '4:5') previewMockup.classList.add('aspect-4-5');
  else if (ratio === '1:1') previewMockup.classList.add('aspect-1-1');
  const previewFrame = document.getElementById('preview-frame');
  if (previewFrame) previewFrame.dataset.ratio = ratio;
}

mockupTextReset.addEventListener('click', resetTextOffset);

// Drag handlers (mouse + touch) — per-element on the small preview
{
  function getMockupDragScale() {
    // Base ratio: canvas(1080) / mockup(216) = 5
    // Account for CSS transform scale on the mockup
    const cssScale = previewMockup.getBoundingClientRect().width / 216;
    return 5 / (cssScale || 1);
  }
  let dragging = false;
  let startX, startY, startOffsetX, startOffsetY;
  let dragTarget = null; // 'micro' | 'headline' | 'body'
  let dragScale = 5;

  function isEditing() {
    return mockupTextGroup.querySelector('[contenteditable="true"]') !== null;
  }

  function getElementKey(el) {
    if (el === mockupMicro || el.closest('.mockup-micro')) return 'micro';
    if (el === mockupHeadline || el.closest('.mockup-headline')) return 'headline';
    if (el === mockupBody || el.closest('.mockup-body')) return 'body';
    return 'headline'; // fallback
  }

  function startDrag(clientX, clientY, el) {
    if (isEditing()) return;
    const isMockup = (slideTypeSelect.value || slideEdits[currentSlideIndex]?.type) === 'mockup';
    if (!isMockup) return;
    dragTarget = getElementKey(el);
    selectedElement = dragTarget;
    dragging = true;
    dragScale = getMockupDragScale();
    startX = clientX;
    startY = clientY;
    startOffsetX = elementOffsets[dragTarget].x;
    startOffsetY = elementOffsets[dragTarget].y;
    mockupTextGroup.classList.add('dragging');
  }

  function moveDrag(clientX, clientY) {
    if (!dragging || !dragTarget) return;
    const dx = (clientX - startX) * dragScale;
    const dy = (clientY - startY) * dragScale;
    elementOffsets[dragTarget].x = Math.max(-500, Math.min(500, startOffsetX + dx));
    elementOffsets[dragTarget].y = Math.max(-800, Math.min(800, startOffsetY + dy));
    applyTextOffset();
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    dragTarget = null;
    mockupTextGroup.classList.remove('dragging');
    saveCurrentSlideEdits();
    saveSession();
  }

  // Mouse — each element is individually draggable
  [mockupMicro, mockupHeadline, mockupBody].forEach(el => {
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      startDrag(e.clientX, e.clientY, el);
    });
  });
  window.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', endDrag);

  // Touch
  [mockupMicro, mockupHeadline, mockupBody].forEach(el => {
    el.addEventListener('touchstart', (e) => {
      if (isEditing()) return;
      const t = e.touches[0];
      e.stopPropagation();
      startDrag(t.clientX, t.clientY, el);
    }, { passive: true });
  });
  window.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    moveDrag(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener('touchend', endDrag);
}

// --- Inline Text Editing (double-click) ---
function setupInlineEdit(el, formFieldName) {
  el.addEventListener('dblclick', (e) => {
    const isMockup = (slideTypeSelect.value || slideEdits[currentSlideIndex]?.type) === 'mockup';
    if (!isMockup) return;
    e.stopPropagation();
    el.contentEditable = 'true';
    el.classList.add('inline-editing');
    el.focus();
    // Select all text
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

  function commitEdit() {
    if (el.contentEditable !== 'true') return;
    el.contentEditable = 'false';
    el.classList.remove('inline-editing');
    // Read plain text (strips highlight spans)
    const text = el.textContent.trim();
    const formField = form.elements[formFieldName];
    if (formField) formField.value = text;
    saveCurrentSlideEdits();
    saveSession();
    updatePreviewMockup(); // Re-applies highlights
  }

  el.addEventListener('blur', commitEdit);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.blur();
    } else if (e.key === 'Escape') {
      // Cancel: restore from form field
      el.contentEditable = 'false';
      el.classList.remove('inline-editing');
      updatePreviewMockup();
    }
  });
}

setupInlineEdit(mockupMicro, 'microLabel');
setupInlineEdit(mockupHeadline, 'headline');
setupInlineEdit(mockupBody, 'body');

// --- Preview Image Drag & Inline Edit ---
const previewFrame = document.getElementById('preview-frame');
const previewDragOverlay = document.getElementById('preview-drag-overlay');
const previewEditGroup = document.getElementById('preview-edit-group');
const previewEditMicro = document.getElementById('preview-edit-micro');
const previewEditHeadline = document.getElementById('preview-edit-headline');
const previewEditBody = document.getElementById('preview-edit-body');
const previewDragHint = document.getElementById('preview-drag-hint');

// Show/hide the drag overlay when a mockup image is generated
function updatePreviewDragOverlay() {
  const slide = slideEdits[currentSlideIndex];
  const isMockup = slide && slide.type === 'mockup';
  const hasImage = previewImg.style.display === 'block' && previewImg.src;
  if (isMockup && hasImage) {
    previewDragOverlay.style.display = 'block';
    // Position the text group to match approximate text location
    positionPreviewEditGroup();
    // Fill in text content (invisible, used for hit area and editing)
    previewEditMicro.textContent = form.elements.microLabel?.value || '';
    previewEditHeadline.textContent = form.elements.headline?.value || '';
    previewEditBody.textContent = form.elements.body?.value || '';
  } else {
    previewDragOverlay.style.display = 'none';
  }
}

function getCanvasHeight(slide) {
  const ratios = { '9:16': 1920, '4:5': 1350, '1:1': 1080 };
  return ratios[slide?.aspectRatio] || 1920;
}

function positionPreviewEditGroup() {
  // The preview image maps canvas to its display size
  const slide = slideEdits[currentSlideIndex];
  if (!previewImg.naturalWidth) return;
  const imgRect = previewImg.getBoundingClientRect();
  const frameRect = previewFrame.getBoundingClientRect();
  const imgLeft = imgRect.left - frameRect.left;
  const imgTop = imgRect.top - frameRect.top;
  const canvasH = getCanvasHeight(slide);
  const scaleX = imgRect.width / 1080;
  const scaleY = imgRect.height / canvasH;

  // Approximate text position in canvas-space based on layout
  const layout = slide?.mockupLayout || 'phone-right';
  let canvasTextX = 90; // safe.left
  let canvasTextY = Math.round(120 * (canvasH / 1920)) + 60;
  if (layout === 'phone-left') {
    canvasTextX = 500;
    canvasTextY = Math.round(canvasH * 0.30);
  } else if (layout === 'text-statement') {
    canvasTextY = Math.round(canvasH * 0.3);
  }

  // Apply headline offset (used for group positioning)
  const ox = slide?.headlineOffsetX || 0;
  const oy = slide?.headlineOffsetY || 0;

  previewEditGroup.style.left = (imgLeft + (canvasTextX + ox) * scaleX) + 'px';
  previewEditGroup.style.top = (imgTop + (canvasTextY + oy) * scaleY) + 'px';
  previewEditGroup.style.maxWidth = (imgRect.width * 0.6) + 'px';

  // Position individual elements with their own offsets
  const microOx = (slide?.microOffsetX || 0) - ox;
  const microOy = (slide?.microOffsetY || 0) - oy;
  previewEditMicro.style.transform = `translate(${microOx * scaleX}px, ${microOy * scaleY}px)`;
  previewEditHeadline.style.transform = 'none';
  const bodyOx = (slide?.bodyOffsetX || 0) - ox;
  const bodyOy = (slide?.bodyOffsetY || 0) - oy;
  previewEditBody.style.transform = `translate(${bodyOx * scaleX}px, ${bodyOy * scaleY}px)`;
}

// Auto-regenerate mockup (fast, no AI call)
async function regenerateMockup() {
  const slide = slideEdits[currentSlideIndex];
  if (!slide || slide.type !== 'mockup') return;

  saveCurrentSlideEdits();

  // For non-AI mockups, just update the live preview — no server call
  if (!slideNeedsAI(slide.type, slide.imageUsage)) {
    updatePreviewMockup();
    saveSession();
    return;
  }

  const payload = buildSlidePayload(slide, currentSlideIndex);

  statusEl.textContent = 'Repositioning...';
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
    statusEl.textContent = `Slide ${currentSlideIndex + 1} done.`;
    setPreviewMode('generated');
    updateGallery();
    saveSession();
    updatePreviewDragOverlay();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

// Drag on the preview image — per-element
{
  let dragging = false;
  let startX, startY, startOffsetX, startOffsetY;
  let previewDragTarget = 'headline';

  function isPreviewEditing() {
    return previewEditGroup.classList.contains('editing');
  }

  function getPreviewScale() {
    const slide = slideEdits[currentSlideIndex];
    const canvasH = getCanvasHeight(slide);
    const imgRect = previewImg.getBoundingClientRect();
    return { sx: 1080 / imgRect.width, sy: canvasH / imgRect.height };
  }

  function getPreviewDragTarget(e) {
    const el = e.target;
    if (el === previewEditMicro || el.closest('.preview-edit-micro')) return 'micro';
    if (el === previewEditBody || el.closest('.preview-edit-body')) return 'body';
    // Default to selected element or headline
    return selectedElement || 'headline';
  }

  function startPreviewDrag(clientX, clientY, target) {
    if (isPreviewEditing()) return;
    const slide = slideEdits[currentSlideIndex];
    if (!slide || slide.type !== 'mockup') return;
    if (previewImg.style.display !== 'block') return;
    previewDragTarget = target;
    selectedElement = target;
    dragging = true;
    startX = clientX;
    startY = clientY;
    startOffsetX = elementOffsets[previewDragTarget].x;
    startOffsetY = elementOffsets[previewDragTarget].y;
    previewDragOverlay.classList.add('dragging');
    // Highlight selected element
    [previewEditMicro, previewEditHeadline, previewEditBody].forEach(el => el.classList.remove('drag-selected'));
    if (previewDragTarget === 'micro') previewEditMicro.classList.add('drag-selected');
    else if (previewDragTarget === 'body') previewEditBody.classList.add('drag-selected');
    else previewEditHeadline.classList.add('drag-selected');
  }

  function movePreviewDrag(clientX, clientY) {
    if (!dragging) return;
    const { sx, sy } = getPreviewScale();
    const dx = (clientX - startX) * sx;
    const dy = (clientY - startY) * sy;
    elementOffsets[previewDragTarget].x = Math.max(-500, Math.min(500, startOffsetX + dx));
    elementOffsets[previewDragTarget].y = Math.max(-800, Math.min(800, startOffsetY + dy));
    positionPreviewEditGroup();
    applyTextOffset();
  }

  function endPreviewDrag() {
    if (!dragging) return;
    dragging = false;
    previewDragOverlay.classList.remove('dragging');
    if (elementOffsets[previewDragTarget].x !== startOffsetX || elementOffsets[previewDragTarget].y !== startOffsetY) {
      saveCurrentSlideEdits();
      saveSession();
      regenerateMockup();
    }
  }

  // Click on individual elements to select
  [previewEditMicro, previewEditHeadline, previewEditBody].forEach(el => {
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'grab';
  });

  // Mouse
  previewDragOverlay.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (isPreviewEditing()) return;
    e.preventDefault();
    const target = getPreviewDragTarget(e);
    startPreviewDrag(e.clientX, e.clientY, target);
  });
  window.addEventListener('mousemove', (e) => movePreviewDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', endPreviewDrag);

  // Touch
  previewDragOverlay.addEventListener('touchstart', (e) => {
    if (isPreviewEditing()) return;
    const t = e.touches[0];
    const target = getPreviewDragTarget(e);
    startPreviewDrag(t.clientX, t.clientY, target);
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    movePreviewDrag(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener('touchend', endPreviewDrag);

  // Double-click to edit text
  previewDragOverlay.addEventListener('dblclick', (e) => {
    const slide = slideEdits[currentSlideIndex];
    if (!slide || slide.type !== 'mockup') return;
    e.preventDefault();
    enterPreviewEditMode();
  });
}

function enterPreviewEditMode() {
  previewEditGroup.classList.add('editing');
  previewEditMicro.textContent = form.elements.microLabel?.value || '';
  previewEditHeadline.textContent = form.elements.headline?.value || '';
  previewEditBody.textContent = form.elements.body?.value || '';
  previewEditMicro.contentEditable = 'true';
  previewEditHeadline.contentEditable = 'true';
  previewEditBody.contentEditable = 'true';
  previewEditHeadline.focus();
  // Select headline text
  const range = document.createRange();
  range.selectNodeContents(previewEditHeadline);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  previewDragHint.textContent = 'Press Escape when done';
}

function exitPreviewEditMode(save) {
  if (!previewEditGroup.classList.contains('editing')) return;
  previewEditGroup.classList.remove('editing');
  previewEditMicro.contentEditable = 'false';
  previewEditHeadline.contentEditable = 'false';
  previewEditBody.contentEditable = 'false';
  previewDragHint.textContent = 'Drag to move text \u00b7 Double-click to edit';

  if (save) {
    const newMicro = previewEditMicro.textContent.trim();
    const newHeadline = previewEditHeadline.textContent.trim();
    const newBody = previewEditBody.textContent.trim();
    if (newMicro) form.elements.microLabel.value = newMicro;
    if (newHeadline) form.elements.headline.value = newHeadline;
    form.elements.body.value = newBody;
    saveCurrentSlideEdits();
    saveSession();
    updatePreviewMockup();
    regenerateMockup();
  }
}

// Escape/Enter keys for preview edit mode
document.addEventListener('keydown', (e) => {
  if (!previewEditGroup.classList.contains('editing')) return;
  if (e.key === 'Escape') {
    exitPreviewEditMode(false);
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    exitPreviewEditMode(true);
  }
});

// Click outside preview to exit edit mode
document.addEventListener('mousedown', (e) => {
  if (!previewEditGroup.classList.contains('editing')) return;
  if (!previewFrame.contains(e.target)) {
    exitPreviewEditMode(true);
  }
});

// --- Icon Upload & Corner Picker ---
async function updateIconPreview() {
  if (!currentBrand) {
    iconPreviewImg.style.display = 'none';
    mockupIconImg.style.display = 'none';
    return;
  }
  const iconUrl = `/brands/${currentBrand}/assets/app-icon.png?t=${Date.now()}`;
  try {
    const res = await fetch(iconUrl, { method: 'HEAD' });
    if (!res.ok || res.status === 204) {
      iconPreviewImg.style.display = 'none';
      mockupIconImg.style.display = 'none';
      return;
    }
  } catch {
    iconPreviewImg.style.display = 'none';
    mockupIconImg.style.display = 'none';
    return;
  }
  iconPreviewImg.src = iconUrl;
  mockupIconImg.src = iconUrl;
  iconPreviewImg.style.display = 'block';
  const showWatermark = form.elements.includeOwl?.checked ?? true;
  mockupIconImg.style.display = showWatermark ? 'block' : 'none';
}

iconUploadBtn.addEventListener('click', () => iconFileInput.click());

iconFileInput.addEventListener('change', async () => {
  const file = iconFileInput.files[0];
  if (!file) return;

  iconUploadBtn.disabled = true;
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
  } finally {
    iconUploadBtn.disabled = false;
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

  refUploadBtn.disabled = true;
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
  } finally {
    refUploadBtn.disabled = false;
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

// --- Per-Slide Reference Image Upload ---
slideRefBtn.addEventListener('click', () => slideRefInput.click());

slideRefInput.addEventListener('change', async () => {
  const file = slideRefInput.files[0];
  if (!file) return;

  slideRefBtn.disabled = true;
  slideRefFilename.textContent = 'Uploading...';
  const fd = new FormData();
  fd.append('image', file);

  try {
    const res = await authFetch('/api/upload-reference', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.ok) {
      slideReferenceImages[currentSlideIndex] = { filename: data.filename, displayName: file.name };
      slideRefFilename.textContent = file.name;
      slideRefPreview.src = data.url;
      slideRefPreview.style.display = 'block';
      slideRefClear.style.display = 'inline-block';
      renderSlideTabs();
      updatePreviewImageOverlay();
      updatePreviewMockup();
    } else {
      slideRefFilename.textContent = 'Upload failed';
    }
  } catch {
    slideRefFilename.textContent = 'Upload error';
  } finally {
    slideRefBtn.disabled = false;
  }
  slideRefInput.value = '';
});

slideRefClear.addEventListener('click', () => {
  delete slideReferenceImages[currentSlideIndex];
  slideRefFilename.textContent = 'No image';
  slideRefPreview.style.display = 'none';
  slideRefClear.style.display = 'none';
  slideRefInput.value = '';
  renderSlideTabs();
  updatePreviewImageOverlay();
  updatePreviewMockup();
});

// --- Build payload ---
function buildSlidePayload(slide, slideIndex) {
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
    imageModel: getSelectedImageModel(),
  };

  if (payload.slideType === 'photo') {
    const personSelect = document.getElementById('person-select');
    if (personSelect?.value) payload.personId = personSelect.value;
    payload.sport = slide.sport || '';
    payload.setting = slide.setting || '';
    payload.action = slide.action || '';
    payload.mood = slide.mood || '';
    payload.overlayStyle = form.elements.overlayStyle?.value || 'dark gradient';
    payload.overlayPlacement = form.elements.overlayPlacement?.value || 'bottom third';
    payload.headlineFontSize = slide.headlineFontSize || parseInt(form.elements.headlineFontSize?.value) || 82;
    payload.bodyFontSize = slide.bodyFontSize || parseInt(form.elements.bodyFontSize?.value) || 34;
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
    // AI background prompt fields
    if (payload.imageUsage === 'ai-background') {
      payload.aiBgSetting = slide.aiBgSetting || form.elements.aiBgSetting?.value || '';
      payload.aiBgMood = slide.aiBgMood || form.elements.aiBgMood?.value || '';
    }
    // Per-element offsets
    payload.microOffsetX = slide.microOffsetX || 0;
    payload.microOffsetY = slide.microOffsetY || 0;
    payload.headlineOffsetX = slide.headlineOffsetX || 0;
    payload.headlineOffsetY = slide.headlineOffsetY || 0;
    payload.bodyOffsetX = slide.bodyOffsetX || 0;
    payload.bodyOffsetY = slide.bodyOffsetY || 0;
    payload.iconOffsetX = slide.iconOffsetX || 0;
    payload.iconOffsetY = slide.iconOffsetY || 0;
    // New controls
    payload.aspectRatio = slide.aspectRatio || form.elements.aspectRatio?.value || '9:16';
    payload.fontFamily = slide.fontFamily || form.elements.mockupFont?.value || 'Helvetica';
    payload.overlayDarken = slide.overlayDarken || 0;
    payload.headlineFontSize = slide.headlineFontSize || parseInt(form.elements.headlineFontSize?.value) || 82;
    payload.bodyFontSize = slide.bodyFontSize || parseInt(form.elements.bodyFontSize?.value) || 34;
    if (slide.textColor) payload.textColor = slide.textColor;
    if (slide.microColor) payload.microColor = slide.microColor;
  } else if (payload.slideType === 'video') {
    payload.scene = slide.scene || form.elements.videoScene?.value || '';
    payload.mood = slide.videoMood || form.elements.videoMood?.value || 'energetic and dynamic';
    payload.cameraMove = slide.cameraMove || form.elements.videoCamera?.value || 'slow tracking shot';
    payload.duration = slide.duration || parseInt(form.elements.videoDuration?.value) || 5;
    payload.audio = slide.audio || form.elements.videoAudio?.checked || false;
    payload.videoTextOverlay = form.elements.videoTextOverlay?.checked ?? true;
    payload.headlineFontSize = slide.headlineFontSize || parseInt(form.elements.headlineFontSize?.value) || 82;
    payload.bodyFontSize = slide.bodyFontSize || parseInt(form.elements.bodyFontSize?.value) || 34;
    payload.fontFamily = slide.fontFamily || form.elements.mockupFont?.value || 'Helvetica';
  } else {
    payload.backgroundStyle = form.elements.backgroundStyle?.value || 'dark premium navy/near-black with very subtle grain';
    payload.layoutTemplate = form.elements.layoutTemplate?.value || 'Layout A - Classic Left Lane';
    payload.headlineFontSize = slide.headlineFontSize || parseInt(form.elements.headlineFontSize?.value) || 82;
    payload.bodyFontSize = slide.bodyFontSize || parseInt(form.elements.bodyFontSize?.value) || 34;
  }

  // Per-slide image takes priority over global
  const slideRef = slideIndex != null ? slideReferenceImages[slideIndex] : null;
  const refImage = slideRef?.filename || referenceImageFilename;
  if (refImage) {
    payload.referenceImage = refImage;
    payload.referenceUsage = form.elements.referenceUsage?.value || 'background inspiration';
    payload.referenceInstructions = form.elements.referenceInstructions?.value || '';
  }

  return payload;
}

// --- Generate Single Slide ---
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  saveCurrentSlideEdits();

  if (generateAbort) generateAbort.abort();
  generateAbort = new AbortController();
  const signal = generateAbort.signal;
  const slideIndex = currentSlideIndex;

  const slide = slideEdits[slideIndex];
  const payload = buildSlidePayload(slide, slideIndex);

  const isVideo = payload.slideType === 'video';
  statusEl.textContent = isVideo
    ? `Generating video ${slideIndex + 1} (this may take 1-7 min)...`
    : `Generating slide ${slideIndex + 1}...`;
  // Switch to generated view for the spinner
  setPreviewMode('generated');
  previewImg.style.display = 'none';
  previewVideo.style.display = 'none';
  downloadButtons.style.display = 'none';
  loadingSpinner.classList.add('active');
  spinnerText.textContent = isVideo
    ? `Generating video... (up to 7 min)`
    : `Generating slide ${slideIndex + 1}...`;

  try {
    const res = await authFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');

    generatedImages[slideIndex] = { url: data.url, filename: data.filename, isVideo: data.isVideo || false };

    // Only update UI if still viewing this slide
    if (currentSlideIndex === slideIndex) {
      if (data.isVideo) {
        previewImg.style.display = 'none';
        previewVideo.src = data.url;
        previewVideo.style.display = 'block';
      } else {
        previewVideo.style.display = 'none';
        previewImg.src = data.url;
        previewImg.style.display = 'block';
      }
      downloadButtons.style.display = 'flex';
      statusEl.textContent = data.usedRefined
        ? `Slide ${slideIndex + 1} done (Claude-refined).`
        : `Slide ${slideIndex + 1} done.`;
      setPreviewMode('generated');
      updatePreviewDragOverlay();
    }

    renderSlideTabs();
    updateGallery();
    updateEditSection();
    saveSession();
    addToVault(data.url, data.filename);
  } catch (err) {
    if (err.name === 'AbortError') return;
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    if (currentSlideIndex === slideIndex) {
      loadingSpinner.classList.remove('active');
    }
  }
});

// --- Edit Slide ---
const editSection = document.getElementById('edit-section');
const editInstructions = document.getElementById('edit-instructions');
const applyEditBtn = document.getElementById('apply-edit-btn');

function updateEditSection() {
  if (editSection) {
    const gen = generatedImages[currentSlideIndex];
    // Hide edit bar for video slides (can't edit video with image API)
    editSection.style.display = (gen && !gen.isVideo) ? 'block' : 'none';
  }
}

applyEditBtn.addEventListener('click', async () => {
  const instructions = editInstructions.value.trim();
  if (!instructions) return;
  const slideIndex = currentSlideIndex;
  const gen = generatedImages[slideIndex];
  if (!gen) return;

  if (generateAbort) generateAbort.abort();
  generateAbort = new AbortController();
  const signal = generateAbort.signal;

  applyEditBtn.disabled = true;
  statusEl.textContent = 'Editing slide...';
  loadingSpinner.classList.add('active');
  spinnerText.textContent = 'Applying edit...';

  try {
    const res = await authFetch('/api/edit-slide', {
      method: 'POST',
      body: JSON.stringify({
        imageUrl: gen.url,
        instructions,
        quality: form.elements.quality.value,
        imageModel: getSelectedImageModel(),
        brand: currentBrand,
      }),
      signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Edit failed');

    generatedImages[slideIndex] = { url: data.url, filename: data.filename };

    if (currentSlideIndex === slideIndex) {
      previewImg.src = data.url;
      previewImg.style.display = 'block';
      statusEl.textContent = `Slide ${slideIndex + 1} edited.`;
      editInstructions.value = '';
    }

    renderSlideTabs();
    updateGallery();
    saveSession();
    addToVault(data.url, data.filename);
  } catch (err) {
    if (err.name === 'AbortError') return;
    statusEl.textContent = `Edit error: ${err.message}`;
  } finally {
    applyEditBtn.disabled = false;
    if (currentSlideIndex === slideIndex) {
      loadingSpinner.classList.remove('active');
    }
  }
});

// --- Download Single ---
downloadSingleBtn.addEventListener('click', async () => {
  const gen = generatedImages[currentSlideIndex];
  if (gen) {
    const a = document.createElement('a');
    a.href = `/api/download/${gen.filename}`;
    a.download = gen.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }

  // Lazy render for non-AI slides: generate server PNG on demand
  const slide = slideEdits[currentSlideIndex];
  const type = slide?.type || 'text';
  const usage = slide?.imageUsage || 'phone';
  if (slideNeedsAI(type, usage)) return; // AI slides must be generated first

  const slideIndex = currentSlideIndex;
  statusEl.textContent = 'Rendering for download...';
  downloadSingleBtn.disabled = true;
  try {
    const payload = buildSlidePayload(slide, slideIndex);
    const res = await authFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Render failed');

    generatedImages[slideIndex] = { url: data.url, filename: data.filename, isVideo: false };
    renderSlideTabs();

    const a = document.createElement('a');
    a.href = `/api/download/${data.filename}`;
    a.download = data.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    statusEl.textContent = `Slide ${slideIndex + 1} downloaded.`;
  } catch (err) {
    statusEl.textContent = `Download failed: ${err.message}`;
  } finally {
    downloadSingleBtn.disabled = false;
  }
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
async function startBatchGeneration() {
  if (!selectedIdea || slideEdits.length === 0) return;
  saveCurrentSlideEdits();

  const slides = slideEdits.map((s, i) => buildSlidePayload(s, i));
  const payload = {
    slides,
    includeOwl: form.elements.includeOwl.checked,
    owlPosition: owlPositionInput.value,
    quality: form.elements.quality.value,
    brand: currentBrand,
    imageModel: getSelectedImageModel(),
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
}

generateAllBtn.addEventListener('click', () => startBatchGeneration());

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
        if (!generatedImages[idx]) addToVault(slide.url, slide.filename);
        generatedImages[idx] = { url: slide.url, filename: slide.filename, isVideo: slide.isVideo || false };
      }
    }
    renderSlideTabs();
    updateGallery();
    saveSession();

    if (generatedImages[currentSlideIndex]) {
      const gen = generatedImages[currentSlideIndex];
      if (gen.isVideo) {
        previewImg.style.display = 'none';
        previewVideo.src = gen.url;
        previewVideo.style.display = 'block';
      } else {
        previewVideo.style.display = 'none';
        previewImg.src = gen.url;
        previewImg.style.display = 'block';
      }
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
      if (gen.isVideo) {
        html += `<video src="${gen.url}" muted style="width:100%;height:100%;object-fit:cover"></video>`;
        html += `<span class="thumb-video-badge">&#9654;</span>`;
      } else {
        html += `<img src="${gen.url}" alt="Slide ${i + 1}" />`;
      }
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

  // Update TikTok post UI when gallery changes
  if (typeof updateTikTokUI === 'function') updateTikTokUI();
}

// --- Screenshot Upload (Mockup) ---
screenshotUploadBtn.addEventListener('click', () => screenshotImageInput.click());

screenshotImageInput.addEventListener('change', async () => {
  const file = screenshotImageInput.files[0];
  if (!file) return;

  screenshotUploadBtn.disabled = true;
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
      updatePreviewMockup();
    } else {
      screenshotFilename.textContent = 'Upload failed';
    }
  } catch {
    screenshotFilename.textContent = 'Upload error';
  } finally {
    screenshotUploadBtn.disabled = false;
  }
});

screenshotClearBtn.addEventListener('click', () => {
  screenshotImageFilename = null;
  screenshotFilename.textContent = 'No screenshot';
  screenshotPreview.style.display = 'none';
  screenshotClearBtn.style.display = 'none';
  screenshotImageInput.value = '';
  toggleMockupPhoneOptions();
  updatePreviewMockup();
});

// --- Freeform AI Generation ---
freeformGenerateBtn.addEventListener('click', async () => {
  const prompt = freeformInput.value.trim();
  if (!prompt) {
    freeformStatus.textContent = 'Please enter a description.';
    return;
  }
  if (!currentBrand) {
    freeformStatus.textContent = 'Create a brand first.';
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

// --- Content Plan Grid ---
function renderContentPlanGrid(ideas, brandObj) {
  const grid = document.getElementById('content-plan-grid');
  const iconUrl = `/brands/${currentBrand}/assets/app-icon.png?t=${Date.now()}`;
  const brandName = brandObj?.name || 'Brand';
  const primaryColor = brandObj?.colors?.primary || '#1a1a2e';
  const textColor = brandObj?.colors?.white || '#ffffff';

  grid.innerHTML = '';
  ideas.forEach(idea => {
    const hookSlide = idea.slides[0] || {};
    const caption = idea.caption || '';
    const truncCaption = caption.length > 120 ? caption.slice(0, 120) + '...' : caption;

    const card = document.createElement('div');
    card.className = 'content-plan-card';
    card.dataset.ideaId = idea.id;

    const header = document.createElement('div');
    header.className = 'plan-card-header';
    const icon = document.createElement('img');
    icon.className = 'plan-card-icon';
    icon.src = iconUrl;
    icon.onerror = function() { this.style.display = 'none'; };
    header.appendChild(icon);
    const brand = document.createElement('span');
    brand.className = 'plan-card-brand';
    brand.textContent = brandName;
    header.appendChild(brand);
    card.appendChild(header);

    const visual = document.createElement('div');
    visual.className = 'plan-card-visual';
    visual.style.background = primaryColor;
    visual.style.color = textColor;
    const slideCount = document.createElement('div');
    slideCount.className = 'plan-card-slide-count';
    slideCount.textContent = idea.slides.length + ' slides';
    visual.appendChild(slideCount);
    const headlineEl = document.createElement('div');
    headlineEl.className = 'plan-card-headline';
    headlineEl.textContent = hookSlide.headline || idea.title;
    visual.appendChild(headlineEl);
    if (hookSlide.body) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'plan-card-body';
      bodyEl.textContent = hookSlide.body;
      visual.appendChild(bodyEl);
    }
    card.appendChild(visual);

    const captionEl = document.createElement('div');
    captionEl.className = 'plan-card-caption';
    captionEl.textContent = truncCaption;
    card.appendChild(captionEl);

    grid.appendChild(card);
  });

  grid.querySelectorAll('.content-plan-card').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('content-plan-view').style.display = 'none';
      selectIdea(el.dataset.ideaId);
    });
  });
}

// --- Auto-Generate Content Ideas from Website ---
autoGenerateBtn.addEventListener('click', async () => {
  if (!currentBrand) {
    autoGenerateStatus.textContent = 'Create a brand first.';
    return;
  }

  autoGenerateBtn.disabled = true;
  autoGenerateStatus.textContent = 'Analyzing website and generating ideas...';

  try {
    const res = await authFetch('/api/generate-content-ideas', {
      method: 'POST',
      body: JSON.stringify({ brand: currentBrand }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');

    if (!data.ideas || data.ideas.length === 0) {
      throw new Error('No ideas generated. Try the freeform input instead.');
    }

    // Load ideas into sidebar as a new category
    const brandObj = brands.find(b => b.id === currentBrand);
    const brandName = brandObj?.name || 'Brand';

    // Build contentData structure
    let idCounter = 1;
    const category = {
      name: 'AI-Generated Ideas',
      ideas: data.ideas.map(idea => ({
        id: `AI-${idCounter++}`,
        title: idea.title,
        caption: idea.caption || '',
        slides: idea.slides.map((s, i) => ({
          ...s,
          number: s.number || i + 1,
          type: s.type || 'text',
        })),
      })),
    };

    contentData = {
      apps: [{
        appName: brandName,
        brandId: currentBrand,
        categories: [category],
      }],
    };

    renderSidebar();
    autoGenerateStatus.textContent = `Generated ${data.ideas.length} carousel ideas.`;

    // Show content plan preview grid
    emptyState.style.display = 'none';
    editorArea.style.display = 'none';
    personalizeView.style.display = 'none';
    if (document.getElementById('meme-view')) document.getElementById('meme-view').style.display = 'none';
    const contentPlanView = document.getElementById('content-plan-view');
    contentPlanView.style.display = 'block';
    document.getElementById('content-plan-subtitle').textContent =
      `${data.ideas.length} carousel ideas for ${brandName}`;
    renderContentPlanGrid(category.ideas, brandObj);

    // Auto-generate images for the first idea
    selectIdea('AI-1');
    startBatchGeneration();
  } catch (err) {
    autoGenerateStatus.textContent = `Error: ${err.message}`;
  } finally {
    autoGenerateBtn.disabled = false;
  }
});

// --- Face Personalization (Full-Page View) ---
// =============================================

const FALLBACK_SCENARIOS = [
  { id: 'professional-portrait', title: 'Professional Portrait', category: 'Business', setting: 'modern office with natural window light', action: 'looking confident at camera', mood: 'professional confidence' },
  { id: 'urban-walk', title: 'Urban Walk', category: 'Lifestyle', setting: 'city sidewalk, golden hour', action: 'walking casually', mood: 'relaxed confidence' },
  { id: 'creative-workspace', title: 'Creative Workspace', category: 'Work', setting: 'bright studio or desk setup', action: 'working on a project', mood: 'focused creativity' },
  { id: 'coffee-meeting', title: 'Coffee Meeting', category: 'Social', setting: 'upscale cafe, warm lighting', action: 'having a conversation', mood: 'friendly engagement' },
  { id: 'outdoor-portrait', title: 'Outdoor Portrait', category: 'Lifestyle', setting: 'park or garden, soft light', action: 'standing relaxed', mood: 'calm authenticity' },
  { id: 'stage-presence', title: 'Stage Presence', category: 'Leadership', setting: 'conference stage or podium', action: 'speaking to an audience', mood: 'commanding authority' },
  { id: 'team-moment', title: 'Team Moment', category: 'Social', setting: 'collaborative workspace', action: 'laughing with colleagues', mood: 'genuine connection' },
  { id: 'morning-routine', title: 'Morning Routine', category: 'Lifestyle', setting: 'sunlit room, early morning', action: 'starting the day', mood: 'peaceful energy' },
];

let personalizedScenarios = [];
const scenarioCache = new Map(); // client-side cache by brandId

let faceImageFiles = []; // array of File objects (max 5)
let storedFacePhotos = []; // photos loaded from brand profile
let selectedScenario = null;
let personalizeResults = [];

const personalizeView = document.getElementById('personalize-view');
const faceImageInput = document.getElementById('face-image-input');
const faceAddBtn = document.getElementById('face-add-btn');
const facePhotosGrid = document.getElementById('face-photos-grid');
const facePhotoCount = document.getElementById('face-photo-count');
const scenarioGrid = document.getElementById('scenario-grid');
const personalizeGenerateBtn = document.getElementById('personalize-generate-btn');
const personalizeStatus = document.getElementById('personalize-status');
const personalizeResultsSection = document.getElementById('personalize-results');
const personalizeResultsGrid = document.getElementById('personalize-results-grid');

// View navigation
function openPersonalizeView() {
  emptyState.style.display = 'none';
  editorArea.style.display = 'none';
  if (document.getElementById('meme-view')) document.getElementById('meme-view').style.display = 'none';
  personalizeView.style.display = 'block';
  // Load brand-specific scenarios if not already loaded
  if (currentBrand && personalizedScenarios.length === 0 && !scenarioCache.has(currentBrand)) {
    loadPersonalizeScenarios(currentBrand);
  }
  // Auto-load stored face photos if user hasn't manually added any
  if (currentBrand && faceImageFiles.length === 0) {
    loadStoredFacePhotos(currentBrand);
  }
}

async function loadStoredFacePhotos(brandId) {
  try {
    const res = await authFetch(`/api/brands/${brandId}/face-photos`);
    const data = await res.json();
    storedFacePhotos = (data.facePhotos || []).filter(p => p.url);
    if (storedFacePhotos.length > 0 && faceImageFiles.length === 0) {
      renderFacePhotos();
    }
  } catch (err) { console.warn('[Face Photos] Load failed:', err.message); storedFacePhotos = []; }
}

function closePersonalizeView() {
  personalizeView.style.display = 'none';
  if (selectedIdea) {
    editorArea.style.display = 'block';
  } else {
    emptyState.style.display = 'flex';
  }
}

document.getElementById('open-personalize-btn').addEventListener('click', openPersonalizeView);
document.getElementById('sidebar-face-btn').addEventListener('click', openPersonalizeView);
document.getElementById('personalize-back-btn').addEventListener('click', closePersonalizeView);

// ===================== MEME STUDIO =====================

const memeView = document.getElementById('meme-view');
const memeDescription = document.getElementById('meme-description');
const memeAspectRatio = document.getElementById('meme-aspect-ratio');
const memeStatus = document.getElementById('meme-status');
const memePreviewImg = document.getElementById('meme-preview-img');
const memePlaceholder = document.querySelector('.meme-placeholder');
const downloadMemeBtn = document.getElementById('download-meme-btn');
let memeFilename = null;

function openMemeView() {
  emptyState.style.display = 'none';
  editorArea.style.display = 'none';
  personalizeView.style.display = 'none';
  document.getElementById('content-plan-view').style.display = 'none';
  memeView.style.display = 'block';
}

function closeMemeView() {
  memeView.style.display = 'none';
  if (selectedIdea) {
    editorArea.style.display = 'block';
  } else {
    emptyState.style.display = 'flex';
  }
}

document.getElementById('open-meme-btn').addEventListener('click', openMemeView);
document.getElementById('sidebar-meme-btn').addEventListener('click', openMemeView);
document.getElementById('meme-back-btn').addEventListener('click', closeMemeView);

document.getElementById('generate-meme-btn').addEventListener('click', async () => {
  const description = memeDescription.value.trim();
  if (!currentBrand) {
    memeStatus.textContent = 'Please select a brand first.';
    return;
  }

  const generateBtn = document.getElementById('generate-meme-btn');
  generateBtn.disabled = true;
  memeStatus.textContent = description ? 'Generating meme...' : 'Generating meme from your website...';
  downloadMemeBtn.style.display = 'none';

  try {
    const res = await authFetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slideType: 'meme',
        description,
        aspectRatio: memeAspectRatio.value,
        brand: currentBrand,
        imageModel: 'gpt',
        includeOwl: true,
        owlPosition: 'bottom-right',
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Generation failed');

    memePreviewImg.src = data.url;
    memePreviewImg.style.display = 'block';
    if (memePlaceholder) memePlaceholder.style.display = 'none';
    memeFilename = data.filename;
    downloadMemeBtn.style.display = 'inline-block';
    memeStatus.textContent = '';
    addToVault(data.url, data.filename);
  } catch (err) {
    memeStatus.textContent = err.message || 'Generation failed';
  } finally {
    generateBtn.disabled = false;
  }
});

downloadMemeBtn.addEventListener('click', () => {
  if (!memeFilename) return;
  const a = document.createElement('a');
  a.href = `/api/download/${memeFilename}`;
  a.download = memeFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

// Render scenario grid
function renderScenarioGrid() {
  const scenarios = personalizedScenarios.length > 0 ? personalizedScenarios : FALLBACK_SCENARIOS;
  scenarioGrid.innerHTML = scenarios.map((s) =>
    `<div class="scenario-card ${selectedScenario === s.id ? 'active' : ''}" data-id="${escapeHtml(s.id)}">
      <div class="scenario-title">${escapeHtml(s.title)}</div>
      <div class="scenario-category">${escapeHtml(s.category)}</div>
    </div>`
  ).join('');

  scenarioGrid.querySelectorAll('.scenario-card').forEach((card) => {
    card.addEventListener('click', () => {
      selectedScenario = selectedScenario === card.dataset.id ? null : card.dataset.id;
      renderScenarioGrid();
    });
  });
}

async function loadPersonalizeScenarios(brandId) {
  if (!brandId) {
    personalizedScenarios = [];
    renderScenarioGrid();
    return;
  }

  // Check client-side cache
  const cached = scenarioCache.get(brandId);
  if (cached) {
    personalizedScenarios = cached;
    selectedScenario = null;
    renderScenarioGrid();
    return;
  }

  // Show loading state
  selectedScenario = null;
  scenarioGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-secondary);padding:24px;">Generating brand scenarios...</div>';

  try {
    const res = await authFetch('/api/personalize-scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: brandId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load scenarios');

    personalizedScenarios = data.scenarios;
    scenarioCache.set(brandId, data.scenarios);
  } catch (err) {
    console.warn('[Scenarios] Falling back to defaults:', err.message);
    personalizedScenarios = [];
  }
  renderScenarioGrid();
}

renderScenarioGrid();

// Multi-photo upload
function renderFacePhotos() {
  // Remove existing thumbnails (keep the add button and hidden input)
  facePhotosGrid.querySelectorAll('.face-photo-thumb').forEach(el => el.remove());

  // Show stored photos if no local files uploaded
  if (faceImageFiles.length === 0 && storedFacePhotos.length > 0) {
    storedFacePhotos.forEach((photo, idx) => {
      const thumb = document.createElement('div');
      thumb.className = 'face-photo-thumb';
      thumb.innerHTML = `
        <img src="${photo.url}" alt="Saved ${idx + 1}" />
        <span class="saved-badge">Saved</span>
      `;
      facePhotosGrid.insertBefore(thumb, faceAddBtn);
    });
    facePhotoCount.textContent = `${storedFacePhotos.length} saved`;
    faceAddBtn.style.display = 'flex';
    return;
  }

  faceImageFiles.forEach((file, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'face-photo-thumb';
    thumb.innerHTML = `
      <img src="${file._preview}" alt="Face ${idx + 1}" />
      <button class="face-photo-remove" data-idx="${idx}" title="Remove">&times;</button>
    `;
    facePhotosGrid.insertBefore(thumb, faceAddBtn);
  });

  facePhotoCount.textContent = `${faceImageFiles.length} / 5`;
  faceAddBtn.style.display = faceImageFiles.length >= 5 ? 'none' : 'flex';

  // Attach remove handlers
  facePhotosGrid.querySelectorAll('.face-photo-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      faceImageFiles.splice(idx, 1);
      renderFacePhotos();
    });
  });
}

faceAddBtn.addEventListener('click', () => faceImageInput.click());

function addFaceFiles(files) {
  const imageFiles = files.filter(f => f.type.startsWith('image/'));
  if (!imageFiles.length) return;
  const remaining = 5 - faceImageFiles.length;
  const toAdd = imageFiles.slice(0, remaining);
  let loaded = 0;
  toAdd.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      file._preview = e.target.result;
      faceImageFiles.push(file);
      loaded++;
      if (loaded === toAdd.length) renderFacePhotos();
    };
    reader.readAsDataURL(file);
  });
}

faceImageInput.addEventListener('change', () => {
  addFaceFiles(Array.from(faceImageInput.files));
  faceImageInput.value = '';
});

// Drag & drop for face photos grid
facePhotosGrid.addEventListener('dragover', (e) => {
  e.preventDefault();
  facePhotosGrid.classList.add('drag-over');
});
facePhotosGrid.addEventListener('dragleave', (e) => {
  if (!facePhotosGrid.contains(e.relatedTarget)) {
    facePhotosGrid.classList.remove('drag-over');
  }
});
facePhotosGrid.addEventListener('drop', (e) => {
  e.preventDefault();
  facePhotosGrid.classList.remove('drag-over');
  addFaceFiles(Array.from(e.dataTransfer.files));
});

// Generate personalized image(s)
personalizeGenerateBtn.addEventListener('click', async () => {
  const personSelect = document.getElementById('personalize-person-select');
  const selectedPersonId = personSelect?.value || '';
  const hasLocal = faceImageFiles.length > 0;
  const hasStored = storedFacePhotos.length > 0;
  const hasPerson = Boolean(selectedPersonId);
  if (!hasLocal && !hasStored && !hasPerson) {
    personalizeStatus.textContent = 'Select a person or upload face photos first.';
    return;
  }
  if (!currentBrand) {
    personalizeStatus.textContent = 'Create a brand first.';
    return;
  }

  const count = parseInt(document.getElementById('personalize-count').value) || 1;
  const model = document.getElementById('personalize-model').value;
  const sport = document.getElementById('personalize-sport').value.trim();
  const custom = document.getElementById('personalize-custom').value.trim();
  const scenarios = personalizedScenarios.length > 0 ? personalizedScenarios : FALLBACK_SCENARIOS;
  const scenario = selectedScenario ? scenarios.find((s) => s.id === selectedScenario) : null;

  if (!scenario && !custom) {
    personalizeStatus.textContent = 'Select a scenario or write a custom one.';
    return;
  }

  personalizeGenerateBtn.disabled = true;

  // Build FormData — attach local files if any, or use personId, otherwise send empty (server uses stored brand photos)
  const photoCount = hasPerson ? (userPersons.find(p => p.id === selectedPersonId)?.photos?.length || 0) : hasLocal ? faceImageFiles.length : storedFacePhotos.length;
  const photoLabel = hasPerson ? 'person' : hasLocal ? 'uploaded' : 'saved';
  function buildFormData() {
    const fd = new FormData();
    if (!hasPerson && hasLocal) faceImageFiles.forEach(file => fd.append('faceImages', file));
    fd.append('brand', currentBrand);
    fd.append('model', model);
    if (hasPerson) fd.append('personId', selectedPersonId);
    return fd;
  }

  if (count === 1) {
    // Single image
    personalizeStatus.textContent = `Generating personalized image (${photoCount} ${photoLabel} photo${photoCount > 1 ? 's' : ''})...`;

    const fd = buildFormData();

    if (custom) {
      fd.append('prompt', custom);
    } else if (scenario) {
      if (sport) fd.append('sport', sport);
      fd.append('setting', scenario.setting);
      fd.append('action', scenario.action);
      fd.append('mood', scenario.mood);
    }

    try {
      const res = await authFetch('/api/generate-personalized', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Generation failed');

      personalizeResults.push(data);
      renderPersonalizeResults();
      personalizeStatus.textContent = `Done! Generated with ${data.model === 'flux' ? 'Flux Kontext Pro' : 'GPT Image 1.5'}.`;
    } catch (err) {
      personalizeStatus.textContent = `Error: ${err.message}`;
    } finally {
      personalizeGenerateBtn.disabled = false;
    }
  } else {
    // Batch — build slides array for multiple scenarios
    const slides = [];
    for (let i = 0; i < count; i++) {
      if (custom) {
        slides.push({ prompt: custom });
      } else if (scenario) {
        const slideData = {
          setting: scenario.setting,
          action: scenario.action,
          mood: scenario.mood,
        };
        if (sport) slideData.sport = sport;
        slides.push(slideData);
      }
    }

    personalizeStatus.textContent = `Starting batch generation (${count} images, ${photoCount} ${photoLabel} photo${photoCount > 1 ? 's' : ''})...`;

    const fd = buildFormData();
    fd.append('slides', JSON.stringify(slides));

    try {
      const res = await authFetch('/api/generate-personalized-carousel', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Batch start failed');

      const pJobId = data.jobId;

      // Poll for results
      const pollInterval = setInterval(async () => {
        try {
          const sRes = await authFetch(`/api/carousel-status/${pJobId}`);
          const job = await sRes.json();

          // Replace batch results in our array
          const batchResults = job.slides.filter((s) => s.ok).map((s) => ({ url: s.url, filename: s.filename }));
          // Keep any previous single results, add batch
          personalizeResults = [...personalizeResults.filter(r => !r._batch), ...batchResults.map(r => ({ ...r, _batch: true }))];
          renderPersonalizeResults();
          personalizeStatus.textContent = `Generating image ${job.current} of ${job.total}... (${job.completed} done)`;

          if (job.status === 'done') {
            clearInterval(pollInterval);
            const succeeded = job.slides.filter((s) => s.ok).length;
            personalizeStatus.textContent = `Done! ${succeeded}/${job.total} images generated.`;
            personalizeGenerateBtn.disabled = false;
          }
        } catch {
          // polling error, keep trying
        }
      }, 2000);
    } catch (err) {
      personalizeStatus.textContent = `Error: ${err.message}`;
      personalizeGenerateBtn.disabled = false;
    }
  }
});

function renderPersonalizeResults() {
  if (personalizeResults.length === 0) {
    personalizeResultsGrid.innerHTML = '<div class="personalize-empty-results">Generated images will appear here</div>';
    return;
  }
  personalizeResultsGrid.innerHTML = personalizeResults.map((r) =>
    `<div class="personalize-result-thumb">
      <img src="${r.url}" alt="Personalized" />
      <button class="result-download" data-url="${r.url}" data-filename="${r.filename}" title="Download">&#8681;</button>
    </div>`
  ).join('');

  personalizeResultsGrid.querySelectorAll('.result-download').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = btn.dataset.url;
      a.download = btn.dataset.filename || 'personalized.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  });

  // Click on thumbnail to open full size
  personalizeResultsGrid.querySelectorAll('.personalize-result-thumb').forEach((thumb) => {
    thumb.addEventListener('click', (e) => {
      if (e.target.classList.contains('result-download')) return;
      const img = thumb.querySelector('img');
      if (img) window.open(img.src, '_blank');
    });
  });
}

// --- TikTok Integration ---
// =============================================

let tiktokConnected = false;
let tiktokUsername = '';
let tiktokPostPollTimer = null;

const tiktokConnectBtn = document.getElementById('tiktok-connect-btn');
const tiktokBtnText = document.getElementById('tiktok-btn-text');
const tiktokPostBtn = document.getElementById('tiktok-post-btn');
const tiktokModal = document.getElementById('tiktok-modal');
const tiktokModalClose = document.getElementById('tiktok-modal-close');
const tiktokCancelBtn = document.getElementById('tiktok-cancel-btn');
const tiktokSubmitBtn = document.getElementById('tiktok-submit-btn');
const tiktokCaption = document.getElementById('tiktok-caption');
const tiktokCaptionCount = document.getElementById('tiktok-caption-count');
const tiktokSlidesPreview = document.getElementById('tiktok-slides-preview');
const tiktokPostStatus = document.getElementById('tiktok-post-status');

// Check TikTok connection status on load
async function checkTikTokStatus() {
  try {
    const res = await authFetch('/api/tiktok/status');
    if (!res.ok) return;
    const data = await res.json();

    // Hide TikTok button entirely when keys aren't configured
    if (data.enabled === false) {
      if (tiktokConnectBtn) tiktokConnectBtn.style.display = 'none';
      if (tiktokPostBtn) tiktokPostBtn.style.display = 'none';
      return;
    }

    tiktokConnected = data.connected;
    tiktokUsername = data.username || '';
    updateTikTokUI();
  } catch {
    // TikTok status check failed — keep disconnected state
  }
}

function updateTikTokUI() {
  if (tiktokConnected) {
    tiktokConnectBtn.classList.add('connected');
    tiktokBtnText.textContent = tiktokUsername || 'Connected';
    tiktokConnectBtn.title = 'TikTok connected — click to disconnect';
  } else {
    tiktokConnectBtn.classList.remove('connected');
    tiktokBtnText.textContent = 'Connect TikTok';
    tiktokConnectBtn.title = 'Connect your TikTok account';
  }

  // Show/hide post button in gallery
  const hasSlides = Object.keys(generatedImages).length > 0;
  if (tiktokPostBtn) {
    tiktokPostBtn.style.display = (tiktokConnected && hasSlides) ? 'inline-flex' : 'none';
  }
}

// Connect/disconnect button handler
tiktokConnectBtn.addEventListener('click', async () => {
  if (tiktokConnected) {
    // Disconnect
    if (!confirm('Disconnect your TikTok account?')) return;
    try {
      await authFetch('/api/tiktok/disconnect', { method: 'POST' });
      tiktokConnected = false;
      tiktokUsername = '';
      updateTikTokUI();
    } catch (err) {
      console.error('TikTok disconnect failed:', err);
    }
    return;
  }

  // Connect — get auth URL and open popup
  try {
    const res = await authFetch('/api/tiktok/auth');
    const data = await res.json();
    if (!data.url) throw new Error('No auth URL returned');

    const popup = window.open(data.url, 'tiktok-auth', 'width=600,height=700,left=200,top=100');

    // Listen for callback message from popup
    const messageHandler = async (event) => {
      if (!event.data?.type?.startsWith('tiktok-')) return;

      window.removeEventListener('message', messageHandler);

      if (event.data.type === 'tiktok-success') {
        // Save tokens to server
        try {
          await authFetch('/api/tiktok/save-tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              access_token: event.data.access_token,
              refresh_token: event.data.refresh_token,
              open_id: event.data.open_id,
              expires_in: event.data.expires_in,
              username: event.data.username,
            }),
          });

          tiktokConnected = true;
          tiktokUsername = event.data.username || '';
          updateTikTokUI();
        } catch (err) {
          console.error('Failed to save TikTok tokens:', err);
        }
      } else if (event.data.type === 'tiktok-error') {
        alert(`TikTok connection failed: ${event.data.error}`);
      }
    };

    window.addEventListener('message', messageHandler);
  } catch (err) {
    console.error('TikTok auth error:', err);
  }
});

// Caption character count
tiktokCaption.addEventListener('input', () => {
  tiktokCaptionCount.textContent = tiktokCaption.value.length;
});

// Open post modal
tiktokPostBtn.addEventListener('click', openTikTokModal);

function openTikTokModal() {
  // Populate slide previews
  const keys = Object.keys(generatedImages).sort((a, b) => a - b);
  tiktokSlidesPreview.innerHTML = keys.map((key) => {
    const gen = generatedImages[key];
    return `<img src="${gen.url}" alt="Slide ${parseInt(key) + 1}" />`;
  }).join('');

  // Reset form
  tiktokCaption.value = '';
  tiktokCaptionCount.textContent = '0';
  tiktokPostStatus.textContent = '';
  tiktokPostStatus.className = 'tiktok-post-status';
  tiktokSubmitBtn.disabled = false;

  document.getElementById('tiktok-auto-music').checked = true;
  document.getElementById('tiktok-disable-comment').checked = false;
  document.getElementById('tiktok-brand-content').checked = false;
  document.getElementById('tiktok-brand-organic').checked = false;
  document.getElementById('tiktok-privacy').value = 'SELF_ONLY';

  tiktokModal.style.display = 'flex';
  _activeFocusTrap = trapFocus(tiktokModal);
}

function closeTikTokModal() {
  tiktokModal.style.display = 'none';
  if (_activeFocusTrap) { _activeFocusTrap.restore(); _activeFocusTrap = null; }
  if (tiktokPostPollTimer) {
    clearInterval(tiktokPostPollTimer);
    tiktokPostPollTimer = null;
  }
}

tiktokModalClose.addEventListener('click', closeTikTokModal);
tiktokCancelBtn.addEventListener('click', closeTikTokModal);

// Close modal on backdrop click
tiktokModal.addEventListener('click', (e) => {
  if (e.target === tiktokModal) closeTikTokModal();
});

// Submit post
tiktokSubmitBtn.addEventListener('click', postToTikTok);

async function postToTikTok() {
  const keys = Object.keys(generatedImages).sort((a, b) => a - b);
  if (keys.length === 0) return;

  const imageUrls = keys.map((key) => generatedImages[key].url);
  const caption = tiktokCaption.value.trim();
  const privacyLevel = document.getElementById('tiktok-privacy').value;
  const autoAddMusic = document.getElementById('tiktok-auto-music').checked;
  const disableComment = document.getElementById('tiktok-disable-comment').checked;
  const brandContentToggle = document.getElementById('tiktok-brand-content').checked;
  const brandOrganicToggle = document.getElementById('tiktok-brand-organic').checked;

  tiktokSubmitBtn.disabled = true;
  tiktokSubmitBtn.textContent = 'Uploading...';
  tiktokPostStatus.textContent = `Converting ${imageUrls.length} slides and uploading to TikTok...`;
  tiktokPostStatus.className = 'tiktok-post-status processing';

  try {
    const res = await authFetch('/api/tiktok/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageUrls,
        caption,
        privacyLevel,
        autoAddMusic,
        disableComment,
        brandContentToggle,
        brandOrganicToggle,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Post failed');

    tiktokPostStatus.textContent = 'Processing on TikTok...';
    tiktokPostStatus.className = 'tiktok-post-status processing';

    // Poll for status
    pollTikTokPostStatus(data.publishId);
  } catch (err) {
    tiktokPostStatus.textContent = `Error: ${err.message}`;
    tiktokPostStatus.className = 'tiktok-post-status error';
    tiktokSubmitBtn.disabled = false;
    tiktokSubmitBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.73a8.19 8.19 0 004.76 1.52v-3.4a4.85 4.85 0 01-1-.16z"/></svg>
      Retry
    `;
  }
}

function pollTikTokPostStatus(publishId) {
  let attempts = 0;
  const maxAttempts = 30; // 60 seconds max

  tiktokPostPollTimer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(tiktokPostPollTimer);
      tiktokPostPollTimer = null;
      tiktokPostStatus.textContent = 'Post is still processing. Check your TikTok app for status.';
      tiktokPostStatus.className = 'tiktok-post-status processing';
      tiktokSubmitBtn.disabled = false;
      tiktokSubmitBtn.textContent = 'Done';
      tiktokSubmitBtn.onclick = closeTikTokModal;
      return;
    }

    try {
      const res = await authFetch(`/api/tiktok/post-status/${publishId}`);
      const data = await res.json();

      if (data.status === 'PUBLISH_COMPLETE') {
        clearInterval(tiktokPostPollTimer);
        tiktokPostPollTimer = null;
        tiktokPostStatus.textContent = 'Posted successfully! Check your TikTok profile.';
        tiktokPostStatus.className = 'tiktok-post-status success';
        tiktokSubmitBtn.disabled = false;
        tiktokSubmitBtn.textContent = 'Done';
        tiktokSubmitBtn.onclick = closeTikTokModal;
      } else if (data.status === 'FAILED') {
        clearInterval(tiktokPostPollTimer);
        tiktokPostPollTimer = null;
        tiktokPostStatus.textContent = `Post failed: ${data.failReason || 'Unknown error'}`;
        tiktokPostStatus.className = 'tiktok-post-status error';
        tiktokSubmitBtn.disabled = false;
        tiktokSubmitBtn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.73a8.19 8.19 0 004.76 1.52v-3.4a4.85 4.85 0 01-1-.16z"/></svg>
          Retry
        `;
      } else {
        tiktokPostStatus.textContent = `Processing on TikTok... (${data.status || 'uploading'})`;
      }
    } catch {
      // Polling error — continue trying
    }
  }, 2000);
}


// --- Session Persistence (localStorage) ---
// =============================================

const SESSION_KEY = 'carousel-studio-session';

function saveSession() {
  try {
    const session = {
      generatedImages,
      slideEdits,
      selectedIdeaId: selectedIdea?.id || null,
      selectedIdeaTitle: selectedIdea?.title || null,
      currentBrand,
      currentSlideIndex,
      slideReferenceImages,
      referenceImageFilename,
      screenshotImageFilename,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch { /* quota exceeded — ignore */ }
}

function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const session = JSON.parse(raw);
    if (session.currentBrand !== currentBrand) return; // brand changed
    if (session.generatedImages && Object.keys(session.generatedImages).length > 0) {
      generatedImages = session.generatedImages;
    }
    if (session.slideReferenceImages) slideReferenceImages = session.slideReferenceImages;
    if (session.referenceImageFilename) referenceImageFilename = session.referenceImageFilename;
    if (session.screenshotImageFilename) screenshotImageFilename = session.screenshotImageFilename;
    if (session.slideEdits && session.slideEdits.length > 0) {
      slideEdits = session.slideEdits;
      // Reconstruct selectedIdea from saved data
      if (session.selectedIdeaId) {
        selectedIdea = {
          id: session.selectedIdeaId,
          title: session.selectedIdeaTitle || 'Restored Session',
          slides: session.slideEdits,
        };
        emptyState.style.display = 'none';
        personalizeView.style.display = 'none';
        if (document.getElementById('meme-view')) document.getElementById('meme-view').style.display = 'none';
        editorArea.style.display = 'block';
        ideaBadge.textContent = session.selectedIdeaId;
        ideaTitle.textContent = session.selectedIdeaTitle || 'Restored Session';
        if (session.currentSlideIndex != null) currentSlideIndex = session.currentSlideIndex;
        renderSlideTabs();
        loadSlideIntoForm(currentSlideIndex);
        updatePreviewMockup();
        updateGallery();
      }
    }
  } catch { /* parse error — ignore */ }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// --- Photo Vault (Firestore-backed) ---
// =============================================

let vaultImages = [];
let vaultHasMore = false;
let vaultNextCursor = null;
let vaultLoading = false;

async function fetchVaultImages(reset = false) {
  if (vaultLoading) return;
  vaultLoading = true;
  try {
    if (reset) {
      vaultImages = [];
      vaultHasMore = false;
      vaultNextCursor = null;
    }
    let url = '/api/images?limit=50';
    if (vaultNextCursor && !reset) url += `&startAfter=${vaultNextCursor}`;
    const res = await authFetch(url);
    if (!res.ok) throw new Error('Failed to load images');
    const data = await res.json();
    if (reset) {
      vaultImages = data.images;
    } else {
      vaultImages = vaultImages.concat(data.images);
    }
    vaultHasMore = data.hasMore;
    vaultNextCursor = data.nextCursor;
  } catch (err) {
    console.error('Failed to fetch vault images:', err);
  } finally {
    vaultLoading = false;
  }
}

async function fetchVaultCount() {
  try {
    const res = await authFetch('/api/images/count');
    if (!res.ok) return;
    const data = await res.json();
    const el = document.getElementById('vault-count');
    if (el) el.textContent = data.count || 0;
  } catch (err) { console.warn('[Vault] Count fetch failed:', err.message); }
}

// Images are auto-saved server-side now; just refresh the count
function addToVault(_url, _filename) {
  fetchVaultCount();
}

function updateVaultCount() {
  fetchVaultCount();
}

function renderVault() {
  const grid = document.getElementById('vault-grid');
  if (!grid) return;
  if (vaultLoading && vaultImages.length === 0) {
    grid.innerHTML = '<div style="padding:24px;text-align:center;color:#9ca3af;font-size:0.9rem;">Loading...</div>';
    return;
  }
  if (vaultImages.length === 0) {
    grid.innerHTML = '<div style="padding:24px;text-align:center;color:#9ca3af;font-size:0.9rem;">No images yet. Generate slides to fill your vault.</div>';
    return;
  }
  let html = vaultImages.map(v =>
    `<div class="vault-item">
      <img src="${v.url}" alt="${v.filename || 'image'}" loading="lazy" />
      <div class="vault-item-actions">
        <button class="vault-dl-btn" data-url="${v.url}" data-filename="${v.filename || 'image.png'}" title="Download">&#8681;</button>
        <button class="vault-rm-btn" data-id="${v.id}" title="Remove">&times;</button>
      </div>
    </div>`
  ).join('');

  if (vaultHasMore) {
    html += `<div style="grid-column: 1/-1; text-align:center; padding:12px;">
      <button id="vault-load-more" style="padding:8px 24px;border:1px solid #374151;background:#1f2937;color:#d1d5db;border-radius:6px;cursor:pointer;">Load more</button>
    </div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.vault-rm-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const res = await authFetch(`/api/images/${id}`, { method: 'DELETE' });
        if (res.ok) {
          vaultImages = vaultImages.filter(v => v.id !== id);
          fetchVaultCount();
          renderVault();
        }
      } catch (err) {
        console.error('Delete failed:', err);
      }
    });
  });

  grid.querySelectorAll('.vault-dl-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const res = await fetch(btn.dataset.url);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = btn.dataset.filename || 'image.png';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch { window.open(btn.dataset.url, '_blank'); }
    });
  });

  grid.querySelectorAll('.vault-item img').forEach((img, idx) => {
    img.addEventListener('click', () => openVaultLightbox(idx));
  });

  document.getElementById('vault-load-more')?.addEventListener('click', async () => {
    await fetchVaultImages(false);
    renderVault();
  });
}

// --- Vault Lightbox ---
let lightboxIndex = 0;
const lightboxEl = document.getElementById('vault-lightbox');
const lightboxImg = document.getElementById('vault-lightbox-img');

function openVaultLightbox(idx) {
  lightboxIndex = idx;
  updateLightboxImage();
  lightboxEl.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  lightboxEl.classList.remove('active');
  document.body.style.overflow = '';
}

function updateLightboxImage() {
  if (!vaultImages[lightboxIndex]) return;
  lightboxImg.src = vaultImages[lightboxIndex].url;
}

document.getElementById('vault-lightbox-close').addEventListener('click', closeLightbox);
lightboxEl.addEventListener('click', (e) => { if (e.target === lightboxEl) closeLightbox(); });
document.getElementById('vault-lightbox-prev').addEventListener('click', (e) => {
  e.stopPropagation();
  if (lightboxIndex > 0) { lightboxIndex--; updateLightboxImage(); }
});
document.getElementById('vault-lightbox-next').addEventListener('click', (e) => {
  e.stopPropagation();
  if (lightboxIndex < vaultImages.length - 1) { lightboxIndex++; updateLightboxImage(); }
});
document.getElementById('vault-lightbox-dl').addEventListener('click', async (e) => {
  e.stopPropagation();
  const v = vaultImages[lightboxIndex];
  if (!v) return;
  try {
    const res = await fetch(v.url);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = v.filename || 'image.png';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch { window.open(v.url, '_blank'); }
});
document.addEventListener('keydown', (e) => {
  if (!lightboxEl.classList.contains('active')) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft' && lightboxIndex > 0) { lightboxIndex--; updateLightboxImage(); }
  else if (e.key === 'ArrowRight' && lightboxIndex < vaultImages.length - 1) { lightboxIndex++; updateLightboxImage(); }
});

async function migrateLocalVault() {
  const uid = firebase.auth?.()?.currentUser?.uid;
  if (!uid) return;
  const migrationKey = `vault-migrated-${uid}`;
  if (localStorage.getItem(migrationKey)) return;

  // Read old localStorage vault
  const oldKey = `carousel-studio-vault-${uid}`;
  let oldVault = [];
  try { oldVault = JSON.parse(localStorage.getItem(oldKey) || '[]'); } catch { /* ignore */ }

  if (oldVault.length > 0) {
    const filenames = oldVault.map(v => v.filename).filter(Boolean);
    if (filenames.length > 0) {
      try {
        await authFetch('/api/images/migrate', {
          method: 'POST',
          body: JSON.stringify({ filenames }),
        });
      } catch { /* migration is best-effort */ }
    }
  }

  localStorage.setItem(migrationKey, '1');
  // Clean up old key
  try { localStorage.removeItem(oldKey); } catch { /* ignore */ }
}

async function openVault() {
  document.getElementById('vault-panel').classList.add('open');
  document.getElementById('vault-backdrop').classList.add('open');
  // Run one-time migration
  await migrateLocalVault();
  // Fetch fresh data (with fresh signed URLs) every time
  renderVault(); // show loading state
  await fetchVaultImages(true);
  renderVault();
}

function closeVault() {
  document.getElementById('vault-panel').classList.remove('open');
  document.getElementById('vault-backdrop').classList.remove('open');
}

// Vault event listeners
document.getElementById('vault-toggle-btn')?.addEventListener('click', openVault);
document.getElementById('vault-close-btn')?.addEventListener('click', closeVault);
document.getElementById('vault-backdrop')?.addEventListener('click', closeVault);

// Vault count loaded on auth state change (not here — avoids stale count from previous user)

// --- Background Library ---

let bgTopics = [];
let bgPollTimer = null;

const bgLibraryOverlay = document.getElementById('bg-library-overlay');
const bgLibraryClose = document.getElementById('bg-library-close');
const bgEmptyState = document.getElementById('bg-empty-state');
const bgDownloadFlow = document.getElementById('bg-download-flow');
const bgBrowseMode = document.getElementById('bg-browse-mode');
const bgTopicsList = document.getElementById('bg-topics-list');
const bgProgressFill = document.getElementById('bg-progress-fill');
const bgProgressLabel = document.getElementById('bg-progress-label');
const bgDownloadProgress = document.getElementById('bg-download-progress');
const bgThumbnailGrid = document.getElementById('bg-thumbnail-grid');
const bgCategoryTabs = document.getElementById('bg-category-tabs');

function openBgLibrary() {
  bgLibraryOverlay.style.display = 'flex';
  _activeFocusTrap = trapFocus(bgLibraryOverlay);
  loadBgLibrary();
}

function closeBgLibrary() {
  bgLibraryOverlay.style.display = 'none';
  if (_activeFocusTrap) { _activeFocusTrap.restore(); _activeFocusTrap = null; }
  if (bgPollTimer) { clearInterval(bgPollTimer); bgPollTimer = null; }
}

document.getElementById('bg-library-btn').addEventListener('click', openBgLibrary);
bgLibraryClose.addEventListener('click', closeBgLibrary);
bgLibraryOverlay.addEventListener('click', (e) => { if (e.target === bgLibraryOverlay) closeBgLibrary(); });

async function loadBgLibrary() {
  if (!currentBrand) return;
  bgEmptyState.style.display = 'none';
  bgDownloadFlow.style.display = 'none';
  bgBrowseMode.style.display = 'none';

  try {
    const res = await authFetch(`/api/backgrounds?brand=${encodeURIComponent(currentBrand)}`);
    const data = await res.json();

    if (data.totalImages === 0) {
      bgEmptyState.style.display = 'block';
    } else {
      bgBrowseMode.style.display = 'block';
      renderBgCategories(data.categories);
    }
  } catch (err) {
    bgEmptyState.style.display = 'block';
  }
}

document.getElementById('bg-start-download-btn').addEventListener('click', () => startBgDownloadFlow());
document.getElementById('bg-download-more-btn').addEventListener('click', () => startBgDownloadFlow());

async function startBgDownloadFlow() {
  bgEmptyState.style.display = 'none';
  bgBrowseMode.style.display = 'none';
  bgDownloadFlow.style.display = 'block';
  bgDownloadProgress.style.display = 'none';
  document.getElementById('bg-download-all-btn').disabled = false;
  document.getElementById('bg-back-browse-btn').style.display = 'none';

  bgTopicsList.innerHTML = '<p style="color:#6b7280; font-size:0.85rem;">Generating topics...</p>';

  try {
    const res = await authFetch('/api/backgrounds/generate-topics', {
      method: 'POST',
      body: JSON.stringify({ brandId: currentBrand }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    bgTopics = data.topics || [];
    renderBgTopics(bgTopics);
  } catch (err) {
    bgTopicsList.innerHTML = `<p style="color:var(--danger); font-size:0.85rem;">Failed: ${err.message}</p>`;
  }
}

function renderBgTopics(topics) {
  bgTopicsList.innerHTML = '';
  topics.forEach((topic, i) => {
    const row = document.createElement('div');
    row.className = 'bg-topic-item';
    row.innerHTML = `<input type="text" value="${topic.replace(/"/g, '&quot;')}" data-index="${i}" />
      <button class="bg-topic-remove" data-index="${i}">&times;</button>`;
    bgTopicsList.appendChild(row);
  });

  bgTopicsList.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => {
      bgTopics[parseInt(input.dataset.index)] = input.value;
    });
  });

  bgTopicsList.querySelectorAll('.bg-topic-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      bgTopics.splice(parseInt(btn.dataset.index), 1);
      renderBgTopics(bgTopics);
    });
  });
}

document.getElementById('bg-add-topic-btn').addEventListener('click', () => {
  bgTopics.push('');
  renderBgTopics(bgTopics);
  const inputs = bgTopicsList.querySelectorAll('input');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

document.getElementById('bg-regenerate-topics-btn').addEventListener('click', () => startBgDownloadFlow());

document.getElementById('bg-download-all-btn').addEventListener('click', async () => {
  const filtered = bgTopics.filter(t => t.trim());
  if (filtered.length === 0) return;

  document.getElementById('bg-download-all-btn').disabled = true;
  bgDownloadProgress.style.display = 'block';
  bgProgressFill.style.width = '0%';
  bgProgressLabel.textContent = 'Starting download...';

  try {
    const res = await authFetch('/api/backgrounds/download', {
      method: 'POST',
      body: JSON.stringify({ brandId: currentBrand, topics: filtered }),
    });
    const data = await res.json();

    if (data.error) {
      bgProgressLabel.textContent = `Error: ${data.error}`;
      document.getElementById('bg-download-all-btn').disabled = false;
      return;
    }

    bgPollTimer = setInterval(async () => {
      try {
        const statusRes = await authFetch(`/api/backgrounds/download-status/${data.jobId}`);
        const status = await statusRes.json();
        const pct = Math.round((status.completed / status.total) * 100);
        bgProgressFill.style.width = pct + '%';
        bgProgressLabel.textContent = status.currentTopic
          ? `Downloading: ${status.currentTopic} (${status.completed}/${status.total})`
          : `${status.completed}/${status.total} topics done`;

        if (status.status === 'done') {
          clearInterval(bgPollTimer);
          bgPollTimer = null;
          bgProgressLabel.textContent = 'Download complete!';
          document.getElementById('bg-back-browse-btn').style.display = 'inline-block';
        }
      } catch {}
    }, 2000);
  } catch (err) {
    bgProgressLabel.textContent = `Error: ${err.message}`;
    document.getElementById('bg-download-all-btn').disabled = false;
  }
});

document.getElementById('bg-back-browse-btn').addEventListener('click', () => loadBgLibrary());

function renderBgCategories(categories) {
  const keys = Object.keys(categories).sort();
  bgCategoryTabs.innerHTML = '';

  // "All" tab
  const allBtn = document.createElement('button');
  allBtn.className = 'bg-category-tab active';
  allBtn.textContent = 'All';
  allBtn.addEventListener('click', () => {
    bgCategoryTabs.querySelectorAll('.bg-category-tab').forEach(b => b.classList.remove('active'));
    allBtn.classList.add('active');
    const allImages = keys.flatMap(k => categories[k].images);
    renderBgThumbnails(allImages);
  });
  bgCategoryTabs.appendChild(allBtn);

  keys.forEach(key => {
    const btn = document.createElement('button');
    btn.className = 'bg-category-tab';
    btn.textContent = key.replace(/-/g, ' ');
    btn.addEventListener('click', () => {
      bgCategoryTabs.querySelectorAll('.bg-category-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderBgThumbnails(categories[key].images);
    });
    bgCategoryTabs.appendChild(btn);
  });

  // Show all by default
  const allImages = keys.flatMap(k => categories[k].images);
  renderBgThumbnails(allImages);
}

function renderBgThumbnails(images) {
  bgThumbnailGrid.innerHTML = '';
  images.forEach(imgUrl => {
    const div = document.createElement('div');
    div.className = 'bg-thumbnail';
    div.innerHTML = `<img src="${imgUrl}" loading="lazy" alt="" />
      <button class="bg-delete-btn" title="Delete">&times;</button>`;

    div.querySelector('img').addEventListener('click', () => selectBackground(imgUrl));

    div.querySelector('.bg-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      // Parse path: /backgrounds/{brandId}/{category}/{filename}
      const parts = imgUrl.replace(/^\/backgrounds\//, '').split('/');
      if (parts.length < 3) return;
      try {
        const res = await authFetch(`/api/backgrounds/${parts[0]}/${parts[1]}/${parts[2]}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) div.remove();
      } catch {}
    });

    bgThumbnailGrid.appendChild(div);
  });
}

async function selectBackground(imgUrl) {
  try {
    const res = await authFetch('/api/backgrounds/select', {
      method: 'POST',
      body: JSON.stringify({ backgroundPath: imgUrl }),
    });
    const data = await res.json();
    if (data.ok) {
      screenshotImageFilename = data.filename;
      screenshotFilename.textContent = data.filename;
      screenshotPreview.src = data.url;
      screenshotPreview.style.display = 'block';
      screenshotClearBtn.style.display = 'inline-block';
      closeBgLibrary();
      updatePreviewMockup();
    }
  } catch (err) {
    console.error('Failed to select background:', err);
  }
}
