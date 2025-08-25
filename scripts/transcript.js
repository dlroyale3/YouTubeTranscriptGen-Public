// Configuration
const API_BASE_URL = 'https://api.youtubetranscriptgen.com';
const LOCAL_API_URL = 'http://localhost:8000'; // Updated to match app.py port

// Authentication state
let isLoggedIn = false;
let currentUser = null;

// Credits system
let currentCredits = 3; // Default for guest users
const GUEST_CREDITS_KEY = 'youtube_transcript_guest_credits';
// Configurable free coins amount awarded on login (admin can tweak easily)
let FREE_LOGIN_COINS = 15;
// Cached cheapest pricing (USD) for logged-in upsell
let MIN_PRICING_USD = null;
// No dedupe: we want to show the alert after every AI reply while credits <= 3

// Admin helper: reset guest credits locally using a URL param (only on localhost)
(() => {
    try {
        const params = new URLSearchParams(window.location.search);
        const reset = params.get('reset_guest_credits') || params.get('admin_reset_guest_credits') || params.get('reset_guest');
        const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        if (isLocal && (reset === '1' || reset === 'true')) {
            localStorage.setItem(GUEST_CREDITS_KEY, '3');
            // Update in-memory state immediately; UI will refresh on DOMContentLoaded
            try { currentCredits = 3; } catch (_) {}
            // Clean the URL to avoid repeated resets on refresh
            try { history.replaceState({}, document.title, location.pathname + location.hash); } catch (_) {}
            console.log('[coins] Guest credits were reset to 3 (local only).');
            window.addEventListener('DOMContentLoaded', () => {
                try { if (typeof updateCreditsDisplay === 'function') updateCreditsDisplay(); } catch (_) {}
            });
        }
    } catch (_) {}
})();

// AI Models system
let availableModels = [];
let selectedModel = { id: 'high', cost: 3 }; // Default model now High

// Conversation system
let conversationHistory = [];
let currentVideoId = null;
let currentVideoTitle = '';
let isConversationLoaded = false;
const GUEST_CONVERSATIONS_KEY = 'youtube_transcript_conversations';

// Blocked videos system - prevent auto-recreation
let blockedVideoIds = new Set();
const BLOCKED_VIDEOS_KEY = 'youtube_transcript_blocked_videos';

// Load blocked videos from localStorage
function loadBlockedVideos() {
    try {
        const blocked = localStorage.getItem(BLOCKED_VIDEOS_KEY);
        if (blocked) {
            blockedVideoIds = new Set(JSON.parse(blocked));
        }
    } catch (error) {
        console.error('Error loading blocked videos:', error);
        blockedVideoIds = new Set();
    }
}

// Save blocked videos to localStorage
function saveBlockedVideos() {
    try {
        localStorage.setItem(BLOCKED_VIDEOS_KEY, JSON.stringify([...blockedVideoIds]));
    } catch (error) {
        console.error('Error saving blocked videos:', error);
    }
}

// Block a video from auto-saving
function blockVideoFromSaving(videoId) {
    blockedVideoIds.add(videoId);
    saveBlockedVideos();
    console.log(`🚫 Video ${videoId} blocked from auto-saving`);
}

// Unblock a video (for debugging)
function unblockVideoFromSaving(videoId) {
    blockedVideoIds.delete(videoId);
    saveBlockedVideos();
    console.log(`✅ Video ${videoId} unblocked from auto-saving`);
}

// Check if video is blocked
function isVideoBlocked(videoId) {
    return blockedVideoIds.has(videoId);
}

// Clear all blocked videos (for debugging)
function clearAllBlockedVideos() {
    blockedVideoIds.clear();
    saveBlockedVideos();
    console.log('🗑️ All blocked videos cleared');
}

// Transcript data
let transcriptData = null;
let currentLanguage = null;
let currentLanguageCode = null;

// Credits Management Functions
function initializeGuestCredits() {
    const savedCredits = localStorage.getItem(GUEST_CREDITS_KEY);
    if (savedCredits === null) {
        // First time user - set 3 credits
        localStorage.setItem(GUEST_CREDITS_KEY, '3');
        currentCredits = 3;
    } else {
        currentCredits = parseInt(savedCredits, 10) || 0;
    }
    // Update the display after initializing credits
    updateCreditsDisplay();
    console.log('[coins] Guest credits initialized:', currentCredits);
}

function updateGuestCredits(newCredits) {
    currentCredits = Math.max(0, newCredits);
    localStorage.setItem(GUEST_CREDITS_KEY, currentCredits.toString());
    updateCreditsDisplay();
    console.log('[coins] Guest credits updated:', currentCredits);
}

async function fetchUserCredits() {
    try {
        const API_URL = await getWorkingAPI();
        
        // Create controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
        
        const response = await fetch(`${API_URL}/api/user/credits`, {
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const data = await response.json();
            const parsed = Number(data.credits);
            currentCredits = Number.isNaN(parsed) ? currentCredits : parsed;
            updateCreditsDisplay();
            console.log('[coins] Credits fetched:', currentCredits, 'Type:', data.user_type);
            // Refresh any existing low-credits warning text/placement based on latest credits
            try {
                setTimeout(() => {
                    try {
                        console.log('🟡 Credits fetch refresh: scheduling maybeShowCreditsNoticeAfterResponse');
                        maybeShowCreditsNoticeAfterResponse();
                    } catch (_) {}
                }, 20);
            } catch (_) {}

            // If user is logged in and conversation is empty, ensure the on-load warning shows when credits ≤ 3
            try {
                setTimeout(() => {
                    try {
                        const chatMessages = document.getElementById('chat-messages');
                        const isEmptyConversation = Array.isArray(conversationHistory) && conversationHistory.length === 0;
                        const warningExists = !!document.querySelector('.ai-message .message-text.coins-warning');
                        const { shouldShow } = getCreditsWarningState();
                        if (isEmptyConversation && shouldShow && chatMessages && !warningExists) {
                            // De-dup and insert one warning right after the welcome message
                            removeCreditsWarning();
                            setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 10);
                            try { window.__WARN_ON_LOAD_SHOWN__ = true; } catch {}
                        }
                    } catch(_) {}
                }, 120);
            } catch(_) {}
        } else {
            console.error('❌ Failed to fetch credits - status:', response.status);
            // Don't fallback to guest credits if response fails - user is logged in
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('❌ Credits fetch timed out');
        } else {
            console.error('❌ Error fetching credits:', error);
        }
        // Don't fallback to guest credits if network error - user is logged in
    }
}

function updateCreditsDisplay() {
    // Update navbar credits
    const creditsAmount = document.getElementById('credits-amount');
    if (creditsAmount) {
        creditsAmount.textContent = currentCredits;
    }
    
    // Update AI header credits
    const creditsAmountAI = document.getElementById('credits-amount-ai');
    if (creditsAmountAI) {
        creditsAmountAI.textContent = currentCredits;
    }

    // Update profile dropdown credits pill
    const creditsAmountProfile = document.getElementById('credits-amount-profile');
    if (creditsAmountProfile) {
        creditsAmountProfile.textContent = currentCredits;
        const pill = document.getElementById('profile-credits-pill');
        if (pill) pill.style.visibility = 'visible';
    }
    
    // Update chat functionality based on credits
    updateChatAvailability();
    // Reset navbar emphasis when credits are safe again
    try {
        if (typeof currentCredits === 'number' && currentCredits > 3) {
            emphasizeNavbarCTA({ login: false, pricing: false });
            const loginBtn = document.getElementById('login-btn');
            const pricingLink = document.querySelector('.pricing-link');
            if (loginBtn) loginBtn.classList.remove('cta-animated');
            if (pricingLink) pricingLink.classList.remove('cta-animated');
        }
    } catch (_) {}
    
    console.log('[coins] Credits display updated:', currentCredits, 'User type:', isLoggedIn ? 'logged_in' : 'guest');
}

function updateChatAvailability() {
    const sendButton = document.getElementById('send-button');
    const chatInput = document.getElementById('chat-input');
    const modelCost = selectedModel.cost;
    const hasEnoughCredits = checkCreditsForModel(modelCost);
    
    if (sendButton) {
        sendButton.disabled = !hasEnoughCredits;
        sendButton.style.opacity = hasEnoughCredits ? '1' : '0.5';
    }
    
    if (chatInput) {
        chatInput.disabled = !hasEnoughCredits;
        chatInput.placeholder = hasEnoughCredits 
            ? 'Ask me anything about this video...'
            : `Need ${modelCost} credits for ${selectedModel.name} model (you have ${currentCredits})`;
    }
}

// Helper: determine if we should show a low-credits warning now
function getCreditsWarningState() {
    const n = Number(currentCredits);
    const valid = Number.isFinite(n) && n >= 0;
    if (!valid) return { shouldShow: false, isZero: false };
    if (isLoggedIn) {
        return { shouldShow: n <= 3, isZero: n === 0 };
    } else {
        // Guests: warn at 2 or fewer
        return { shouldShow: n <= 2, isZero: n === 0 };
    }
}

function coinsLabel(n) { return n === 1 ? 'coin' : 'coins'; }

async function fetchAIModels() {
    try {
        const API_URL = await getWorkingAPI();
        const response = await fetch(`${API_URL}/api/models`, {
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
            const data = await response.json();
            availableModels = data.models;
            await initializeModelDropdown();
            console.log('🤖 AI models fetched:', availableModels);
        } else {
            console.error('❌ Failed to fetch AI models - status:', response.status);
            // Fallback to default models (include ultra)
            availableModels = [
                { id: 'high', name: 'High Quality', cost: 3, description: 'Great accuracy and speed for most use cases' },
                { id: 'medium', name: 'Medium Quality', cost: 1, description: 'Balanced performance and cost' },
                { id: 'ultra', name: 'Ultra High Quality', cost: 15, description: 'Best accuracy and reasoning, premium cost' }
            ];
            await initializeModelDropdown();
        }
    } catch (error) {
        console.error('❌ Error fetching AI models:', error);
        // Fallback to default models (include ultra)
        availableModels = [
            { id: 'high', name: 'High Quality (Default)', cost: 3, description: 'Great accuracy and speed for most use cases' },
            { id: 'medium', name: 'Medium Quality', cost: 1, description: 'Balanced performance and cost' },
            { id: 'ultra', name: 'Ultra High Quality', cost: 15, description: 'Best accuracy and reasoning, premium cost' }
        ];
        await initializeModelDropdown();
    }
}

async function initializeModelDropdown() {
    const dropdownMenu = document.getElementById('ai-model-dropdown-menu');
    const dropdownBtn = document.getElementById('ai-model-dropdown-btn');
    
    if (!dropdownMenu || !dropdownBtn) return;
    
    // Clear existing options
    dropdownMenu.innerHTML = '';
    
    // Add model options
    availableModels.forEach(model => {
        const option = document.createElement('div');
        option.className = `ai-model-option ${model.id === selectedModel.id ? 'selected' : ''}`;
        option.setAttribute('data-model-id', model.id);
        
        option.innerHTML = `
            <div class="model-info">
                <div class="model-title">${model.name}</div>
                <div class="model-desc">${model.description}</div>
            </div>
            <div class="model-price">${model.cost} <img src="icons/COIN.png" class="coin-icon" alt="coin"></div>
        `;
        
        option.addEventListener('click', () => {
            selectModel(model);
            hideModelDropdown();
        });
        
        dropdownMenu.appendChild(option);
    });
    
    // Set initial selected model (prefer High)
    const defaultModel = availableModels.find(m => m.id === 'high') || availableModels[0];
    if (defaultModel) {
        selectModel(defaultModel);
    }
    
    // Setup dropdown toggle
    dropdownBtn.addEventListener('click', toggleModelDropdown);
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!dropdownBtn.contains(e.target) && !dropdownMenu.contains(e.target)) {
            hideModelDropdown();
        }
    });
    
    // Try to load conversation now that models are available
    await loadConversationWhenReady();
    // If logged-in, credits low, and conversation empty (welcome only), surface warning once
    try {
        const { shouldShow } = getCreditsWarningState();
        const isEmptyConversation = Array.isArray(conversationHistory) && conversationHistory.length === 0;
        const warningExists = !!document.querySelector('.ai-message .message-text.coins-warning');
        if (shouldShow && isEmptyConversation && !warningExists) {
            removeCreditsWarning();
            setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 20);
            try { window.__WARN_ON_LOAD_SHOWN__ = true; } catch {}
        }
    } catch (_) {}
}

function selectModel(model) {
    selectedModel = model;
    
    // Update dropdown button text
    const modelName = document.getElementById('selected-model-name');
    const modelCost = document.getElementById('selected-model-cost');
    
    if (modelName) modelName.textContent = model.name;
    if (modelCost) modelCost.innerHTML = `(${model.cost} <img src="icons/COIN.png" class="coin-icon" alt="coin">)`;
    
    // Update selected state in dropdown
    document.querySelectorAll('.ai-model-option').forEach(option => {
        option.classList.remove('selected');
        if (option.getAttribute('data-model-id') === model.id) {
            option.classList.add('selected');
        }
    });
    
    // Update chat availability based on new model cost
    updateChatAvailability();
    
    console.log('🤖 Model selected:', model);
}

function toggleModelDropdown() {
    const dropdownMenu = document.getElementById('ai-model-dropdown-menu');
    const dropdownBtn = document.getElementById('ai-model-dropdown-btn');
    if (dropdownMenu && dropdownBtn) {
        dropdownMenu.classList.toggle('show');
        dropdownBtn.classList.toggle('active');
    }
}

function hideModelDropdown() {
    const dropdownMenu = document.getElementById('ai-model-dropdown-menu');
    const dropdownBtn = document.getElementById('ai-model-dropdown-btn');
    if (dropdownMenu && dropdownBtn) {
        dropdownMenu.classList.remove('show');
        dropdownBtn.classList.remove('active');
    }
}

function checkCreditsForModel(modelCost) {
    return currentCredits >= modelCost;
}

// Conversation Management Functions
function initializeConversationSystem() {
    // Get video ID from URL - prioritize transcript ID, then video_id parameter
    const urlParams = new URLSearchParams(window.location.search);
    const transcriptId = urlParams.get('id');
    const videoIdParam = urlParams.get('video_id');
    
    // If we have transcript ID, use it; otherwise use video_id parameter
    if (transcriptId) {
        currentVideoId = transcriptId;
    } else if (videoIdParam) {
        currentVideoId = videoIdParam;
    }
    
    console.log('🔧 Conversation system initialized for video:', currentVideoId, 'from URL params:', { transcriptId, videoIdParam });
    
    // Don't load conversation yet - wait for models and auth status
}

// Add flag to prevent conversation loading after logout
let isAfterLogout = false;
// Track if we've appended the low-credits warning once during initial restore
window.__WARN_ON_LOAD_SHOWN__ = false;

async function loadConversationWhenReady() {
    // Don't load conversation if we just logged out
    if (isAfterLogout) {
        console.log('🚫 Skipping conversation load - recently logged out');
        return false;
    }
    
    // Check if all dependencies are ready
    if (!currentVideoId || availableModels.length === 0) {
        console.log('⏳ Waiting for dependencies:', { 
            videoId: !!currentVideoId, 
            modelsLoaded: availableModels.length > 0 
        });
        return false;
    }
    
    if (!isConversationLoaded) {
        console.log('💬 Loading conversation for video:', currentVideoId);
        await loadConversation();
        return true;
    }
    
    return false;
}

async function loadConversation() {
    if (!currentVideoId) return;
    
    // Prevent duplicate loading
    if (isConversationLoaded) {
        console.log('⚠️ Conversation already loaded, skipping duplicate load');
        return;
    }
    
    try {
        // Reset conversation loaded flag
        isConversationLoaded = false;
        
        console.log('📥 Loading conversation for video:', currentVideoId, 'User logged in:', isLoggedIn);
        
        // Clear any existing conversation data to prevent cross-contamination
        conversationHistory = [];
        
        if (isLoggedIn) {
            // Always prioritize database for logged-in users
            await loadConversationFromDB();
        } else {
            // Load from localStorage for guest users
            loadConversationFromLocalStorage();
        }
    } catch (error) {
        console.error('❌ Error loading conversation:', error);
        // Continue with empty conversation
        conversationHistory = [];
        isConversationLoaded = true;
    }
}

async function loadConversationFromDB() {
    try {
        console.log('📡 Loading conversation from DB for video:', currentVideoId);
        
        const API_URL = await getWorkingAPI();
        const response = await fetch(`${API_URL}/api/conversations/${currentVideoId}`, {
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
            const data = await response.json();
            
            // Verify we're loading conversation for the correct video
            // Ensure currentVideoId is set from the conversation payload
            if (data.video_id) {
                currentVideoId = data.video_id;
            }

            // If the conversation row included transcript_data, display it immediately.
            // Build a normalized transcript object and call displayTranscript to avoid
            // relying on displaySavedTranscript being defined elsewhere.
            try {
                if (data.transcript_data) {
                    console.log('✅ Conversation payload contains transcript_data - rendering now');
                    try {
                        const saved = data.transcript_data;
                        const normalized = {
                            video_id: data.video_id || currentVideoId,
                            transcript: saved.transcript || [],
                            language: saved.language || saved.language_name || 'Unknown',
                            language_code: saved.language_code || 'en',
                            is_translated: !!saved.is_translated
                        };
                        // Try to render immediately if displayTranscript exists; otherwise queue for later
                        try {
                            if (typeof displayTranscript === 'function') {
                                displayTranscript(normalized);
                            } else if (typeof window.displayTranscript === 'function') {
                                window.displayTranscript(normalized);
                            } else {
                                // Store pending transcript for consumption by displayTranscript when it becomes available.
                                // Avoid fragile polling; let the renderer consume the queued transcript on first invocation.
                                try { window.__PENDING_TRANSCRIPT__ = normalized; } catch (_) {}
                                console.log('⏳ Queued transcript for later rendering (displayTranscript not available yet)');
                            }
                        } catch (err) {
                            console.warn('⚠️ Could not display embedded transcript_data:', err);
                        }
                    } catch (e) {
                        console.warn('⚠️ Could not display embedded transcript_data:', e);
                    }
                }
            } catch (e) {
                console.debug('No embedded transcript_data present in conversation payload');
            }

            if (data.video_id && data.video_id !== currentVideoId) {
                console.warn('⚠️ Conversation video mismatch! Expected:', currentVideoId, 'Got:', data.video_id);
                conversationHistory = [];
                isConversationLoaded = true;
                return;
            }
            
            conversationHistory = data.conversation_data || [];
            
            // Restore last used model
            if (data.last_model_used) {
                const model = availableModels.find(m => m.id === data.last_model_used);
                if (model) {
                    selectModel(model);
                }
            }
            
            // Restore chat messages in UI - do NOT set isRestoringMessages here
            // The restoreChatMessages function will handle its own flag management
            restoreChatMessages();
            
            console.log('💬 Conversation loaded from database:', conversationHistory.length, 'messages');
        } else if (response.status === 404) {
            // No saved conversation, start fresh
            conversationHistory = [];
        } else {
            throw new Error(`Failed to load conversation: ${response.status}`);
        }
    } catch (error) {
        console.error('❌ Error loading conversation from DB:', error);
        conversationHistory = [];
    }
    
    isConversationLoaded = true;
}

function loadConversationFromLocalStorage() {
    try {
        const savedConversations = JSON.parse(localStorage.getItem(GUEST_CONVERSATIONS_KEY) || '{}');
        const conversation = savedConversations[currentVideoId];
        
        if (conversation) {
            conversationHistory = conversation.conversation_history || [];
            
            // Restore last used model
            if (conversation.last_model_used) {
                const model = availableModels.find(m => m.id === conversation.last_model_used);
                if (model) {
                    selectModel(model);
                }
            }
            
            // Restore chat messages in UI
            restoreChatMessages();
            
            console.log('💬 Conversation loaded from localStorage:', conversationHistory.length, 'messages');
        } else {
            conversationHistory = [];
        }
    } catch (error) {
        console.error('❌ Error loading conversation from localStorage:', error);
        conversationHistory = [];
    }
    
    isConversationLoaded = true;
}

// Add flag to prevent duplicate restore
let isRestoringMessages = false;

function restoreChatMessages() {
    // Force reset flag in case it got stuck
    const currentTime = Date.now();
    const lastRestoreTime = window.lastRestoreTime || 0;
    
    // If less than 100ms has passed since last restore, skip
    if (currentTime - lastRestoreTime < 100) {
        console.log('⚠️ restoreChatMessages called too soon, skipping');
        return;
    }
    
    if (isRestoringMessages) {
        console.log('⚠️ restoreChatMessages already in progress, forcing reset after 1 second');
        // Force reset after 1 second if stuck
        setTimeout(() => {
            isRestoringMessages = false;
            console.log('🔄 Forced reset of isRestoringMessages flag');
        }, 1000);
        return;
    }
    
    isRestoringMessages = true;
    window.lastRestoreTime = currentTime;
    console.log('🔄 restoreChatMessages called, conversation length:', conversationHistory.length);
    
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) {
        isRestoringMessages = false;
        return;
    }
    
    // Small delay to ensure DOM is ready
    setTimeout(() => {
        try {
            // Clear existing messages except the initial welcome message (if it exists and is first)
            const allMessages = chatMessages.querySelectorAll('.ai-message, .user-message');
            const hasWelcomeMessage = chatMessages.children.length > 0 && 
                                     chatMessages.children[0].classList.contains('ai-message') && 
                                     chatMessages.children[0].querySelector('.message-text')?.textContent.includes('I have access to the transcript');
            
            // Clear all messages
            chatMessages.innerHTML = '';
            
            // Re-add welcome message if it existed
            if (hasWelcomeMessage) {
                const welcomeDiv = document.createElement('div');
                welcomeDiv.className = 'ai-message';
                welcomeDiv.innerHTML = `
                    <div class="ai-avatar">🤖</div>
                    <div class="message-content">
                        <div class="message-text">Hi! I'm your AI assistant. I have access to the transcript of this video and can help answer questions about its content. What would you like to know?</div>
                    </div>
                `;
                chatMessages.appendChild(welcomeDiv);
            }
            
            // Restore conversation messages with proper markdown formatting
            console.log('📚 Starting to restore', conversationHistory.length, 'messages...');
            conversationHistory.forEach((msg, index) => {
                console.log(`📄 Restoring message ${index + 1}:`, msg.role, msg.content.substring(0, 50) + '...');
                addMessageToChat(msg.content, msg.role === 'user' ? 'user' : 'ai', true); // true = isFromHistory
            });
            
            console.log('✅ Successfully restored', conversationHistory.length, 'messages from conversation history');
            // If thresholds say we should warn and the conversation is empty, show exactly one warning after welcome
            try {
                const isEmptyConversation = Array.isArray(conversationHistory) && conversationHistory.length === 0;
                const { shouldShow } = getCreditsWarningState();
                if (!window.__WARN_ON_LOAD_SHOWN__ && shouldShow && isEmptyConversation) {
                    removeCreditsWarning();
                    console.log('🟡 Scheduling low-credits warning for EMPTY conversation after restore');
                    setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 10);
                }
                // Post-restore pass: for NON-empty conversations, place a single warning after the last AI message
                const warningExists = !!document.querySelector('.ai-message .message-text.coins-warning');
                if (shouldShow && !isEmptyConversation && !warningExists) {
                    console.log('🟡 Scheduling low-credits warning for NON-EMPTY conversation after restore');
                    setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 25);
                }
            } catch (e) { console.warn('⚠️ restoreChatMessages warning scheduling error:', e); }
            
        } catch (error) {
            console.error('❌ Error in restoreChatMessages:', error);
        } finally {
            isRestoringMessages = false;
        }
    }, 100); // 100ms delay
}

// Debounce timer for conversation saving
let saveConversationTimer = null;

async function saveConversation() {
    // Don't save if we're just restoring messages or loading from conversation
    if (isRestoringMessages) {
        console.log('🚫 Skipping save - currently restoring messages');
        return;
    }
    
    // Don't save if this video is blocked from auto-saving
    if (isVideoBlocked(currentVideoId)) {
        console.log(`🚫 Skipping save - video ${currentVideoId} is blocked from auto-saving`);
        return;
    }

    if (!currentVideoId || !currentVideoTitle || conversationHistory.length === 0) return;

    try {
        if (isLoggedIn) {
            await saveConversationToDB();
        } else {
            saveConversationToLocalStorage();
        }
    } catch (error) {
        console.error('❌ Error saving conversation:', error);
    }
}

// Debounced version for frequent saves
function saveConversationDebounced(delay = 1000) {
    // Clear existing timer
    if (saveConversationTimer) {
        clearTimeout(saveConversationTimer);
    }
    
    // Set new timer
    saveConversationTimer = setTimeout(() => {
        saveConversation().catch(error => {
            console.warn('⚠️ Debounced save failed:', error);
        });
    }, delay);
}async function saveConversationToDB() {
    try {
        const API_URL = await getWorkingAPI();
        
        // Skip transcript data for chat messages to improve performance
        // Only include transcript data on initial transcript generation
        const isInitialTranscriptSave = transcriptData && transcriptData.length > 0 && !isRestoringMessages;
        const urlParams = new URLSearchParams(window.location.search);
        const isFromConversationLoad = urlParams.get('video_id') && !urlParams.get('id');
        
        let transcript_data = null;
        if (isInitialTranscriptSave && !isFromConversationLoad) {
            transcript_data = {
                transcript: transcriptData,
                video_id: currentVideoId,
                language: currentLanguage || 'en',
                language_code: currentLanguageCode || 'en'
            };
            console.log('💾 Including transcript data in conversation save');
        }
        // Also persist available languages if we have them cached for this video
        try {
            const cached = localStorage.getItem(`languages_${currentVideoId}`);
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed && Array.isArray(parsed.languages)) {
                    if (!transcript_data) transcript_data = {};
                    transcript_data.languages = parsed.languages;
                    console.log(`💾 Including ${parsed.languages.length} cached languages in save`);
                }
            }
        } catch (e) {
            console.log('⚠️ Could not attach cached languages to save:', e);
        }
        
        const requestBody = {
            video_id: currentVideoId,
            video_title: currentVideoTitle,
            conversation_data: conversationHistory,
            last_model_used: selectedModel.id
        };
        
        // Only add transcript_data if it exists to reduce payload size
        if (transcript_data) {
            requestBody.transcript_data = transcript_data;
        } else {
            // If we're not including transcript_data, still try to persist languages quickly
            try {
                const cached = localStorage.getItem(`languages_${currentVideoId}`);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    if (parsed && Array.isArray(parsed.languages)) {
                        requestBody.languages = parsed.languages;
                        if (currentLanguageCode) requestBody.language_code = currentLanguageCode;
                        console.log('💾 Persisting languages without transcript_data for faster history');
                    }
                }
            } catch {}
        }
        
    const response = await fetch(`${API_URL}/api/conversations`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        
        if (response.ok) {
            console.log('💬 Conversation saved to database');
            
            // Skip conversation history refresh during active chat for better performance
            // Only refresh when user opens profile dropdown or on page load
            console.log('⚡ Skipping conversation history refresh for better performance');
        } else {
            throw new Error(`Failed to save conversation: ${response.status}`);
        }
    } catch (error) {
        console.error('❌ Error saving conversation to DB:', error);
    }
}

function saveConversationToLocalStorage() {
    try {
        const savedConversations = JSON.parse(localStorage.getItem(GUEST_CONVERSATIONS_KEY) || '{}');
        
        // Prefer the start timestamp; fall back to now
        let updatedAt = new Date().toISOString();
        let createdAt = null;
        try {
            if (currentVideoId) {
                const startIso = getStartTime(currentVideoId);
                if (startIso) {
                    createdAt = startIso;
                    updatedAt = startIso;
                }
            }
        } catch (_) {}

        savedConversations[currentVideoId] = {
            video_title: currentVideoTitle,
            conversation_history: conversationHistory,
            last_model_used: selectedModel.id,
            updated_at: updatedAt,
            created_at: createdAt || updatedAt
        };
        
        localStorage.setItem(GUEST_CONVERSATIONS_KEY, JSON.stringify(savedConversations));
        console.log('💬 Conversation saved to localStorage');
    } catch (error) {
        console.error('❌ Error saving conversation to localStorage:', error);
    }
}

async function clearConversation() {
    conversationHistory = [];
    currentResponseId = null; // Reset response ID when clearing conversation
    
    // Clear chat UI
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
        // Keep only the welcome message
        const welcomeMessage = chatMessages.querySelector('.ai-message');
        chatMessages.innerHTML = '';
        if (welcomeMessage) {
            chatMessages.appendChild(welcomeMessage);
        }
    }
    // After clearing, if logged-in and low credits, show a single warning for empty conversation
    try {
        const { shouldShow } = getCreditsWarningState();
        if (isLoggedIn && shouldShow) {
            removeCreditsWarning();
            setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 20);
            try { window.__WARN_ON_LOAD_SHOWN__ = true; } catch {}
        }
    } catch (_) {}
    
    // Delete from storage
    try {
        if (isLoggedIn && currentVideoId) {
            const API_URL = await getWorkingAPI();
            await fetch(`${API_URL}/api/conversations/${currentVideoId}`, {
                method: 'DELETE',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' }
            });
            
            // Ensure future saves are allowed for this video
            unblockVideoFromSaving(currentVideoId);
            // Purge corresponding guest localStorage entry as well to avoid any re-import later
            try {
                const savedConversations = JSON.parse(localStorage.getItem(GUEST_CONVERSATIONS_KEY) || '{}');
                if (savedConversations && savedConversations[currentVideoId]) {
                    delete savedConversations[currentVideoId];
                    localStorage.setItem(GUEST_CONVERSATIONS_KEY, JSON.stringify(savedConversations));
                    console.log('🧹 Purged guest localStorage for current video after clear');
                }
            } catch (_) {}
            
        } else if (currentVideoId) {
            const savedConversations = JSON.parse(localStorage.getItem(GUEST_CONVERSATIONS_KEY) || '{}');
            delete savedConversations[currentVideoId];
            localStorage.setItem(GUEST_CONVERSATIONS_KEY, JSON.stringify(savedConversations));
            
            // Ensure future saves are allowed for this video
            unblockVideoFromSaving(currentVideoId);
        }
        
        // Reset flags so new conversation behaves normally and can be saved
        isConversationLoaded = false;
        isRestoringMessages = false;
        console.log('🔄 Ready for new conversation and saving');

        console.log('💬 Conversation cleared successfully');
    // Refresh history list if visible for logged-in users
    try { if (isLoggedIn) { await loadConversationHistory(); } } catch (_) {}
    } catch (error) {
        console.error('❌ Error clearing conversation:', error);
    }
}

async function transferGuestConversations() {
    if (!isLoggedIn) return;
    // If a recent clear-all happened, skip transfer to avoid resurrecting cleared data
    try {
        if (window.__DISABLE_GUEST_TRANSFER__) {
            console.log('⏭️ Skipping guest conversation transfer due to recent clear-all');
            try { localStorage.removeItem(GUEST_CONVERSATIONS_KEY); } catch (_) {}
            return;
        }
    } catch (_) {}
    
    try {
        const savedConversations = JSON.parse(localStorage.getItem(GUEST_CONVERSATIONS_KEY) || '{}');
        
        if (Object.keys(savedConversations).length === 0) return;
        
        const API_URL = await getWorkingAPI();
        const response = await fetch(`${API_URL}/api/conversations/transfer`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                guest_conversations: savedConversations
            })
        });
        
        if (response.ok) {
            const data = await response.json();
            console.log('📤 Guest conversations transferred:', data.transferred_count);
            // After a successful transfer request, clear localStorage to prevent future re-imports
            try {
                localStorage.removeItem(GUEST_CONVERSATIONS_KEY);
                console.log('🧹 Cleared guest conversations from localStorage after transfer');
            } catch (_) {}
            // Reîncarcă conversația din contul logat pentru a reflecta instant conversația transferată
            try {
                isConversationLoaded = false;
                await loadConversationWhenReady();
                console.log('🔄 Reloaded conversation after guest transfer');
            } catch (err) {
                console.warn('❌ Failed to reload conversation after guest transfer:', err);
            }
        }
    } catch (error) {
        console.error('❌ Error transferring guest conversations:', error);
    }
}

// Conversation History UI Functions
let isLoadingConversationHistory = false;

// Local override for conversation start times: track when the conversation started (first user message)
const LAST_MSG_MAP_KEY = 'ytg_last_msg_times_v1';
function getLastMsgMap() {
    try { return JSON.parse(localStorage.getItem(LAST_MSG_MAP_KEY) || '{}'); } catch { return {}; }
}
function setLastMsgTime(videoId, iso) {
    try {
        const map = getLastMsgMap();
        map[videoId] = iso;
        localStorage.setItem(LAST_MSG_MAP_KEY, JSON.stringify(map));
    } catch (_) {}
}
function getLastMsgTime(videoId) {
    try { const map = getLastMsgMap(); return map[videoId] || null; } catch { return null; }
}
function removeLastMsgTime(videoId) {
    try { const map = getLastMsgMap(); delete map[videoId]; localStorage.setItem(LAST_MSG_MAP_KEY, JSON.stringify(map)); } catch (_) {}
}
function clearAllLastMsgTimes() {
    try { localStorage.removeItem(LAST_MSG_MAP_KEY); } catch (_) {}
}
// Start time map (preferred for history label)
const START_TIME_MAP_KEY = 'ytg_conv_start_times_v1';
function getStartMap() {
    try { return JSON.parse(localStorage.getItem(START_TIME_MAP_KEY) || '{}'); } catch { return {}; }
}
function getStartTime(videoId) {
    try { const map = getStartMap(); return map[videoId] || null; } catch { return null; }
}
function setStartTime(videoId, iso) {
    try { const map = getStartMap(); map[videoId] = iso; localStorage.setItem(START_TIME_MAP_KEY, JSON.stringify(map)); } catch (_) {}
}
function removeStartTime(videoId) {
    try { const map = getStartMap(); delete map[videoId]; localStorage.setItem(START_TIME_MAP_KEY, JSON.stringify(map)); } catch (_) {}
}
function clearAllStartTimes() {
    try { localStorage.removeItem(START_TIME_MAP_KEY); } catch (_) {}
}
// Broadcast helpers for cross-tab coordination
function broadcastDeletedVideo(videoId) {
    try {
        localStorage.setItem('ytg_deleted_event', JSON.stringify({videoId: videoId, ts: Date.now()}));
        // remove immediately to trigger storage event in other tabs
        localStorage.removeItem('ytg_deleted_event');
    } catch (_) {}
}
function broadcastClearedAll() {
    try {
        localStorage.setItem('ytg_cleared_all', JSON.stringify({ts: Date.now()}));
        localStorage.removeItem('ytg_cleared_all');
    } catch (_) {}
}

// Listen for cross-tab storage events to keep all tabs in sync
window.addEventListener('storage', function(e) {
    try {
        if (!e.key) return;
        if (e.key === 'ytg_deleted_event') {
            const payload = JSON.parse(e.newValue || e.oldValue || '{}');
            const vid = payload && payload.videoId;
            if (vid) {
                try { const saved = JSON.parse(localStorage.getItem(GUEST_CONVERSATIONS_KEY) || '{}'); delete saved[vid]; localStorage.setItem(GUEST_CONVERSATIONS_KEY, JSON.stringify(saved)); } catch (_) {}
                try { removeLastMsgTime(vid); removeStartTime(vid); } catch (_) {}
                try { unblockVideoFromSaving(vid); } catch (_) {}
            }
        }
        if (e.key === 'ytg_cleared_all') {
            try { localStorage.removeItem(GUEST_CONVERSATIONS_KEY); } catch (_) {}
            try { localStorage.removeItem(LAST_MSG_MAP_KEY); } catch (_) {}
            try { localStorage.removeItem(START_TIME_MAP_KEY); } catch (_) {}
            try { clearAllBlockedVideos(); } catch (_) {}
            try { window.__DISABLE_GUEST_TRANSFER__ = true; } catch (_) {}
        }
    } catch (_) {}
});

// If a transcript was queued while displayTranscript wasn't available, attempt to render it now
window.addEventListener('DOMContentLoaded', () => {
    try {
        const pending = window.__PENDING_TRANSCRIPT__;
        if (pending && (typeof displayTranscript === 'function' || typeof window.displayTranscript === 'function')) {
            try {
                (displayTranscript || window.displayTranscript)(pending);
                delete window.__PENDING_TRANSCRIPT__;
                console.log('✅ Rendered pending transcript on DOMContentLoaded');
            } catch (err) {
                console.warn('⚠️ Failed to render pending transcript on DOMContentLoaded:', err);
            }
        }
    } catch (_) {}
});
function pickMostRecentISO(a, b) {
    const ta = a ? Date.parse(a) : NaN;
    const tb = b ? Date.parse(b) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta >= tb ? a : b;
    if (Number.isFinite(ta)) return a;
    if (Number.isFinite(tb)) return b;
    return a || b || new Date().toISOString();
}
function updateHistoryItemTimeNow(videoId) {
    try {
        const list = document.getElementById('conversation-list');
        if (!list) return;
        const item = list.querySelector(`.conversation-item[data-video-id="${CSS.escape(videoId)}"]`)
                  || list.querySelector(`.conversation-item button.delete-conversation-btn[data-video-id="${CSS.escape(videoId)}"]`)?.closest('.conversation-item');
        if (!item) return;
        const timeEl = item.querySelector('.conversation-time');
        if (!timeEl) return;
    timeEl.textContent = 'Just now';
    } catch (_) {}
}

async function loadConversationHistory() {
    if (!isLoggedIn) {
        // For guest users, hide the history section
        const historySection = document.getElementById('conversation-history-section');
        if (historySection) {
            historySection.style.display = 'none';
        }
        return;
    }
    
    // Prevent multiple simultaneous calls
    if (isLoadingConversationHistory) {
        return;
    }
    isLoadingConversationHistory = true;
    
    try {
        const API_URL = await getWorkingAPI();
        // Add cache bust to ensure fresh data
        const cacheBust = Date.now();
        const response = await fetch(`${API_URL}/api/conversations?_=${cacheBust}`, {
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
            const data = await response.json();
            displayConversationHistory(data.conversations || []);
        } else {
            console.error('Failed to load conversation history');
            displayConversationHistory([]);
        }
    } catch (error) {
        console.error('Error loading conversation history:', error);
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
    
    // Show the history section for logged users
    if (historySection) {
        historySection.style.display = 'block';
    }
    
    if (conversations.length === 0) {
        conversationList.innerHTML = '<div class="no-conversations">No saved conversations</div>';
        if (showAllContainer) showAllContainer.style.display = 'none';
        return;
    }
    
    // Show first 10 conversations
    const displayConversations = conversations.slice(0, 10);
    const hasMore = conversations.length > 10;
    
    conversationList.innerHTML = '';
    
    displayConversations.forEach(conv => {
        const item = createConversationItem(conv);
        conversationList.appendChild(item);
    });
    
    // Show "Show All" button if there are more conversations
    if (showAllContainer) {
        if (hasMore) {
            showAllContainer.style.display = 'block';
            const showAllBtn = document.getElementById('show-all-conversations');
            if (showAllBtn) {
                showAllBtn.onclick = () => {
                    displayAllConversations(conversations);
                    showAllContainer.style.display = 'none';
                };
            }
        } else {
            showAllContainer.style.display = 'none';
        }
    }
}

function displayAllConversations(conversations) {
    const conversationList = document.getElementById('conversation-list');
    if (!conversationList) return;
    
    conversationList.innerHTML = '';
    conversationList.style.maxHeight = '300px'; // Increase height for all conversations
    
    conversations.forEach(conv => {
        const item = createConversationItem(conv);
        conversationList.appendChild(item);
    });
}

function createConversationItem(conv) {
    const item = document.createElement('div');
    item.className = `conversation-item ${conv.video_id === currentVideoId ? 'current' : ''}`;
    item.setAttribute('data-video-id', conv.video_id);
    
    // Truncate title if too long
    const maxTitleLength = 35;
    const title = conv.video_title.length > maxTitleLength 
        ? conv.video_title.substring(0, maxTitleLength) + '...'
        : conv.video_title;
    
    // Format time: show age since last user message sent to AI
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
        </div>
    `;
    
    // Add click handler for loading conversation
    item.querySelector('.conversation-info').addEventListener('click', () => {
        loadSpecificConversation(conv.video_id);
        hideProfileDropdown();
    });
    
    // Add delete handler - SIMPLE APPROACH
    const deleteBtn = item.querySelector('.delete-conversation-btn');
    deleteBtn.addEventListener('click', async (e) => {
        const timestamp = new Date().toISOString();
        console.log(`🔘 [${timestamp}] Delete button clicked for video:`, conv.video_id);
        
        e.stopPropagation();
        
        // Prevent multiple clicks by checking if already disabled
        if (deleteBtn.disabled) {
            console.log(`⚠️ [${timestamp}] Button already disabled, ignoring click`);
            return;
        }
        
        // Immediately disable button to prevent double clicks
        deleteBtn.disabled = true;
        deleteBtn.style.opacity = '0.5';
        console.log(`🚫 [${timestamp}] Button disabled for video:`, conv.video_id);
        
        // Simple delete - no complex logic
        try {
            await deleteSpecificConversation(conv.video_id);
        } finally {
            deleteBtn.disabled = false;
            deleteBtn.style.opacity = '1';
            console.log(`✅ [${timestamp}] Button re-enabled for video:`, conv.video_id);
        }
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

async function loadSpecificConversation(videoId) {
    if (videoId === currentVideoId) {
        // Already viewing this conversation
        return;
    }
    
    try {
        console.log('🔄 Loading specific conversation for video:', videoId, 'Current video:', currentVideoId);
        
        // Force redirect to ensure clean context switch
        // This prevents cross-contamination of conversations between videos
        window.location.href = `transcript.html?video_id=${videoId}`;
        
    } catch (error) {
        console.error('❌ Error loading specific conversation:', error);
        alert('Failed to load conversation. Please try again.');
    }
}

function showConversationOnlyView(videoTitle) {
    console.log('📺 Showing conversation-only view for:', videoTitle);
    
    const transcriptLayout = document.getElementById('transcript-layout');
    const transcriptContent = document.getElementById('transcript-content');
    const videoTitleElement = document.getElementById('video-title');
    
    if (!transcriptLayout || !transcriptContent) return;
    
    // Update video title
    if (videoTitleElement) {
        videoTitleElement.textContent = videoTitle;
    }
    
    // Clear transcript content and show a message
    transcriptContent.innerHTML = `
        <div class="no-transcript-message">
            <h3>Conversation History</h3>
            <p>The transcript for this video is no longer available, but you can view your conversation history below.</p>
        </div>
    `;
    
    // Show the transcript layout
    transcriptLayout.style.display = 'flex';
    
    // Initialize chat system
    setTimeout(() => {
        // Set transcriptData to empty for this case
        transcriptData = [];
        initializeChat();
    }, 100);
}

async function deleteSpecificConversation(videoId) {
    const timestamp = new Date().toISOString();
    console.log(`🗑️ [${timestamp}] deleteSpecificConversation called for video:`, videoId);
    
    // Check if user is logged in
    if (!isLoggedIn) {
        alert('You must be logged in to delete conversations.');
        return;
    }
    
    try {
        console.log('🗑️ Attempting to delete conversation for video:', videoId);
        const API_URL = await getWorkingAPI();
        const response = await fetch(`${API_URL}/api/conversations/${videoId}`, {
            method: 'DELETE',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });
        
        console.log('📡 Delete response status:', response.status);
        
        if (response.ok) {
            const result = await response.json();
            console.log('✅ Conversation deleted successfully:', result);
            
            // Mark deletion timestamp to prevent immediate history reload
            window.lastConversationDeletion = Date.now();
            
            // Purge the corresponding guest localStorage entry to avoid any future re-imports
            try {
                const savedConversations = JSON.parse(localStorage.getItem(GUEST_CONVERSATIONS_KEY) || '{}');
                if (savedConversations && savedConversations[videoId]) {
                    delete savedConversations[videoId];
                    localStorage.setItem(GUEST_CONVERSATIONS_KEY, JSON.stringify(savedConversations));
                    console.log('🧹 Purged guest localStorage for video:', videoId);
                }
            } catch (_) {}
            
            // If this is the current video, clear ONLY the UI (no additional backend call)
            if (videoId === currentVideoId) {
                console.log('🔄 Clearing current conversation UI (local only)');
                conversationHistory = [];
                const chatMessages = document.getElementById('chat-messages');
                if (chatMessages) {
                    const welcomeMessage = chatMessages.querySelector('.ai-message');
                    chatMessages.innerHTML = '';
                    if (welcomeMessage) {
                        chatMessages.appendChild(welcomeMessage);
                    }
                }
                // After delete, if logged-in and low credits, show warning for empty chat
                try {
                    const { shouldShow } = getCreditsWarningState();
                    if (isLoggedIn && shouldShow) {
                        removeCreditsWarning();
                        setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 20);
                        try { window.__WARN_ON_LOAD_SHOWN__ = true; } catch {}
                    }
                } catch (_) {}
                console.log('💬 Current conversation UI cleared (no backend call)');
            }
            // Remove last message override for this conversation
            try { removeLastMsgTime(videoId); removeStartTime(videoId); } catch (_) {}
            
            // Reload conversation history to update the sidebar
            console.log('🔄 Reloading conversation history after deletion');
            // Add a small delay to ensure backend has processed the deletion
            setTimeout(async () => {
                await loadConversationHistory();
            }, 500);
            
        } else {
            const errorData = await response.json().catch(() => ({}));
            console.error('❌ Delete failed with status:', response.status, 'Error:', errorData);
            throw new Error(`Failed to delete conversation: ${response.status} - ${errorData.error || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('❌ Error deleting conversation:', error);
        alert(`Failed to delete conversation: ${error.message}. Please try again.`);
    }
}

async function clearAllConversations() {
    try {
        const API_URL = await getWorkingAPI();
        const response = await fetch(`${API_URL}/api/conversations/clear`, {
            method: 'DELETE',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
            console.log('🗑️ All conversations cleared successfully');
            // Clear current conversation UI as well
            await clearConversation();
            // Also purge any guest-cached conversations to avoid re-insertion
            try {
                localStorage.removeItem(GUEST_CONVERSATIONS_KEY);
                console.log('🧹 Purged guest conversations from localStorage after clear-all');
            } catch (_) {}
            // Prevent accidental re-transfer after a clear-all
            window.__DISABLE_GUEST_TRANSFER__ = true;
            // Clear all last message overrides
            try { clearAllLastMsgTimes(); clearAllStartTimes(); } catch (_) {}
            // After clearing all, if logged-in and low credits, surface the warning once
            try {
                const { shouldShow } = getCreditsWarningState();
                if (isLoggedIn && shouldShow) {
                    removeCreditsWarning();
                    setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 20);
                    try { window.__WARN_ON_LOAD_SHOWN__ = true; } catch {}
                }
            } catch (_) {}
            // Reload conversation history
            await loadConversationHistory();
        } else {
            throw new Error('Failed to clear conversations');
        }
    } catch (error) {
        console.error('❌ Error clearing conversations:', error);
        alert('Failed to clear conversations. Please try again.');
    }
}

function setupConversationHistoryEventListeners() {
    // Clear all conversations button
    const clearAllBtn = document.getElementById('clear-all-conversations');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', clearAllConversations);
    }
    
    // Clear current conversation button (now in chat header)
    const clearCurrentBtn = document.getElementById('clear-chat-btn');
    if (clearCurrentBtn) {
        clearCurrentBtn.addEventListener('click', clearConversation);
    }
}

async function spendCredits(amount = 3) {
    if (currentCredits < amount) {
        alert(`Not enough credits! You have ${currentCredits} credits, but need ${amount}.`);
        return false;
    }
    
    if (isLoggedIn) {
        // Spend credits for logged-in user via API
        try {
            const API_URL = await getWorkingAPI();
            const response = await fetch(`${API_URL}/api/user/spend-credits`, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ amount: amount })
            });
            
            if (response.ok) {
                const data = await response.json();
                currentCredits = data.remaining_credits;
                updateCreditsDisplay();
                console.log('[coins] Credits spent successfully:', amount, 'Remaining:', currentCredits);
                return true;
            } else {
                const errorData = await response.json();
                alert(`Error: ${errorData.error}`);
                return false;
            }
        } catch (error) {
            console.error('❌ Error spending credits:', error);
            alert('Failed to spend credits. Please try again.');
            return false;
        }
    } else {
        // Spend credits for guest user via localStorage
        updateGuestCredits(currentCredits - amount);
    console.log('[coins] Guest credits spent:', amount, 'Remaining:', currentCredits);
        return true;
    }
}

// Fetch and cache the cheapest price from pricing packs (for logged-in upsell)
async function ensureMinPricingUSD() {
    if (MIN_PRICING_USD !== null) return MIN_PRICING_USD;
    try {
        const API_URL = await getWorkingAPI();
        const res = await fetch(`${API_URL}/api/pricing`, { credentials: 'omit' });
        if (res.ok) {
            const data = await res.json();
            const packs = data && data.packs ? data.packs : [];
            let min = null;
            for (const p of packs) {
                const v = typeof p.price_usd === 'number' ? p.price_usd : (typeof p.price === 'number' ? p.price : null);
                if (v !== null) min = (min === null) ? v : Math.min(min, v);
            }
            if (min !== null) MIN_PRICING_USD = min;
        }
    } catch (_) {}
    if (MIN_PRICING_USD === null) MIN_PRICING_USD = 4.99; // safe fallback
    return MIN_PRICING_USD;
}

function emphasizeNavbarCTA({ login = false, pricing = false } = {}) {
    try {
        const loginBtn = document.getElementById('login-btn');
        const pricingLink = document.querySelector('.pricing-link');
        if (loginBtn) loginBtn.classList.toggle('cta-animated', !!login);
        if (pricingLink) pricingLink.classList.toggle('cta-animated', !!pricing);
    } catch (_) {}
}

function addInlineCTAButton(messageTextEl, { type }) {
    // type: 'login' | 'pricing'
    try {
        const row = document.createElement('div');
        row.className = 'message-cta-row';
    const btn = document.createElement('button');
    // Match navbar styles: login uses .login-button, pricing uses .pricing-link
    btn.className = `${type === 'login' ? 'login-button' : 'pricing-link'} cta-animated`;
        btn.type = 'button';
        if (type === 'login') {
            // Prepend same icon as navbar Login button
            btn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
                    <polyline points="10,17 15,12 10,7"/>
                    <line x1="15" y1="12" x2="3" y2="12"/>
                </svg>
                <span>Login</span>
            `;
        } else {
            btn.textContent = 'See Pricing';
        }
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            if (type === 'login') {
                try { await handleLogin(); } catch (_) {}
            } else {
                // route to pricing with return
                try {
                    const currentUrl = window.location.href; // includes params
                    // Save exact return target for pricing to pick up
                    try { sessionStorage.setItem('returnTo', currentUrl); } catch {}
                    // Navigate to pricing in the same folder as current page
                    const url = new URL('pricing.html', window.location.href);
                    window.location.href = url.toString();
                } catch {
                    window.location.href = 'pricing.html';
                }
            }
        });
        row.appendChild(btn);
        // Place CTA inside the chat bubble box itself
        messageTextEl.appendChild(row);
    } catch (_) {}
}

// Remove any existing low-credits warning message bubble from chat
function removeCreditsWarning() {
    try {
        const chatMessages = document.getElementById('chat-messages');
        if (!chatMessages) return false;
        const warnings = chatMessages.querySelectorAll('.ai-message .message-text.coins-warning');
        let removed = false;
        warnings.forEach(el => {
            const aiMessage = el.closest('.ai-message');
            if (aiMessage && aiMessage.parentElement) {
                aiMessage.parentElement.removeChild(aiMessage);
                removed = true;
            }
        });
        return removed;
    } catch (_) { return false; }
}

async function maybeShowCreditsNoticeAfterResponse() {
    try {
    // If an AI response is currently in progress, defer any warning insert/normalize
    try {
        const typing = document.getElementById('ai-typing-indicator');
        if (typeof isSending === 'boolean' && isSending || typing) {
            console.log('⏳ Deferring low-credits warning while AI is responding');
            return;
        }
    } catch (_) {}
    // Diagnostics
    const n = Number(currentCredits);
    const dbg = { loggedIn: !!isLoggedIn, credits: n, convLen: Array.isArray(conversationHistory) ? conversationHistory.length : null, onLoadShown: !!window.__WARN_ON_LOAD_SHOWN__, adding: !!window.__WARN_ADDING__ };
    console.log('🔎 maybeShowCreditsNoticeAfterResponse called:', dbg);
    // Only show if guard is not set OR we need to normalize an existing warning
        const warnings = document.querySelectorAll('.ai-message .message-text.coins-warning');
        const hasOne = warnings.length === 1;
        const hasMany = warnings.length > 1;

        // Determine state - show when 3 or fewer
    const { shouldShow, isZero } = getCreditsWarningState();
    const low = !isZero && shouldShow;
    const zero = isZero;
    if (!low && !zero) {
            // Remove any stale warning if credits are now safe
            window.__WARN_ON_LOAD_SHOWN__ = false;
            if (warnings.length) {
                console.log('🧹 Removing stale low-credits warning (credits are safe)');
                removeCreditsWarning();
            }
            return;
        }

        // If multiple warnings slipped in somehow, prune then proceed to add one
        if (hasMany) {
            console.warn('🧹 Found multiple low-credits warnings. Pruning to one...');
            removeCreditsWarning();
        }
        // If exactly one exists already, just normalize placement and exit
        if (hasOne) {
            try {
                const chatMessages = document.getElementById('chat-messages');
                const allAI = chatMessages ? chatMessages.querySelectorAll('.ai-message') : null;
                const warningAI = warnings[0].closest('.ai-message');
                if (chatMessages && allAI && allAI.length && warningAI) {
                    const lastAI = allAI[allAI.length - 1];
                    if (lastAI && lastAI !== warningAI) {
                        lastAI.insertAdjacentElement('afterend', warningAI);
                        console.log('🔧 Normalized existing warning position to after the last AI message');
                    }
                }
                // Also refresh the displayed credits count/plural if present
                try {
                    if (low) {
                        const span = warnings[0].querySelector('.text-red');
                        if (span) {
                            const nn = Number(currentCredits);
                            span.textContent = `you have ${nn} ${coinsLabel(nn)}`;
                            console.log('🔁 Refreshed warning credits text to latest value');
                        }
                    } else if (zero) {
                        // Switch to zero-credits template and re-add CTA
                        const msgEl = warnings[0];
                        msgEl.innerHTML = `You're out of coins <img src="icons/COIN.png" class="coin-icon" alt="coin">.`;
                        if (!isLoggedIn) {
                            msgEl.innerHTML += ` <span class="text-green">Login to get ${FREE_LOGIN_COINS} <img src=\"icons/COIN.png\" class=\"coin-icon\" alt=\"coin\"> free</span> and keep chatting.`;
                            addInlineCTAButton(msgEl, { type: 'login' });
                        } else {
                            const minPrice = await ensureMinPricingUSD();
                            const formatted = `$${Number(minPrice).toFixed(2)}`;
                            msgEl.innerHTML += ` You can buy more for as low as <span class="text-green">${formatted}</span>.`;
                            addInlineCTAButton(msgEl, { type: 'pricing' });
                        }
                        console.log('🔁 Refreshed warning to zero-credits template');
                    }
                } catch (_) {}
                // Always scroll to bottom when a warning is present
                try {
                    if (chatMessages) {
                        chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
                        console.log('📜 Scrolled to bottom after normalizing existing warning');
                    }
                } catch (_) {}
            } catch (_) {}
            window.__WARN_ON_LOAD_SHOWN__ = true;
            return;
        }

        // Concurrency guard: if an addition is already in progress and there's no existing warning yet, bail early
        if (window.__WARN_ADDING__ && warnings.length === 0) {
            console.log('⏳ Skipping add: another warning addition is in progress');
            return;
        }
        window.__WARN_ADDING__ = true;

        if (!isLoggedIn) {
            // Build message with colored highlights
            const coinsHtml = zero
                ? `You're out of coins <img src="icons/COIN.png" class="coin-icon" alt="coin">.`
                : `You're running low on coins <img src="icons/COIN.png" class="coin-icon" alt="coin"> (<span class="text-red">you have ${Number(currentCredits)} ${coinsLabel(Number(currentCredits))}</span>).`;
            const bonusHtml = ` <span class="text-green">Login to get ${FREE_LOGIN_COINS} <img src=\"icons/COIN.png\" class=\"coin-icon\" alt=\"coin\"> free</span> and keep chatting.`;
            const messageTextEl = addMessageToChat('', 'ai');
            if (messageTextEl) {
                messageTextEl.classList.add('coins-warning');
                messageTextEl.innerHTML = `${coinsHtml}${bonusHtml}`;
                addInlineCTAButton(messageTextEl, { type: 'login' });
                // Place warning right after the last AI message
                try {
                    const chatMessages = document.getElementById('chat-messages');
                    const allAI = chatMessages ? chatMessages.querySelectorAll('.ai-message') : null;
                    const warningAI = messageTextEl.closest('.ai-message');
                    if (chatMessages && allAI && allAI.length && warningAI) {
                        const lastAI = allAI[allAI.length - 1];
                        if (lastAI && lastAI !== warningAI) {
                            lastAI.insertAdjacentElement('afterend', warningAI);
                        }
                    }
                } catch (_) {}
            }
            emphasizeNavbarCTA({ login: true, pricing: false });
            console.log('✅ Added low-credits warning for GUEST');
        } else {
            const minPrice = await ensureMinPricingUSD();
            const formatted = `$${Number(minPrice).toFixed(2)}`;
            const coinsHtml = zero
                ? `You're out of coins <img src="icons/COIN.png" class="coin-icon" alt="coin">.`
                : `You're running low on coins <img src="icons/COIN.png" class="coin-icon" alt="coin"> (<span class="text-red">you have ${Number(currentCredits)} ${coinsLabel(Number(currentCredits))}</span>).`;
            const priceHtml = ` You can buy more for as low as <span class="text-green">${formatted}</span>.`;
            const messageTextEl = addMessageToChat('', 'ai');
            if (messageTextEl) {
                messageTextEl.classList.add('coins-warning');
                messageTextEl.innerHTML = `${coinsHtml}${priceHtml}`;
                addInlineCTAButton(messageTextEl, { type: 'pricing' });
                // Place warning right after the last AI message
                try {
                    const chatMessages = document.getElementById('chat-messages');
                    const allAI = chatMessages ? chatMessages.querySelectorAll('.ai-message') : null;
                    const warningAI = messageTextEl.closest('.ai-message');
                    if (chatMessages && allAI && allAI.length && warningAI) {
                        const lastAI = allAI[allAI.length - 1];
                        if (lastAI && lastAI !== warningAI) {
                            lastAI.insertAdjacentElement('afterend', warningAI);
                        }
                    }
                } catch (_) {}
            }
            emphasizeNavbarCTA({ login: false, pricing: true });
            console.log('✅ Added low-credits warning for LOGGED-IN user');
        }
        // Always scroll to bottom after warning
        try {
            const chatMessages = document.getElementById('chat-messages');
            if (chatMessages) {
                chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
            }
        } catch (_) {}
    // Set guard so no further warnings are added until reset
    window.__WARN_ADDING__ = false;
    window.__WARN_ON_LOAD_SHOWN__ = true;
    } catch (e) {
        console.warn('credits notice failed', e);
    window.__WARN_ADDING__ = false;
    }
}

// Function to test which API endpoint works
async function getWorkingAPI() {
    // Try production API first
    try {
        const response = await fetch(`${API_BASE_URL}/`, { 
            method: 'GET',
            mode: 'cors'
        });
        if (response.ok) {
            console.log('✅ Production API accessible');
            return API_BASE_URL;
        }
    } catch (error) {
        console.log('❌ Production API not accessible:', error);
    }
    
    // Try local API
    try {
        const response = await fetch(`${LOCAL_API_URL}/`, { 
            method: 'GET',
            mode: 'cors'
        });
        if (response.ok) {
            console.log('✅ Local API accessible');
            return LOCAL_API_URL;
        }
    } catch (error) {
        console.log('❌ Local API not accessible:', error);
    }
    
    // If both fail, return production (will show error)
    console.log('⚠️ No API endpoints accessible, using production');
    return API_BASE_URL;
}

// Authentication functions
async function checkAuthStatus() {
    try {
        const API_URL = await getWorkingAPI();
        
        // Create controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
        
        const response = await fetch(`${API_URL}/auth/user`, {
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        const data = await response.json();
        
        if (data.error || data.expired) {
            // User not logged in or session expired
            isLoggedIn = false;
            currentUser = null;
            updateAuthUI();
            // Initialize guest credits for non-logged-in users
            initializeGuestCredits();
            try { if (window.Ratings && typeof Ratings.refresh === 'function') Ratings.refresh(); } catch {}
        } else {
            // User is logged in
            console.log('✅ User is logged in:', data.email);
            isLoggedIn = true;
            currentUser = data;
            
            // Reset logout flag when user logs in
            isAfterLogout = false;
            
            updateAuthUI();
            // Fetch credits for logged-in user (non-blocking)
            fetchUserCredits().catch(err => console.warn('Credits fetch failed:', err));
            try { if (window.Ratings && typeof Ratings.refresh === 'function') Ratings.refresh(); } catch {}
            
            // Important: First load conversation from account, then transfer guest data
            // Force reload conversation from database (in case user was guest before)
            isConversationLoaded = false;
            // Clean up any existing low-credits warnings from guest session
            removeCreditsWarning();
            window.__WARN_ON_LOAD_SHOWN__ = false;
            await loadConversationWhenReady();

            // After loading, if no messages and low credits, show warning once
            try {
                const { shouldShow } = getCreditsWarningState();
                const isEmptyConversation = Array.isArray(conversationHistory) && conversationHistory.length === 0;
                const warningExists = !!document.querySelector('.ai-message .message-text.coins-warning');
                if (shouldShow && isEmptyConversation && !warningExists) {
                    removeCreditsWarning();
                    console.log('🟡 Auth-load pass: scheduling warning for empty conversation');
                    setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 20);
                    try { window.__WARN_ON_LOAD_SHOWN__ = true; } catch {}
                }
            } catch (_) {}
            
            // Transfer guest conversations (but don't override existing account conversations)
            transferGuestConversations().catch(err => console.warn('Guest conversation transfer failed:', err));
        }
        
        // Update chat availability after auth status is determined
        updateChatAvailability();
        
        // Try to load conversation now that auth status is determined
        await loadConversationWhenReady();
        // And re-check once more afterward for the same empty chat case
        try {
            const { shouldShow } = getCreditsWarningState();
            const isEmptyConversation = Array.isArray(conversationHistory) && conversationHistory.length === 0;
            const warningExists = !!document.querySelector('.ai-message .message-text.coins-warning');
            if (isLoggedIn && shouldShow && isEmptyConversation && !warningExists) {
                removeCreditsWarning();
                console.log('🟡 Auth re-check pass: scheduling warning for empty conversation');
                setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 20);
                try { window.__WARN_ON_LOAD_SHOWN__ = true; } catch {}
            }
        } catch (_) {}
        
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('❌ Auth check timed out');
        } else {
            console.error('❌ Error checking auth status:', error);
        }
        isLoggedIn = false;
        currentUser = null;
        updateAuthUI();
        // Initialize guest credits for error case
        initializeGuestCredits();
        updateChatAvailability();
    try { if (window.Ratings && typeof Ratings.refresh === 'function') Ratings.refresh(); } catch {}
    }
}

function updateAuthUI() {
    const loginBtn = document.getElementById('login-btn');
    const profileSection = document.getElementById('profile-section');
    const profilePicture = document.getElementById('profile-picture');
    const profileName = document.getElementById('profile-name');
    const profileEmail = document.getElementById('profile-email');
    const pricingLinks = document.querySelectorAll('.pricing-link');
    
    // Check if we're currently in loading state
    const loadingContainer = document.getElementById('loading-container');
    const isLoading = loadingContainer && loadingContainer.style.display !== 'none';
    
    if (isLoading) {
        // Hide both during loading
        if (loginBtn) {
            loginBtn.style.display = 'none';
        }
        if (profileSection) {
            profileSection.style.display = 'none';
        }
        // Hide pricing during loading (same behavior as login/profile)
        try {
            pricingLinks.forEach((el) => { if (el) el.style.display = 'none'; });
        } catch (_) {}
        return;
    }
    
    if (isLoggedIn && currentUser) {
        // Show profile, hide login
        if (loginBtn) {
            loginBtn.style.display = 'none';
        }
        if (profileSection) {
            profileSection.style.display = 'block';
        }
    // Ensure pricing is visible after loading completes
    try { pricingLinks.forEach((el) => { if (el) el.style.display = ''; }); } catch (_) {}
        
        // Update profile info
        if (profilePicture) {
            profilePicture.src = currentUser.picture || '';
            profilePicture.alt = currentUser.name || 'Profile';
        }
        if (profileName) {
            profileName.textContent = currentUser.name || 'User';
        }
        if (profileEmail) {
            profileEmail.textContent = currentUser.email || '';
        }
        
        console.log('✅ Profile UI updated for:', currentUser.name);
        
        // Load conversation history for logged in user (but not immediately after deletion)
        const lastDeletion = window.lastConversationDeletion || 0;
        const timeSinceLastDeletion = Date.now() - lastDeletion;
        
        if (timeSinceLastDeletion > 2000) { // Only load if more than 2 seconds since last deletion
            loadConversationHistory();
        } else {
            console.log('🔄 Skipping history reload - recent deletion detected');
        }
    } else {
        // Show login, hide profile
        if (loginBtn) {
            loginBtn.style.display = 'flex';
        }
        if (profileSection) {
            profileSection.style.display = 'none';
        }
    // Ensure pricing is visible after loading completes
    try { pricingLinks.forEach((el) => { if (el) el.style.display = ''; }); } catch (_) {}
        
        // Clear profile info
        if (profilePicture) {
            profilePicture.src = '';
            profilePicture.alt = '';
        }
        if (profileName) {
            profileName.textContent = '';
        }
        if (profileEmail) {
            profileEmail.textContent = '';
        }
    }
}

async function handleLogin() {
    try {
        const API_URL = await getWorkingAPI();
        console.log(`🔐 Attempting login with API: ${API_URL}`);
        
        // Mark that we're starting a login flow
        localStorage.setItem('oauth_flow_started', Date.now().toString());
        
        // Get current page URL to return after login
        const currentUrl = window.location.href;
        console.log(`📍 Current page URL: ${currentUrl}`);
        
        // Encode the return URL and add it to login request
        const loginUrl = `${API_URL}/auth/login?return_url=${encodeURIComponent(currentUrl)}`;
        console.log(`🔗 Login URL with return: ${loginUrl}`);
        
        window.location.href = loginUrl;
    } catch (error) {
        console.error('Error during login:', error);
        alert('Login failed. Please try again.');
    }
}

async function handleLogout() {
    try {
        console.log('🚪 Starting logout process...');
        
        // Set flag to prevent conversation reloading
        isAfterLogout = true;
        
        const API_URL = await getWorkingAPI();
        
        // Clear any OAuth flow markers
        localStorage.removeItem('oauth_flow_started');
        
        // Call logout endpoint
        const response = await fetch(`${API_URL}/auth/logout`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        // Update local state regardless of response
        isLoggedIn = false;
        currentUser = null;
        console.log('🔄 Updated login state to false');
        
        // Initialize guest credits before updating UI
    console.log('[coins] Initializing guest credits after logout...');
        initializeGuestCredits();
        
    // Reset conversation state completely for guest mode
        console.log('💬 Resetting conversation after logout...');
    conversationHistory = [];
        isConversationLoaded = false;
        isRestoringMessages = false;
    // Clear AI continuation context to prevent leakage across sessions
    try { currentResponseId = null; } catch (_) {}
    window.__WARN_ON_LOAD_SHOWN__ = false;
        
        // Hide typing indicator if it's showing
        hideTypingIndicator();
        
        // Re-enable chat input if it was disabled
        const chatInput = document.getElementById('chat-input');
        const sendButton = document.getElementById('send-button');
        if (chatInput) chatInput.disabled = false;
        if (sendButton) sendButton.disabled = false;
        
        // Clear chat messages UI immediately
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
            // Re-add welcome message for clean start
            const welcomeDiv = document.createElement('div');
            welcomeDiv.className = 'ai-message';
            welcomeDiv.innerHTML = `
                <div class="ai-avatar">🤖</div>
                <div class="message-content">
                    <div class="message-text">Hi! I'm your AI assistant. I have access to the transcript of this video and can help answer questions about its content. What would you like to know?</div>
                </div>
            `;
            chatMessages.appendChild(welcomeDiv);
            // If guest credits are low, append warning
            try {
                const { shouldShow } = getCreditsWarningState();
                if (shouldShow) {
                    console.log('🟡 Guest low-credits seed: scheduling warning');
                    setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 30);
                }
            } catch (_) {}
        }
        
        // Update UI immediately
        console.log('🔄 Updating UI after logout...');
        updateAuthUI();
        hideProfileDropdown();
        
        // Don't load any conversation - keep it clean after logout
        console.log('✅ Logout cleanup completed - conversation reset to welcome message only');
        
        // Reset the logout flag after 30 seconds to allow normal operation
        setTimeout(() => {
            isAfterLogout = false;
            console.log('🔄 Logout protection removed - normal conversation loading resumed');
        }, 30000);
        
        // Check if logout was successful
        if (response.ok) {
            console.log('✅ Logged out successfully from server');
        } else {
            console.warn('⚠️ Server logout may have failed, but local state cleared');
        }
        
    } catch (error) {
        console.error('Error during logout:', error);
        
        // Set flag to prevent conversation reloading even on error
        isAfterLogout = true;
        
        // Even if there's an error, clear local state and update UI
        isLoggedIn = false;
        currentUser = null;
        console.log('🔄 Updated login state to false (error case)');
        
        // Initialize guest credits before updating UI
    console.log('[coins] Initializing guest credits after logout error...');
        
    // Reset conversation state completely for guest mode
        conversationHistory = [];
        isConversationLoaded = false;
        isRestoringMessages = false;
    // Also clear any AI continuation context just in case
    try { currentResponseId = null; } catch (_) {}
        
        // Clear chat messages UI immediately
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
            // Re-add welcome message for clean start
            const welcomeDiv = document.createElement('div');
            welcomeDiv.className = 'ai-message';
            welcomeDiv.innerHTML = `
                <div class="ai-avatar">🤖</div>
                <div class="message-content">
                    <div class="message-text">Hi! I'm your AI assistant. I have access to the transcript of this video and can help answer questions about its content. What would you like to know?</div>
                </div>
            `;
            chatMessages.appendChild(welcomeDiv);
            // If guest credits are low, append warning
            try {
                const { shouldShow } = getCreditsWarningState();
                if (shouldShow) {
                    console.log('🟡 Guest low-credits seed (alt path): scheduling warning');
                    setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 30);
                }
            } catch (_) {}
        }
        
        initializeGuestCredits();
        
        // Reset conversation state and load guest conversation
        console.log('� Resetting conversation after logout error...');
        isConversationLoaded = false;
    window.__WARN_ON_LOAD_SHOWN__ = false;
        
        console.log('�🔄 Updating UI after logout error...');
        updateAuthUI();
        hideProfileDropdown();
        
        // Don't load any conversation - keep it clean after logout error
        console.log('✅ Logout error cleanup completed - conversation reset to welcome message only');
        
        // Reset the logout flag after 30 seconds to allow normal operation
        setTimeout(() => {
            isAfterLogout = false;
            console.log('🔄 Logout protection removed after error - normal conversation loading resumed');
        }, 30000);
    }
}

function showProfileDropdown() {
    const dropdown = document.getElementById('profile-dropdown');
    dropdown.classList.add('show');
    
    // Load conversation history when dropdown is shown
    if (isLoggedIn) {
    // Force refresh so timestamps are recalculated from 'now'
    loadConversationHistory();
    }
}

function hideProfileDropdown() {
    const dropdown = document.getElementById('profile-dropdown');
    if (dropdown) {
        dropdown.classList.remove('show');
        console.log('🔽 Profile dropdown hidden');
    }
}

function toggleProfileDropdown() {
    const dropdown = document.getElementById('profile-dropdown');
    if (dropdown.classList.contains('show')) {
        hideProfileDropdown();
    } else {
        showProfileDropdown();
    }
}

document.addEventListener('DOMContentLoaded', async function() {
    // Load blocked videos list first
    loadBlockedVideos();
    
    // Block the problematic video that keeps recreating
    blockVideoFromSaving('LV2hPfwP0MI');
    
    const loadingContainer = document.getElementById('loading-container');
    const errorContainer = document.getElementById('error-container');
    const transcriptLayout = document.getElementById('transcript-layout');
    const errorText = document.getElementById('error-text');
    const transcriptContent = document.getElementById('transcript-content');
    // Removed languageElement, segmentCountElement, transcriptStatusElement as they no longer exist
    const videoTitleElement = document.getElementById('video-title');
    const videoDurationElement = document.getElementById('video-duration');
    const videoViewsElement = document.getElementById('video-views');
    const videoLikesElement = document.getElementById('video-likes');
    const videoPublishedElement = document.getElementById('video-published');
    const videoDescriptionElement = document.getElementById('video-description');
    const youtubePlayer = document.getElementById('youtube-player');
    const togglePlayerBtn = document.getElementById('toggle-player-btn');
    const playerColumn = document.getElementById('player-column');
    const toggleDescriptionBtn = document.getElementById('toggle-description-btn');

    // Authentication setup
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const profileContainer = document.querySelector('.profile-container');
    const profilePicture = document.getElementById('profile-picture');
    const profileDropdown = document.getElementById('profile-dropdown');
    
    // Add event listeners for authentication
    if (loginBtn) {
        loginBtn.addEventListener('click', handleLogin);
    }
    
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }
    
    // Toggle only when clicking avatar, not when clicking inside the dropdown content
    if (profilePicture) { profilePicture.addEventListener('click', function(e){ e.stopPropagation(); toggleProfileDropdown(); }); }
    if (profileDropdown) { profileDropdown.addEventListener('click', function(e){ e.stopPropagation(); }); }
    
    // Setup conversation history event listeners
    setupConversationHistoryEventListeners();
    
    // Close dropdown when clicking outside (not inside dropdown)
    document.addEventListener('click', function(event) {
        const profileSection = document.getElementById('profile-section');
        const dropdown = document.getElementById('profile-dropdown');
        if (profileSection && dropdown && !profileSection.contains(event.target)) {
            hideProfileDropdown();
        }
    });
    
    // Initialize credits and AI models
    initializeGuestCredits();
    await fetchAIModels();
    
    // Initialize conversation system
    initializeConversationSystem();

    // Initial low-credits pass: once at startup to seed a single warning at the end of current AI messages
    try {
        setTimeout(() => {
            try {
                const { shouldShow } = getCreditsWarningState();
                if (shouldShow) {
                    console.log('🟡 Startup seed: scheduling maybeShowCreditsNoticeAfterResponse');
                    maybeShowCreditsNoticeAfterResponse();
                }
            } catch(_) {}
        }, 0);
    } catch(_) {}

    // Bottom Get Transcript CTA wiring (identical behavior to index input/button)
    try {
        const bottomInput = document.getElementById('bottom-youtube-url');
        const bottomBtn = document.getElementById('bottom-get-transcript-btn');
        const bottomErr = document.getElementById('bottom-error-message');
        const bottomErrText = document.getElementById('bottom-error-text');
        const bottomErrClose = document.getElementById('bottom-error-close-btn');

        function validateYouTubeUrl(url) {
            if (!url || url.trim() === '') return { isValid: false, message: 'Please enter a YouTube URL' };
            const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|\?v=)([^#\&\?]*).*/;
            const match = url.match(regExp);
            if (match && match[2].length === 11) { return { isValid: true, videoId: match[2] }; }
            return { isValid: false, message: 'Please enter a valid YouTube URL' };
        }
        function showBottomError(message) { if (bottomErr && bottomErrText) { bottomErrText.textContent = message; bottomErr.style.display = 'flex'; } }
        function hideBottomError() { if (bottomErr) bottomErr.style.display = 'none'; }
        function handleBottomGetTranscript() {
            const url = bottomInput ? bottomInput.value : '';
            const validation = validateYouTubeUrl(url);
            if (!validation.isValid) { showBottomError(validation.message); return; }
            hideBottomError();
            const selectedLanguage = 'en';
            const transcriptUrl = `transcript.html?url=${encodeURIComponent(url)}&lang=${selectedLanguage}&video_id=${validation.videoId}`;
            window.location.href = transcriptUrl;
        }
        if (bottomBtn) bottomBtn.addEventListener('click', function(e){ e.preventDefault(); handleBottomGetTranscript(); });
        if (bottomInput) bottomInput.addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); handleBottomGetTranscript(); } });
        if (bottomInput) bottomInput.addEventListener('input', function(){ if (bottomErr && bottomErr.style.display === 'flex') hideBottomError(); });
        if (bottomErrClose) bottomErrClose.addEventListener('click', hideBottomError);
    } catch (e) { console.warn('bottom CTA wiring failed', e); }

    // Remember current page before going to Pricing from any Pricing button/link
    try {
        const pricingLinks = document.querySelectorAll('.pricing-link');
        pricingLinks.forEach(link => {
            link.addEventListener('click', function() {
                try { sessionStorage.setItem('returnTo', window.location.href); } catch {}
            });
        });
        // Also delegate to catch dynamically added elements (e.g., inline CTA)
        document.addEventListener('click', function(e){
            try {
                const t = e.target;
                const el = t && t.closest ? t.closest('.pricing-link') : null;
                if (el) { sessionStorage.setItem('returnTo', window.location.href); }
            } catch {}
        });
    } catch {}
    
    // Check authentication status on page load
    // Detect if this is an OAuth return by checking for specific OAuth behavior
    const currentUrlParams = new URLSearchParams(window.location.search);
    const hasOAuthParams = currentUrlParams.has('code') || currentUrlParams.has('state') || currentUrlParams.has('error');
    const hasRecentNavigation = window.performance && window.performance.navigation && window.performance.navigation.type === 1; // PAGE_LOAD_REDIRECT
    
    // Check if we recently started an OAuth flow
    const oauthFlowStarted = localStorage.getItem('oauth_flow_started');
    const recentOAuthFlow = oauthFlowStarted && (Date.now() - parseInt(oauthFlowStarted)) < 300000; // 5 minutes
    
    // Detect OAuth return by checking if we just got redirected AND don't have transcript params
    const hasTranscriptParams = currentUrlParams.has('id') || currentUrlParams.has('url');
    const isLikelyOAuthReturn = (hasOAuthParams || recentOAuthFlow || (hasRecentNavigation && !hasTranscriptParams)) || 
                               (document.referrer && document.referrer.includes('accounts.google.com'));
    
    if (isLikelyOAuthReturn) {
        console.log('🔄 Detected OAuth return, waiting for session to establish...');
        // Clear the OAuth flow marker
        localStorage.removeItem('oauth_flow_started');
        
        // Much faster delays for better UX
        setTimeout(() => {
            console.log('🔄 Quick auth check after OAuth...');
            checkAuthStatus();
        }, 200); // Reduced from 500ms to 200ms
        
        // Faster retry if first fails
        setTimeout(() => {
            if (!isLoggedIn) {
                console.log('🔄 Fast retry auth check...');
                checkAuthStatus();
            }
        }, 700); // Reduced from 1500ms to 700ms
        
        // Additional quick check after UI is ready
        setTimeout(() => {
            if (!isLoggedIn) {
                console.log('🔄 Final quick auth check...');
                checkAuthStatus();
            }
        }, 1200); // One more check at 1.2s
    } else {
        // Normal page load - check immediately
        setTimeout(() => {
            checkAuthStatus();
        }, 50); // Reduced from 100ms to 50ms
    }
    
    // Initialize credits system for guest users only (logged users will get credits from fetchUserCredits)
    initializeGuestCredits();

    // Normalize warning on bfcache restore (back/forward) to avoid duplicates
    window.addEventListener('pageshow', function() {
        try {
            const { shouldShow } = getCreditsWarningState();
            if (!shouldShow) {
                const removed = removeCreditsWarning();
                if (removed) console.log('🧹 pageshow: removed existing warning since credits are safe');
                return;
            }
            const removedAny = removeCreditsWarning();
            const exists = !!document.querySelector('.ai-message .message-text.coins-warning');
            const isEmptyConversation = Array.isArray(conversationHistory) && conversationHistory.length === 0;
            // If we removed duplicates, re-add a single normalized warning
            if (removedAny) {
                console.log('🧹 pageshow: pruned duplicates, re-adding one');
                setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 0);
            } else if (!exists) {
                // Only auto-add on pageshow when logged-in AND the conversation is empty
                if (isLoggedIn && isEmptyConversation) {
                    console.log('🟡 pageshow: scheduling warning for empty conversation');
                    setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 0);
                }
            }
        } catch (_) {}
    });
    
    const descriptionHeader = document.getElementById('description-header');

    // Initialize loading animation variable
    let loadingAnimation = null;
    let selectedFormat = 'txt'; // Default format
    let youtubePlayerInstance = null; // Store YouTube player instance globally
    let playerInitializationInProgress = false; // Flag to prevent duplicate initializations
    let languageCache = new Map(); // Cache for language data per video ID

    // Get parameters from URL
    const urlParams = new URLSearchParams(window.location.search);
    const transcriptId = urlParams.get('id');
    const videoUrl = urlParams.get('url');
    const language = urlParams.get('lang');
    const videoId = urlParams.get('video_id');
    const conversationVideoId = urlParams.get('video_id'); // For conversation loading

    // Check if we have transcript ID or need to generate transcript
    if (transcriptId) {
        // Load existing transcript by transcript ID
        loadTranscript(transcriptId);
    } else if (conversationVideoId && !videoUrl) {
        // Loading from conversation history - try to find transcript by video ID
        console.log('🔄 Loading from conversation history for video:', conversationVideoId);
        
        // Set current video context
        currentVideoId = conversationVideoId;
        
        // Try to load transcript by video ID
        loadTranscriptByVideoId(conversationVideoId);
    } else if (videoUrl && language && videoId) {
        // Pre-load languages immediately for instant dropdown! 🚀
        console.log('🚀 Pre-loading languages for instant dropdown...');
        preloadLanguagesOptimized(videoId, language);
        
        // Generate new transcript
        generateTranscript(videoUrl, language, videoId);
    } else {
        showError('Invalid transcript link. Please generate a new transcript.');
        return;
    }

    // Set initial state - description collapsed
    videoDescriptionElement.classList.add('collapsed');
    toggleDescriptionBtn.classList.add('rotated');

    // Player toggle functionality
    togglePlayerBtn.addEventListener('click', function() {
        playerColumn.classList.toggle('collapsed');
        transcriptLayout.classList.toggle('player-collapsed');
    });

    // Description toggle functionality
    function toggleDescription() {
        videoDescriptionElement.classList.toggle('collapsed');
        toggleDescriptionBtn.classList.toggle('rotated');
    }

    toggleDescriptionBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleDescription();
    });

    descriptionHeader.addEventListener('click', function() {
        toggleDescription();
    });

    // Initialize default format selection
    const txtOption = document.querySelector('.download-option[data-format="txt"]');
    if (txtOption) {
        txtOption.classList.add('selected');
    }

    // Handle purchase toast: detect flag and show premium notification
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('purchase') === '1') {
            // Refresh credits quickly
            setTimeout(() => { checkAuthStatus(); }, 150);
            showPurchaseToast();
            params.delete('purchase');
            const clean = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}${window.location.hash}`;
            window.history.replaceState({}, '', clean);
        }
    } catch (e) { console.warn('purchase toast failed', e); }

    // Transcript action buttons functionality
    const copyBtn = document.getElementById('copy-transcript-btn');
    const downloadBtn = document.getElementById('download-transcript-btn');
    const downloadDropdownBtn = document.getElementById('download-dropdown-btn');
    const downloadDropdownMenu = document.getElementById('download-dropdown-menu');
    const languageBtn = document.getElementById('language-btn');
    const languageDropdownBtn = document.getElementById('language-dropdown-btn');
    const languageDropdownMenu = document.getElementById('language-dropdown-menu');

    // Copy transcript functionality
    copyBtn.addEventListener('click', function() {
        copyTranscriptToClipboard();
    });

    // Download transcript functionality
    downloadBtn.addEventListener('click', function() {
        downloadTranscript(selectedFormat); // Use selected format
    });

    // Dropdown toggle
    downloadDropdownBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        downloadDropdownMenu.classList.toggle('show');
        
        // Set default selection if not already set
        if (!document.querySelector('.download-option.selected')) {
            const txtOption = document.querySelector('.download-option[data-format="txt"]');
            if (txtOption) {
                txtOption.classList.add('selected');
            }
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', function(e) {
        if (!downloadDropdownBtn.contains(e.target) && !downloadDropdownMenu.contains(e.target)) {
            downloadDropdownMenu.classList.remove('show');
        }
    });

    // Handle dropdown option selection
    downloadDropdownMenu.addEventListener('click', function(e) {
        const option = e.target.closest('.download-option');
        if (option) {
            const format = option.dataset.format;
            
            // Remove previous selection
            document.querySelectorAll('.download-option').forEach(opt => {
                opt.classList.remove('selected');
            });
            
            // Mark current option as selected
            option.classList.add('selected');
            selectedFormat = format;
            
            // Close dropdown
            downloadDropdownMenu.classList.remove('show');
            
            console.log('Format selected:', format);
        }
    });

    // Language dropdown functionality
    languageDropdownBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        languageDropdownMenu.classList.toggle('show');
        
        // Center scroll on current language when dropdown opens
        if (languageDropdownMenu.classList.contains('show')) {
            setTimeout(() => {
                const currentOption = languageDropdownMenu.querySelector('.language-option.current');
                if (currentOption) {
                    currentOption.scrollIntoView({ 
                        behavior: 'smooth', 
                        block: 'center' 
                    });
                }
            }, 50); // Small delay to ensure dropdown is visible
        }
    });

    // Close language dropdown when clicking outside
    document.addEventListener('click', function(e) {
        if (!languageDropdownBtn.contains(e.target) && !languageDropdownMenu.contains(e.target)) {
            languageDropdownMenu.classList.remove('show');
        }
    });

    // Handle language option selection
    languageDropdownMenu.addEventListener('click', function(e) {
        const option = e.target.closest('.language-option');
        if (option && !option.classList.contains('loading')) {
            const langCode = option.dataset.lang;
            const langName = option.querySelector('.language-name')?.textContent;
            
            // Close dropdown first
            languageDropdownMenu.classList.remove('show');
            
            if (langCode && currentVideoId) {
                // Check if this is already the current language
                if (option.classList.contains('current')) {
                    console.log('Language already selected:', langCode, langName);
                    return; // Don't reload if same language
                }
                
                console.log('Language selected:', langCode, langName);
                
                // Store current player state if possible
                let currentTime = 0;
                let isPlaying = false;
                
                if (isPlayerReady()) {
                    try {
                        const playerInstance = youtubePlayerInstance || window.youtubePlayerInstance;
                        if (playerInstance.getCurrentTime) {
                            currentTime = playerInstance.getCurrentTime();
                        }
                        if (playerInstance.getPlayerState) {
                            isPlaying = playerInstance.getPlayerState() === 1; // YT.PlayerState.PLAYING
                        }
                        console.log('📍 Stored player state:', { currentTime, isPlaying });
                    } catch (error) {
                        console.log('⚠️ Could not get player state:', error);
                    }
                }
                
                // Generate new transcript with selected language
                const videoUrl = `https://www.youtube.com/watch?v=${currentVideoId}`;
                generateTranscript(videoUrl, langCode, currentVideoId);
            }
        }
    });

    async function preloadLanguagesOptimized(videoId, currentLanguage) {
        console.log('🚀 Starting ultra-fast language preload for:', videoId);
        
        // 1. Instant fallback - show at least current language immediately
        showCurrentLanguageInstant(currentLanguage);
        
        // 2. Check cache first - instant if cached!
        const cacheKey = `languages_${videoId}`;
        const cached = localStorage.getItem(cacheKey);
        
        if (cached) {
            try {
                const cachedData = JSON.parse(cached);
                // Check if cache is not too old (1 hour)
                if (Date.now() - cachedData.timestamp < 3600000) {
                    console.log('⚡ Using cached languages - INSTANT!');
                    displayAvailableLanguages(cachedData.languages, currentLanguage);
                    return; // Done instantly!
                }
            } catch (e) {
                console.log('🗑️ Clearing invalid cache');
                localStorage.removeItem(cacheKey);
            }
        }
        
        // 3. Background load for cache update (don't wait!)
        loadAndCacheLanguages(videoId, currentLanguage);
    }

    function showCurrentLanguageInstant(currentLanguage) {
        const languageDropdownMenu = document.getElementById('language-dropdown-menu');
        const currentLanguageTextSpan = document.getElementById('current-language-text');
        
        // Show current language immediately with fallback
        if (currentLanguageTextSpan) {
            const displayName = getLanguageDisplayName(currentLanguage);
            currentLanguageTextSpan.textContent = displayName;
            console.log('⚡ Instantly showing current language:', displayName);
        }
        
        // Show loading with current language already visible
        if (languageDropdownMenu) {
            languageDropdownMenu.innerHTML = `
                <div class="language-option current" data-lang="${currentLanguage}">
                    <span class="language-name">${getLanguageDisplayName(currentLanguage)}</span>
                </div>
                <div class="language-option loading">
                    <span class="loading-spinner">⟳</span>
                    <span>Loading other languages...</span>
                </div>
            `;
        }
    }

    function getLanguageDisplayName(languageCode) {
        const commonLanguages = {
            'en': 'English',
            'es': 'Español',
            'fr': 'Français', 
            'de': 'Deutsch',
            'it': 'Italiano',
            'pt': 'Português',
            'ru': 'Русский',
            'ja': '日本語',
            'ko': '한국어',
            'zh': '中文',
            'ar': 'العربية',
            'hi': 'हिन्दी',
            'tr': 'Türkçe',
            'pl': 'Polski',
            'nl': 'Nederlands',
            'sv': 'Svenska',
            'da': 'Dansk',
            'no': 'Norsk',
            'fi': 'Suomi',
            'ro': 'Română'
        };
        
        return commonLanguages[languageCode] || languageCode.toUpperCase();
    }

    async function loadAndCacheLanguages(videoId, currentLanguage) {
        try {
            const workingAPI = await getWorkingAPI();
            console.log('🔄 Background loading languages for cache...');
            
            const response = await fetch(`${workingAPI}/api/video-languages/${videoId}`);
            if (!response.ok) throw new Error('Failed to load languages');
            
            const data = await response.json();
            if (data.success && data.languages) {
                // Cache the languages
                const cacheData = {
                    languages: data.languages,
                    timestamp: Date.now()
                };
                localStorage.setItem(`languages_${videoId}`, JSON.stringify(cacheData));
                
                // Update UI immediately
                displayAvailableLanguages(data.languages, currentLanguage);
                console.log('✅ Languages loaded and cached successfully');
            }
        } catch (error) {
            console.error('❌ Error loading languages:', error);
            showLanguageError();
        }
    }

    async function generateTranscript(url, language, videoId) {
        console.log('Generating transcript for:', { url, language, videoId });
        
        showLoading('Generating transcript...', 'This may take a few moments depending on video length');

        // Only setup new player if it's a different video or player doesn't exist
        if (currentVideoId !== videoId || !youtubePlayerInstance) {
            console.log('🎥 Setting up player for new/different video');
            setupYouTubePlayer(videoId);
        } else {
            console.log('🔄 Keeping existing player for same video');
        }
        
        // Store current video ID globally
        currentVideoId = videoId;
        
        try {
            // Detect working API endpoint
            const workingAPI = await getWorkingAPI();
            console.log('Using API:', workingAPI);
            
            // Load video info - languages already loading in background!
            loadVideoInfo(videoId, workingAPI);
            
            // Languages should already be loading from preload, skip redundant call!

            const requestData = {
                url: url,
                language: language
            };

            console.log('Making API request to:', `${workingAPI}/api/generate`);
            console.log('Request data:', requestData);

            // Add timeout and better error handling
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 120000); // 120 second timeout (was 30)

            const response = await fetch(`${workingAPI}/api/generate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestData),
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            console.log('API Response status:', response.status);
            console.log('API Response ok:', response.ok);
            
            // Try to get response text first to see what we're getting
            const text = await response.text();
            console.log('Raw response text:', text);
            
            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                console.error('Failed to parse JSON:', e);
                throw new Error('Invalid JSON response from server');
            }
            
            console.log('Parsed response data:', data);
            
            if (!response.ok) {
                console.log('API Error - Status:', response.status, 'Data:', data);
                throw new Error(data.error || `HTTP ${response.status}: Failed to generate transcript`);
            }
            
            if (data.success && data.transcript_id) {
                console.log('Success! Transcript ID:', data.transcript_id);
                // Update URL to include transcript ID
                const newUrl = `${window.location.pathname}?id=${data.transcript_id}&lang=${data.language_code}`;
                window.history.replaceState({}, '', newUrl);
                
                // Load the generated transcript
                loadTranscript(data.transcript_id, workingAPI);
            } else {
                console.error('Invalid API response structure:', data);
                throw new Error('Invalid response from server');
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                console.error('Request timed out');
                showError('Request timed out. Please try again.');
            } else {
                console.error('Error generating transcript:', error);
                showError(error.message);
            }
        }
    }

    function loadTranscript(id, apiUrl = API_BASE_URL) {
        showLoading('Loading transcript...', 'Please wait while we retrieve your transcript');

        fetch(`${apiUrl}/api/transcript/${id}`)
            .then(response => {
                if (!response.ok) {
                    if (response.status === 404) {
                        throw new Error('Transcript not found or expired');
                    } else if (response.status >= 500) {
                        throw new Error('Server error. Please try again later');
                    } else {
                        throw new Error('Failed to load transcript');
                    }
                }
                return response.json();
            })
            .then(data => {
                if (data.success && data.data) {
                    // Pre-load languages as soon as we have video ID for instant dropdown!
                    if (data.data.video_id) {
                        console.log('🚀 Pre-loading languages for existing transcript...');
                        preloadLanguagesOptimized(data.data.video_id, data.data.language_code);
                    }
                    displayTranscript(data.data);
                } else {
                    throw new Error('Invalid transcript data received');
                }
            })
            .catch(error => {
                console.error('Error loading transcript:', error);
                showError(error.message);
            });
    }

    function displayTranscript(data) {
        // If a transcript was queued earlier because displayTranscript wasn't defined yet,
        // consume and render it immediately instead of waiting for external polling.
        try {
            const pending = window.__PENDING_TRANSCRIPT__;
            if (pending && pending.video_id && pending.video_id === data.video_id) {
                try {
                    // Clear pending before rendering to avoid re-entrancy
                    try { delete window.__PENDING_TRANSCRIPT__; } catch (_) { window.__PENDING_TRANSCRIPT__ = null; }
                    data = pending; // Override data with pending normalized transcript
                    console.log('▶️ Consumed queued transcript and rendering now');
                } catch (e) {
                    console.warn('⚠️ Failed to consume pending transcript:', e);
                }
            }
        } catch (_) {}
        hideLoading();
        hideError();

        // No longer setting transcript info in header as we replaced it with action buttons
        console.log('Transcript info:', {
            language: `${data.language} (${data.language_code})`,
            segments: data.transcript.length,
            status: data.is_translated ? 'Translated' : 'Original'
        });

        // Set up YouTube player - make sure it's properly initialized
        const videoId = data.video_id;
        const previousVideoId = currentVideoId;
        
        // Reset conversation context if video changed
        if (previousVideoId && previousVideoId !== videoId) {
            console.log('🔄 Video changed in displayTranscript from', previousVideoId, 'to', videoId, '- resetting conversation');
            conversationHistory = [];
            isConversationLoaded = false;
            isRestoringMessages = false;
        }
        
        currentVideoId = videoId; // Update global video ID
        
        // Only setup new player if videoId changed or player doesn't exist
        if (previousVideoId !== videoId || !isPlayerReady()) {
            console.log('🎥 Need to setup/reinitialize player');
            setupYouTubePlayer(videoId);
        } else {
            console.log('🔄 Player already ready for same video, keeping existing instance');
            // Ensure the player instance is accessible
            if (!youtubePlayerInstance && window.youtubePlayerInstance) {
                youtubePlayerInstance = window.youtubePlayerInstance;
            }
        }

        // Load video information
        loadVideoInfo(videoId);

        // Languages should already be optimally loaded, just verify
        const languageDropdown = document.getElementById('language-dropdown-menu');
        if (languageDropdown && languageDropdown.innerHTML.includes('Loading languages')) {
            console.log('⚠️ Languages still loading, this should be rare now...');
            loadAvailableLanguages(videoId, data.language_code);
        } else {
            console.log('✅ Languages already loaded via optimization!');
        }
        
        // Update current language text in button
        updateCurrentLanguageText(data.language, data.language_code);

        // Store transcript data globally
        transcriptData = data.transcript;

        // Clear previous content
        transcriptContent.innerHTML = '';

        // Create transcript segments
        data.transcript.forEach((segment, index) => {
            const segmentElement = document.createElement('div');
            segmentElement.className = 'transcript-segment';
            segmentElement.dataset.startTime = segment.start;

            // Create segment header with timestamp and copy button
            const segmentHeader = document.createElement('div');
            segmentHeader.className = 'segment-header';

            const timeElement = document.createElement('div');
            timeElement.className = 'segment-time';
            timeElement.textContent = segment.formatted_time;
            
            // Add click handler for timestamp seeking
            timeElement.addEventListener('click', function(e) {
                e.stopPropagation(); // Prevent segment click
                console.log('🕐 Timestamp clicked:', segment.start, 'Player ready:', isPlayerReady());
                handleTimestampClick(segment.start);
            });

            // Create copy button
            const copyButton = document.createElement('button');
            copyButton.className = 'segment-copy-btn';
            copyButton.title = 'Copy this segment';
            copyButton.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
            `;

            // Add copy functionality
            copyButton.addEventListener('click', function(e) {
                e.stopPropagation(); // Prevent segment click
                const textToCopy = `[${segment.formatted_time}] ${segment.text}`;
                navigator.clipboard.writeText(textToCopy).then(() => {
                    // Brief visual feedback
                    copyButton.classList.add('copied');
                    setTimeout(() => {
                        copyButton.classList.remove('copied');
                    }, 1000);
                }).catch(err => {
                    console.error('Failed to copy segment: ', err);
                });
            });

            const textElement = document.createElement('div');
            textElement.className = 'segment-text';
            textElement.textContent = segment.text;

            // Assemble the segment
            segmentHeader.appendChild(timeElement);
            segmentHeader.appendChild(copyButton);
            segmentElement.appendChild(segmentHeader);
            segmentElement.appendChild(textElement);

            // Add click handler for segment click (only highlights, no seeking)
            segmentElement.addEventListener('click', function() {
                // Remove active class from all segments
                document.querySelectorAll('.transcript-segment').forEach(seg => {
                    seg.classList.remove('active');
                });
                
                // Add active class to clicked segment
                segmentElement.classList.add('active');
                
                // Only highlight - no seeking to timestamp
                console.log('📝 Segment highlighted:', segment.formatted_time);
            });

            transcriptContent.appendChild(segmentElement);
        });

        // Show the transcript layout
        transcriptLayout.style.display = 'flex';
        
        // Initialize chat after transcript is loaded
        setTimeout(async () => {
            initializeChat();
            
            // Load conversation after chat is initialized and models are available
            // Only load if not already loaded and models are available
            if (!isConversationLoaded && availableModels.length > 0) {
                console.log('🔄 Loading conversation from displayTranscript');
                await loadConversation();
            } else if (isConversationLoaded) {
                console.log('✅ Conversation already loaded, skipping reload in displayTranscript');
            }
        }, 500);
        
        // Add global click handler to remove segment highlighting when clicking outside
        document.addEventListener('click', function(e) {
            // Check if click is outside transcript segments
            if (!e.target.closest('.transcript-segment')) {
                // Remove active class from all segments
                document.querySelectorAll('.transcript-segment').forEach(seg => {
                    seg.classList.remove('active');
                });
            }
        });
        
        // Verify player is working after transcript is displayed
        setTimeout(() => {
            console.log('🔍 Post-transcript verification - Player ready:', isPlayerReady());
            if (!isPlayerReady() && currentVideoId) {
                console.log('⚠️ Player not ready after transcript load, attempting to fix...');
                setupYouTubePlayer(currentVideoId);
            }
        }, 1000);
    }

    function loadVideoInfo(videoId, apiUrl = API_BASE_URL) {
        // Load video information from backend
        fetch(`${apiUrl}/api/video-info/${videoId}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to load video info');
                }
                return response.json();
            })
            .then(data => {
                if (data.success && data.data) {
                    const videoInfo = data.data;
                    videoTitleElement.textContent = videoInfo.title || `Video: ${videoId}`;
                    currentVideoTitle = videoInfo.title || `Video: ${videoId}`; // Set for conversation system
                    videoDurationElement.textContent = videoInfo.duration || '--:--';
                    videoViewsElement.textContent = videoInfo.viewCount || '--';
                    videoLikesElement.textContent = videoInfo.likeCount || '--';
                    videoPublishedElement.textContent = videoInfo.publishedAt || '--';
                    videoDescriptionElement.textContent = videoInfo.description || 'No description available';
                } else {
                    // Fallback to placeholder content
                    setPlaceholderVideoInfo(videoId);
                }
            })
            .catch(error => {
                console.error('Error loading video info:', error);
                setPlaceholderVideoInfo(videoId);
            });
    }

    function setPlaceholderVideoInfo(videoId) {
        videoTitleElement.textContent = `Video: ${videoId}`;
        currentVideoTitle = `Video: ${videoId}`; // Set for conversation system
        videoDurationElement.textContent = "--:--";
        videoViewsElement.textContent = "--";
        videoLikesElement.textContent = "--";
        videoPublishedElement.textContent = "--";
        videoDescriptionElement.textContent = "Description not available";
    }

    function loadAvailableLanguages(videoId, currentLanguageCode, apiUrl = API_BASE_URL) {
        // Store current video ID globally for language switching
        currentVideoId = videoId;
        
        console.log(`Loading available languages for video: ${videoId}`);
        
        fetch(`${apiUrl}/api/video-languages/${videoId}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to load languages');
                }
                return response.json();
            })
            .then(data => {
                if (data.success && data.languages) {
                    displayAvailableLanguages(data.languages, currentLanguageCode);
                } else {
                    console.error('Invalid language data:', data);
                    showLanguageError();
                }
            })
            .catch(error => {
                console.error('Error loading available languages:', error);
                showLanguageError();
            });
    }

    function displayAvailableLanguages(languages, currentLanguageCode) {
        console.log('displayAvailableLanguages called with:', { languages, currentLanguageCode });
        
        const languageDropdownMenu = document.getElementById('language-dropdown-menu');
        
        // Clear loading message
        languageDropdownMenu.innerHTML = '';
        
        if (!languages || !Array.isArray(languages) || languages.length === 0) {
            languageDropdownMenu.innerHTML = '<div class="language-option loading"><span class="loading-spinner">⟳</span><span>No languages available</span></div>';
            return;
        }
        
        // Filter out translated languages - keep only direct/original languages
        const directLanguages = languages.filter(lang => lang.is_direct === true);
        console.log('Direct languages filtered:', directLanguages);
        
        if (directLanguages.length === 0) {
            languageDropdownMenu.innerHTML = '<div class="language-option loading"><span class="loading-spinner">⟳</span><span>No direct languages available</span></div>';
            return;
        }
        
        // Sort languages alphabetically by name for better UX
        directLanguages.sort((a, b) => a.name.localeCompare(b.name));
        console.log('Languages sorted alphabetically');
        
        // Create language options for direct languages only
        directLanguages.forEach(lang => {
            const option = document.createElement('div');
            option.className = 'language-option';
            option.dataset.lang = lang.code;
            
            // Mark current language
            if (lang.code === currentLanguageCode) {
                option.classList.add('current');
            }
            
            option.innerHTML = `
                <span class="language-name">${lang.name}</span>
            `;
            
            languageDropdownMenu.appendChild(option);
        });
        
        // Update language button text with current language
        updateCurrentLanguageText(directLanguages, currentLanguageCode);
        
        console.log(`Loaded ${directLanguages.length} direct languages for video`);
    }

    function showLanguageError() {
        const languageDropdownMenu = document.getElementById('language-dropdown-menu');
        languageDropdownMenu.innerHTML = '<div class="language-option loading"><span class="loading-spinner">⟳</span><span>Error loading languages</span></div>';
    }

    function updateCurrentLanguageText(languages, currentLanguageCode) {
        const currentLanguageTextSpan = document.getElementById('current-language-text');
        
        if (currentLanguageTextSpan && currentLanguageCode) {
            // Try to find in provided languages array first
            if (languages && Array.isArray(languages)) {
                const currentLang = languages.find(lang => lang.code === currentLanguageCode);
                if (currentLang) {
                    currentLanguageTextSpan.textContent = currentLang.name;
                    console.log(`Updated language button text to: ${currentLang.name}`);
                    return;
                }
            }
            
            // Fallback to our instant display name function
            const displayName = getLanguageDisplayName(currentLanguageCode);
            currentLanguageTextSpan.textContent = displayName;
            console.log(`Language text updated to: ${displayName} (using fallback)`);
        } else {
            // Default fallback
            if (currentLanguageTextSpan) {
                currentLanguageTextSpan.textContent = 'Language';
            }
        }
    }

    function setupYouTubePlayer(videoId) {
        if (youtubePlayer && videoId) {
            console.log('🎥 Setting up YouTube player for video ID:', videoId);
            
            // Detect production environment for optimal messaging
            const isProduction = window.location.hostname === 'youtubetranscriptgen.com' || 
                                window.location.hostname.includes('youtubetranscriptgen.com');
            
            if (isProduction) {
                console.log('🚀 PRODUCTION ENVIRONMENT DETECTED! Player should work perfectly on youtubetranscriptgen.com! 🎯');
            } else {
                console.log('⚠️ Development environment - some YouTube features may be limited');
            }
            
            // Prevent duplicate initializations
            if (playerInitializationInProgress) {
                console.log('⏳ Player initialization already in progress, skipping...');
                return;
            }
            
            playerInitializationInProgress = true;
            
            // Clear any existing player first to prevent conflicts
            if (youtubePlayerInstance) {
                console.log('🔄 Clearing existing player instance');
                try {
                    if (typeof youtubePlayerInstance.destroy === 'function') {
                        youtubePlayerInstance.destroy();
                    }
                } catch (error) {
                    console.log('⚠️ Could not destroy previous player:', error);
                }
                youtubePlayerInstance = null;
                window.youtubePlayerInstance = null;
            }
            
            // Try simple nocookie iframe FIRST (like working site)
            console.log('🔄 Starting with simple nocookie iframe approach...');
            createSimpleNocookiePlayer(videoId);
        }
    }

    function createSimpleNocookiePlayer(videoId) {
        console.log('🎬 Creating simple nocookie player (FIRST APPROACH) like working site');
        
        // Clear any existing content first
        youtubePlayer.innerHTML = '';
        
        // Detect if we're on production domain vs localhost
        const isProduction = window.location.hostname === 'youtubetranscriptgen.com' || 
                            window.location.hostname.includes('youtubetranscriptgen.com');
        const isLocalhost = window.location.hostname === 'localhost' || 
                           window.location.hostname === '127.0.0.1';
        
        console.log(`🌐 Environment detected: ${isProduction ? 'PRODUCTION' : isLocalhost ? 'LOCALHOST' : 'OTHER'}`);
        
        // Build iframe URL with optimal parameters for each environment
        let iframeUrl = `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1`;
        
        if (isProduction) {
            // Production domain - YouTube should work perfectly!
            iframeUrl += `&origin=${encodeURIComponent(window.location.origin)}`;
            console.log('✅ Using production domain - optimal compatibility!');
        } else if (isLocalhost) {
            // Localhost - skip origin parameter to avoid cross-origin issues
            console.log('⚠️ Localhost detected - using fallback parameters');
        } else {
            // Other domains - try with origin
            iframeUrl += `&origin=${encodeURIComponent(window.location.origin)}`;
        }
        
        // Create simple iframe exactly like working site
        youtubePlayer.innerHTML = `
            <iframe 
                height="315" 
                width="100%" 
                src="${iframeUrl}"
                title="YouTube Video Player" 
                frameborder="0"
                allow="clipboard-write; encrypted-media; picture-in-picture; web-share" 
                allowfullscreen
                style="width: 100%; height: 100%; border-radius: 8px;">
            </iframe>
        `;
        
        // Set up global onYouTubeIframeAPIReady exactly like working site
        window.onYouTubeIframeAPIReady = function() {
            try {
                console.log("🎬 Setting up YouTube player exactly like working site");
                var iframe = youtubePlayer.querySelector("iframe");
                if (iframe) {
                    var player = new YT.Player(iframe);
                    
                    // Create player instance for our transcript functionality
                    youtubePlayerInstance = {
                        seekTo: function(seconds) {
                            try {
                                console.log('📍 Seeking to:', seconds, 'via YT.Player (simple approach)');
                                player.seekTo(seconds);
                                player.playVideo();
                            } catch (error) {
                                console.error('❌ Error seeking:', error);
                                showNotification('Video seeking not available', 'error');
                            }
                        },
                        destroy: function() {
                            if (iframe && iframe.parentNode) {
                                iframe.parentNode.removeChild(iframe);
                            }
                        }
                    };
                    
                    window.youtubePlayerInstance = youtubePlayerInstance;
                    playerInitializationInProgress = false;
                    console.log('✅ Simple nocookie player setup complete like working site');
                } else {
                    console.log('❌ No iframe found for simple approach');
                    // If iframe not found, try fallback
                    createYouTubePlayer(videoId);
                }
            } catch (error) {
                console.error("❌ Error setting up simple YouTube player: ", error);
                // If simple approach fails, try YouTube API approach
                console.log('🔄 Simple approach failed, trying YouTube API approach...');
                createYouTubePlayer(videoId);
            }
        };
        
        // Load YouTube API if not already loaded
        if (!window.YT) {
            console.log('🔄 Loading YouTube API for simple approach...');
            const tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';
            const firstScriptTag = document.getElementsByTagName('script')[0];
            firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
        } else if (window.YT && window.YT.Player) {
            // API already loaded, call the function directly
            console.log('✅ YouTube API already loaded, setting up simple player...');
            window.onYouTubeIframeAPIReady();
        }
    }

    function createYouTubePlayer(videoId) {
        // Clear existing content
        youtubePlayer.innerHTML = '';
        
        // Try to create YouTube API player
        try {
            console.log('🔄 Creating new YouTube API player');
            youtubePlayerInstance = new YT.Player(youtubePlayer, {
                height: '100%',
                width: '100%',
                videoId: videoId,
                playerVars: {
                    'autoplay': 0,
                    'controls': 1,
                    'rel': 0,
                    'modestbranding': 1,
                    'enablejsapi': 1
                },
                events: {
                    'onReady': function(event) {
                        console.log('✅ YouTube player ready with API');
                        youtubePlayerInstance = event.target;
                        
                        // Ensure player instance is globally accessible
                        window.youtubePlayerInstance = youtubePlayerInstance;
                        playerInitializationInProgress = false;
                    },
                    'onError': function(event) {
                        console.error('❌ YouTube API player error:', event.data);
                        
                        // YouTube API failed, try simple fallback
                        console.log(`🔄 YouTube API error ${event.data}: Switching to simple fallback`);
                        
                        playerInitializationInProgress = false;
                        // Use simple fallback approach
                        createFallbackPlayer(videoId);
                    }
                }
            });
        } catch (error) {
            console.error('❌ Error creating YouTube API player:', error);
            playerInitializationInProgress = false;
            createFallbackPlayer(videoId);
        }
    }

    function createFallbackPlayer(videoId) {
        console.log('🔄 Creating simple fallback player like working site');
        
        // Clear any existing content first
        youtubePlayer.innerHTML = '';
        
        // Detect environment for optimal configuration
        const isProduction = window.location.hostname === 'youtubetranscriptgen.com' || 
                            window.location.hostname.includes('youtubetranscriptgen.com');
        const isLocalhost = window.location.hostname === 'localhost' || 
                           window.location.hostname === '127.0.0.1';
        
        // Build iframe URL with optimal parameters
        let iframeUrl = `https://www.youtube-nocookie.com/embed/${videoId}?enablejsapi=1`;
        
        if (isProduction) {
            // Production domain - perfect compatibility
            iframeUrl += `&origin=${encodeURIComponent(window.location.origin)}`;
            console.log('✅ Fallback using production domain - should work perfectly!');
        } else if (isLocalhost) {
            // Localhost - minimal parameters to avoid cross-origin issues
            console.log('⚠️ Fallback on localhost - using minimal parameters');
        } else {
            // Other domains
            iframeUrl += `&origin=${encodeURIComponent(window.location.origin)}`;
        }
        
        // Create simple iframe like on working site
        youtubePlayer.innerHTML = `
            <iframe 
                height="315" 
                width="100%" 
                src="${iframeUrl}"
                title="YouTube Video Player" 
                frameborder="0"
                allow="clipboard-write; encrypted-media; picture-in-picture; web-share" 
                allowfullscreen
                style="width: 100%; height: 100%; border-radius: 8px;">
            </iframe>
        `;
        
        // Set up global onYouTubeIframeAPIReady like working site
        window.onYouTubeIframeAPIReady = function() {
            try {
                console.log("🎬 Setting up YouTube player like working site");
                var iframe = youtubePlayer.querySelector("iframe");
                if (iframe) {
                    var player = new YT.Player(iframe);
                    
                    // Create player instance for our transcript functionality
                    youtubePlayerInstance = {
                        seekTo: function(seconds) {
                            try {
                                console.log('📍 Seeking to:', seconds, 'via YT.Player');
                                player.seekTo(seconds);
                                player.playVideo();
                            } catch (error) {
                                console.error('❌ Error seeking:', error);
                                showNotification('Video seeking not available', 'error');
                            }
                        },
                        destroy: function() {
                            if (iframe && iframe.parentNode) {
                                iframe.parentNode.removeChild(iframe);
                            }
                        }
                    };
                    
                    window.youtubePlayerInstance = youtubePlayerInstance;
                    playerInitializationInProgress = false;
                    console.log('✅ Simple player setup complete like working site');
                } else {
                    console.log('❌ No iframe found');
                }
            } catch (error) {
                console.error("❌ Error setting up the YouTube player: ", error);
                // If this fails, show restriction message
                createSimpleRestrictionMessage(videoId);
            }
        };
        
        // Load YouTube API if not already loaded
        if (!window.YT) {
            const tag = document.createElement('script');
            tag.src = 'https://www.youtube.com/iframe_api';
            const firstScriptTag = document.getElementsByTagName('script')[0];
            firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
        } else if (window.YT && window.YT.Player) {
            // API already loaded, call the function directly
            window.onYouTubeIframeAPIReady();
        }
    }

    function createSimpleRestrictionMessage(videoId) {
        console.log('🚫 Creating simple restriction message');
        youtubePlayer.innerHTML = `
            <div style="
                width: 100%; 
                height: 100%; 
                background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
                color: white;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                text-align: center;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                border-radius: 8px;
                min-height: 300px;
            ">
                <div style="max-width: 400px; padding: 30px;">
                    <div style="font-size: 48px; margin-bottom: 20px;">🚫</div>
                    <h3 style="
                        margin: 0 0 15px 0; 
                        color: #ff6b6b; 
                        font-size: 20px;
                        font-weight: 600;
                    ">Video Restricționat</h3>
                    <p style="
                        margin: 0 0 25px 0; 
                        color: #cccccc; 
                        font-size: 14px;
                        line-height: 1.5;
                    ">
                        Acest video nu poate fi afișat din cauza restricțiilor YouTube.<br>
                        Transcriptul funcționează în continuare!
                    </p>
                    <button onclick="window.open('https://www.youtube.com/watch?v=${videoId}', '_blank')" style="
                        background: linear-gradient(135deg, #ff0000 0%, #cc0000 100%);
                        color: white;
                        border: none;
                        padding: 12px 24px;
                        border-radius: 6px;
                        cursor: pointer;
                        font-weight: 600;
                        font-size: 14px;
                        box-shadow: 0 4px 12px rgba(255, 0, 0, 0.3);
                    ">
                        🔗 Deschide pe YouTube
                    </button>
                </div>
            </div>
        `;
        
        // Create minimal player instance
        youtubePlayerInstance = {
            seekTo: function(seconds) {
                console.log('📍 Seek requested but video is restricted:', seconds);
                showNotification('Video restricted - seeking not available. Use YouTube link above.', 'error');
            },
            destroy: function() {
                youtubePlayer.innerHTML = '';
            }
        };
        
        window.youtubePlayerInstance = youtubePlayerInstance;
        playerInitializationInProgress = false;
        console.log('✅ Simple restriction message shown');
    }

    function animateLoadingSteps() {
    const stepsContainer = document.querySelector('.loading-steps .steps-inner') || document.querySelector('.loading-steps');
        const steps = document.querySelectorAll('.step');
        let currentStep = 0;
        let stepInterval;
        let isCompleted = false; // Flag to prevent repetition
        let resizeHandler;

        // Ensure the steps viewport fits exactly 5 cards
        function fitStepsViewportExactlyFive() {
            try {
                const content = document.querySelector('.loading-content');
                const viewport = document.querySelector('.loading-steps');
                const inner = document.querySelector('.loading-steps .steps-inner');
                if (!content || !viewport || !inner || steps.length < 5) return;
                // Ensure viewport uses content-box for predictable padding behavior
                viewport.style.boxSizing = 'content-box';

                // Add a small bottom padding so the bottom card (and shadow) isn't clipped
                const shadowPad = 8; // px
                viewport.style.paddingBottom = `${shadowPad}px`;

                // Measure available space using client box of content (exclude borders)
                const contentRect = content.getBoundingClientRect();
                const viewportRect = viewport.getBoundingClientRect();
                const availableToBottom = content.clientHeight - (viewportRect.top - contentRect.top);
                let effectiveAvailable = Math.max(0, availableToBottom - shadowPad);
                if (effectiveAvailable <= 0) return;

                // Measure a card height and compute proportional gap
                const first = steps[0];
                const cardHeight = first.getBoundingClientRect().height;
                if (!cardHeight) return;

                // Desired proportional gap ~16% of card height, constrained 10..22px
                // Note: if five cards can't fit, maxAvailableGap will clamp this down,
                // which previously made it appear the gap didn't change.
                const desiredGap = Math.round(cardHeight * 0.16);
                const maxAvailableGap = Math.floor((effectiveAvailable - cardHeight * 5) / 4);
                let gap = desiredGap;
                gap = Math.max(10, Math.min(gap, 22));
                gap = Math.max(6, Math.min(gap, maxAvailableGap));

                // Final total height for exactly 5 cards
                let total = Math.round(cardHeight * 5 + gap * 4);
                // If rounding pushes us over, adjust gap down slightly
                if (total > effectiveAvailable) {
                    const over = total - effectiveAvailable;
                    const reduceEach = Math.ceil(over / 4);
                    gap = Math.max(4, gap - reduceEach);
                    total = Math.round(cardHeight * 5 + gap * 4);
                }

                // Apply styles: set gap and viewport height including padding bottom
                inner.style.gap = `${gap}px`;
                viewport.style.maxHeight = `${total + shadowPad}px`;

                // Force a reflow and recalc stride so scrolling aligns with the new gap
                void inner.offsetHeight;
            } catch (_) {}
        }
        
        // Define timing for each step (progressive increase to reach ~110s total, leaving 10s buffer)
        // Total: ~110 seconds with exponential-like progression
        const stepTimings = [
            1500,  // Step 1: 1.5s
            1800,  // Step 2: 1.8s  
            2200,  // Step 3: 2.2s
            2600,  // Step 4: 2.6s
            3000,  // Step 5: 3.0s
            3500,  // Step 6: 3.5s
            4000,  // Step 7: 4.0s
            4500,  // Step 8: 4.5s
            5000,  // Step 9: 5.0s
            5500,  // Step 10: 5.5s
            6000,  // Step 11: 6.0s
            6500,  // Step 12: 6.5s
            7000,  // Step 13: 7.0s
            7500,  // Step 14: 7.5s
            8000,  // Step 15: 8.0s
            8500,  // Step 16: 8.5s
            9000,  // Step 17: 9.0s
            9500   // Step 18: 9.5s - step 19 waits for real completion
        ]; // Total: ~110 seconds
        
        const maxVisibleSteps = 5; // Show only 5 steps at a time
        // Compute actual step height including gap to keep JS in sync with CSS
        function computeStepStride() {
            const first = steps[0];
            const second = steps[1];
            if (first && second) {
                const b1 = first.getBoundingClientRect();
                const b2 = second.getBoundingClientRect();
                const stride = Math.max(0, b2.top - b1.top);
                return stride || b1.height; // fallback
            }
            return 0;
        }
        let stepHeight = computeStepStride();
        // Fit viewport after layout settles, and on resize
    requestAnimationFrame(() => {
            fitStepsViewportExactlyFive();
            // recalc stride after any gap adjustments
            stepHeight = computeStepStride() || stepHeight;
        });
        setTimeout(() => {
            fitStepsViewportExactlyFive();
            stepHeight = computeStepStride() || stepHeight;
        }, 120);
        resizeHandler = () => {
            fitStepsViewportExactlyFive();
            stepHeight = computeStepStride() || stepHeight;
        };
        window.addEventListener('resize', resizeHandler, { passive: true });
        
        function animateScroll() {
            if (currentStep >= maxVisibleSteps) {
                // Recompute stride in case of responsive changes
                stepHeight = computeStepStride() || stepHeight;
                const scrollOffset = (currentStep - maxVisibleSteps + 1) * stepHeight;
                stepsContainer.style.transform = `translateY(-${scrollOffset}px)`;
            }
        }
        
        function advanceToNextStep() {
            if (isCompleted) return; // Prevent repetition
            
            if (currentStep > 0) {
                steps[currentStep - 1].classList.remove('active');
                steps[currentStep - 1].classList.add('completed');
            }
            
            if (currentStep < steps.length - 1) { // Don't auto-advance the last step
                steps[currentStep].classList.add('active');
                
                // Animate scroll if needed
                animateScroll();
                
                const nextStepDelay = stepTimings[currentStep] || 5000;
                currentStep++;
                
                stepInterval = setTimeout(advanceToNextStep, nextStepDelay);
            } else {
                // Activate the final step and keep it loading
                steps[currentStep].classList.add('active');
                animateScroll(); // Ensure final step is visible
                isCompleted = true; // Mark as completed to prevent repetition
                console.log('🔄 Final step activated, waiting for real completion...');
            }
        }
        
        // Start the animation
        if (steps.length > 0) {
            advanceToNextStep();
        }
        
        // Return cleanup function
        return function cleanup() {
            isCompleted = true; // Stop any future iterations
            if (stepInterval) {
                clearTimeout(stepInterval);
                stepInterval = null;
            }
            // Reset container position
            if (stepsContainer) { stepsContainer.style.transform = 'translateY(0)'; }
            try { window.removeEventListener('resize', resizeHandler); } catch (_) {}
        };
    }

    function showLoading(title = 'Loading...', subtitle = 'Please wait') {
        // Hide credits immediately when loading starts
        const creditsElements = document.querySelectorAll('.credits-display, .credits-display-ai');
        creditsElements.forEach(element => {
            element.classList.remove('visible');
        });
        console.log('💰 Credits hidden during loading');
        // Hide pricing immediately to match login/profile timing; will be restored by updateAuthUI after loading
        try {
            document.querySelectorAll('.pricing-link').forEach(el => { el.style.display = 'none'; });
        } catch (_) {}
        
        // Update loading text if elements exist
        const loadingTitle = document.querySelector('.loading-content h2');
        const loadingSubtitle = document.querySelector('.loading-content p');
        
        if (loadingTitle) loadingTitle.textContent = title;
        if (loadingSubtitle) loadingSubtitle.textContent = subtitle;
        
        // Reset all steps to initial state
        const steps = document.querySelectorAll('.step');
        steps.forEach((step, index) => {
            step.classList.remove('active', 'completed');
            if (index === 0) {
                step.classList.add('active'); // Start with first step active
            }
        });
        
    // Reset loading container styles (no scale to avoid flicker)
    loadingContainer.style.opacity = '1';
    loadingContainer.style.display = 'flex';
        errorContainer.style.display = 'none';
        transcriptLayout.style.display = 'none';
        
        // Hide auth UI during loading
        console.log('🎭 Loading started - hiding auth UI');
        updateAuthUI();
        
        // Start step animation with cleanup function
        if (loadingAnimation) {
            loadingAnimation(); // Call cleanup if exists
        }
        setTimeout(() => {
            loadingAnimation = animateLoadingSteps();
        }, 100); // Small delay to ensure DOM is ready
    }

    function hideLoading() {
        // Complete the final step if it's active
        const steps = document.querySelectorAll('.step');
        const finalStep = steps[steps.length - 1];
        
        if (finalStep && finalStep.classList.contains('active')) {
            finalStep.classList.remove('active');
            finalStep.classList.add('completed');
            console.log('✅ Final step completed');
        }
        
        // Cleanup animation
        if (loadingAnimation && typeof loadingAnimation === 'function') {
            loadingAnimation(); // Call cleanup function
            loadingAnimation = null;
        }
        
        // Add fade-out effect and then completely hide
    loadingContainer.style.opacity = '0';
        
        setTimeout(() => {
            loadingContainer.style.display = 'none';
            // Reset loading container state for next time
            loadingContainer.style.opacity = '';
            
            // Reset all steps to initial state
            steps.forEach((step, index) => {
                step.classList.remove('active', 'completed');
            });
            
            // Show auth UI now that loading is complete
            console.log('🎭 Loading complete - updating auth UI');
            updateAuthUI();
            
            // Update credits display
            updateCreditsDisplay();
            
            // Show credits with smooth animation after loading is complete
            setTimeout(() => {
                const creditsElements = document.querySelectorAll('.credits-display, .credits-display-ai');
                creditsElements.forEach(element => {
                    element.classList.add('visible');
                });
                console.log('💰 Credits now visible after loading complete');
            }, 100); // Small delay for smooth transition
        }, 300); // Wait for fade animation to complete
    }

    function showError(message) {
        hideLoading();
        errorText.textContent = message;
        errorContainer.style.display = 'block';
        transcriptLayout.style.display = 'none';
    }

    function hideError() {
        errorContainer.style.display = 'none';
    }

    // Copy transcript to clipboard
    function copyTranscriptToClipboard() {
        if (!transcriptData) {
            showNotification('No transcript data available', 'error');
            return;
        }

        let textToCopy = '';
        transcriptData.forEach(segment => {
            const timestamp = formatTimestamp(segment.start);
            textToCopy += `[${timestamp}] ${segment.text}\n`;
        });

        navigator.clipboard.writeText(textToCopy).then(() => {
            showNotification('Transcript copied to clipboard!', 'success');
        }).catch(err => {
            console.error('Failed to copy: ', err);
            showNotification('Failed to copy transcript', 'error');
        });
    }

    // Download transcript in different formats
    function downloadTranscript(format) {
        if (!transcriptData) {
            showNotification('No transcript data available', 'error');
            return;
        }

        const videoTitle = document.getElementById('video-title').textContent || 'transcript';
        const fileName = `${videoTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.${format}`;
        
        let content = '';
        let mimeType = 'text/plain';

        switch (format) {
            case 'txt':
                transcriptData.forEach(segment => {
                    const timestamp = formatTimestamp(segment.start);
                    content += `[${timestamp}] ${segment.text}\n`;
                });
                break;
            
            case 'srt':
                mimeType = 'application/x-subrip';
                transcriptData.forEach((segment, index) => {
                    const start = formatSRTTime(segment.start);
                    const end = formatSRTTime(segment.start + (segment.duration || 5));
                    content += `${index + 1}\n${start} --> ${end}\n${segment.text}\n\n`;
                });
                break;
            
            case 'vtt':
                mimeType = 'text/vtt';
                content = 'WEBVTT\n\n';
                transcriptData.forEach(segment => {
                    const start = formatVTTTime(segment.start);
                    const end = formatVTTTime(segment.start + (segment.duration || 5));
                    content += `${start} --> ${end}\n${segment.text}\n\n`;
                });
                break;
            
            case 'json':
                mimeType = 'application/json';
                content = JSON.stringify({
                    title: videoTitle,
                    transcript: transcriptData
                }, null, 2);
                break;
        }

        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showNotification(`Transcript downloaded as ${format.toUpperCase()}`, 'success');
    }

    // Format timestamp for display
    function formatTimestamp(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    // Format time for SRT files
    function formatSRTTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    }

    // Format time for VTT files
    function formatVTTTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    }

    // Cleanup old language cache entries (keep only last 10 videos)
    function cleanupLanguageCache() {
        try {
            const cacheKeys = Object.keys(localStorage).filter(key => key.startsWith('languages_'));
            if (cacheKeys.length > 10) {
                // Sort by timestamp and remove oldest
                const cacheEntries = cacheKeys.map(key => {
                    try {
                        const data = JSON.parse(localStorage.getItem(key));
                        return { key, timestamp: data.timestamp || 0 };
                    } catch {
                        return { key, timestamp: 0 };
                    }
                }).sort((a, b) => b.timestamp - a.timestamp);
                
                // Remove oldest entries beyond 10
                for (let i = 10; i < cacheEntries.length; i++) {
                    localStorage.removeItem(cacheEntries[i].key);
                }
                console.log('🧹 Cleaned up old language cache entries');
            }
        } catch (error) {
            console.log('⚠️ Error cleaning cache:', error);
        }
    }

    // Run cleanup on page load
    cleanupLanguageCache();

    // Show notification
    function showNotification(message, type = 'info') {
        // Create notification element if it doesn't exist
        let notification = document.getElementById('notification');
        if (!notification) {
            notification = document.createElement('div');
            notification.id = 'notification';
            notification.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 12px 20px;
                border-radius: 8px;
                color: white;
                font-weight: 500;
                z-index: 1000;
                transform: translateX(400px);
                transition: transform 0.3s ease;
            `;
            document.body.appendChild(notification);
        }

        // Set message and style based on type
        notification.textContent = message;
        notification.className = type;
        
        if (type === 'success') {
            notification.style.background = '#22c55e';
        } else if (type === 'error') {
            notification.style.background = '#ef4444';
        } else {
            notification.style.background = '#3b82f6';
        }

        // Show notification
        notification.style.transform = 'translateX(0)';

        // Hide after 3 seconds
        setTimeout(() => {
            notification.style.transform = 'translateX(400px)';
        }, 3000);
    }

    // Handle timestamp clicks for video seeking
    function handleTimestampClick(timestamp) {
        console.log('🕐 Timestamp clicked:', timestamp, 'Player instance exists:', !!youtubePlayerInstance);
        
        // Try to get player instance from global scope if local one is not available
        const playerInstance = youtubePlayerInstance || window.youtubePlayerInstance;
        
        if (playerInstance) {
            console.log('✅ Found player instance, attempting to seek');
            if (typeof playerInstance.seekTo === 'function') {
                try {
                    playerInstance.seekTo(timestamp, true);
                    console.log('✅ Successfully seeked to:', timestamp);
                    // Removed success notification for cleaner UX
                } catch (error) {
                    console.error('❌ Error seeking video:', error);
                    showNotification('Could not seek video', 'error');
                }
            } else {
                console.log('⚠️ seekTo function not available, trying alternative method');
                // Try alternative seeking method for iframe
                if (playerInstance.seekTo) {
                    playerInstance.seekTo(timestamp);
                    // Removed success notification for cleaner UX
                } else {
                    console.error('❌ No seekTo method available');
                    showNotification('Video seeking not available', 'error');
                }
            }
        } else {
            console.log('❌ Video player not ready, player instance:', playerInstance);
            showNotification('Video player not ready. Please wait for the video to load.', 'error');
            
            // Try to reinitialize player if we have a video ID
            if (currentVideoId) {
                console.log('🔄 Attempting to reinitialize player...');
                setTimeout(() => {
                    setupYouTubePlayer(currentVideoId);
                    setTimeout(() => {
                        handleTimestampClick(timestamp);
                    }, 2000);
                }, 1000);
            }
        }
    }

    // Utility function to check if player is ready
    function isPlayerReady() {
        const playerInstance = youtubePlayerInstance || window.youtubePlayerInstance;
        return playerInstance && typeof playerInstance.seekTo === 'function';
    }

    // Utility function to wait for player to be ready
    function waitForPlayer(callback, maxAttempts = 5) {
        let attempts = 0;
        const checkPlayer = () => {
            if (isPlayerReady()) {
                callback();
            } else if (attempts < maxAttempts) {
                attempts++;
                console.log(`⏳ Waiting for player (attempt ${attempts}/${maxAttempts})`);
                setTimeout(checkPlayer, 1000);
            } else {
                console.error('❌ Player not ready after maximum attempts');
                showNotification('Video player not responding', 'error');
            }
        };
        checkPlayer();
    }

    // Function to load transcript by video ID (moved inside DOMContentLoaded scope)
    async function loadTranscriptByVideoId(videoId) {
        console.log('🔍 Attempting to load transcript for video ID:', videoId);
        
        try {
            showLoading('Loading conversation...', 'Please wait while we retrieve your conversation');
            
            // IMPORTANT: Reset conversation context when switching videos
            if (currentVideoId !== videoId) {
                console.log('🔄 Switching video context from', currentVideoId, 'to', videoId);
                currentVideoId = videoId;
                conversationHistory = [];
                isConversationLoaded = false;
                isRestoringMessages = false;
                
                // Clear chat messages immediately
                const chatMessages = document.getElementById('chat-messages');
                if (chatMessages) {
                    chatMessages.innerHTML = '';
                }
            }
            
            const API_URL = await getWorkingAPI();
            const transcriptResponse = await fetch(`${API_URL}/api/transcript/by-video/${videoId}`);
            
            if (transcriptResponse.ok) {
                const transcriptData = await transcriptResponse.json();
                if (transcriptData.success && transcriptData.data) {
                    console.log('✅ Found transcript for video, loading normally');
                    
                    // Update URL with proper transcript ID
                    const newUrl = new URL(window.location);
                    newUrl.searchParams.set('id', transcriptData.data.id);
                    newUrl.searchParams.delete('video_id');
                    window.history.replaceState({}, '', newUrl);
                    
                    // Load transcript normally
                    displayTranscript(transcriptData.data);
                    return;
                }
            }
            
            // No transcript found, try to load conversation details
            console.log('⚠️ No transcript found, checking for conversation details');
            
            const convResponse = await fetch(`${API_URL}/api/conversations/${videoId}`, {
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' }
            });
            
            console.log('📡 Conversation response status:', convResponse.status);
            
            if (convResponse.ok) {
                const convData = await convResponse.json();
                console.log('✅ Found conversation details:', convData);
                console.log('📺 Video title:', convData.video_title);
                
                // Set video title from conversation
                currentVideoTitle = convData.video_title;
                
                // Show conversation-only view
                hideLoading();
                showConversationOnlyView(convData.video_title);
                
                // Load AI models first, then conversation
                try {
                    if (availableModels.length === 0) {
                        console.log('🤖 Loading AI models...');
                        await fetchAIModels();
                    }
                    
                    console.log('💬 Force loading conversation...');
                    // Force load conversation
                    isConversationLoaded = false;
                    await loadConversation();
                    console.log('✅ Conversation loading completed');
                } catch (modelError) {
                    console.error('❌ Error loading models or conversation:', modelError);
                }
            } else {
                // No conversation found either
                hideLoading();
                throw new Error('No transcript or conversation found for this video');
            }
            
        } catch (error) {
            console.error('❌ Error loading transcript by video ID:', error);
            hideLoading();
            
            // Show a more user-friendly error message with option to create new transcript
            const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const errorMessage = `
                <div style="text-align: center; padding: 40px;">
                    <h3>No Conversation Found</h3>
                    <p>This conversation may have expired or doesn't exist yet.</p>
                    <p>Would you like to generate a new transcript for this video?</p>
                    <br>
                    <a href="/?url=${encodeURIComponent(videoUrl)}" class="btn btn-primary">
                        Generate New Transcript
                    </a>
                </div>
            `;
            
            showError(errorMessage);
        }
    }

    function showConversationOnlyView(videoTitle) {
        console.log('📺 Showing conversation-only view for:', videoTitle);
        
        const transcriptLayout = document.getElementById('transcript-layout');
        const transcriptContent = document.getElementById('transcript-content');
        const videoTitleElement = document.getElementById('video-title');
        
        if (!transcriptLayout || !transcriptContent) return;
        
        // Update video title
        if (videoTitleElement) {
            videoTitleElement.textContent = videoTitle;
        }
        
        // Try to load saved transcript first
        loadSavedTranscript().then(savedTranscript => {
            if (savedTranscript) {
                console.log('✅ Found saved transcript, displaying it');
                transcriptData = savedTranscript.transcript;
                // If saved transcript has languages, prime cache and render immediately
                try {
                    if (Array.isArray(savedTranscript.languages) && currentVideoId) {
                        localStorage.setItem(`languages_${currentVideoId}`, JSON.stringify({
                            languages: savedTranscript.languages,
                            timestamp: Date.now()
                        }));
                        displayAvailableLanguages(savedTranscript.languages, savedTranscript.language_code || currentLanguageCode);
                        console.log(`⚡ Primed language cache with ${savedTranscript.languages.length} saved languages`);
                    }
                } catch (e) {
                    console.log('⚠️ Could not prime language cache from saved transcript:', e);
                }
                displaySavedTranscript(savedTranscript);
            } else {
                // No saved transcript, show message
                transcriptContent.innerHTML = `
                    <div class="no-transcript-message">
                        <h3>Conversation History</h3>
                        <p>The transcript for this video is no longer available, but you can view your conversation history below.</p>
                    </div>
                `;
            }
        }).catch(error => {
            console.log('⚠️ Could not load saved transcript:', error);
            // Show message for no transcript
            transcriptContent.innerHTML = `
                <div class="no-transcript-message">
                    <h3>Conversation History</h3>
                    <p>The transcript for this video is no longer available, but you can view your conversation history below.</p>
                </div>
            `;
        });
        
        // Show the transcript layout
        transcriptLayout.style.display = 'flex';
        
        // Initialize YouTube player for conversation-only view
        if (currentVideoId) {
            console.log('🎥 Setting up YouTube player for conversation-only view:', currentVideoId);
            setupYouTubePlayer(currentVideoId);
            
            // Load video information (description, stats, etc.)
            console.log('📊 Loading video info for conversation-only view:', currentVideoId);
            loadVideoInfo(currentVideoId);
        }
        
        // Initialize chat system
        setTimeout(() => {
            // Set transcriptData to empty for this case if no saved transcript
            if (!transcriptData || transcriptData.length === 0) {
                transcriptData = [];
            }
            initializeChat();
        }, 100);
    }

    async function loadSavedTranscript() {
        try {
            const API_URL = await getWorkingAPI();
            const response = await fetch(`${API_URL}/api/transcript/saved/${currentVideoId}`, {
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' }
            });
            
            if (response.ok) {
                const data = await response.json();
                console.log('✅ Loaded saved transcript from database');
                return data.data;
            } else if (response.status === 404) {
                console.log('ℹ️ No saved transcript found');
                return null;
            } else {
                throw new Error(`Failed to load saved transcript: ${response.status}`);
            }
        } catch (error) {
            console.error('❌ Error loading saved transcript:', error);
            return null;
        }
    }

    function displaySavedTranscript(savedTranscriptData) {
            // Normalize saved transcript data to the same shape used by displayTranscript
            const normalized = {
                video_id: currentVideoId,
                transcript: savedTranscriptData?.transcript || [],
                language: savedTranscriptData?.language || savedTranscriptData?.language_name || 'Unknown',
                language_code: savedTranscriptData?.language_code || 'en',
                is_translated: !!savedTranscriptData?.is_translated
            };

            console.log('📺 Displaying saved transcript via unified renderer', {
                segments: normalized.transcript.length,
                lang: normalized.language,
                lang_code: normalized.language_code,
                video: normalized.video_id
            });

            // Preload languages for this video so dropdown matches normal flow
            if (normalized.video_id) {
                try {
                    preloadLanguagesOptimized(normalized.video_id, normalized.language_code);
                } catch (e) {
                    console.log('⚠️ Could not preload languages for saved transcript:', e);
                }
            }

            // Delegate to the main display logic to ensure identical UI/behavior
            displayTranscript(normalized);
    }

    // Make loadTranscriptByVideoId available globally
    window.loadTranscriptByVideoId = loadTranscriptByVideoId;
});

function ensureToastContainer() {
    let c = document.querySelector('.toast-container');
    if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c); }
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
    requestAnimationFrame(() => t.classList.add('show'));
    const remove = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); };
    t.querySelector('.close-btn').addEventListener('click', remove);
    setTimeout(remove, 5000);
}

// Chat functionality
let currentResponseId = null;
let isSending = false; // prevent duplicate rapid sends
let autoScrollEnabled = true; // auto-scroll only when user is at/near bottom

// Helper to detect if container is scrolled to bottom (within threshold)
function isAtBottom(el, threshold = 10) {
    if (!el) return true;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}

function initializeChat() {
    console.log('🤖 Initializing chat system...');
    
    // Set up chat event listeners directly
    setupChatEventListeners();
    
    // Focus on input if transcript is loaded
    if (transcriptData && transcriptData.length > 0) {
        const chatInput = document.getElementById('chat-input');
        if (chatInput) {
            chatInput.focus();
        }
        console.log('✅ Chat initialized with transcript context:', {
            transcriptSegments: transcriptData.length,
            totalLength: transcriptData.reduce((acc, seg) => acc + seg.text.length, 0)
        });
    } else {
        console.log('⏳ Chat initialized - waiting for transcript data');
    }
    
    // Initialize conversation state (don't reset if already loaded)
    if (!isConversationLoaded) {
        conversationHistory = [];
        // Only reset currentResponseId if starting a completely new conversation
        if (conversationHistory.length === 0) {
            currentResponseId = null;
            console.log('🔄 New conversation started - reset response ID');
        }
    } else {
        console.log('🔄 Conversation already loaded - keeping existing response ID:', currentResponseId);
    }
    console.log('🔄 Chat conversation state initialized');
}

function setupChatEventListeners() {
    // Guard against duplicate wiring
    if (window.__CHAT_LISTENERS_WIRED__) {
        console.log('⚠️ Chat listeners already wired, skipping re-attach');
        return;
    }
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.getElementById('send-button');
    const chatMessages = document.getElementById('chat-messages');
    
    console.log('🎛️ Setting up chat event listeners...', {
        chatInput: !!chatInput,
        sendButton: !!sendButton
    });
    
    if (!chatInput || !sendButton) {
        console.error('❌ Chat elements not found:', {
            chatInput: !!chatInput,
            sendButton: !!sendButton
        });
        return;
    }

    // Setup auto-scroll behavior: enable only when user is at bottom
    if (chatMessages) {
        // Initialize state based on current position
        autoScrollEnabled = isAtBottom(chatMessages);
        chatMessages.addEventListener('scroll', () => {
            // Update flag: user scrolling up disables auto-scroll until back at bottom
            autoScrollEnabled = isAtBottom(chatMessages);
        }, { passive: true });
    }
    
    // Unified resize/center function for all content changes
    const resizeAndCenterChatInput = () => {
        // Use rAF to ensure DOM reflects pasted/cut text before measuring
        requestAnimationFrame(() => {
            const el = chatInput;
            const cs = window.getComputedStyle(el);
            // Determine min and max heights
            // Capture a stable baseline (initial) height once so we can shrink back to it later.
            // Prefer the CSS default (46px) over any expanded inline/computed height that may have been set earlier.
            const FALLBACK_BASE = 46;
            let baseMin = parseFloat(el.dataset.baseMinH || '');
            if (!Number.isFinite(baseMin)) {
                // If inline style height exists (likely from previous growth), ignore it and use fallback
                const hasInlineHeight = el.style.height && el.style.height !== 'auto' && el.style.height !== '';
                baseMin = hasInlineHeight ? FALLBACK_BASE : (parseFloat(cs.height) || FALLBACK_BASE);
                // Clamp to fallback in case computed height is unexpectedly large
                if (!Number.isFinite(baseMin) || baseMin > FALLBACK_BASE * 1.5) {
                    baseMin = FALLBACK_BASE;
                }
                el.dataset.baseMinH = String(baseMin);
            } else {
                // If previously stored baseline is off (too big/small), correct it
                if (baseMin > FALLBACK_BASE * 1.5 || baseMin < 30) {
                    baseMin = FALLBACK_BASE;
                    el.dataset.baseMinH = String(baseMin);
                }
            }
            const minH = Math.max(40, Math.round(baseMin));
            const maxH = 120; // keep existing cap

            // Remember base paddings (from CSS) once
            if (!el.dataset.basePt || !el.dataset.basePb) {
                el.dataset.basePt = String(parseFloat(cs.paddingTop) || 12);
                el.dataset.basePb = String(parseFloat(cs.paddingBottom) || 12);
            }
            const basePT = parseFloat(el.dataset.basePt) || 12;
            const basePB = parseFloat(el.dataset.basePb) || 12;

            // Reset to base paddings before measuring
            el.style.paddingTop = basePT + 'px';
            el.style.paddingBottom = basePB + 'px';
            // Reset height to auto for an accurate scrollHeight
            el.style.height = 'auto';

            // scrollHeight includes vertical paddings for textarea
            const sh = el.scrollHeight;
            const contentH = Math.max(0, sh - basePT - basePB);

            if (contentH + basePT + basePB <= minH) {
                // Content fits within the minimum height: center it by adding equal top/bottom padding
                const extra = minH - (contentH + basePT + basePB);
                const add = Math.max(0, Math.floor(extra / 2));
                el.style.height = minH + 'px';
                el.style.paddingTop = (basePT + add) + 'px';
                el.style.paddingBottom = (basePB + add) + 'px';
                el.style.overflowY = 'hidden';
            } else {
                // Content exceeds min height: grow up to max, keep symmetric base padding
                const desired = contentH + basePT + basePB;
                const target = Math.min(maxH, desired);
                el.style.height = target + 'px';
                el.style.paddingTop = basePT + 'px';
                el.style.paddingBottom = basePB + 'px';
                if (desired > maxH) {
                    // Only when we hit the cap, enable vertical scrolling
                    el.style.overflowY = 'auto';
                    // Keep caret visible at bottom when adding new lines
                    el.scrollTop = el.scrollHeight;
                } else {
                    el.style.overflowY = 'hidden';
                }
            }

            // Enable/disable send button based on content
            const hasContent = el.value.trim().length > 0;
            sendButton.disabled = !hasContent;
        });
    };

    // Apply on all relevant content change events
    chatInput.addEventListener('input', resizeAndCenterChatInput);
    chatInput.addEventListener('paste', resizeAndCenterChatInput);
    chatInput.addEventListener('cut', resizeAndCenterChatInput);
    chatInput.addEventListener('keyup', resizeAndCenterChatInput);
    chatInput.addEventListener('change', resizeAndCenterChatInput);
    
    // Handle Enter/Shift+Enter
    chatInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            if (e.shiftKey) {
                // Shift+Enter: allow new line
                console.log('⏎ Shift+Enter: New line allowed');
                return;
            } else {
                // Enter: send message
                e.preventDefault();
                if (isSending) {
                    console.log('⏳ Message send in progress, ignoring Enter');
                    return;
                }
                console.log('⏎ Enter: Sending message');
                sendMessage();
            }
        }
    });
    
    // Handle send button click
    sendButton.addEventListener('click', function() {
        console.log('🖱️ Send button clicked');
        sendMessage();
    });
    
    // Initial state
    sendButton.disabled = true;
    // Normalize initial sizing/centering
    try { resizeAndCenterChatInput(); } catch (_) {}
    
    console.log('✅ Chat event listeners set up successfully');
    // Mark as wired to avoid duplicates
    window.__CHAT_LISTENERS_WIRED__ = true;
}

async function sendMessage() {
    if (isSending) return; // guard against rapid triggers
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.getElementById('send-button');
    const chatMessages = document.getElementById('chat-messages');

    if (!chatInput || !chatInput.value.trim()) return;

    const message = chatInput.value.trim();
    const modelCost = selectedModel.cost;

    // Check if user has enough credits
    if (!checkCreditsForModel(modelCost)) {
        // Show error in chat
        addMessageToChat(
            `❌ Insufficient credits! You need ${modelCost} credits for ${selectedModel.name} model, but you only have ${currentCredits} credits.`,
            'ai'
        );
        
        // Show alert
        alert(`Not enough credits! You have ${currentCredits} credits, but need ${modelCost} for ${selectedModel.name} model.`);
        return;
    }

    // Mark sending immediately to block duplicates
    isSending = true;
    // Disable UI immediately to avoid race conditions
    chatInput.disabled = true;
    sendButton.disabled = true;

    // Spend credits BEFORE sending message
    const creditsSpent = await spendCredits(modelCost);
    if (!creditsSpent) {
        // spendCredits already shows error message
        isSending = false;
        chatInput.disabled = false;
        sendButton.disabled = false;
        return;
    }

    // Record conversation start time (first user message) and last message time
    try {
        const nowIso = new Date().toISOString();
        if (currentVideoId) {
            // Set start time only if not present yet
            if (!getStartTime(currentVideoId)) {
                setStartTime(currentVideoId, nowIso);
            }
            setLastMsgTime(currentVideoId, nowIso);
            // Update the visible history item immediately if open
            updateHistoryItemTimeNow(currentVideoId);
        }
    } catch (_) {}

    // Add user message
    addMessageToChat(message, 'user');
    chatInput.value = '';
    chatInput.style.height = 'auto';
    // Re-run sizing to shrink back and remove scrollbar if shown
    try { chatInput.dispatchEvent(new Event('input')); } catch (_) {}

    // Show inline typing indicator
    showTypingIndicator();

    try {
        const urlParams = new URLSearchParams(window.location.search);
        const transcriptId = urlParams.get('id');

        const requestData = {
            message: message,
            conversation_history: conversationHistory,
            transcript_id: transcriptId,
            previous_response_id: currentResponseId,
            model_lvl: selectedModel.id
        };

        const API_URL = await getWorkingAPI();

        const response = await fetch(`${API_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let output = '';
        let isFirstRealContent = true;
        let receivedResponseId = null; // Store the response ID from backend
        let aiMessageText = null;

        while (true) {
            const {done, value} = await reader.read();
            
            const chunk = new TextDecoder().decode(value);
            
            // Check if this chunk contains the response ID
            if (chunk.startsWith('__RESPONSE_ID__:')) {
                const responseIdMatch = chunk.match(/^__RESPONSE_ID__:([^\n]+)/);
                if (responseIdMatch) {
                    receivedResponseId = responseIdMatch[1];
                    console.log('🆔 Received response ID from backend:', receivedResponseId);
                    // Skip this chunk and continue with the next one
                    continue;
                }
            }
            
            // Only hide typing indicator and create AI message when we have real content
            if (isFirstRealContent && chunk.trim()) {
                hideTypingIndicator();
                aiMessageText = addMessageToChat('', 'ai');
                isFirstRealContent = false;
            }
            
            // Only process content if we have the AI message element
            if (aiMessageText) {
                output += chunk;
                aiMessageText.innerHTML = marked.parse(output);
                if (autoScrollEnabled) {
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
            }

            if (done) {
                break;
            }
        }

        // Ensure typing indicator is hidden even if no real content was received
        hideTypingIndicator();
        
        // Fallback: if no AI message was created, create one now
        if (!aiMessageText && output) {
            aiMessageText = addMessageToChat(output, 'ai');
        }

        // Store the response ID for next conversation turn
        if (receivedResponseId) {
            currentResponseId = receivedResponseId;
            console.log('✅ Set currentResponseId for next turn:', currentResponseId);
        }

        // Save conversation history after full response
        conversationHistory.push(
            { role: 'user', content: message },
            { role: 'assistant', content: output }
        );
        streamedContent = output;
        
        // Save conversation to storage with debouncing for better performance
        // This prevents multiple rapid saves during active chat sessions
        saveConversationDebounced(500); // 500ms delay
        
    console.log('✅ AI response completed and displayed, saving with 500ms delay...');
    // After displaying the AI response and saving, show low/zero coins notice if applicable
    setTimeout(() => { maybeShowCreditsNoticeAfterResponse(); }, 50);

    } catch (error) {
        console.error('Chat error:', error);
        hideTypingIndicator();
        const errorMessage = document.querySelector('.ai-message:last-child .message-text');
        if (errorMessage) {
            errorMessage.textContent = 'Sorry, I encountered an error. Please try again.';
            errorMessage.style.color = '#ef4444';
        }
    } finally {
        chatInput.disabled = false;
        sendButton.disabled = false;
        chatInput.focus();
    isSending = false;
    }
}

// Typing indicator functions
function showTypingIndicator() {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    // Remove any existing typing indicator
    hideTypingIndicator();

    // Create typing indicator message
    const typingMessage = document.createElement('div');
    typingMessage.className = 'ai-typing-message';
    typingMessage.id = 'ai-typing-indicator';

    typingMessage.innerHTML = `
        <div class="ai-avatar">🤖</div>
        <div class="message-content">
            <div class="ai-typing-dots">
                <span></span>
                <span></span>
                <span></span>
            </div>
        </div>
    `;

    chatMessages.appendChild(typingMessage);
    if (autoScrollEnabled) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

function hideTypingIndicator() {
    const typingIndicator = document.getElementById('ai-typing-indicator');
    if (typingIndicator) {
        typingIndicator.remove();
    }
}

function addMessageToChat(message, sender, isFromHistory = false) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    const messageDiv = document.createElement('div');
    messageDiv.className = `${sender}-message`;

    const avatar = document.createElement('div');
    avatar.className = `${sender}-avatar`;
    
    if (sender === 'user') {
        // For user messages, use profile picture if available, otherwise emoji
        if (currentUser && currentUser.picture) {
            const img = document.createElement('img');
            img.src = currentUser.picture;
            img.alt = currentUser.name || 'User';
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.borderRadius = '50%';
            img.style.objectFit = 'cover';
            avatar.appendChild(img);
        } else {
            avatar.textContent = '👤';
        }
    } else {
        avatar.textContent = '🤖';
    }

    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';

    const messageText = document.createElement('div');
    messageText.className = 'message-text';

    // Apply markdown formatting for AI messages (both live and from history)
    if (sender === 'user') {
        messageText.textContent = message;
    } else {
        // For AI messages, always apply markdown formatting
        // Whether it's from live streaming or from conversation history
        if (isFromHistory || typeof marked !== 'undefined') {
            try {
                messageText.innerHTML = marked.parse(message);
                console.log('✨ Markdown formatted for AI message:', isFromHistory ? '(from history)' : '(live)');
            } catch (error) {
                console.error('❌ Markdown parsing error:', error);
                messageText.textContent = message; // Fallback to plain text
            }
        } else {
            messageText.innerHTML = message; // Will be updated later with markdown in live streaming
        }
    }

    messageContent.appendChild(messageText);

    if (sender === 'user') {
        messageDiv.appendChild(messageContent);
        messageDiv.appendChild(avatar);
    } else {
        messageDiv.appendChild(avatar);
        messageDiv.appendChild(messageContent);
    }

    chatMessages.appendChild(messageDiv);
    // If user message, force auto-scroll and re-enable it (sender intent)
    if (sender === 'user') {
        autoScrollEnabled = true;
        chatMessages.scrollTop = chatMessages.scrollHeight;
    } else {
        if (autoScrollEnabled) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }

    return messageText; // important for live updating
}

// Ratings system moved to shared scripts/ratings.js

