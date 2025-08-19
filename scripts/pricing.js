// Global config (easy to change)
const FRONTEND_BASE_URL = window.location.origin + (window.location.pathname.includes('/frontend') ? '/frontend' : '');
const API_BASE_URL = 'https://api.youtubetranscriptgen.com';
const LOCAL_API_URL = 'http://localhost:8000';
let ACTIVE_API_BASE = API_BASE_URL; // Will be set to whichever endpoint responds first
let DEBUG_NOTES = [];
const DEV_EMAIL = new URLSearchParams(window.location.search).get('dev_email') || new URLSearchParams(window.location.search).get('email');
// Guest credits localStorage key (must match transcript.js)
const GUEST_CREDITS_KEY = 'youtube_transcript_guest_credits';
// Determine where to return after successful payment
const qs = new URLSearchParams(window.location.search);
const FROM_PARAM = qs.get('from');

// Admin helper: reset guest credits locally using a URL param (only on localhost)
(() => {
  try {
    const reset = qs.get('reset_guest_credits') || qs.get('admin_reset_guest_credits') || qs.get('reset_guest');
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (isLocal && (reset === '1' || reset === 'true')) {
      try { localStorage.setItem('youtube_transcript_guest_credits', '3'); } catch {}
      try { history.replaceState({}, document.title, location.pathname + location.hash); } catch {}
  console.log('[coins] Guest credits were reset to 3 (local only).');
    }
  } catch {}
})();

function getSafeReferrer() {
  try {
    const ref = document.referrer;
    if (!ref) return '';
    const u = new URL(ref);
    const sameOrigin = u.origin === window.location.origin;
    const isPricing = /(^|\/)pricing\.html(\?|#|$)/.test(u.pathname + u.search + u.hash);
    if (sameOrigin && !isPricing) return ref;
    return '';
  } catch { return ''; }
}

// Resolve return target with priority: explicit param > stored session > safe referrer > default
(() => {
  const stored = (function(){ try { return sessionStorage.getItem('returnTo') || ''; } catch { return ''; } })();
  const ref = getSafeReferrer();
  const storedSafe = (() => {
    try {
      if (!stored) return '';
      const u = new URL(stored, window.location.origin);
      const isPricing = /(^|\/)pricing\.html(\?|#|$)/.test(u.pathname + u.search + u.hash);
      return isPricing ? '' : stored;
    } catch { return ''; }
  })();
  let resolved = FROM_PARAM || storedSafe || ref || `${FRONTEND_BASE_URL}/transcript.html`;
  // Normalize relative URLs to absolute for session storage
  try {
    resolved = new URL(resolved, window.location.origin).toString();
  } catch {}
  try { sessionStorage.setItem('returnTo', resolved); } catch {}
  window.__RETURN_TO = resolved;
})();

let RETURN_TO = window.__RETURN_TO;
DEBUG_NOTES.push(`RETURN_TO: ${RETURN_TO}`);

// Default fallback prices; will be replaced by /api/pricing if backend is available
const PRICING_DEFAULTS = {
  starter: { coins: 150, price_usd: 4.99 },
  plus: { coins: 300, price_usd: 6.99 },
  pro: { coins: 500, price_usd: 8.99 }
};

function isLocalHost() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

async function fetchPricingFromBackend() {
  // Prefer remote API; if unreachable and we're on localhost, fall back to local
  const tryOrder = [API_BASE_URL, ...(isLocalHost() ? [LOCAL_API_URL] : [])];
  console.log('[pricing] trying API bases in order:', tryOrder);
  for (const base of tryOrder) {
    try {
      // Pricing is public; don't include credentials to avoid CORS credential restrictions via nginx "*" header
      const url = `${base}/api/pricing`;
      console.log('[pricing] fetching packs from', url);
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error(`pricing fetch failed: ${res.status}`);
      const data = await res.json();
      console.log('[pricing] server response:', data);
      if (!data.success) throw new Error('pricing not successful');
      const byId = {};
      (data.packs || []).forEach(p => { byId[p.id] = p; });
      ACTIVE_API_BASE = base; // remember which base worked
      DEBUG_NOTES.push(`API OK: ${base}`);
      return { packs: byId, stripeEnabled: !!data.stripe_enabled };
    } catch (e) {
      console.warn('[pricing] fetch failed for base', base, e);
      DEBUG_NOTES.push(`API FAIL: ${base}`);
      // continue to next base
    }
  }
  // No API reachable: still enable buttons to allow testing checkout; backend will return a clear error if not ready
  ACTIVE_API_BASE = API_BASE_URL; // default
  DEBUG_NOTES.push('API unreachable; enabling buttons in fallback');
  return { packs: PRICING_DEFAULTS, stripeEnabled: true };
}

function renderPricing(packs) {
  document.querySelectorAll('.plan-card').forEach(card => {
    const id = card.getAttribute('data-pack-id');
    const p = packs[id] || PRICING_DEFAULTS[id];
    if (!p) return;
    const coinsEl = card.querySelector('[data-field="coins"]');
    const priceEl = card.querySelector('[data-field="price"]');
    const wasEl = card.querySelector('[data-field="was"]');
    const discEl = card.querySelector('[data-field="discount"]');
  if (coinsEl) coinsEl.innerHTML = `${p.coins} <span class="coin"><img src="icons/COIN.png" class="coin-icon" alt="coin"></span>`;
    if (priceEl) priceEl.textContent = (p.price_usd ?? p.price).toFixed(2);

    // Dynamic discount vs base (left-most) pack
    const base = packs.starter || PRICING_DEFAULTS.starter;
    if (base && id !== 'starter') {
      const unitBase = base.price_usd / base.coins; // price per coin
      const nominalPrice = unitBase * p.coins; // what it would cost at base rate
      const discount = Math.max(0, 1 - (p.price_usd / nominalPrice));
      const pct = Math.round(discount * 100);
      if (pct >= 1) {
        if (wasEl) {
          wasEl.style.display = 'inline';
          wasEl.textContent = `$${nominalPrice.toFixed(2)}`;
        }
        if (discEl) {
          discEl.style.display = 'inline-block';
          discEl.textContent = `-${pct}%`;
          // CSS adds the word 'discount' after; text remains percentage only
        }
        // Add small discount hint in features if not present
        const features = card.querySelector('.plan-features');
        if (features && !features.querySelector('[data-auto-discount]')) {
          const li = document.createElement('li');
          li.setAttribute('data-auto-discount','1');
          li.textContent = `Save ${pct}% on your purchase`;
          features.prepend(li);
        }
      } else {
        if (wasEl) wasEl.style.display = 'none';
        if (discEl) discEl.style.display = 'none';
      }
    } else {
      if (wasEl) wasEl.style.display = 'none';
      if (discEl) discEl.style.display = 'none';
    }
  });
}

async function createCheckout(packId) {
  function addParam(url, key, value) {
    try {
      const u = new URL(url);
      u.searchParams.set(key, value);
      return u.toString();
    } catch {
      // Fallback for relative URLs
      const hasQuery = url.includes('?');
      const sep = hasQuery ? '&' : '?';
      return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }
  }
  const endpoint = `${ACTIVE_API_BASE}/api/checkout/session`;
  console.log('[pricing] creating checkout for', packId, 'via', endpoint);
  // Let backend append success/cancel flags; do not add purchase flag here
  const returnToWithFlag = RETURN_TO;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  body: JSON.stringify({ pack_id: packId, return_to: returnToWithFlag, ...(DEV_EMAIL ? { email: DEV_EMAIL } : {}) })
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('[pricing] checkout failed', res.status, text);
    throw new Error(text || 'Failed to start checkout');
  }
  const data = await res.json();
  console.log('[pricing] checkout session created', data);
  return data;
}

function wireBuyButtons(stripeEnabled) {
  console.log('[pricing] wiring buttons, stripeEnabled =', stripeEnabled, 'ACTIVE_API_BASE =', ACTIVE_API_BASE);
  document.querySelectorAll('.plan-card .buy-button').forEach(btn => {
    const card = btn.closest('.plan-card');
    const packId = card.getAttribute('data-pack-id');
    if (!stripeEnabled) {
      const note = card.querySelector('[data-field="note"]');
      if (note) {
        note.style.display = 'block';
        note.textContent = 'Stripe may not be fully configured yet; click to try checkout.';
      }
    }
    btn.disabled = false; // keep enabled; avoid :disabled CSS overlay
    btn.addEventListener('click', async () => {
      if (btn.dataset.busy === '1') return; // prevent multi-clicks without :disabled
      btn.dataset.busy = '1';
      const original = btn.textContent;
      btn.textContent = 'Redirecting...';
      try {
        const { url } = await createCheckout(packId);
        if (url) window.location.href = url;
      } catch (e) {
        console.error('[pricing] checkout error for pack', packId, e);
        alert('Checkout failed. Please login and try again.');
        btn.textContent = original;
        btn.dataset.busy = '0';
      }
    });
  });
}

// Placeholder for future pricing functionality
(function(){
  // Basic enhancement: when JS loads, add a subtle entrance animation
  const cards = document.querySelectorAll('.plan-card');
  cards.forEach((c, i) => {
    c.style.opacity = '0';
    c.style.transform += ' translateY(8px)';
    setTimeout(() => {
      c.style.transition = 'opacity .4s ease, transform .4s ease';
      c.style.opacity = '1';
      c.style.transform = c.style.transform.replace(' translateY(8px)', '');
    }, 80 * (i+1));
  });
})();

(function showStripeStatus(){
  const params = new URLSearchParams(window.location.search);
  const success = params.get('success');
  if (success) {
    const div = document.createElement('div');
    div.className = 'status-banner status-success show';
    div.textContent = 'Payment successful! Your credits will appear shortly.';
    document.querySelector('.pricing-page')?.prepend(div);
  }
})();

(async function initPricingPage(){
  const { packs, stripeEnabled } = await fetchPricingFromBackend();
  renderPricing(packs);

  // Check login status to decide whether to show Login or Buy
  let isLoggedIn = false;
  try {
    const res = await fetch(`${ACTIVE_API_BASE}/auth/user`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      isLoggedIn = !data.error;
      console.log('[pricing] auth status:', isLoggedIn ? 'logged in' : 'guest');
    }
  } catch (e) {
    console.warn('[pricing] auth check failed', e);
  }

  // Wire buttons based on auth state
  if (!isLoggedIn) {
    document.querySelectorAll('.plan-card .buy-button').forEach(btn => {
      btn.textContent = 'Login to buy';
      btn.dataset.mode = 'login';
      btn.disabled = false;
      btn.addEventListener('click', async () => {
        try {
          // Mimic transcript.js login flow with return_url back to this pricing page
          const currentUrl = window.location.href;
          const loginUrl = `${ACTIVE_API_BASE}/auth/login?return_url=${encodeURIComponent(currentUrl)}`;
          console.log('[pricing] redirecting to login:', loginUrl);
          window.location.href = loginUrl;
        } catch (err) {
          alert('Login failed. Please try again.');
        }
      }, { once: true });
    });
  } else {
    wireBuyButtons(stripeEnabled);
  }

  // Fetch and display credits in navbar
  try {
    const creditsAmount = document.getElementById('credits-amount');
    if (!creditsAmount) throw new Error('no-credits-el');

    if (isLoggedIn) {
      // Logged in: get from backend
      const res = await fetch(`${ACTIVE_API_BASE}/api/user/credits`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.credits === 'number') {
          creditsAmount.textContent = data.credits;
        }
      }
    } else {
      // Guest: read from localStorage (authoritative for guest state)
      let guestCredits = 3;
      try {
        const saved = localStorage.getItem(GUEST_CREDITS_KEY);
        const parsed = parseInt(saved ?? '3', 10);
        if (!Number.isNaN(parsed)) guestCredits = parsed;
      } catch { /* ignore */ }
      creditsAmount.textContent = guestCredits;
    }
  } catch (_) {}
  // Show a tiny debug banner for visibility
  // try {
  //   const div = document.createElement('div');
  //   div.style.cssText = 'position:fixed;bottom:8px;left:8px;background:#111;color:#9fe;padding:6px 10px;border-radius:6px;font:12px/1.2 system-ui;opacity:.9;z-index:9999;';
  // div.textContent = `API: ${ACTIVE_API_BASE} | StripeEnabled: ${stripeEnabled} | ${DEBUG_NOTES.join(' | ')}${DEV_EMAIL ? ' | DEV_EMAIL set' : ''}`;
  //   document.body.appendChild(div);
  // } catch(_) {}
})();
