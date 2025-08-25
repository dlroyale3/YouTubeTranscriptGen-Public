// Main page functionality
// Basic config matching transcript page
const API_BASE_URL = 'https://api.youtubetranscriptgen.com';
const LOCAL_API_URL = 'http://localhost:8000';

// Auth/credits state
let isLoggedIn = false;
let currentUser = null;
let currentCredits = 3;
const GUEST_CREDITS_KEY = 'youtube_transcript_guest_credits';
// Conversation time maps (shared with transcript page)
const START_TIME_MAP_KEY = 'ytg_conv_start_times_v1';
const LAST_MSG_MAP_KEY = 'ytg_last_msg_times_v1';
function getStartMap() {
    try { return JSON.parse(localStorage.getItem(START_TIME_MAP_KEY) || '{}'); } catch { return {}; }
}
function getStartTime(videoId) {
    try { const map = getStartMap(); return map[videoId] || null; } catch { return null; }
}
function getLastMsgMap() { try { return JSON.parse(localStorage.getItem(LAST_MSG_MAP_KEY) || '{}'); } catch { return {}; } }
function getLastMsgTime(videoId) { try { const m = getLastMsgMap(); return m[videoId] || null; } catch { return null; } }
function removeLastMsgTime(videoId) { try { const m = getLastMsgMap(); delete m[videoId]; localStorage.setItem(LAST_MSG_MAP_KEY, JSON.stringify(m)); } catch {} }
function removeStartTime(videoId) { try { const m = getStartMap(); delete m[videoId]; localStorage.setItem(START_TIME_MAP_KEY, JSON.stringify(m)); } catch {} }

// Conversation list cache (for navbar dropdown)
let isLoadingConversationHistory = false;

async function getWorkingAPI() {
    try {
        const r = await fetch(`${API_BASE_URL}/`, { method: 'GET', mode: 'cors' });
        if (r.ok) return API_BASE_URL;
    } catch {}
    try {
        const r = await fetch(`${LOCAL_API_URL}/`, { method: 'GET', mode: 'cors' });
        if (r.ok) return LOCAL_API_URL;
    } catch {}
    return API_BASE_URL;
}

function initializeGuestCredits() {
    const saved = localStorage.getItem(GUEST_CREDITS_KEY);
    if (saved === null) {
        localStorage.setItem(GUEST_CREDITS_KEY, '3');
        currentCredits = 3;
    } else {
        currentCredits = parseInt(saved, 10) || 0;
    }
    updateCreditsDisplay();
}

function updateCreditsDisplay() {
    const creditsAmount = document.getElementById('credits-amount');
    if (creditsAmount) creditsAmount.textContent = currentCredits;
    // Reveal credits visually once initialized
    const creditsElements = document.querySelectorAll('.credits-display');
    creditsElements.forEach(el => el.classList.add('visible'));

    // Profile dropdown pill
    const creditsAmountProfile = document.getElementById('credits-amount-profile');
    if (creditsAmountProfile) {
        creditsAmountProfile.textContent = currentCredits;
    }
}

async function fetchUserCredits() {
    try {
        const API_URL = await getWorkingAPI();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${API_URL}/api/user/credits`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const data = await res.json();
            currentCredits = data.credits;
            updateCreditsDisplay();
        }
    } catch {}
}

async function checkAuthStatus() {
    try {
        const API_URL = await getWorkingAPI();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(`${API_URL}/auth/user`, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (data.error || data.expired) {
            isLoggedIn = false; currentUser = null; updateAuthUI(); initializeGuestCredits();
            try { if (window.Ratings && typeof Ratings.refresh === 'function') Ratings.refresh(); } catch {}
        } else {
            isLoggedIn = true; currentUser = data; updateAuthUI(); fetchUserCredits();
            try { if (window.Ratings && typeof Ratings.refresh === 'function') Ratings.refresh(); } catch {}
            // Load conversation history on first open of dropdown; also preload once
            loadConversationHistory();
        }
    } catch {
        isLoggedIn = false; currentUser = null; updateAuthUI(); initializeGuestCredits();
    }
}

function updateAuthUI() {
    const loginBtn = document.getElementById('login-btn');
    const profileSection = document.getElementById('profile-section');
    const profilePicture = document.getElementById('profile-picture');
    const profileName = document.getElementById('profile-name');
    const profileEmail = document.getElementById('profile-email');

    if (isLoggedIn && currentUser) {
        if (loginBtn) loginBtn.style.display = 'none';
        if (profileSection) profileSection.style.display = 'block';
        if (profilePicture) { profilePicture.src = currentUser.picture || ''; profilePicture.alt = currentUser.name || 'Profile'; }
        if (profileName) profileName.textContent = currentUser.name || 'User';
        if (profileEmail) profileEmail.textContent = currentUser.email || '';
    } else {
        if (loginBtn) loginBtn.style.display = 'flex';
        if (profileSection) profileSection.style.display = 'none';
        if (profilePicture) { profilePicture.src = ''; profilePicture.alt = ''; }
        if (profileName) profileName.textContent = '';
        if (profileEmail) profileEmail.textContent = '';
    }
}

async function handleLogin() {
    try {
        const API_URL = await getWorkingAPI();
        localStorage.setItem('oauth_flow_started', Date.now().toString());
        const currentUrl = window.location.href;
        window.location.href = `${API_URL}/auth/login?return_url=${encodeURIComponent(currentUrl)}`;
    } catch {}
}

async function handleLogout() {
    try {
        const API_URL = await getWorkingAPI();
        await fetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
    } catch {}
    isLoggedIn = false; currentUser = null; initializeGuestCredits(); updateAuthUI();
    try { if (window.Ratings && typeof Ratings.refresh === 'function') Ratings.refresh(); } catch {}
}

function showProfileDropdown() {
    const dropdown = document.getElementById('profile-dropdown');
    if (dropdown) dropdown.classList.add('show');
    if (isLoggedIn) loadConversationHistory();
}
function hideProfileDropdown() { const d = document.getElementById('profile-dropdown'); if (d) d.classList.remove('show'); }
function toggleProfileDropdown() { const d = document.getElementById('profile-dropdown'); if (!d) return; d.classList.contains('show') ? hideProfileDropdown() : showProfileDropdown(); }

async function loadConversationHistory() {
    if (!isLoggedIn || isLoadingConversationHistory) return;
    isLoadingConversationHistory = true;
    try {
        const API_URL = await getWorkingAPI();
        const res = await fetch(`${API_URL}/api/conversations?_=${Date.now()}`, { credentials: 'include', headers: { 'Content-Type': 'application/json' } });
        if (res.ok) {
            const data = await res.json();
            displayConversationHistory(data.conversations || []);
        } else {
            displayConversationHistory([]);
        }
    } catch {
        displayConversationHistory([]);
    } finally {
        isLoadingConversationHistory = false;
    }
}

function displayConversationHistory(conversations) {
    const conversationList = document.getElementById('conversation-list');
    const showAllContainer = document.getElementById('show-all-container');
    const historySection = document.getElementById('conversation-history-section');
    if (!conversationList || !isLoggedIn) return;
    if (historySection) historySection.style.display = 'block';
    if (conversations.length === 0) {
        conversationList.innerHTML = '<div class="no-conversations">No saved conversations</div>';
        if (showAllContainer) showAllContainer.style.display = 'none';
        return;
    }
    const displayConversations = conversations.slice(0, 10);
    const hasMore = conversations.length > 10;
    conversationList.innerHTML = '';
    displayConversations.forEach(conv => {
        const item = createConversationItem(conv);
        conversationList.appendChild(item);
    });
    if (showAllContainer) {
        if (hasMore) {
            showAllContainer.style.display = 'block';
            const btn = document.getElementById('show-all-conversations');
            if (btn) btn.onclick = () => { displayAllConversations(conversations); showAllContainer.style.display = 'none'; };
        } else {
            showAllContainer.style.display = 'none';
        }
    }
}

function displayAllConversations(conversations) {
    const conversationList = document.getElementById('conversation-list');
    if (!conversationList) return;
    conversationList.innerHTML = '';
    conversationList.style.maxHeight = '300px';
    conversations.forEach(conv => {
        const item = createConversationItem(conv);
        conversationList.appendChild(item);
    });
}

function createConversationItem(conv) {
    const item = document.createElement('div');
    item.className = 'conversation-item';
    item.setAttribute('data-video-id', conv.video_id);
    const maxTitleLength = 35;
    const title = conv.video_title.length > maxTitleLength ? conv.video_title.substring(0, maxTitleLength) + '...' : conv.video_title;
    // Prefer the last user-to-AI message time for the age label; fallback to server times
    const lastISO = getLastMsgTime(conv.video_id) || conv.updated_at || conv.created_at;
    const updatedTime = formatRelativeTime(lastISO);
    item.innerHTML = `
        <div class="conversation-info">
            <div class="conversation-title">${title}</div>
            <div class="conversation-time">${updatedTime}</div>
        </div>
        <div class="conversation-actions">
            <button class="delete-conversation-btn" title="Delete conversation" data-video-id="${conv.video_id}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3,6 5,6 21,6"></polyline>
                    <path d="m19,6v14a2,2 0 0,1 -2,2H7a2,2 0 0,1 -2,-2V6m3,0V4a2,2 0 0,1 2,-2h4a2,2 0 0,1 2,2v2"></path>
                </svg>
            </button>
        </div>`;
    item.querySelector('.conversation-info').addEventListener('click', () => {
        window.location.href = `transcript.html?video_id=${conv.video_id}`;
        hideProfileDropdown();
    });
    const deleteBtn = item.querySelector('.delete-conversation-btn');
    deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        deleteBtn.disabled = true; deleteBtn.style.opacity = '0.5';
        try {
            await deleteSpecificConversation(conv.video_id);
            // Purge guest localStorage entry as well to avoid re-import
            try {
                const key = 'youtube_transcript_conversations';
                const saved = JSON.parse(localStorage.getItem(key) || '{}');
                if (saved && saved[conv.video_id]) {
                    delete saved[conv.video_id];
                    localStorage.setItem(key, JSON.stringify(saved));
                }
            } catch {}
        } finally { deleteBtn.disabled = false; deleteBtn.style.opacity = '1'; }
    });
    return item;
}

function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    if (diffMs < 0) return 'Just now';
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD}d ago`;
    const diffW = Math.floor(diffD / 7);
    if (diffW < 4) return `${diffW}w ago`;
    return date.toLocaleDateString();
}

async function deleteSpecificConversation(videoId) {
    if (!isLoggedIn) { alert('You must be logged in to delete conversations.'); return; }
    try {
        const API_URL = await getWorkingAPI();
        const res = await fetch(`${API_URL}/api/conversations/${videoId}`, { method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
        if (res.ok) {
            try { removeLastMsgTime(videoId); removeStartTime(videoId); } catch {}
            // Broadcast to other tabs so they also purge guest-local copies and state
            try { if (typeof broadcastDeletedVideo === 'function') broadcastDeletedVideo(videoId); } catch {}
            await loadConversationHistory();
        }
    } catch {}
}

async function clearAllConversations() {
    if (!isLoggedIn) return;
    try {
        const API_URL = await getWorkingAPI();
        const res = await fetch(`${API_URL}/api/conversations/clear`, { method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
        if (res.ok) {
            // Purge any guest-cached conversations too to avoid re-transfer
            try { localStorage.removeItem('youtube_transcript_conversations'); } catch {}
            try { if (typeof broadcastClearedAll === 'function') broadcastClearedAll(); } catch {}
            // Disable guest transfer flag for this page lifecycle
            try { window.__DISABLE_GUEST_TRANSFER__ = true; } catch {}
            // Also clear local last-message and start-time maps
            try { localStorage.removeItem(LAST_MSG_MAP_KEY); } catch {}
            try { localStorage.removeItem(START_TIME_MAP_KEY); } catch {}
            await loadConversationHistory();
        } else {
            alert('Failed to clear conversations. Please try again.');
        }
    } catch {
        alert('Failed to clear conversations. Please try again.');
    }
}

document.addEventListener('DOMContentLoaded', function() {
    // Burger menu functionality
    const burgerMenu = document.getElementById('burger-menu');
    const burgerDropdownMenu = document.getElementById('burger-dropdown-menu');
    
    // Get transcript functionality
    const getTranscriptBtn = document.getElementById('get-transcript-btn');
    const youtubeInput = document.getElementById('youtube-url');
    const errorMessage = document.getElementById('error-message');
    const errorText = document.getElementById('error-text');
    const errorCloseBtn = document.getElementById('error-close-btn');
    
    // Always use English as default language (auto behavior)
    const selectedLanguage = 'en';
    let isBurgerDropdownOpen = false;

    function toggleBurgerDropdown() {
        isBurgerDropdownOpen = !isBurgerDropdownOpen;
        if (isBurgerDropdownOpen) {
            burgerDropdownMenu.classList.add('show');
        } else {
            burgerDropdownMenu.classList.remove('show');
        }
    }

    function closeBurgerDropdown() {
        isBurgerDropdownOpen = false;
        burgerDropdownMenu.classList.remove('show');
    }

    function validateYouTubeUrl(url) {
        if (!url || url.trim() === '') {
            return { isValid: false, message: 'Please enter a YouTube URL' };
        }
        
        const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|\?v=)([^#\&\?]*).*/;
        const match = url.match(regExp);
        
        if (match && match[2].length == 11) {
            return { isValid: true, videoId: match[2] };
        } else {
            return { isValid: false, message: 'Please enter a valid YouTube URL' };
        }
    }

    function showError(message) {
        errorText.textContent = message;
        errorMessage.style.display = 'flex';
    }

    function hideError() {
        errorMessage.style.display = 'none';
    }

    function handleGetTranscript() {
        const url = youtubeInput.value;
        const validation = validateYouTubeUrl(url);
        
        if (!validation.isValid) {
            showError(validation.message);
            return;
        }
        
        hideError();
        
        // Always use English as default language (auto behavior)
        const transcriptUrl = `transcript.html?url=${encodeURIComponent(url)}&lang=${selectedLanguage}&video_id=${validation.videoId}`;
        window.location.href = transcriptUrl;
    }

    // Burger menu functionality
    burgerMenu.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleBurgerDropdown();
    });

    // Get transcript button functionality
    getTranscriptBtn.addEventListener('click', function(e) {
        e.preventDefault();
        handleGetTranscript();
    });

    // Hide error message when user starts typing
    youtubeInput.addEventListener('input', function() {
        if (errorMessage.style.display === 'flex') {
            hideError();
        }
    });

    // Handle Enter key press in YouTube URL input
    youtubeInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleGetTranscript();
        }
    });

    // Close error message when X button is clicked
    errorCloseBtn.addEventListener('click', function() {
        hideError();
    });

    // Add hover listeners for burger dropdown items
    const burgerMenuItems = document.querySelectorAll('.burger-menu-item');
    
    burgerMenuItems.forEach(item => {
        item.addEventListener('mouseenter', function() {
            burgerMenu.classList.add('dropdown-hovered');
        });
        
        item.addEventListener('mouseleave', function() {
            burgerMenu.classList.remove('dropdown-hovered');
        });
    });

    // Also handle hover on the dropdown menu itself
    burgerDropdownMenu.addEventListener('mouseenter', function() {
        burgerMenu.classList.add('dropdown-hovered');
    });
    
    burgerDropdownMenu.addEventListener('mouseleave', function() {
        burgerMenu.classList.remove('dropdown-hovered');
    });

    // Close burger dropdown when clicking outside
    document.addEventListener('click', function(e) {
        if (!burgerMenu.contains(e.target) && !burgerDropdownMenu.contains(e.target)) {
            closeBurgerDropdown();
        }
    });

    // Auth UI wiring
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const profileContainer = document.querySelector('.profile-container');
    const profilePicture = document.getElementById('profile-picture');
    const profileDropdown = document.getElementById('profile-dropdown');
    if (loginBtn) loginBtn.addEventListener('click', handleLogin);
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    // Only toggle dropdown when clicking the avatar, not when interacting inside the dropdown
    if (profilePicture) profilePicture.addEventListener('click', function(e){ e.stopPropagation(); toggleProfileDropdown(); });
    // Prevent clicks inside the dropdown from toggling/closing it
    if (profileDropdown) profileDropdown.addEventListener('click', function(e){ e.stopPropagation(); });
    const clearAllBtn = document.getElementById('clear-all-conversations');
    if (clearAllBtn) clearAllBtn.addEventListener('click', clearAllConversations);
    document.addEventListener('click', function(ev){
        const profileSection = document.getElementById('profile-section');
        const dropdown = document.getElementById('profile-dropdown');
        if (profileSection && dropdown && !profileSection.contains(ev.target)) hideProfileDropdown();
    });

    // Remember current page before going to Pricing from any Pricing button/link
    try {
        const pricingLinks = document.querySelectorAll('.pricing-link');
        pricingLinks.forEach(link => {
            link.addEventListener('click', function() {
                try { sessionStorage.setItem('returnTo', window.location.href); } catch {}
            });
        });
        // Also delegate to catch dynamically added elements
        document.addEventListener('click', function(e){
            try {
                const t = e.target;
                const el = t && t.closest ? t.closest('.pricing-link') : null;
                if (el) { sessionStorage.setItem('returnTo', window.location.href); }
            } catch {}
        });
    } catch {}

    // Init credits; then check auth
    initializeGuestCredits();
    setTimeout(() => { checkAuthStatus(); }, 50);

        // Handle purchase success flag from pricing return
        try {
            const params = new URLSearchParams(window.location.search);
            if (params.get('purchase') === '1') {
                // Force a light reload of credits by re-checking auth and credits
                setTimeout(() => { checkAuthStatus(); }, 150);
                showPurchaseToast();
                // Clean up URL to avoid re-showing on refresh
                params.delete('purchase');
                const clean = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}${window.location.hash}`;
                window.history.replaceState({}, '', clean);
            }
        } catch {}
        
    // Ratings + FAQ init (below-the-fold sections)
    try { if (window.Ratings && typeof Ratings.init === 'function') Ratings.init(); } catch {}
    try { initFAQToggles(); } catch {}
});

function ensureToastContainer() {
    let c = document.querySelector('.toast-container');
    if (!c) {
        c = document.createElement('div');
        c.className = 'toast-container';
        document.body.appendChild(c);
    }
    return c;
}

function showPurchaseToast() {
    const c = ensureToastContainer();
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `
        <div class="icon">✓</div>
        <div class="content">
            <div class="title">Purchase confirmed</div>
            <div class="message">Your coins were added to your account. Enjoy!</div>
        </div>
        <button class="close-btn" aria-label="Close">✕</button>
    `;
    c.appendChild(t);
    // Animate in
    requestAnimationFrame(() => t.classList.add('show'));
    const remove = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); };
    t.querySelector('.close-btn').addEventListener('click', remove);
    setTimeout(remove, 5000);
}

// Ratings system moved to shared scripts/ratings.js

// FAQ toggle behavior
function initFAQToggles() {
    const items = document.querySelectorAll('.faq-item');
    items.forEach(item => {
        const btn = item.querySelector('.faq-question');
        const ans = item.querySelector('.faq-answer');
        if (!btn || !ans) return;
        btn.addEventListener('click', () => {
            const expanded = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', String(!expanded));
            if (expanded) { ans.hidden = true; } else { ans.hidden = false; }
        });
    });
}
