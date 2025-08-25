// Centralized Ratings module used by all pages
(function(global){
  const Ratings = {};

  async function getAPIBase() {
    try {
      if (typeof global.getWorkingAPI === 'function') {
        return await global.getWorkingAPI();
      }
    } catch {}
    // Fallbacks if getWorkingAPI is not available
    try {
      if (typeof global.API_BASE_URL === 'string' && global.API_BASE_URL) {
        return global.API_BASE_URL;
      }
    } catch {}
    try {
      if (typeof global.LOCAL_API_URL === 'string' && global.LOCAL_API_URL) {
        return global.LOCAL_API_URL;
      }
    } catch {}
    return location.origin;
  }

  function $(id){ return document.getElementById(id); }
  function $all(sel){ return Array.from(document.querySelectorAll(sel)); }

  function updateStarsAverage(avg) {
    const pct = Math.max(0, Math.min(5, Number(avg || 0))) / 5 * 100;
    const avgStars = $('avg-stars');
    if (avgStars) avgStars.style.width = pct + '%';
  }

  function injectAggregateRatingLD(avg, count) {
    try {
      const old = document.getElementById('aggregate-rating-ld-json');
      if (old) old.remove();
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.id = 'aggregate-rating-ld-json';
      const data = {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        '@id': 'https://youtubetranscriptgen.com/#softwareapp',
        'name': 'YouTube Transcript Generator',
        'applicationCategory': 'UtilityApplication',
        'operatingSystem': 'Web',
        'url': 'https://youtubetranscriptgen.com',
        'offers': { '@type': 'Offer', 'price': 0, 'priceCurrency': 'USD' },
        'aggregateRating': {
          '@type': 'AggregateRating',
          'ratingValue': Number(avg || 0),
          'ratingCount': Number(count || 0)
        }
      };
      script.textContent = JSON.stringify(data);
      document.body.appendChild(script);
    } catch {}
  }

  function setUserStarSelection(container, value, disabled) {
    const stars = container.querySelectorAll('.star');
    stars.forEach(btn => {
      const v = Number(btn.dataset.value);
      if (v <= value) btn.classList.add('selected'); else btn.classList.remove('selected');
      btn.setAttribute('aria-checked', String(v === value));
      if (disabled) btn.disabled = true;
    });
  }

  async function fetchRatingsSummary() {
    const API_URL = await getAPIBase();
    const res = await fetch(`${API_URL}/api/ratings/summary`, { credentials: 'include' });
    if (!res.ok) throw new Error('ratings summary error');
    return await res.json();
  }

  async function submitRatingValue(value) {
    const API_URL = await getAPIBase();
    const res = await fetch(`${API_URL}/api/ratings/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ rating: value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || data.success === false) {
      throw data || new Error('submit failed');
    }
    return data;
  }

  async function init() {
    const ratingCard = document.querySelector('.rating-card');
    if (!ratingCard) return; // Not on this page
    const ratingInput = $('rating-input');
    const ratingStatus = $('rating-status');
    const avgEl = $('avg-rating');
    const countEl = $('rating-count');

    // Attach click handlers once
    if (ratingInput && !ratingInput.__wired__) {
      ratingInput.addEventListener('click', async (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement) || !t.classList.contains('star') || t.hasAttribute('disabled')) return;
        const val = Number(t.getAttribute('data-value'));
        if (!val) return;
        try {
          const res = await submitRatingValue(val);
          const avg2 = res.ratingValue || val;
          const count2 = res.ratingCount || (Number(countEl?.textContent || '0') + 1);
          if (avgEl) avgEl.textContent = Number(avg2).toFixed(1);
          if (countEl) countEl.textContent = String(count2);
          updateStarsAverage(avg2);
          injectAggregateRatingLD(avg2, count2);
          setUserStarSelection(ratingInput, val, true);
          if (ratingStatus) ratingStatus.textContent = 'Thanks for rating!';
        } catch (e2) {
          const msg = e2 && e2.error === 'ALREADY_RATED' ? 'You have already rated.' : 'Failed to submit rating. Please try again later.';
          if (ratingStatus) ratingStatus.textContent = msg;
          if (e2 && e2.error === 'ALREADY_RATED') {
            try { await refresh(); } catch {}
          }
        }
      });
      // Hover/focus preview (only when not disabled/locked)
      const stars = ratingInput.querySelectorAll('.star');
      stars.forEach((btn) => {
        btn.addEventListener('mouseenter', () => {
          if (btn.hasAttribute('disabled')) return;
          const v = Number(btn.getAttribute('data-value')) || 0;
          setUserStarSelection(ratingInput, v, false);
        });
        btn.addEventListener('focus', () => {
          if (btn.hasAttribute('disabled')) return;
          const v = Number(btn.getAttribute('data-value')) || 0;
          setUserStarSelection(ratingInput, v, false);
        });
      });
      ratingInput.addEventListener('mouseleave', () => {
        // Clear preview if not yet rated (i.e., not disabled)
        const anyDisabled = Array.from(ratingInput.querySelectorAll('.star')).some(s => s.hasAttribute('disabled'));
        if (!anyDisabled) setUserStarSelection(ratingInput, 0, false);
      });
      ratingInput.__wired__ = true;
    }

    await refresh();
  }

  async function refresh() {
    const ratingInput = $('rating-input');
    const ratingStatus = $('rating-status');
    const avgEl = $('avg-rating');
    const countEl = $('rating-count');
    if (!ratingInput) return;
    // Reset
    const stars = ratingInput.querySelectorAll('.star');
    stars.forEach(btn => { btn.classList.remove('selected'); btn.disabled = false; btn.setAttribute('aria-checked', 'false'); });
    if (ratingStatus) ratingStatus.textContent = '';

    try {
      const data = await fetchRatingsSummary();
      const avg = data.ratingValue || 0;
      const count = data.ratingCount || 0;
      if (avgEl) avgEl.textContent = Number(avg).toFixed(1);
      if (countEl) countEl.textContent = String(count);
      updateStarsAverage(avg);
      injectAggregateRatingLD(avg, count);
      if (data.hasRated) {
        setUserStarSelection(ratingInput, data.userRating || Math.round(avg), true);
        if (ratingStatus) ratingStatus.textContent = 'Thanks for rating!';
      }
    } catch {
      if (ratingStatus) ratingStatus.textContent = 'Ratings are temporarily unavailable.';
    }
  }

  Ratings.init = init;
  Ratings.refresh = refresh;
  global.Ratings = Ratings;

  // Auto-init on DOM ready (safe no-op if no rating markup)
  document.addEventListener('DOMContentLoaded', function(){
    try { Ratings.init(); } catch {}
  });

})(window);
