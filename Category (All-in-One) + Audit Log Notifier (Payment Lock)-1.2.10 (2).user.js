// ==UserScript==
// @name         Category (All-in-One) + Audit Log Notifier (Payment Lock)
// @namespace    http://tampermonkey.net/
// @version      1.2.10
// @description  Category auto-selector + advanced audit-log notifier. Paid-ad lock keeps original category and disables auto category changes; Payment ads require confirmation before Reject.
// @author       Roni
// @match        https://admin.bikroy.com/review/item/listing_fee
// @match        https://admin.bikroy.com/review/item/general
// @match        https://admin.bikroy.com/review/item/edited
// @match        https://admin.bikroy.com/review/item/verification
// @match        https://admin.bikroy.com/review/item/member
// @match        https://admin.bikroy.com/item/*
// @grant        none
// ==/UserScript==


(function() {
    'use strict';

    // This userscript also runs on /item/* for the audit-log notifier.
    // The Category auto-selection portion should only run on /review/item/* pages.
    if (!/\/review\/item\//.test(window.location.pathname)) {
        return;
    }

    // Get the title input field and category dropdown
    let titleField = null; // resolved at init time
    let categorySelect = null; // resolved at init time

    // These elements might not be present immediately, so get them dynamically or check for existence later
    const itemTypeSelectId = 'fields-item_type-value';
    const brandSelectId = 'fields-brand-value';
    const modelInputFieldId = 'fields-model-value';
    const accessoryTypeSelectId = 'fields-accessory_type-value';

    // Specific checkbox for blacklisted/fraud reasons
    let blacklistedAccountCheckbox = null; // resolved at init time

    // Flag to indicate if the ad is deactivated
    let isAdDeactivated = false;
    let isAdBlacklistedOrFraud = false; // New flag for blacklisted/fraud status
    let isMembershipAd = false; // Flag for special membership ads


// --- Robust element resolution + AUTO category visual marker (orange) ---
const TM_AUTO_CATEGORY_CLASS = 'tm-auto-category-changed';
const TM_AUTO_CATEGORY_STYLE_ID = 'tm-auto-category-style';
let tmIsSettingCategory = false;
let tmLastAutoCategoryValue = null;
// --- Category reset (one-time per ad/page URL) + original-category hint ---
const TM_CAT_RESET_KEY_PREFIX = 'tm_cat_reset_once::';
let tmSkipAutoCategoryThisLoad = false;
let tmAutoChangedFromValue = null; // value before the script auto-changed category (this load)
let tmAutoChangedFromText = null; // label before the script auto-changed category (this load)

function tmGetOptionTextByValue(selectEl, value) {
    if (!selectEl || !value) return null;
    try {
        const opt = Array.from(selectEl.options || []).find(o => o && String(o.value) === String(value));
        const txt = opt ? (opt.textContent || '').trim() : '';
        return txt || null;
    } catch (_) { return null; }
}

function tmGetCurrentAdUrlText() {
    // The review UI shows the public ad URL in: <h4 class="is-minor">http(s)://bikroy.com/en/ad/...</h4>
    // This is the most reliable per-ad identifier because the admin route often stays the same.
    const h4 = document.querySelector('h4.is-minor');
    if (!h4) return null;
    const raw = (h4.textContent || '').trim();
    if (!raw) return null;
    const m = raw.match(/https?:\/\/\S+/i);
    return m ? m[0] : raw;
}

function tmCatResetStorageKey() {
    // One-time per ad: key by the per-ad public URL (fallback to href).
    const adUrl = tmGetCurrentAdUrlText();
    return TM_CAT_RESET_KEY_PREFIX + (adUrl || window.location.href);
}

function tmCatResetStorageKeyByHref() {
    // Fallback key used very early in page load before the <h4 class="is-minor"> is present.
    // This is still safe because it's removed immediately after being consumed (one-time).
    return TM_CAT_RESET_KEY_PREFIX + window.location.href;
}


function tmInitCategoryResetOnce() {
    try {
        const keysToTry = [tmCatResetStorageKey(), tmCatResetStorageKeyByHref()];
        let raw = null;
        let usedKey = null;
        for (const k of keysToTry) {
            if (!k) continue;
            raw = sessionStorage.getItem(k);
            if (raw) { usedKey = k; break; }
        }
        if (!raw) return;
        const payload = JSON.parse(raw);
        // Use on this load only, then remove (still disabled for this load via tmSkipAutoCategoryThisLoad)
        if (usedKey) {
            // Remove both potential keys so it truly behaves as one-time.
            sessionStorage.removeItem(usedKey);
            sessionStorage.removeItem(tmCatResetStorageKeyByHref());
            sessionStorage.removeItem(tmCatResetStorageKey());
        }

        tmSkipAutoCategoryThisLoad = true;
        tmDisableAutoCategoryChange = true;

        // Restore original category (best-effort)
        if (payload && payload.originalValue) {
            tmOriginalCategoryValue = String(payload.originalValue);
            tmOriginalCategoryCaptured = true;
        }
        console.log('[Category Reset] Active for this load: auto category change disabled.');

        // Apply the original category once the DOM is ready
        setTimeout(() => {
            tmRefreshCoreElements();
            if (!categorySelect) return;
            if (tmOriginalCategoryValue && categorySelect.value !== tmOriginalCategoryValue) {
                tmLastAutoCategoryValue = null;
                tmClearAutoCategoryVisual(categorySelect);
                tmSetCategoryValue(tmOriginalCategoryValue, { auto: false });
                tmClearAutoCategoryVisual(categorySelect);
            } else {
                tmLastAutoCategoryValue = null;
                tmClearAutoCategoryVisual(categorySelect);
            }
            tmEnsureCategoryResetUI();
        }, 50);
    } catch (e) {
        console.warn('[Category Reset] Failed to init reset mode:', e);
    }
}

function tmEnsureCategoryResetUI() {
    // Re-resolve category element without calling tmRefreshCoreElements() here.
    // (tmRefreshCoreElements() calls tmEnsureBindings() -> tmEnsureCategoryResetUI(); calling it here caused recursion.)
    categorySelect = document.getElementById('category') || document.querySelector('#category');
    if (!categorySelect) return;
    tmInjectAutoCategoryStyle();

    // Place button next to the visible category widget (select2 container if present, else the select)
    const select2Container = (categorySelect.nextElementSibling && categorySelect.nextElementSibling.classList
        && categorySelect.nextElementSibling.classList.contains('select2'))
        ? categorySelect.nextElementSibling
        : null;

    const anchor = select2Container || categorySelect;
    if (!anchor || !anchor.parentElement) return;

    // Create/reset button once
    let btn = document.getElementById('tm-category-reset-btn');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'tm-category-reset-btn';
        btn.type = 'button';
        btn.textContent = 'Reset';
        btn.title = 'Reload with the original category and disable auto category change for this ad (this reload only)';
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();

            tmRefreshCoreElements();
            // Prefer the truly-original category captured before auto-change.
            const originalVal =
                tmOriginalCategoryValue ||
                tmAutoChangedFromValue ||
                (categorySelect ? categorySelect.getAttribute('data-tm-original-cat') : null);

            if (!originalVal) {
                console.warn('[Category Reset] Original category is unknown; doing a plain reload.');
                window.location.reload();
                return;
            }

            // Store original in sessionStorage and reload
            const payload = { originalValue: String(originalVal), ts: Date.now() };
            sessionStorage.setItem(tmCatResetStorageKey(), JSON.stringify(payload));
            // Also set a href-only fallback key so reset mode works even if the ad URL label isn't present yet on reload.
            sessionStorage.setItem(tmCatResetStorageKeyByHref(), JSON.stringify(payload));
            window.location.reload();
        }, true);

        anchor.parentElement.insertBefore(btn, anchor.nextSibling);
    }

    // Show button only when category was auto-changed (orange marker) and not already in reset mode
    const showBtn = categorySelect.classList.contains(TM_AUTO_CATEGORY_CLASS) && !tmSkipAutoCategoryThisLoad;
    btn.style.display = showBtn ? 'inline-flex' : 'none';

    // Bind badge triggers once per load (works with select2 or native)
    if (!document.documentElement.dataset.tmOrigCatBadgeBound) {
        document.documentElement.dataset.tmOrigCatBadgeBound = '1';

        // When interacting with category control, try to show badge once dropdown opens
        document.addEventListener('click', (e) => {
            tmRefreshCoreElements();
            if (!categorySelect) return;

            // Re-resolve the visible widget each time (select2 container can be re-rendered)
            const s2 = (categorySelect.nextElementSibling && categorySelect.nextElementSibling.classList
                && categorySelect.nextElementSibling.classList.contains('select2'))
                ? categorySelect.nextElementSibling : null;
            const container = s2 || categorySelect;

            if (container && (container.contains(e.target) || categorySelect.contains(e.target))) {
                tmMaybeShowOriginalCategoryBadgeSoon();
            } else {
                tmHideOriginalCategoryBadge();
            }
        }, true);

        // Mutation observer to hide badge when dropdown closes
        const mo = new MutationObserver(() => {
            const dd = tmFindVisibleDropdownEl();
            if (!dd) tmHideOriginalCategoryBadge();
        });
        mo.observe(document.body || document.documentElement, { childList: true, subtree: true });

        // Also support native <select>: show/hide the original-category hint based on focus/blur.
        tmBindOriginalCategoryHintHandlers();
    }
}

function tmFindVisibleDropdownEl() {
    // Try several common dropdown containers (select2, bootstrap, generic)
    const candidates = [
        document.querySelector('.select2-container--open .select2-dropdown'),
        document.querySelector('.select2-dropdown'),
        document.querySelector('.select2-results'),
        document.querySelector('[role="listbox"]'),
        document.querySelector('.dropdown-menu.show'),
        document.querySelector('.dropdown-menu'),
        document.querySelector('.ui-select__menu'),
    ].filter(Boolean);

    for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) return el;
    }
    return null;
}

function tmMaybeShowOriginalCategoryBadgeSoon() {
    tmRefreshCoreElements();
    if (!categorySelect) return;
    if (!categorySelect.classList.contains(TM_AUTO_CATEGORY_CLASS)) return;

    // Original category label: prefer captured original, else from 'from' snapshot
    const originalVal = tmOriginalCategoryValue || tmAutoChangedFromValue;
    const originalText = tmGetOptionTextByValue(categorySelect, originalVal) || tmAutoChangedFromText;

    if (!originalText) return;

    // Only show if it's different from current
    const currentText = tmGetSelectedText(categorySelect);
    if (currentText && currentText.trim() === originalText.trim()) return;

    // If the UI is native <select>, there may be no DOM dropdown element to anchor to.
    // In that case we show a small badge to the LEFT of the select while it's focused/open.
    setTimeout(() => {
        const dd = tmFindVisibleDropdownEl();
        if (dd) {
            tmShowOriginalCategoryBadge(originalText);
        } else {
            tmShowOriginalCategoryInlineBadge(originalText);
        }
    }, 60);
}


function tmShowOriginalCategoryBadge(originalText) {
    const dd = tmFindVisibleDropdownEl();
    if (!dd) return;

    let badge = document.getElementById('tm-original-category-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'tm-original-category-badge';
        badge.innerHTML = `<strong>Original:</strong><span class="tm-text"></span>`;
        (document.body || document.documentElement).appendChild(badge);
    }
    const span = badge.querySelector('.tm-text');
    if (span) span.textContent = originalText;

    const r = dd.getBoundingClientRect();
    badge.style.top = `${Math.max(8, r.top)}px`;
    badge.style.left = `${Math.max(8, r.left - 12)}px`;
    requestAnimationFrame(() => {
        const br = badge.getBoundingClientRect();
        const left = Math.max(8, r.left - br.width - 10);
        badge.style.left = `${left}px`;
    });
    badge.style.display = 'block';
}


function tmShowOriginalCategoryInlineBadge(originalText) {
    tmRefreshCoreElements();
    if (!categorySelect) return;

    let badge = document.getElementById('tm-original-category-inline-badge');
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'tm-original-category-inline-badge';
        badge.innerHTML = `<strong>Original:</strong><span class="tm-text"></span>`;
        (document.body || document.documentElement).appendChild(badge);
    }

    const span = badge.querySelector('.tm-text');
    if (span) span.textContent = originalText;

    // Anchor to the SELECT itself (left side), not the dropdown menu.
    const r = categorySelect.getBoundingClientRect();

    // Show first (so we can measure), then place
    badge.style.display = 'block';

    requestAnimationFrame(() => {
        const br = badge.getBoundingClientRect();
        const left = Math.max(8, r.left - br.width - 10);
        const top = Math.max(8, r.top + (r.height - br.height) / 2);
        badge.style.left = `${left}px`;
        badge.style.top = `${top}px`;
    });
}


function tmHideOriginalCategoryBadge() {
    const badge = document.getElementById('tm-original-category-badge');
    if (badge) badge.style.display = 'none';

    const inline = document.getElementById('tm-original-category-inline-badge');
    if (inline) inline.style.display = 'none';
}

function tmBindOriginalCategoryHintHandlers() {
    tmRefreshCoreElements();
    if (!categorySelect) return;

    if (categorySelect.dataset.tmOrigHintBound) return;
    categorySelect.dataset.tmOrigHintBound = '1';

    // Show hint when user opens/focuses the category dropdown
    categorySelect.addEventListener('focus', () => tmMaybeShowOriginalCategoryBadgeSoon(), true);
    categorySelect.addEventListener('mousedown', () => tmMaybeShowOriginalCategoryBadgeSoon(), true);
    categorySelect.addEventListener('click', () => tmMaybeShowOriginalCategoryBadgeSoon(), true);

    // Hide when dropdown collapses / user clicks elsewhere
    categorySelect.addEventListener('blur', () => tmHideOriginalCategoryBadge(), true);
    categorySelect.addEventListener('change', () => setTimeout(() => tmHideOriginalCategoryBadge(), 50), true);
}


// --- Payment detection bridge (from Audit Log Notifier) ---
// When the audit-log notifier detects a paid ad, it dispatches a `tm-payment-detected` event.
// On paid ads we DO NOT auto-change the category; we keep the original category and show the payment notifier.
const TM_PAYMENT_EVENT_NAME = 'tm-payment-detected';
const TM_GLOBAL_PAYMENT_FLAG = '__TM_PAYMENT_DETECTED__';

let tmPaymentDetected = false; // set by Audit Log Notifier
let tmPaymentDateISO = null; // optional
let tmOriginalCategoryValue = null; // captured before any auto-change
let tmOriginalCategoryCaptured = false;
let tmDisableAutoCategoryChange = false; // when true, script won't auto-change category

function tmCaptureOriginalCategoryValue(force = false) {
    tmRefreshCoreElements();
    if (!categorySelect) return;

    if (!force && tmOriginalCategoryCaptured) return;

    const v = categorySelect.value;

    // Capture only meaningful values (not empty/"none")
    if (v && v !== 'none') {
        tmOriginalCategoryValue = v;
        tmOriginalCategoryCaptured = true;
        console.log(`[Payment Lock] Captured original category value: ${tmOriginalCategoryValue}`);
    }
}

function tmDisconnectObserver(refName) {
    try {
        const obs = window[refName];
        if (obs && typeof obs.disconnect === 'function') {
            obs.disconnect();
            console.log(`[Payment Lock] Disconnected observer: ${refName}`);
        }
    } catch (_) { /* ignore */ }
}

function tmCancelPendingAutoSelections() {
    // These are the observer names used by this script.
    tmDisconnectObserver('itemTypeObserver');
    tmDisconnectObserver('brandSelectObserver');
    tmDisconnectObserver(`${modelInputFieldId}Observer`);
}

function tmRestoreOriginalCategoryIfAutoChanged() {
    tmRefreshCoreElements();
    if (!categorySelect) return;

    // If we never captured, try best-effort capture now.
    if (!tmOriginalCategoryCaptured) tmCaptureOriginalCategoryValue(true);

    if (!tmOriginalCategoryValue) return;

    // Only restore if the category was auto-set by this script (not a manual user change).
    const looksAutoSet =
        !!tmLastAutoCategoryValue ||
        categorySelect.classList.contains(TM_AUTO_CATEGORY_CLASS);

    if (!looksAutoSet) return;

    if (categorySelect.value !== tmOriginalCategoryValue) {
        console.log(`[Payment Lock] Restoring category to original (${tmOriginalCategoryValue}) because this is a paid ad.`);
        tmLastAutoCategoryValue = null;
        tmClearAutoCategoryVisual(categorySelect);
        tmSetCategoryValue(tmOriginalCategoryValue, { auto: false });
        tmLastAutoCategoryValue = null;
        tmClearAutoCategoryVisual(categorySelect);
    }
}

function tmHandlePaymentDetected(dateObj) {
    if (tmPaymentDetected) return;
    tmPaymentDetected = true;
    tmDisableAutoCategoryChange = true;
    if (dateObj instanceof Date && !isNaN(dateObj)) {
        tmPaymentDateISO = dateObj.toISOString();
    }
    console.log('[Payment Lock] Payment detected. Category auto-change is now disabled for this ad.');

    // Stop any pending auto field selection based on a possibly-wrong auto category.
    tmCancelPendingAutoSelections();

    // Restore original category if it was auto-changed earlier.
    tmRestoreOriginalCategoryIfAutoChanged();
}

// Listen for the notifier event (dispatched by the Audit Log Notifier part)
window.addEventListener(TM_PAYMENT_EVENT_NAME, (e) => {
    const iso = e && e.detail && e.detail.date ? String(e.detail.date) : null;
    const d = iso ? new Date(iso) : null;
    tmHandlePaymentDetected(d);
});

// If the notifier already ran (e.g., script order/race), honor the global flag.
if (window[TM_GLOBAL_PAYMENT_FLAG]) {
    const existingIso = window.__TM_PAYMENT_DATE_ISO__ ? String(window.__TM_PAYMENT_DATE_ISO__) : null;
    const existingDate = existingIso ? new Date(existingIso) : null;
    tmHandlePaymentDetected(existingDate);
}


const tmDefer = (fn) => {
    if (typeof queueMicrotask === 'function') return queueMicrotask(fn);
    return setTimeout(fn, 0);
};

// If user pressed Reset on this ad, disable auto category change for this load.
tmInitCategoryResetOnce();

// --- SPA / Next-Ad navigation fix ---
// Admin review UI often swaps ads via pushState without a full reload.
// If we don't reset per-ad flags (payment/deactivated/membership) and re-run init,
// auto category changes + backtick title generation can appear "broken".
let tmLastHrefSeen = window.location.href;
let tmReinitQueued = false;

function tmResetPerAdState() {
    // Reset per-ad flags so one paid/deactivated ad doesn't poison the next one.
    try { tmPaymentDetected = false; } catch (_) {}
    try { tmPaymentDateISO = null; } catch (_) {}
    try { tmDisableAutoCategoryChange = false; } catch (_) {}
    try { tmSkipAutoCategoryThisLoad = false; } catch (_) {}
    try { tmAutoChangedFromValue = null; tmAutoChangedFromText = null; } catch (_) {}
    try { tmLastAutoCategoryValue = null; } catch (_) {}
    try { tmIsSettingCategory = false; } catch (_) {}

    // Original-category capture is per-ad; reset so the next ad can be captured correctly.
    try { tmOriginalCategoryValue = null; tmOriginalCategoryCaptured = false; } catch (_) {}

    // Clear global payment ISO too.
    try { delete window.__TM_PAYMENT_DATE_ISO__; } catch (_) {}

    try { isAdDeactivated = false; } catch (_) {}
    try { isAdBlacklistedOrFraud = false; } catch (_) {}
    try { isMembershipAd = false; } catch (_) {}

    // Clear the global payment flag set by the audit-log notifier, if present.
    try {
        if (typeof window[TM_GLOBAL_PAYMENT_FLAG] !== 'undefined') window[TM_GLOBAL_PAYMENT_FLAG] = false;
    } catch (_) {}

    // Remove per-ad UI hints
    try { tmHideOriginalCategoryBadge(); } catch (_) {}
    const btn = document.getElementById('tm-category-reset-btn');
    if (btn) btn.remove();

    // Clear orange marker on current select (new ad will recalc anyway)
    try {
        tmRefreshCoreElements();
        if (categorySelect) tmClearAutoCategoryVisual(categorySelect);
    } catch (_) {}
}

function tmQueueReinitialize(reason) {
    if (tmReinitQueued) return;
    tmReinitQueued = true;

    tmDefer(() => {
        tmReinitQueued = false;
        try { tmResetPerAdState(); } catch (_) {}

        // If user hit "Reset" (sessionStorage) on THIS URL load, honor it.
        try { tmInitCategoryResetOnce(); } catch (_) {}

        // Let the new ad UI render, then re-run main initialization.
        setTimeout(() => {
            try { initializeScript(); } catch (e) { console.warn('[TM Reinit]', reason, e); }
        }, 80);
    });
}

function tmStartHrefWatcher() {
    // Patch history methods for SPA navigation
    try {
        const _push = history.pushState;
        history.pushState = function(...args) {
            const r = _push.apply(this, args);
            tmDefer(() => {
                if (window.location.href !== tmLastHrefSeen) {
                    tmLastHrefSeen = window.location.href;
                    tmQueueReinitialize('pushState');
                }
            });
            return r;
        };

        const _replace = history.replaceState;
        history.replaceState = function(...args) {
            const r = _replace.apply(this, args);
            tmDefer(() => {
                if (window.location.href !== tmLastHrefSeen) {
                    tmLastHrefSeen = window.location.href;
                    tmQueueReinitialize('replaceState');
                }
            });
            return r;
        };

        window.addEventListener('popstate', () => {
            tmDefer(() => {
                if (window.location.href !== tmLastHrefSeen) {
                    tmLastHrefSeen = window.location.href;
                    tmQueueReinitialize('popstate');
                }
            });
        }, true);
    } catch (_) { /* ignore */ }

    // Fallback poll (covers cases where routing changes don't touch history methods)
    setInterval(() => {
        const hrefNow = window.location.href;
        if (hrefNow !== tmLastHrefSeen) {
            tmLastHrefSeen = hrefNow;
            tmQueueReinitialize('interval-href');
        }
    }, 350);
}


// --- Per-ad URL watcher (the admin route often stays the same) ---
let tmLastAdUrlSeen = null;
let tmAdUrlCheckQueued = false;

function tmCheckAdUrlChange(reason) {
    if (tmAdUrlCheckQueued) return;
    tmAdUrlCheckQueued = true;
    tmDefer(() => {
        tmAdUrlCheckQueued = false;
        const cur = tmGetCurrentAdUrlText();
        if (!cur) return;

        if (tmLastAdUrlSeen === null) {
            tmLastAdUrlSeen = cur;
            return;
        }

        if (cur !== tmLastAdUrlSeen) {
            tmLastAdUrlSeen = cur;
            tmQueueReinitialize('ad-url:' + (reason || 'changed'));
        }
    });
}

function tmStartAdUrlWatcher() {
    // Initialize the last seen value when available
    tmLastAdUrlSeen = tmGetCurrentAdUrlText();

    // Watch DOM changes (the h4 is often replaced/updated when the next ad loads)
    try {
        const obs = new MutationObserver(() => tmCheckAdUrlChange('mutation'));
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (_) {}

    // Fallback polling
    setInterval(() => tmCheckAdUrlChange('interval'), 400);

    // After approve/reject actions, the next ad usually loads shortly after a click
    document.addEventListener('click', () => {
        setTimeout(() => tmCheckAdUrlChange('click'), 120);
    }, true);
}

// Start watcher so each new ad is handled correctly.
tmStartHrefWatcher();
// Also watch the per-ad public URL shown in <h4 class="is-minor">...
// because the admin route often doesn't change between ads.
tmStartAdUrlWatcher();

function tmInjectAutoCategoryStyle() {
    if (document.getElementById(TM_AUTO_CATEGORY_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = TM_AUTO_CATEGORY_STYLE_ID;
    style.textContent = `
        #category.${TM_AUTO_CATEGORY_CLASS} { color: orange !important; font-weight: 700 !important; }
        #category.${TM_AUTO_CATEGORY_CLASS} option:checked { color: orange !important; font-weight: 700 !important; }

        #tm-category-reset-btn{
            margin-left:8px; padding:6px 10px; border:1px solid #c9c9c9; border-radius:6px;
            background:#fff; cursor:pointer; font-size:12px; line-height:1; user-select:none;
        }
        #tm-category-reset-btn:hover{ filter:brightness(0.98); }
        #tm-original-category-badge{
            position:fixed; z-index:2147483647; background:#fff; border:1px solid #c9c9c9;
            border-radius:8px; padding:6px 10px; font-size:12px; box-shadow:0 6px 18px rgba(0,0,0,.12);
            max-width:260px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        }
        #tm-original-category-badge strong{ font-weight:700; margin-right:6px; }
        #tm-original-category-inline-badge{
            position:fixed; z-index:2147483647; background:#fff; border:1px solid #c9c9c9;
            border-radius:8px; padding:6px 10px; font-size:12px; box-shadow:0 6px 18px rgba(0,0,0,.12);
            max-width:260px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        }
        #tm-original-category-inline-badge strong{ font-weight:700; margin-right:6px; }
    `;
    (document.head || document.documentElement).appendChild(style);
}

function tmApplyAutoCategoryVisual(selectEl) {
    if (!selectEl) return;
    tmInjectAutoCategoryStyle();
    selectEl.classList.add(TM_AUTO_CATEGORY_CLASS);

    // Best-effort: color the selected option too (some browsers ignore <option> styles)
    try {
        Array.from(selectEl.options || []).forEach(opt => {
            if (opt && opt.dataset && opt.dataset.tmAutoColored === '1') {
                opt.style.color = '';
                opt.style.fontWeight = '';
                delete opt.dataset.tmAutoColored;
            }
        });
        const selectedOpt = selectEl.options && selectEl.selectedIndex >= 0 ? selectEl.options[selectEl.selectedIndex] : null;
        if (selectedOpt) {
            selectedOpt.dataset.tmAutoColored = '1';
            selectedOpt.style.color = 'orange';
            selectedOpt.style.fontWeight = '700';
        }
    } catch (_) {
        // ignore styling issues
    }
}

function tmClearAutoCategoryVisual(selectEl) {
    if (!selectEl) return;
    selectEl.classList.remove(TM_AUTO_CATEGORY_CLASS);
    try {
        Array.from(selectEl.options || []).forEach(opt => {
            if (opt && opt.dataset && opt.dataset.tmAutoColored === '1') {
                opt.style.color = '';
                opt.style.fontWeight = '';
                delete opt.dataset.tmAutoColored;
            }
        });
    } catch (_) {
        // ignore styling issues
    }
}

function tmFindBlacklistedCheckbox() {
    const tryLabel = (re) => {
        const labels = Array.from(document.querySelectorAll('label'));
        const label = labels.find(l => re.test((l.textContent || '').trim()));
        if (!label) return null;

        const forId = label.getAttribute('for');
        if (forId) {
            const el = document.getElementById(forId);
            if (el && el.type === 'checkbox') return el;
        }

        const inside = label.querySelector('input[type="checkbox"]');
        if (inside) return inside;

        const near = label.closest('div')?.querySelector('input[type="checkbox"]');
        return near || null;
    };

    return (
        tryLabel(/blacklisted\s*account/i) ||
        tryLabel(/blacklisted/i) ||
        document.querySelector('input[type="checkbox"][name*="blacklisted" i]') ||
        document.querySelector('input[type="checkbox"][value*="blacklisted" i]') ||
        null
    );
}

// --- Payment AD Reject Confirmation (shown only for paid ads) ---
const TM_PAYMENT_REJECT_STYLE_ID = 'tm-payment-reject-confirm-style';
const TM_PAYMENT_REJECT_MODAL_ID = 'tm-payment-reject-confirm-modal';
let tmPaymentRejectBypassOnce = false;

function tmIsPaymentAdRightNow() {
    // Fast path: audit-log notifier already flagged payment
    try {
        if (tmPaymentDetected || window[TM_GLOBAL_PAYMENT_FLAG]) return true;
    } catch (_) { /* ignore */ }

    // Fallback: quick scan of currently visible audit log text
    try {
        const logItems = document.querySelectorAll('.review-logs ul li');
        for (const item of logItems) {
            const t = item && (item.innerText || item.textContent) ? (item.innerText || item.textContent) : '';
            if (/Made payment[\s\S]*?approved/i.test(t)) return true;
        }
        const box = document.querySelector('.review-logs');
        const txt = box ? (box.innerText || box.textContent || '') : '';
        if (/Made payment[\s\S]*?approved/i.test(txt)) return true;
    } catch (_) { /* ignore */ }

    return false;
}

function tmInjectPaymentRejectConfirmStyles() {
    if (document.getElementById(TM_PAYMENT_REJECT_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = TM_PAYMENT_REJECT_STYLE_ID;
    style.textContent = `
        #${TM_PAYMENT_REJECT_MODAL_ID} {
            position: fixed; inset: 0; z-index: 100000;
            display: flex; align-items: center; justify-content: center;
            background: rgba(0,0,0,0.45);
        }
        #${TM_PAYMENT_REJECT_MODAL_ID} .tm-pr-dialog {
            width: min(520px, calc(100vw - 32px));
            background: #fff;
            border-radius: 10px;
            padding: 16px 16px 14px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.35);
        }
        #${TM_PAYMENT_REJECT_MODAL_ID} .tm-pr-title {
            font-size: 16px;
            font-weight: 800;
            margin: 0 0 8px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        #${TM_PAYMENT_REJECT_MODAL_ID} .tm-pr-msg {
            font-size: 14px;
            margin: 0 0 14px;
            line-height: 1.4;
        }
        #${TM_PAYMENT_REJECT_MODAL_ID} .tm-pr-actions {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
            align-items: center;
        }
        #${TM_PAYMENT_REJECT_MODAL_ID} .tm-pr-actions .ui-btn {
            min-width: 110px;
        }
        #${TM_PAYMENT_REJECT_MODAL_ID} .tm-pr-actions .tm-pr-cancel {
            background: #eee;
        }
    `;
    (document.head || document.documentElement).appendChild(style);
}

function tmClosePaymentRejectModal() {
    const el = document.getElementById(TM_PAYMENT_REJECT_MODAL_ID);
    if (el) el.remove();
}

function tmIsRejectButton(btn) {
    if (!btn || btn.tagName !== 'BUTTON') return false;

    // Must be the critical submit reject button
    const cls = btn.classList;
    if (!cls) return false;
    if (!cls.contains('ui-btn') || !cls.contains('btn-submit') || !cls.contains('has-busy') || !cls.contains('is-auto') || !cls.contains('is-critical')) return false;

    // Must have label "Reject"
    const labelEl = btn.querySelector('.label');
    const label = (labelEl ? labelEl.textContent : btn.textContent) || '';
    return label.trim().toLowerCase() === 'reject';
}

function tmShowPaymentRejectModal(originalRejectButton) {
    if (!originalRejectButton) return;

    // If already open, do nothing.
    if (document.getElementById(TM_PAYMENT_REJECT_MODAL_ID)) return;

    tmInjectPaymentRejectConfirmStyles();

    const overlay = document.createElement('div');
    overlay.id = TM_PAYMENT_REJECT_MODAL_ID;

    overlay.innerHTML = `
        <div class="tm-pr-dialog" role="dialog" aria-modal="true">
            <div class="tm-pr-title">💰 Payment AD</div>
            <p class="tm-pr-msg">Are you sure you want to reject this payment AD?</p>
            <div class="tm-pr-actions">
                <button type="button" class="ui-btn btn-submit has-busy is-auto is-critical tm-pr-confirm">
                    <span class="label">Reject</span><span class="spin"></span>
                </button>
                <button type="button" class="ui-btn btn-submit tm-pr-cancel">
                    <span class="label">Cancel</span>
                </button>
            </div>
        </div>
    `;

    const onKeyDown = (ev) => {
        if (ev && ev.key === 'Escape') {
            ev.preventDefault();
            tmClosePaymentRejectModal();
            document.removeEventListener('keydown', onKeyDown, true);
        }
    };

    overlay.addEventListener('click', (ev) => {
        // Click outside dialog closes
        if (ev.target === overlay) {
            tmClosePaymentRejectModal();
            document.removeEventListener('keydown', onKeyDown, true);
        }
    }, true);

    const confirmBtn = overlay.querySelector('.tm-pr-confirm');
    const cancelBtn = overlay.querySelector('.tm-pr-cancel');

    if (cancelBtn) {
        cancelBtn.addEventListener('click', (ev) => {
            if (ev) { ev.preventDefault(); ev.stopPropagation(); }
            tmClosePaymentRejectModal();
            document.removeEventListener('keydown', onKeyDown, true);
        }, true);
    }

    if (confirmBtn) {
        confirmBtn.addEventListener('click', (ev) => {
            if (ev) { ev.preventDefault(); ev.stopPropagation(); }

            tmClosePaymentRejectModal();
            document.removeEventListener('keydown', onKeyDown, true);

            // Allow the next click to proceed without re-prompting (prevents an infinite loop)
            tmPaymentRejectBypassOnce = true;

            // Trigger the original Reject button.
            try {
                originalRejectButton.click();
            } catch (e) {
                try {
                    originalRejectButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                } catch (_) { /* ignore */ }
            }
        }, true);
    }

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown, true);

    // Focus confirm for faster action
    try { if (confirmBtn) confirmBtn.focus(); } catch (_) { /* ignore */ }
}

function tmPaymentRejectConfirmOnClick(event) {
    if (!event) return;

    // If the previous click was a confirmed "Reject", allow it through without re-prompting.
    if (tmPaymentRejectBypassOnce) {
        tmPaymentRejectBypassOnce = false;
        return;
    }

    const target = event.target;
    if (!target || !target.closest) return;

    // Don't intercept clicks inside our own confirmation modal
    try {
        const modalRoot = document.getElementById(TM_PAYMENT_REJECT_MODAL_ID);
        if (modalRoot && target.closest('#' + TM_PAYMENT_REJECT_MODAL_ID)) return;
    } catch (_) { /* ignore */ }


    const btn = target.closest('button');
    if (!tmIsRejectButton(btn)) return;

    // Only gate when this is a paid ad
    if (!tmIsPaymentAdRightNow()) return;

    // Intercept and show confirmation modal
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

    tmShowPaymentRejectModal(btn);
}

function tmEnsureBindings() {
    // Bind manual-change detector once per category select element
    if (categorySelect && !categorySelect.dataset.tmManualBound) {
        categorySelect.dataset.tmManualBound = '1';
        categorySelect.addEventListener('change', () => {
            // If we changed it ourselves, don't clear the visual marker
            if (tmIsSettingCategory) return;
            tmLastAutoCategoryValue = null;
            tmClearAutoCategoryVisual(categorySelect);
        });
    }

    // Category helper UI (reset button + original badge)
    if (categorySelect) tmEnsureCategoryResetUI();

    // Bind backtick handler once globally (works even if fields re-render)
    if (!document.documentElement.dataset.tmBacktickTitleBound) {
        document.documentElement.dataset.tmBacktickTitleBound = '1';
        document.addEventListener('keydown', generateTitleFromSelections, true);
    }

    // Bind Payment AD reject confirmation once globally
    if (!document.documentElement.dataset.tmPaymentRejectConfirmBound) {
        document.documentElement.dataset.tmPaymentRejectConfirmBound = '1';
        document.addEventListener('click', tmPaymentRejectConfirmOnClick, true);
    }
}

function tmRefreshCoreElements() {
    titleField = document.getElementById('fields-title-value') || document.querySelector('#fields-title-value');
    categorySelect = document.getElementById('category') || document.querySelector('#category');
    blacklistedAccountCheckbox = tmFindBlacklistedCheckbox();
    tmEnsureBindings();

    // If category was auto-set earlier and the element re-rendered, restore the visual marker
    if (categorySelect && tmLastAutoCategoryValue && categorySelect.value === tmLastAutoCategoryValue) {
        tmApplyAutoCategoryVisual(categorySelect);
    }

    return { titleField, categorySelect, blacklistedAccountCheckbox };
}

function tmSetCategoryValue(newValue, { auto = false } = {}) {
    tmRefreshCoreElements();
    if (!categorySelect) return false;

    const prevValue = categorySelect.value;
    const prevText = tmGetSelectedText(categorySelect);
    const changed = categorySelect.value !== newValue;

    if (changed) {
        tmIsSettingCategory = true;
        categorySelect.value = newValue;
        triggerChangeEvent(categorySelect);
        tmDefer(() => { tmIsSettingCategory = false; });
    }

    if (auto) {
        // Snapshot the first "original" category (before auto-change) so we can show it later.
        if (!tmAutoChangedFromValue && prevValue && prevValue !== 'none') {
            tmAutoChangedFromValue = prevValue;
            tmAutoChangedFromText = prevText || null;
            try { categorySelect.setAttribute('data-tm-original-cat', String(prevValue)); } catch (_) {}
        }
        tmLastAutoCategoryValue = newValue;
        tmApplyAutoCategoryVisual(categorySelect);
        // Keep the Reset button visibility in sync
        tmDefer(() => tmEnsureCategoryResetUI(), 0);
    } else {
        // If set manually / restored, hide helper UI if needed
        tmDefer(() => tmEnsureCategoryResetUI(), 0);
    }

    return changed;
}

function tmGetSelectedText(selectEl) {
    if (!selectEl) return null;
    const opt = (selectEl.options && selectEl.selectedIndex >= 0) ? selectEl.options[selectEl.selectedIndex] : null;
    const txt = opt ? (opt.textContent || '').trim() : '';
    return txt || null;
}


    // --- NEW FUNCTION: Check for Shop with specific memberships ---
    /**
     * Checks if the current ad is from a "Shop" with a "Business Premium" or "Business Plus" membership.
     * This function is intended to run only on the verification page.
     * @returns {boolean} - True if the ad matches the membership criteria, otherwise false.
     */
    function checkMembershipStatus() {
        const currentUrl = window.location.href;
        const verificationPage = "https://admin.bikroy.com/review/item/verification";

        // Only run this check on the verification page
        if (!currentUrl.startsWith(verificationPage)) {
            return false;
        }

        const shopBubble = document.querySelector('span.ui-bubble.is-valid');
        const membershipBubble = document.querySelector('span.ui-bubble.is-membership-limits');

        if (shopBubble && shopBubble.textContent.trim() === 'Shop' && membershipBubble) {
            const membershipText = membershipBubble.textContent;
            // Check if the membership text indicates a Business Premium or Business Plus package for any category.
            if (membershipText.includes('ads in') && (membershipText.includes('Business Premium') || membershipText.includes('Business Plus'))) {
                console.log(`[Membership Check] Detected Shop with special membership: "${membershipText}". Halting modification actions.`);
                return true; // It's a special membership ad
            }
        }

        console.log("[Membership Check] Ad does not meet special membership criteria.");
        return false;
    }

    // --- Category, Item Type, Brand, and Model Mappings ---
    // IMPORTANT: The 'itemTypeValue's, 'brandValue's, and 'modelKeywords' are inferred or examples.
    // It is CRUCIAL that you VERIFY these values against the actual 'value' attributes
    // of the options that appear in the respective dropdowns on the live website.
    // You may also need to significantly EXPAND the keyword lists based on your specific needs.
    const CATEGORY_AND_ITEM_TYPE_MAP = [
        // Mobiles - Top-level category with direct brands/models (Category -> Brand -> Model)
        {
            categoryValue: "230", // Mobile Phones
            keywords: ["mobile phone"],
            itemTypes: [], // No itemType dropdown for Mobile Phones
            brandsAndModels: [
                { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: ["galaxy", "note", "s24", "a55"] },
                { brandKeywords: ["apple", "অ্যাপল", "iphone", "আইফোন"], brandValue: "apple", modelKeywords: ["iphone", "আইফোন", "15 pro", "14 pro max"] },
                { brandKeywords: ["xiaomi", "শাওমি", "redmi", "poco"], brandValue: "xiaomi", modelKeywords: ["redmi note", "poco f5", "mi 13"] },
                { brandKeywords: ["vivo", "ভিভো"], brandValue: "vivo", modelKeywords: ["v30", "y100"] },
                { brandKeywords: ["oppo", "অপো"], brandValue: "oppo", modelKeywords: ["reno", "f25"] },
                { brandKeywords: ["realme", "রিয়েলমি"], brandValue: "realme", modelKeywords: ["narzo", "c67"] },
                { brandKeywords: ["oneplus", "ওয়ানপ্লাস"], brandValue: "oneplus", modelKeywords: ["nord", "12r"] },
                { brandKeywords: ["nokia", "নোকিয়া"], brandValue: "nokia", modelKeywords: ["c21", "g400"] },
                { brandKeywords: ["huawei", "হুয়াওয়ে"], brandValue: "huawei", modelKeywords: ["nova", "p50"] },
                { brandKeywords: ["symphony", "সিম্ফনি"], brandValue: "symphony", modelKeywords: ["z60", "i60"] },
                { brandKeywords: ["itel", "আইটেল"], brandValue: "itel", modelKeywords: ["s23", "a70"] },
                { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: ["primo h9", "nxt"] },
                { brandKeywords: ["infinix", "ইনফিনিক্স"], brandValue: "infinix", modelKeywords: ["hot 40", "note 40"] },
                { brandKeywords: ["tecno", "টেকনো"], brandValue: "tecno", modelKeywords: ["spark 20", "camon 30"] },
                { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: [] },
                { brandKeywords: ["motorola", "মটোরোলা"], brandValue: "motorola", modelKeywords: [] },
                { brandKeywords: ["aamra", "আমড়া"], brandValue: "aamra", modelKeywords: [] },
                { brandKeywords: ["acer", "এসার"], brandValue: "acer", modelKeywords: [] },
                { brandKeywords: ["zte"], brandValue: "zte", modelKeywords: [] },
                { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other", "অন্যান্য"], brandValue: "other", modelKeywords: [] }
            ]
        },

        // Musical Instruments
        {
            categoryValue: "332",
            keywords: ["piano", "ulanzi", "drums", "bass guitar", "ukulele", "violin", "cello", "percussion", "guitar", "electric guitar", "string instrument", "guitar amplifier", "studio equipment", "live music equipment", "woodwind", "microphone",
                       "মাইক্রোফোন", "মিউজিক্যাল ইন্সট্রুমেন্ট", "পিয়ানো", "ড্রামস", "পারকাশন", "গিটার", "স্ট্রিং ইন্সট্রুমেন্ট", "এম্প্লিফায়ার", "স্টুডিও সরঞ্জাম", "লাইভ মিউজিক সরঞ্জাম", "ভিনাইল", "উডউইন্ড"],
            itemTypes: [
                { itemTypeValue: "keyboard_piano", name: "harmonium", keywords: ["piano", "electric piano", "digital piano", "synthesizer", "পিয়ানো", "সিন্থেসাইজার"], brandsAndModels: [] },
                { itemTypeValue: "percussion_drums", keywords: ["percussion", "drums", "drum set", "percussion instrument", "ড্রামস", "পারকাশন", "তবলা", "খঞ্জনি"], brandsAndModels: [] },
                { itemTypeValue: "string_instrument_amplifier", name: "guitar", keywords: ["string instrument", "guitar", "bass guitar", "ukulele", "violin", "cello", "guitar amplifier", "guitar amplifier", "স্ট্রিং ইন্সট্রুমেন্ট", "গিটার", "বেস গিটার", "ভায়োলিন", "গিটার এম্প্লিফায়ার"], brandsAndModels: [] },
                { itemTypeValue: "studio_live_music_equipment", name: "microphone", keywords: ["microphone", "ulanzi", "live music equipment", "wireless microphone", "mixer", "audio interface", "monitor speaker", "মাইক্রোফোন", "লাইভ মিউজিক সরঞ্জাম"], brandsAndModels: [] },
                { itemTypeValue: "vinyl", keywords: ["vinyl", "vinyl record", "record player", "গ্রামোফোন", "রেকর্ড প্লেয়ার"], brandsAndModels: [] },
                { itemTypeValue: "woodwind_brass", keywords: ["woodwind", "flute", "saxophone", "trumpet", "clarinet", "বাঁশি", "স্যাক্সোফোন", "ট্রাম্পেট"], brandsAndModels: [] },
                { itemTypeValue: "other", keywords: ["other", "অন্যান্য বাদ্যযন্ত্র"], brandsAndModels: [] }
            ],
            brandsAndModels: [
                { brandKeywords: ["yamaha", "ইয়ামাহা"], brandValue: "yamaha", modelKeywords: [] },
                { brandKeywords: ["casio", "ক্যাসিও"], brandValue: "casio", modelKeywords: [] },
                { brandKeywords: ["gibson"], brandValue: "gibson", modelKeywords: [] },
                { brandKeywords: ["fender"], brandValue: "fender", modelKeywords: [] },
                { brandKeywords: ["roland", "রোল্যান্ড"], brandValue: "roland", modelKeywords: [] },
                { brandKeywords: ["other brand", "other", "অন্যান্য ব্র্যান্ড", "অন্যান্য"], brandValue: "other_brand", modelKeywords: [] }
            ]
        },

        // Children's Items
        {
            categoryValue: "283",
            keywords: ["car seat carrier", "baby carrier", "stroller", "toys", "baby bike", "baby tricycle", "baby nakshikatha",
                       "বেবি নকশীকাথা", "বেবি ক্যারিয়ার", "বেবি আইটেম", "খেলনা", "বাচ্চাদের খেলনা", "পুতুল", "স্ট্রলার", "খেলনা", "বাচ্চাদের বাইক", "বাচ্চাদের গাড়ী"],
            itemTypes: [
                { itemTypeValue: "baby_item", name: "baby nakshikatha", keywords: ["বেবি নকশীকাথা", "baby nakshikatha"], brandsAndModels: [] },
                { itemTypeValue: "car_seat_carrier", keywords: ["car seat carrier", "baby carrier", "infant car seat", "বেবি ক্যারিয়ার"], brandsAndModels: [] },
                { itemTypeValue: "pram_stroller", name: "Baby Stroller", keywords: ["stroller", "baby pram", "baby stroller", "প্রাম", "স্ট্রলার", "বেবি প্রাম"], brandsAndModels: [] },
                { itemTypeValue: "toy", name: "Kids Toy", keywords: ["toy", "toys", "children's toy", "kids toy", "educational toy", "খেলনা", "বাচ্চাদের খেলনা", "পুতুল", "গাড়ি খেলনা"], brandsAndModels: [] },
                { itemTypeValue: "other", name: "baby tricycle", keywords: ["baby bike", "baby tricycle", "বাচ্চাদের বাইক", "বাচ্চাদের গাড়ী"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands for children's items are typically not in a dropdown for classifieds
        },

        // Fitness & Gym
        {
            categoryValue: "316",
            keywords: ["dumbbells", "treadmills", "exercise bikes", "weight loss", "gym equipment", "exercise equipment", "yoga mat", "walking machine", "running machine", "jump rope",
                       "ডাম্বেল", "ট্রেডমিল", "ব্যায়াম বাইক", "ওজন কমানো", "জিম সরঞ্জাম", "ব্যায়ামের সরঞ্জাম"],
            itemTypes: [
                { itemTypeValue: "dumbbells", name: "Dumbbells", keywords: ["dumbbells", "ডাম্বেল", "weights", "বারবেল"], brandsAndModels: [] },
                { itemTypeValue: "treadmills", name: "Treadmill", keywords: ["treadmills", "ট্রেডমিল", "walking machine", "running machine"], brandsAndModels: [] },
                { itemTypeValue: "exercise_bikes", name: "Exercise Bike", keywords: ["exercise bikes", "ব্যায়াম বাইক", "stationary bike", "সাইক্লিং মেশিন"], brandsAndModels: [] },
                { itemTypeValue: "weight_loss", keywords: ["weight loss", "ওজন কমানো", "slimming belt", "weight loss machine", "স্লিমিং বেল্ট"], brandsAndModels: [] },
                { itemTypeValue: "others", keywords: ["others", "অন্যান্য ফিটনেস সরঞ্জাম", "yoga mat", "jump rope", "resistance band", "ইয়োগা ম্যাট", "দড়ি লাফ"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands for gym equipment are typically not in a dropdown for classifieds
        },

        // Other Hobby, Sport & Kids items
        {
            categoryValue: "347", // Other Hobby, Sport & Kids items
            name: "Drone", // Added name for title generation
            keywords: ["drone", "drone camera", "skating shoe", "rubik's cube", // New keywords provided by user
                       "ড্রোন", "ড্রোন ক্যামেরা", "স্কেটিং সু"],
        },

        // Sports
        {
            categoryValue: "315", // Sports
            keywords: ["cricket", "cricket bat", "cricket jersey", "cricket ball", "cricket kit", "fishing rod", "camping", "football", "football", "football boot", "football jersey", "board games", "carrom board", "chess", "badminton", "jersey", "racket", "boxing", "martial arts", "boxing gloves", "punching bag",
                       "বক্সিং", "মার্শাল আর্টস", "ক্রিকেট", "ক্রিকেট", "ক্রিকেট ব্যাট", "ক্রিকেট বল", "টেবিল টেনিস", "ফিশিং", "ক্যাম্পিং", "ফুটবল", "ফুটবল বুট", "ফুটবল জার্সি", "লুডো", "দাবা", "ক্যারাম বোর্ড", "কেরাম বোর্ড", "ইনডোর স্পোর্টস", "মাছ ধরার ছিপ", "তাঁবু"],
            itemTypes: [
                { itemTypeValue: "boxing_martial_arts", name: "Boxing & Martial Arts", keywords: ["boxing", "martial arts", "boxing gloves", "punching bag", "বক্সিং", "মার্শাল আর্টস", "বক্সিং গ্লাভস"], brandsAndModels: [] },
                { itemTypeValue: "cricket", name: "Cricket Bat", keywords: ["cricket", "cricket bat", "cricket jersey", "cricket ball", "wicket", "cricket kit", "ক্রিকেট", "ক্রিকেট ব্যাট", "ক্রিকেট বল"], brandsAndModels: [] },
                { itemTypeValue: "fishing_camping", name: "Fishing & Camping", keywords: ["fishing", "camping", "fishing rod", "tent for sale", "sleeping bag", "ফিশিং", "ক্যাম্পিং", "মাছ ধরার ছিপ", "তাঁবু"], brandsAndModels: [] },
                { itemTypeValue: "football", name: "Football Boot", keywords: ["football", "football boot", "football jersey", "soccer", "manchester", "barcelona", "ফুটবল", "ফুটবল বুট", "ফুটবল জার্সি"], brandsAndModels: [] },
                { itemTypeValue: "game_board_game", name: "Carrom Board", keywords: ["carrom board", "board games", "ludo", "chess", "carrom", "বোর্ড গেম", "লুডো", "দাবা", "ক্যারাম বোর্ড"], brandsAndModels: [] },
                { itemTypeValue: "hockey", name: "Hockey", keywords: ["hockey", "hockey stick", "হকি", "হকি স্টিক"], brandsAndModels: [] },
                { itemTypeValue: "indoor_sports", name: "Badminton Racket", keywords: ["indoor sports", "table tennis", "badminton", "basketball indoor", "টেবিল টেনিস", "ব্যাডমিন্টন", "বাস্কেটবল"], brandsAndModels: [] },
                { itemTypeValue: "other", name: "Other Sports Item", keywords: ["others", "অন্যান্য খেলাধুলা", "outdoor sports", "সাইক্লিং", "swimming", "সাঁতার"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands for sports items are typically not in a dropdown for classifieds
        },

        // Bathroom Products
        {
            categoryValue: "264", // Bathroom & Sanitary
            keywords: ["basin", "wash basin", "bathtub", "shower cabin", "mirror", "commode", "sanitary items", "geyser", "faucet", "bathroom mirror", "shower cabin",
                       "বেসিন", "হাত ধোয়ার বেসিন", "বাথটাব", "গিজার", "শাওয়ার কেবিন", "কমোড", "বাথরুম আয়না", "বাথরুমের আয়না"],
            itemTypes: [
                { itemTypeValue: "basin", name: "Basin", keywords: ["basin", "বেসিন", "wash basin", "হাত ধোয়ার বেসিন"], brandsAndModels: [] },
                { itemTypeValue: "bathtub", name: "Bathtub", keywords: ["bathtub", "shower cabin", "বাথটাব", "শাওয়ার কেবিন"], brandsAndModels: [] },
                { itemTypeValue: "mirror", name: "Bathroom Mirror", keywords: ["bathroom mirror", "বাথরুম আয়না", "বাথরুমের আয়না"], brandsAndModels: [] },
                { itemTypeValue: "commode", name: "Commode", keywords: ["commode", "কমোড", "ওয়াটার ক্লোসেট"], brandsAndModels: [] },
                { itemTypeValue: "sanitary_items", name: "Faucet", keywords: ["sanitary items", "স্যানিটারি আইটেম", "faucet", "shower", "flush", "শাওয়ার"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Geyser", keywords: ["geyser", "গিজার"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands for bathroom products are typically not in a dropdown for classifieds
        },

        // Bedroom Furniture
        {
            categoryValue: "249", // Bedroom Furniture
            keywords: ["bedroom set", "bedroom furniture set", "\\bbed\\b", "khat", "khaat", "double bed", "single bed", "queen size bed", "king size bed", "bunk bed", "bed side table", "almirah", "almari", "wardrobe", "wardrobes", "dressing table", "bed side table", "drawer", "locker", "trunk", "alna", "locker",
                       "বেডরুম ফার্নিচার", "খাট", "মেহগনি খাট", "আকাসি খাট", "আকাশি খাট", "আলমারি", "স্টিলের আলমারি", "ওয়ারড্রব", "ওয়ারড্রোব", "কাপড়ের ওয়ারড্রব", "স্টিলের ওয়ারড্রব", "আলনা", "ড্রেসিং টেবিল", "বেড সাইড টেবিল", "ড্রয়ার", "সিন্দুক","লকার", "ট্রাঙ্ক", "আলনা"],
            itemTypes: [
                { itemTypeValue: "almirah", name: "Almirah", keywords: ["almirah", "almari", "আলমারি", "কাপড়ের আলমারি", "স্টিলের আলমারি"], brandsAndModels: [] },
                { itemTypeValue: "bed_side_table", name: "Bed Side Table", keywords: ["bed side table", "বেড সাইড টেবিল", "নাইট স্ট্যান্ড", "নাইট টেবিল"], brandsAndModels: [] },
                { itemTypeValue: "beds", name: "Bed", keywords: ["\\bbed\\b", "খাট", "khat", "khaat", "double bed", "single bed", "queen size bed", "king size bed", "bunk bed", "মেহগনি খাট", "আকাসি খাট", "আকাশি খাট"], brandsAndModels: [] },
                { itemTypeValue: "drawer", name: "Drawer", keywords: ["drawer", "ড্রয়ার", "chest of drawers", "ড্রয়ার টেবিল"], brandsAndModels: [] },
                { itemTypeValue: "dressing_tables", name: "Dressing Table", keywords: ["dressing tables", "dressing table", "ড্রেসিং টেবিল", "মিরর টেবিল"], brandsAndModels: [] },
                { itemTypeValue: "locker", name: "Locker", keywords: ["locker", "লকার", "সেফ", "সিন্দুক লকার", "গোপন লকার"], brandsAndModels: [] },
                { itemTypeValue: "rack", name: "Rack", keywords: [], brandsAndModels: [] }, // Keywords kept as provided
                { itemTypeValue: "trunk", name: "Trunk", keywords: ["trunk", "ট্রাঙ্ক", "সিন্দুক", "বাক্স ট্রাঙ্ক", "কাঠের ট্রাঙ্ক"], brandsAndModels: [] },
                { itemTypeValue: "wardrobes", name: "Wardrobe", keywords: ["alna","wardrobes", "wardrobe", "ওয়ারড্রব", "কাপড়ের ওয়ারড্রব", "স্টিলের ওয়ারড্রব", "আলনা"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Furniture", keywords: ["others", "অন্যান্য বেডরুম ফার্নিচার"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands for furniture are typically not in a dropdown for classifieds, but rather free text or specific brands in itemType.
        },

        // Children's Furniture
        {
            categoryValue: "251", // Children's Furniture
            keywords: ["baby cot", "baby dolna", "baby swing", "kids bed", "children's bed", "single bed for kids", "bunk bed for kids", "kids bunk bed", "high chair", "booster seat", "swing", "kids reading table", "feeding chair", "baby bouncer", "baby rocker",
                       "বেবি কট", "বাচ্চাদের খাট", "শিশুদের খাট", "বাচ্চাদের দোলনা", "হাই চেয়ার", "বুস্টার সিট", "ঝুলনা", "বাচ্চাদের পড়ার টেবিল", "বেবি বাউন্সার", "বাউন্সার", "বেবি রকার"],
            itemTypes: [
                { itemTypeValue: "baby_cot", name: "Baby Cot", keywords: ["baby cot", "বেবি কট", "infant cot", "শিশুদের খাট", "cradle"], brandsAndModels: [] },
                { itemTypeValue: "kids_bed", name: "Kids Bed", keywords: ["kids bed", "বাচ্চাদের খাট", "children's bed", "single bed for kids", "bunk bed for kids", "kids bunk bed"], brandsAndModels: [] },
                { itemTypeValue: "high_chair", name: "Booster Seat", keywords: ["high chair", "booster seats", "হাই চেয়ার", "বুস্টার সিট", "feeding chair", "খাবার চেয়ার", "baby booster"], brandsAndModels: [] },
                { itemTypeValue: "swing", name: "Baby Swing", keywords: ["baby dolna", "swing", "baby swing", "বাচ্চাদের দোলনা"], brandsAndModels: [] }, // Corrected keyword for swing
                { itemTypeValue: "kids_reading_table", name: "Kids Reading Table", keywords: ["kids reading table", "বাচ্চাদের পড়ার টেবিল", "children's study table", "kids desk", "study desk for kids"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands for children's furniture are typically not in a dropdown for classifieds
        },

        // Home Textiles & Decoration
        {
            categoryValue: "579", // Home Textiles & Decoration
            keywords: ["blanket", "cushion", "sofa cover", "curtain", "porda", "window curtain", "door curtain", "cushion", "bed covers", "bedsheet", "bed sheet", "mattress", "bedding", "carpet", "home decor", "handicrafts", "antiques", "paintings", "toshok", "jajim", "zazim", "flower vase", "wall decor", "showpiece", "paintings", "painting", "wall art",
                       "কম্বল", "লেপ", "সোফা কভার", "বালিশের কভার", "সোফার ফোম", "পর্দা", "জানালার পর্দা", "দরজার পর্দা", "কুশন", "বেড কভার", "তোশক", "জাজিম", "ম্যাট্রেস", "বেডিং", "কার্পেট", "গৃহ সজ্জা", "হস্তশিল্প", "এন্টিক", "চিত্রকর্ম", "আর্টিফিশিয়াল ফুল", "কার্পেট"],
            itemTypes: [
                { itemTypeValue: "blanket", name: "Blanket", keywords: ["blanket", "কম্বল", "quilt", "লেপ"], brandsAndModels: [] },
                { itemTypeValue: "box", name: "Tissue Box", keywords: ["tissue box"], brandsAndModels: [] },
                { itemTypeValue: "curtains", name: "Curtains", keywords: ["curtain", "পর্দা", "porda", "window curtain", "door curtain", "জানালার পর্দা", "দরজার পর্দা"], brandsAndModels: [] },
                { itemTypeValue: "cushions_covers", name: "Sofa Cover", keywords: ["cushion", "sofa cover", "কুশন", "সোফা কভার", "pillow cover", "বালিশের কভার", "সোফার ফোম"], brandsAndModels: [] },
                { itemTypeValue: "mattresses_bedding", name: "Mattress", keywords: ["mattress", "bedding", "তোশক", "বেডিং", "ম্যাট্রেস", "জাজিম", "বালিশ", "চাদর", "bedsheet"], brandsAndModels: [] },
                { itemTypeValue: "carpets", name: "Carpet", keywords: ["carpet", "কার্পেট", "rug", "মাদুর"], brandsAndModels: [] },
                { itemTypeValue: "home_decor", name: "Showpiece", keywords: ["flower vase", "wall decor", "showpiece", "ফ্লাওয়ার ভাস", "শোপিস", "আর্টিফিশিয়াল ফুল"], brandsAndModels: [] },
                { itemTypeValue: "handicrafts", name: "Nakshi Katha", keywords: ["handicrafts", "হস্তশিল্প", "crafts", "আর্ট পিস","কাঁথা"], brandsAndModels: [] },
                { itemTypeValue: "antique", name: "Antique Showpiece", keywords: ["antiques", "এন্টিক", "পুরাতন জিনিস", "vintage"], brandsAndModels: [] },
                { itemTypeValue: "painting", name: "Painting", keywords: ["paintings", "painting", "চিত্রকর্ম", "wall art", "দেয়াল চিত্র"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands are typically not in a dropdown for these item types on classifieds.
        },

        // Doors
        {
            categoryValue: "265",
            keywords: ["door", "doors", "wooden door", "glass door", "aluminium door", "steel door", "pvc door", "main door", "interior door", "bathroom door", "kitchen door",
                       "দরজা", "কাঠের দরজা", "গ্লাস দরজা", "অ্যালুমিনিয়াম দরজা", "স্টিল দরজা", "পিভিসি দরজা", "মেইন ডোর", "ইন্টেরিয়র ডোর", "বাথরুমের দরজা", "কিচেন দরজা"],
            itemTypes: [
                { itemTypeValue: "wooden", keywords: ["wooden door", "wood door", "কাঠের দরজা"], brandsAndModels: [] },
                { itemTypeValue: "glass", keywords: ["glass door", "glass panel door", "গ্লাস দরজা"], brandsAndModels: [] },
                { itemTypeValue: "aluminium", keywords: ["aluminium door", "aluminum door", "অ্যালুমিনিয়াম দরজা"], brandsAndModels: [] },
                { itemTypeValue: "steel", keywords: ["steel door", "স্টিল দরজা"], brandsAndModels: [] },
                { itemTypeValue: "pvc", keywords: ["pvc door", "পিভিসি দরজা"], brandsAndModels: [] },
                { itemTypeValue: "main_door", keywords: ["main door", "front door", "মেইন ডোর", "প্রধান দরজা"], brandsAndModels: [] },
                { itemTypeValue: "interior_door", keywords: ["interior door", "room door", "ইন্টেরিয়র ডোর", "ঘরের দরজা"], brandsAndModels: [] },
                { itemTypeValue: "bathroom_door", keywords: ["bathroom door", "বাথরুমের দরজা"], brandsAndModels: [] },
                { itemTypeValue: "kitchen_door", keywords: ["kitchen door", "কিচেন দরজা"], brandsAndModels: [] },
                { itemTypeValue: "glass_door", keywords: ["sliding glass door", "glass sliding door"], brandsAndModels: [] },
                { itemTypeValue: "other", keywords: ["other", "others", "অন্যান্য"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },

        // Kitchen & Dining Furniture
        {
            categoryValue: "248", // Kitchen & Dining Furniture
            keywords: ["kitchen rack", "kitchen cabinet", "dining table", "dining chair", "dining chairs", "oven rack", "dish rack", "cutlery rack", "kitchen trolley",
                        "ক্যাবিনেট", "ডাইনিং টেবিল", "ডাইনিং চেয়ার", "কিচেন র‍্যাক", "কিচেন ট্রলি", "রান্নাঘরের র‍্যাক"],
            itemTypes: [
                { itemTypeValue: "cabinets", name: "Kitchen Cabinet", keywords: ["kitchen cabinet", "কিচেন ক্যাবিনেট"], brandsAndModels: [] },
                { itemTypeValue: "dining_table_chairs", name: "Dining Table", keywords: ["dining table", "dining chairs", "ডাইনিং টেবিল", "ডাইনিং চেয়ার", "dinner table", "6 seater dining table", "4 seater dining table"], brandsAndModels: [] },
                { itemTypeValue: "racks_trolleys", name: "Kitchen Rack", keywords: ["kitchen trolley", "কিচেন র‍্যাক", "কিচেন ট্রলি", "kitchen rack", "serving trolley", "রান্নাঘরের র‍্যাক", "storage trolley"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Furniture", keywords: ["others", "অন্যান্য রান্নাঘরের ফার্নিচার", "kitchen island", "buffet cabinet"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands for furniture are typically not in a dropdown for classifieds
        },

        // Office & Shop Furniture
        {
            categoryValue: "250", // Office & Shop Furniture
            keywords: ["bench", "cabinet", "conference table", "meeting table", "boss chair", "counter", "reception counter", "shop counter", "dokan counter", "office desk", "office table", "boss table", "display rack", "dokan stand", "drawer", "office chair", "official chair", "parlor furniture", "printer rack", "reception table", "stool", "workstation desk", "decoration", "malamal", "parlor bed",
                       "বেঞ্চ", "ক্যাবিনেট", "কনফারেন্স টেবিল", "কাউন্টার", "ডেস্ক", "ডিসপ্লে র‍্যাক", "দোকান স্ট্যান্ড", "ড্রয়ার", "ডিসপ্লে সুকেশ", "ডিসপ্লে সুকেস", "ডিসপ্লে সুকেজ", "অফিস চেয়ার", "অফিসের টেবিল", "পার্লার ফার্নিচার", "প্রিন্টার র‍্যাক", "রিসেপশন টেবিল", "স্টুল", "ডেকোরেশন", "মালামাল", "বস চেয়ার", "পার্লার বেড"],
            itemTypes: [
                { itemTypeValue: "bench", name: "Bench", keywords: ["bench", "বেঞ্চ"], brandsAndModels: [] },
                { itemTypeValue: "conference_tables", name: "Conference Table", keywords: ["conference table", "কনফারেন্স টেবিল", "meeting table"], brandsAndModels: [] },
                { itemTypeValue: "counter", name: "Counter Table", keywords: ["counter", "কাউন্টার", "reception counter", "shop counter"], brandsAndModels: [] },
                { itemTypeValue: "desks", name: "Office Desk", keywords: ["ডেস্ক", "অফিসের টেবিল", "office desk", "boss table"], brandsAndModels: [] },
                { itemTypeValue: "display_racks", name: "Display Rack", keywords: ["display rack", "ডিসপ্লে র‍্যাক", "display shelf", "ডিসপ্লে সুকেশ", "ডিসপ্লে সুকেস", "ডিসপ্লে সুকেজ", "শোকেস র‍্যাক"], brandsAndModels: [] },
                { itemTypeValue: "dokan_stand", name: "Dokan Stand", keywords: ["dokan stand", "দোকান স্ট্যান্ড", "shop stand"], brandsAndModels: [] },
                { itemTypeValue: "door", name: "Door", keywords: ["office door"], brandsAndModels: [] },
                { itemTypeValue: "drawer", name: "Office Drawer", keywords: ["office drawer", "অফিস ড্রয়ার", "drawer unit"], brandsAndModels: [] },
                { itemTypeValue: "office_chairs", name: "Office Chair", keywords: ["office chairs", "অফিস চেয়ার", "বস চেয়ার", "executive chair", "boss chair", "revolving chair"], brandsAndModels: [] },
                { itemTypeValue: "office_cabinet", name: "Office Cabinet", keywords: ["office cabinet", "অফিস ক্যাবিনেট", "file cabinet", "ফাইল ক্যাবিনেট"], brandsAndModels: [] },
                { itemTypeValue: "parlor_furniture", name: "Parlor Furniture", keywords: ["parlor furniture", "parlor bed", "পার্লার বেড", "পার্লার ফার্নিচার", "salon chair", "বিউটি পার্লার ফার্নিচার"], brandsAndModels: [] },
                { itemTypeValue: "printer_rack", name: "Printer Rack", keywords: ["printer rack", "প্রিন্টার র‍্যাক"], brandsAndModels: [] },
                { itemTypeValue: "reception_tables", name: "Reception Table", keywords: ["reception table", "রিসেপশন টেবিল", "front desk"], brandsAndModels: [] },
                { itemTypeValue: "shop", name: "Malamal & Decoration", keywords: ["দোকানের সরঞ্জাম", "decoration", "malamal", "ডেকোরেশন", "মালামাল"], brandsAndModels: [] }, // Adjusted name for clarity
                { itemTypeValue: "stool", name: "Stool", keywords: ["stool", "স্টুল"], brandsAndModels: [] },
                { itemTypeValue: "workstations", name: "Workstation", keywords: ["workstation desk"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Furniture", keywords: ["others", "অন্যান্য অফিস ফার্নিচার", "অন্যান্য দোকানের ফার্নিচার"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands for furniture are typically not in a dropdown for classifieds
        },

        // Living Room Furniture
        {
            categoryValue: "247", // Living Room Furniture
            name: "Living Room Furniture", // Added name for title generation
            keywords: ["sofa", "divan", "\\btable\\b", "chair", "showcase", "bookcase", "shelf", "bookshelf", "book shelf", "dolna", "rocking chair", "computer table", "shoe rack", "stool", "swing", "tv stand", "tv cabinet",
                       "সোফা", "ডিভান", "ডিভাইন", "টেবিল", "চেয়ার", "শোকেস", "সুকেশ", "সুকেস", "বুককেস", "শেল্ফ", "দোলনা", "মোরা", "রকিং চেয়ার", "শু র‍্যাক", "স্টুল", "ঝুলনা", "টিভি স্ট্যান্ড"],
            itemTypes: [
                { itemTypeValue: "bookcases_shelves", name: "Bookshelf", keywords: ["shelf", "shelves", "বুককেস", "বুকশেল্ফ","শেল্ফ", "বইয়ের তাক", "ওয়াল শেল্ফ"], brandsAndModels: [] },
                { itemTypeValue: "centre_side_tables", name: "Centre Table", keywords: ["centre table", "tea table", "side table", "সেন্টার টেবিল", "সাইড টেবিল", "coffee table", "কফি টেবিল"], brandsAndModels: [] },
                { itemTypeValue: "dolna", name: "Dolna", keywords: ["dolna", "দোলনা", "swings", "ঝুলনা চেয়ার"], brandsAndModels: [] },
                { itemTypeValue: "mora", name: "Mora", keywords: ["মোরা", "puff", "পাফ"], brandsAndModels: [] },
                { itemTypeValue: "rocking_chair", name: "Rocking Chair", keywords: ["rocking chair", "রকিং চেয়ার"], brandsAndModels: [] },
                { itemTypeValue: "shoe_racks", name: "Shoe Rack", keywords: ["shoe rack", "শু র‍্যাক", "জুতার র‍্যাক"], brandsAndModels: [] },
                { itemTypeValue: "showcases", name: "Showcase", keywords: ["showcase", "শোকেস", "সুকেশ", "সুকেস", "display cabinet", "গ্লাস শোকেস"], brandsAndModels: [] },
                { itemTypeValue: "sofas", name: "Sofa", keywords: ["sofa set", "ডিভান", "ডিভাইন", "সোফা", "সোফা সেট", "l-shape sofa", "fabric sofa"], brandsAndModels: [] },
                { itemTypeValue: "stool", name: "Stool", keywords: ["stool", "স্টুল", "tool"], brandsAndModels: [] },
                { itemTypeValue: "swing", name: "Swing", keywords: ["swing", "দোলনা", "indoor swing", "lawn swing"], brandsAndModels: [] },
                { itemTypeValue: "tables_chairs", name: "Table/Chair", keywords: ["reading table", "computer table", "chairs", "টেবিল", "চেয়ার", "প্লাস্টিকের চেয়ার"], brandsAndModels: [] },
                { itemTypeValue: "tv_stands", name: "TV Stand", keywords: ["tv stands", "টিভি স্ট্যান্ড", "tv cabinet", "টিভি ক্যাবিনেট"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Furniture", keywords: ["others", "অন্যান্য লিভিং রুম ফার্নিচার"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands for furniture are typically not in a dropdown for classifieds
        },

        // Household Items
        {
            categoryValue: "256", // Household Items
            keywords: ["dinner set", "drill machine", "machineries", "ketli", "kitchen scale", "water pump", "sewing machine", "Knife Set", "table mat", "lunch box", "tiffin box", "grinder",
                       "ডিনার সেট", "কেটলি", "রান্নাঘর", "র‍্যাক", "মাপার যন্ত্র", "সেলাই মেশিন", "টেবিল ম্যাট", "ড্রিল মেশিন"],
            itemTypes: [
                { itemTypeValue: "cool_box", name: "Cool Box", keywords: ["cool box", "কুল বক্স", "ice box", "আইস বক্স"], brandsAndModels: [] },
                { itemTypeValue: "dinner_set", name: "Dinner Set", keywords: ["dinner set", "ডিনার সেট", "crockery", "থালাবাসন"], brandsAndModels: [] },
                { itemTypeValue: "garden", name: "Drill Machine", keywords: ["drill machine", "water pump", "mud pump", "grinding machine", "grinder", "গ্রাইন্ডিং মেশিন", "ড্রিল মেশিন"], brandsAndModels: [] }, // 'garden' for 'Tools & Machineries'
                { itemTypeValue: "ketli", name: "Ketli", keywords: ["ketli", "kettle", "কেটলি", "tea kettle", "চা কেটলি"], brandsAndModels: [] },
                { itemTypeValue: "kitchen_dining", name: "Crockeries", keywords: ["flask", "Knife Set", "lunch box", "tiffin box"], brandsAndModels: [] }, // Name adjusted to clarify it's an item, not furniture
                { itemTypeValue: "rack", name: "Rack", keywords: ["router stand", "রাউটার স্ট্যান্ড"], brandsAndModels: [] },
                { itemTypeValue: "scale", name: "Kitchen Scale", keywords: ["kitchen scale", "কিচেন স্কেল"], brandsAndModels: [] },
                { itemTypeValue: "sewing_machine", name: "Sewing Machine", keywords: ["sewing machine", "সেলাই মেশিন"], brandsAndModels: [] },
                { itemTypeValue: "table_mat", name: "Table Mat", keywords: ["table mat", "টেবিল ম্যাট"], brandsAndModels: [] },
                { itemTypeValue: "other", name: "Other Household Item", keywords: ["mobaj tala", "মোবাজ তালা", "others", "অন্যান্য গৃহস্থালী পণ্য"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands are typically not in a dropdown for these item types on classifieds.
        },
        {
            categoryValue: "1206", // Household
            keywords: ["mosquito bat", "air freshner"],
            itemTypes: [
                { itemTypeValue: "cleaning", name: "", keywords: [], brandsAndModels: [] },
                { itemTypeValue: "laundry", name: "Laundry Detergent", keywords: [], brandsAndModels: [] },
                { itemTypeValue: "dish_washing", name: "Dish Washing Liquid", keywords: [], brandsAndModels: [] },
                { itemTypeValue: "tissues_disposables", name: "Tissue", keywords: [], brandsAndModels: [] },
                { itemTypeValue: "fresheners", name: "Air Freshner", keywords: ["air freshner"], brandsAndModels: [] },
                { itemTypeValue: "repellents", name: "Mosquito Repellent", keywords: ["mosquito bat"], brandsAndModels: [] },
                { itemTypeValue: "other", name: "Shopping Bag", keywords: ["Shopping Bag"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands are typically not in a dropdown for these item types on classifieds.
        },
        // Grocery
        {
            categoryValue: "1201",
            keywords: ["beverages", "frozen food", "pulses", "canned food", "packaged food", "dairy", "snacks", "chocolate", "baking", "cooking",
                       "পানীয়", "ফ্রোজেন ফুড", "ক্যানড ফুড", "প্যাকেটজাত খাবার", "দুগ্ধজাত পণ্য", "গুড়", "চকোলেট", "বেকিং", "সরিষার তেল",
                      ],
            itemTypes: [
                { itemTypeValue: "beverages", keywords: ["\\btea\\b", "coffee", "কফি"], brandsAndModels: [] },
                { itemTypeValue: "frozen", keywords: ["frozen food", "ফ্রোজেন ফুড", "আইসক্রিম", "সসেজ", "বার্গার প্যাটি"], brandsAndModels: [] },
                { itemTypeValue: "canned", keywords: ["canned", "canned food", "dry food", "packaged food", "ক্যানড ফুড", "প্যাকেটজাত খাবার", "শুকনো খাবার"], brandsAndModels: [] },
                { itemTypeValue: "dairy_chilled", keywords: ["dairy", "chilled", "দুগ্ধজাত পণ্য", "দুধ", "দই", "মাখন", "পনির"], brandsAndModels: [] },
                { itemTypeValue: "snacks", keywords: ["biscuits", "snacks", "chocolates", "বিস্কুট", "স্ন্যাকস", "চকোলেট", "চিপস", "কেক", "ক্যান্ডি"], brandsAndModels: [] },
                { itemTypeValue: "baking_cooking", keywords: ["baking", "cooking", "soyabean oil", "mustard oil", "spice", "\\bsalt\\b", "sugar", "মসলা", "তেল", "চিনি", "লবণ"], brandsAndModels: [] },
                { itemTypeValue: "bakery", keywords: ["bakery", "bread", "cake", "গুড়", "বনরুটি"], brandsAndModels: [] },
                { itemTypeValue: "personal_care", keywords: ["soap", "shampoo", "toothpaste", "সাবান", "শ্যাম্পু", "টুথপেস্ট"], brandsAndModels: [] },
                { itemTypeValue: "other", keywords: ["miscellaneous grocery"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands for grocery items are usually not in a dropdown for a classifieds site
        },
        // Baby Products
        { categoryValue: "1204",
            keywords: ["breast pump",
                      ],
            itemTypes: [
                { itemTypeValue: "baby_food", keywords: [], brandsAndModels: [] },
                { itemTypeValue: "diapers_wipes", keywords: ["baby diaper", "diaper"], brandsAndModels: [] },
                { itemTypeValue: "skin_haircare", keywords: ["baby lotion", "baby shampoo", "baby soap", "baby oil"], brandsAndModels: [] },
                { itemTypeValue: "baby_accessories", keywords: ["baby feeder"], brandsAndModels: [] },
                { itemTypeValue: "for_mom", keywords: ["breast pump"], brandsAndModels: [] },
                { itemTypeValue: "other", keywords: [], brandsAndModels: [] },
            ],
            brandsAndModels: []
        },

        // Mobile Phone Accessories
        {
            categoryValue: "231",
            keywords: ["charger", "adopter", "adapter", "power bank", "mobile cover", "মোবাইল এক্সেসরিজ", "চার্জার", "অ্যাডাপ্টার", "পাওয়ার ব্যাংক", "মোবাইল কভার", "রিং লাইট",
                       "screen protector", "display", "motherboard", "battery", "memory card", "c type cable", "type c cable", "cable", "\\bholder\\b", "case", "vr box", "selfie stick"],
            itemTypes: [
                { itemTypeValue: "charger", name: "Charger", keywords: ["charger", "চার্জার", "fast charger", "wireless charger", "wall charger"], brandsAndModels: [] },
                { itemTypeValue: "adopter", name: "Adopter", keywords: ["adopter", "adapter", "অ্যাডাপ্টার", "চার্জার অ্যাডাপ্টার"], brandsAndModels: [] },
                { itemTypeValue: "display", name: "Display", keywords: ["display", "screen", "lcd", "oled", "ডিসপ্লে", "স্ক্রিন"], brandsAndModels: [] },
                { itemTypeValue: "power_bank", name: "Power Bank", keywords: ["power bank", "পাওয়ার ব্যাংক", "portable charger"], brandsAndModels: [] },
                { itemTypeValue: "selfie_stick", name: "Selfie Stick", keywords: ["selfie stick", "সেলফি স্টিক"], brandsAndModels: [] },
                { itemTypeValue: "c_type_cable", name: "C type Cable", keywords: ["c type cable", "type c cable", "usb c", "সি টাইপ কেবল"], brandsAndModels: [] },
                { itemTypeValue: "battery", name: "Battery", keywords: ["battery", "ব্যাটারি"], brandsAndModels: [] },
                { itemTypeValue: "motherboard", name: "Motherboard", keywords: ["motherboard", "main board", "মাদারবোর্ড", "মেইন বোর্ড"], brandsAndModels: [] },
                { itemTypeValue: "phone_cover_case", name: "Phone Cover / Case", keywords: ["phone cover", "mobile cover", "case", "phone case", "মোবাইল কভার", "ফোন কেস"], brandsAndModels: [] },
                { itemTypeValue: "memory_card", name: "Memory Card", keywords: ["memory card", "sd card", "microsd", "মেমোরি কার্ড"], brandsAndModels: [] },
                { itemTypeValue: "power_banks", name: "Power Banks", keywords: ["power banks", "power bank", "পাওয়ার ব্যাংক"], brandsAndModels: [] },
                { itemTypeValue: "screen_protectors", name: "Screen Protectors", keywords: ["screen protector", "স্ক্রিন প্রোটেক্টর", "tempered glass", "গ্লাস প্রোটেক্টর"], brandsAndModels: [] },
                { itemTypeValue: "chargers", name: "Chargers", keywords: ["chargers", "charger", "চার্জার"], brandsAndModels: [] },
                { itemTypeValue: "cables", name: "Cables", keywords: ["cable", "ক্যাবল", "usb cable", "charging cable", "data cable"], brandsAndModels: [] },
                { itemTypeValue: "holders_stands", name: "Holders & Stands", keywords: ["\\bholder\\b", "mobile holder", "ফোন স্ট্যান্ড", "car phone holder", "ring holder"], brandsAndModels: [] },
                { itemTypeValue: "bags_cases", name: "Bags & Cases", keywords: ["case", "mobile cover", "phone cover", "মোবাইল কভার", "ফোন কেস", "mobile pouch"], brandsAndModels: [] },
                { itemTypeValue: "vr_boxes", name: "VR Boxes", keywords: ["vr box", "ভিআর বক্স", "virtual reality box"], brandsAndModels: [] },
                { itemTypeValue: "selfie_sticks", name: "Selfie Sticks", keywords: ["selfie stick", "সেলফি স্টিক", "রিং লাইট"], brandsAndModels: [] },
                { itemTypeValue: "other", keywords: ["parts", "অন্যান্য এক্সেসরিজ", "mobile tripod", "mobile lens"], brandsAndModels: [] }
            ],
            brandsAndModels: [
                { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: [] },
                { brandKeywords: ["xiaomi", "শাওমি", "redmi", "poco"], brandValue: "xiaomi", modelKeywords: [] },
                { brandKeywords: ["apple", "অ্যাপল", "iphone", "আইফোন"], brandValue: "apple", modelKeywords: [] },
                { brandKeywords: ["vivo", "ভিভো"], brandValue: "vivo", modelKeywords: [] },
                { brandKeywords: ["oppo", "অপো"], brandValue: "oppo", modelKeywords: [] },
                { brandKeywords: ["realme", "রিয়েলমি"], brandValue: "realme", modelKeywords: [] },
                { brandKeywords: ["infinix", "ইনফিনিক্স"], brandValue: "infinix", modelKeywords: [] },
                { brandKeywords: ["tecno", "টেকনো"], brandValue: "tecno", modelKeywords: [] },
                { brandKeywords: ["google", "গুগল", "pixel"], brandValue: "google", modelKeywords: [] },
                { brandKeywords: ["oneplus", "ওয়ানপ্লাস"], brandValue: "oneplus", modelKeywords: [] },
                { brandKeywords: ["motorola", "মটোরোলা"], brandValue: "motorola", modelKeywords: [] },
                { brandKeywords: ["itel", "আইটেল"], brandValue: "itel", modelKeywords: [] },
                { brandKeywords: ["nokia", "নোকিয়া"], brandValue: "nokia", modelKeywords: [] },
                { brandKeywords: ["symphony", "সিম্ফনি"], brandValue: "symphony", modelKeywords: [] },
                { brandKeywords: ["huawei", "হুয়াওয়ে"], brandValue: "huawei", modelKeywords: [] },
                { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                { brandKeywords: ["honor"], brandValue: "honor", modelKeywords: [] },
                { brandKeywords: ["sony", "সনি"], brandValue: "sony", modelKeywords: [] },
                { brandKeywords: ["iqoo"], brandValue: "iqoo", modelKeywords: [] },
                { brandKeywords: ["nothing"], brandValue: "nothing", modelKeywords: [] },
                { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: [] },
                { brandKeywords: ["other brand", "other", "অন্যান্য ব্র্যান্ড", "অন্যান্য"], brandValue: "other_brand", modelKeywords: [] }
            ]
        },
        { categoryValue: "103", keywords: ["mobile phone service", "phone repair", "মোবাইল সার্ভিস", "ফোন মেরামত"], itemTypes: [] },
        { categoryValue: "102", keywords: ["sim card", "সিম কার্ড"], itemTypes: [] },
        {
            categoryValue: "232", // Wearables
            name: "Wearables", // Added name for title generation
            keywords: ["smartwatch", "fitness tracker", "স্মার্টওয়াচ", "ফিটনেস ট্র্যাকার", "smart band", "fitness band", "স্মার্ট ব্যান্ড", "smart watch", "apple watch", "smartband"],
            itemTypes: [

                {
                    itemTypeValue: "smart_watch",
                    name: "Smart Watch", // Added name for title generation
                    keywords: ["smart watch", "smartwatch", "স্মার্টওয়াচ", "android watch", "apple watch"],
                    brandsAndModels: []
                },
                {
                    itemTypeValue: "fitness_bands",
                    name: "Fitness Band", // Added name for title generation
                    keywords: ["fitness band", "smart band", "ফিটনেস ব্যান্ড", "স্মার্ট ব্যান্ড"],
                    brandsAndModels: []
                }
            ],
            brandsAndModels: [] // Brands are nested within itemTypes
        },

        // Video Game Consoles & Accessories
        {
            categoryValue: "242",
            keywords: ["video game", "console", "playstation", "xbox", "nintendo", "game accessory", "video game console", "gamepad", "joystick", "vr headset", "game cd", "game cassette", "pc game", "ভিডিও গেম", "কন্সোল", "প্লেস্টেশন", "এক্সবক্স", "নিন্টেন্ডো"],
            itemTypes: [
                {
                    itemTypeValue: "consoles", // Video Game Consoles
                    keywords: ["video game console", "console", "playstation", "xbox", "nintendo switch", "ps5", "ps4", "xbox series x", "xbox one", "sega genesis", "gaming console"],
                    brandsAndModels: [
                        { brandKeywords: ["microsoft xbox", "xbox"], brandValue: "microsoft_xbox", modelKeywords: ["xbox series x", "xbox series s", "xbox one", "xbox 360"] },
                        { brandKeywords: ["nintendo"], brandValue: "nintendo", modelKeywords: ["switch", "wii", "wii u", "nintendo switch", "switch oled", "switch lite"] },
                        { brandKeywords: ["sony playstation", "playstation", "ps"], brandValue: "sony_play_station", modelKeywords: ["ps5", "ps4", "ps3", "playstation 5", "playstation 4"] },
                        { brandKeywords: ["sega genesis", "sega"], brandValue: "sega_genesis", modelKeywords: [] }, // Listed as a brand value in dropdown
                        { brandKeywords: ["apple"], brandValue: "apple", modelKeywords: [] }, // Listed as a brand value in dropdown (e.g., Apple Arcade gaming, Apple TV)
                        { brandKeywords: ["chromecast"], brandValue: "chromecast", modelKeywords: [] }, // Listed as a brand value in dropdown (less common for console, but present)
                        { brandKeywords: ["wii u"], brandValue: "wii_u", modelKeywords: [] }, // Listed as a brand value in dropdown
                        { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other"], brandValue: "other", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "accessories", // Video Game Accessories
                    keywords: ["controller", "gamepad", "joystick", "racing wheel", "steering wheel", "gaming chair", "game controller"],
                    brandsAndModels: [
                        { brandKeywords: ["microsoft xbox", "xbox"], brandValue: "microsoft_xbox", modelKeywords: ["xbox controller", "elite controller"] },
                        { brandKeywords: ["nintendo"], brandValue: "nintendo", modelKeywords: ["joy-con", "pro controller", "nunchuk"] },
                        { brandKeywords: ["sony playstation", "playstation", "ps"], brandValue: "sony_play_station", modelKeywords: ["dualsense", "dualshock"] },
                        { brandKeywords: ["logitech", "লজিটেক"], brandValue: "logitech", modelKeywords: ["g29", "f310"] }, // Popular gaming accessory brand, if present in overall brand list
                        { brandKeywords: ["razer", "রেজার"], brandValue: "other", modelKeywords: ["kishi", "wolverine"] }, // Popular gaming accessory brand, using 'other' if not directly listed
                        { brandKeywords: ["apple"], brandValue: "apple", modelKeywords: [] }, // As a brand for accessories
                        { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other"], brandValue: "other", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "games", // Video Games
                    keywords: ["video game", "playstation game", "xbox game", "nintendo game"],
                    brandsAndModels: [
                        { brandKeywords: ["sony playstation", "playstation", "ps"], brandValue: "sony_play_station", modelKeywords: ["god of war", "spiderman", "fifa"] }, // Popular game titles
                        { brandKeywords: ["microsoft xbox", "xbox"], brandValue: "microsoft_xbox", modelKeywords: ["halo", "forza", "gears of war"] },
                        { brandKeywords: ["nintendo"], brandValue: "nintendo", modelKeywords: ["zelda", "mario", "pokemon"] },
                        { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other"], brandValue: "other", modelKeywords: [] } // For other game publishers/generic games
                    ]
                }
            ],
            brandsAndModels: [] // All brands/models are nested under itemTypes
        },

        // TV & Video Accessories
        {
            categoryValue: "850",
            keywords: ["dish tv", "chromecast", "dth", "hdmi cable", "mini projector", "nano laser", "projector", "receiver", "satellite tv", "set top box", "vcr", "vga", "video player", "tv box", "tv card", "ভিডিও এক্সেসরিজ", "প্রজেক্টর", "অ্যামপ্লিফায়ার", "সেট টপ বক্স", "টিভি কার্ড", "স্মার্ট টিভি কার্ড"],
            itemTypes: [
                { itemTypeValue: "chromecast", keywords: ["chromecast", "ক্রোমকাস্ট", "google chromecast"], brandsAndModels: [{ brandKeywords: ["google", "গুগল"], brandValue: "other", modelKeywords: [] }] }, // Assuming 'other'
                { itemTypeValue: "dth", name: "akash dth", keywords: ["dth", "ডিটিএইচ"], brandsAndModels: [{ brandKeywords: ["akash dth", "আকাশ ডিটিএইচ"], brandValue: "other", modelKeywords: [] }] }, // Assuming 'other'
                { itemTypeValue: "hdmi_cable", name: "hdmi cable", keywords: ["hdmi cable", "এইচডিএমআই ক্যাবল"], brandsAndModels: [] }, // Usually generic brands
                { itemTypeValue: "mini_box", keywords: ["mini box", "মিনি বক্স"], brandsAndModels: [] },
                { itemTypeValue: "mini_projector", keywords: ["mini projector", "মিনি প্রজেক্টর"], brandsAndModels: [
                    { brandKeywords: ["epson", "ইপসন"], brandValue: "epson", modelKeywords: [] },
                    { brandKeywords: ["xiaomi", "শাওমি"], brandValue: "xiaomi", modelKeywords: [] }
                ]},
                { itemTypeValue: "nano_laser", keywords: ["nano laser", "ন্যানো লেজার"], brandsAndModels: [] },
                { itemTypeValue: "projector", name: "projector", keywords: ["projector", "প্রজেক্টর", "ভিডিও প্রজেক্টর"], brandsAndModels: [
                    { brandKeywords: ["epson", "ইপসন"], brandValue: "epson", modelKeywords: ["eb-", "powerlite"] },
                    { brandKeywords: ["benq", "বেনকিউ"], brandValue: "other", modelKeywords: ["th series", "tk series"] }, // Assuming 'other'
                    { brandKeywords: ["optoma", "অপ্টোমা"], brandValue: "other", modelKeywords: [] }, // Assuming 'other'
                    { brandKeywords: ["viewsonic", "ভিউসোনিক"], brandValue: "other", modelKeywords: [] } // Assuming 'other'
                ]},
                { itemTypeValue: "receiver", keywords: ["receiver", "রিসিভার"], brandsAndModels: [
                    { brandKeywords: ["sony", "সনি"], brandValue: "sony", modelKeywords: [] },
                    { brandKeywords: ["yamaha", "ইয়ামাহা"], brandValue: "yamaha", modelKeywords: [] }
                ]},
                { itemTypeValue: "satellite_tv", keywords: ["satellite tv", "স্যাটেলাইট টিভি"], brandsAndModels: [] },
                { itemTypeValue: "set_top_box", keywords: ["set top box", "সেট টপ বক্স", "android box", "স্মার্ট বক্স"], brandsAndModels: [
                    { brandKeywords: ["xiaomi", "শাওমি", "mi"], brandValue: "mi", modelKeywords: ["mi box", "mi stick"] },
                    { brandKeywords: ["tenda", "টেন্ডা"], brandValue: "other", modelKeywords: [] } // Assuming 'other'
                ]},
                { itemTypeValue: "vcr", keywords: ["vcr"], brandsAndModels: [] },
                { itemTypeValue: "vga", name: "vga cable", keywords: ["vga", "ভিজিএ"], brandsAndModels: [] },
                { itemTypeValue: "video_player", keywords: ["video player", "ডিভিডি প্লেয়ার", "dvd player", "ব্লু-রে প্লেয়ার", "bluray player"], brandsAndModels: [
                    { brandKeywords: ["sony", "সনি"], brandValue: "sony", modelKeywords: [] },
                    { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: [] },
                    { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", modelKeywords: [] }
                ]},
                { itemTypeValue: "tv_boxes_cards", name: "android tv box", keywords: ["tv box", "tv card", "টিভি বক্স", "টিভি কার্ড", "স্মার্ট টিভি কার্ড"], brandsAndModels: [] },
                { itemTypeValue: "other_accessory", keywords: ["other accessory", "অন্যান্য এক্সেসরিজ"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // All brands/models are nested under itemTypes
        },

        // TVs
        {
            categoryValue: "851", // TVs
            name: "LED TV",
            keywords: ["television", "\\btv\\b", "led tv", "smart tv", "android tv", "4k tv", "full hd tv", "টেলিভিশন", "টিভি", "স্মার্ট টিভি", "এলইডি টিভি", "অ্যান্ড্রয়েড টিভি"],
            itemTypes: [], // Assuming no further item_type dropdown for TVs directly
            brandsAndModels: [
                { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: ["qled", "crystal uhd", "ফ্রেম টিভি", "the frame", "neo qled", "au series"] },
                { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: ["oled", "nanocell", "ইউএইচডি টিভি", "uhd tv", "oled evo", "uq series"] },
                { brandKeywords: ["sony", "সনি"], brandValue: "sony", modelKeywords: ["bravia", "ব্রাভিয়া", "x series", "a series"] },
                { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: ["walton smart tv", "walton led", "wsa series"] },
                { brandKeywords: ["philips", "ফিলিপস"], brandValue: "philips", modelKeywords: ["ambilight"] },
                { brandKeywords: ["xiaomi", "শাওমি", "mi"], brandValue: "mi", modelKeywords: ["মি টিভি", "রেডমি টিভি", "mi tv stick"] }, // 'mi' is the brandValue here
                { brandKeywords: ["haier", "হায়ার"], brandValue: "haier", modelKeywords: [] },
                { brandKeywords: ["hisense", "হিসেন্স"], brandValue: "hisense", modelKeywords: [] },
                { brandKeywords: ["bluestar", "ব্লুস্টার"], brandValue: "bluestar", modelKeywords: [] },
                { brandKeywords: ["daeivoo", "ডেইভো"], brandValue: "daeivoo", modelKeywords: [] },
                { brandKeywords: ["elite", "এলিট"], brandValue: "elite", modelKeywords: [] },
                { brandKeywords: ["jamuna", "যমুনা"], brandValue: "jamuna", modelKeywords: [] },
                { brandKeywords: ["minister", "মিনিস্টার"], brandValue: "minister", modelKeywords: [] },
                { brandKeywords: ["national", "ন্যাশনাল"], brandValue: "national", modelKeywords: [] },
                { brandKeywords: ["onida", "ওনিডা"], brandValue: "onida", modelKeywords: [] },
                { brandKeywords: ["osaca", "ওসাকা"], brandValue: "osaca", modelKeywords: [] },
                { brandKeywords: ["sansui", "সানসুই"], brandValue: "sansui", modelKeywords: [] },
                { brandKeywords: ["sharp", "শার্প"], brandValue: "sharp", modelKeywords: [] },
                { brandKeywords: ["symphony", "সিম্ফনি"], brandValue: "symphony", modelKeywords: [] },
                { brandKeywords: ["toshiba", "তোশিবা"], brandValue: "toshiba", modelKeywords: [] },
                { brandKeywords: ["transtec", "ট্রান্সটেক"], brandValue: "transtec", modelKeywords: [] },
                { brandKeywords: ["videocon", "ভিডিওকন"], brandValue: "videocon", modelKeywords: [] },
                { brandKeywords: ["viomi", "ভিওমি"], brandValue: "viomi", modelKeywords: [] },
                { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other"], brandValue: "other", modelKeywords: [] }
            ]
        },

        // Refrigerators & Freezers
        {
            categoryValue: "852",
            name: "Refrigerators & Freezers",
            keywords: ["refrigerator", "fridge", "freezer", "mini freezer", "display fridge", "water dispenser", "water cooler",
                       "ফ্রিজ", "ফ্রীজ", "রেফ্রিজারেটর", "ডিপ ফ্রিজ", "ওয়াটার ডিসপেনসার", "ওয়াটার কুলার", "ডিসপ্লে ফ্রিজ"],
            itemTypes: [
                { itemTypeValue: "refrigerator", keywords: ["refrigerator", "fridge", "ফ্রিজ", "ফ্রীজ", "রেফ্রিজারেটর"], brandsAndModels: [] },
                { itemTypeValue: "freezer", keywords: ["freezer", "deep freezer", "ডিপ ফ্রিজ", "ডিপ ফ্রিজার"], brandsAndModels: [] },
                { itemTypeValue: "water_dispenser", keywords: ["water dispenser", "ওয়াটার ডিসপেনসার"], brandsAndModels: [] },
                { itemTypeValue: "display_fridge", keywords: ["display fridge", "glass door fridge", "ডিসপ্লে ফ্রিজ", "শো কেস ফ্রিজ"], brandsAndModels: [] },
                { itemTypeValue: "water_cooler", keywords: ["water cooler", "ওয়াটার কুলার"], brandsAndModels: [] },
                { itemTypeValue: "mini_freezer", keywords: ["mini freezer", "mini fridge", "ছোট ফ্রিজ"], brandsAndModels: [] }
            ],
            brandsAndModels: [
                { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: [] },
                { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: [] },
                { brandKeywords: ["whirlpool", "হুইরপুল"], brandValue: "whirlpool", modelKeywords: [] },
                { brandKeywords: ["haier", "হায়ার"], brandValue: "haier", modelKeywords: [] },
                { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", modelKeywords: [] },
                { brandKeywords: ["sharp", "শার্প"], brandValue: "sharp", modelKeywords: [] },
                { brandKeywords: ["hitachi", "হিটাচি"], brandValue: "hitachi", modelKeywords: [] },
                { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                { brandKeywords: ["singer", "সিঙ্গার"], brandValue: "singer", modelKeywords: [] },
                { brandKeywords: ["toshiba", "তোশিবা"], brandValue: "toshiba", modelKeywords: [] },
                { brandKeywords: ["other brand", "other", "অন্যান্য ব্র্যান্ড", "অন্যান্য"], brandValue: "other", modelKeywords: [] }
            ]
        },

        // Electronics - Home Appliances (Category -> Item Type -> Brand -> Model)
        {
            categoryValue: "898", // Home Appliances (Corrected Category ID)
            keywords: ["washing machine", "ওয়াশিং মেশিন", "dryer", "ড্রায়ার", "dishwasher",
                       "oven", "microwave", "ওভেন", "মাইক্রোওয়েভ ওভেন", "toaster", "টোস্টার",
                       "blender", "juicer", "mixer", "beater", "ব্লেন্ডার", "জুসার", "মিক্সার", "বিটার",
                       "roti maker", "ruti maker", "yogurt maker", "kima maker", "salad maker", "sandwich maker", "রুটি মেকার", "কিমা মেকার", "সালাদ মেকার", "স্যান্ডউইচ মেকার", "দই মেকার",
                       "stove", "gas stove", "induction cooker", "infrared cooker", "electric cooker", "চুলা", "স্টোভ", "ইলেক্ট্রিক কুকার",
                       "rice cooker", "curry cooker", "frying pan", "pressure cooker", "রাইস কুকার", "ফ্রাইং পেন", "প্রেসার কুকার", "কারি কুকার",
                       "vacuum cleaner", "ভ্যাকুয়াম ক্লিনার", "\\biron\\b", "ইস্ত্রি",
                       "water filter", "water purifier", "filter", "ওয়াটার ফিল্টার", "পানির ফিল্টার", "ফিল্টার", "ওয়াটার পিউরিফায়ার",
                       "stabilizer", "voltage stabilizer", "স্ট্যাবিলাইজার", "স্টেব্লাইজার",
                       "coffee maker", "কফি মেকার", "egg boiler", "ডিম সিদ্ধ করার মেশিন", "fruit cleaner", "ফল পরিষ্কারক",
                       "sealer", "সিলার", "kitchen hood", "কিচেন হুড"
                      ],
            itemTypes: [
                { itemTypeValue: "coffee_maker", name: "coffee maker", keywords: ["coffee maker", "কফি মেকার"], brandsAndModels: [
                    { brandKeywords: ["philips", "ফিলিপস"], brandValue: "philips", modelKeywords: [] },
                    { brandKeywords: ["delonghi", "ডেলংহি"], brandValue: "delonghi", modelKeywords: [] },
                    { brandKeywords: ["miyako", "মিয়াকো"], brandValue: "miyako", modelKeywords: [] }
                ]},
                { itemTypeValue: "dryer", keywords: ["dryer", "ড্রায়ার", "cleaning appliance", "ভ্যাকুয়াম ক্লিনার", "vacuum cleaner"], brandsAndModels: [ // 'dryer' value for 'Cleaning Appliances'
                    { brandKeywords: ["philips", "ফিলিপস"], brandValue: "philips", modelKeywords: [] },
                    { brandKeywords: ["xiaomi", "শাওমি"], brandValue: "xiaomi", modelKeywords: [] },
                    { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: [] },
                    { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: [] }
                ]},
                { itemTypeValue: "egg_boiler", keywords: ["egg boiler", "ডিম সিদ্ধ করার মেশিন"], brandsAndModels: [
                    { brandKeywords: ["nova", "নোভা"], brandValue: "nova", modelKeywords: [] }
                ]},
                { itemTypeValue: "fruit_cleaner", name: "fruit cleaner", keywords: ["fruit cleaner", "ফল পরিষ্কারক"], brandsAndModels: [] },
                { itemTypeValue: "irons", name: "iron", keywords: ["\\biron\\b", "ইস্ত্রি"], brandsAndModels: [
                    { brandKeywords: ["philips", "ফিলিপস"], brandValue: "philips", modelKeywords: [] },
                    { brandKeywords: ["singer", "সিঙ্গার"], brandValue: "singer", modelKeywords: [] },
                    { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                    { brandKeywords: ["nova", "নোভা"], brandValue: "nova", modelKeywords: [] }
                ]},
                { itemTypeValue: "juicer_blender", name: "blender", keywords: ["juicer", "blender", "mixer", "beater", "জুসার", "ব্লেন্ডার", "মিক্সার", "বিটার", "ব্যালেন্ডার"], brandsAndModels: [
                    { brandKeywords: ["philips", "ফিলিপস"], brandValue: "philips", modelKeywords: [] },
                    { brandKeywords: ["singer", "সিঙ্গার"], brandValue: "singer", modelKeywords: [] },
                    { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                    { brandKeywords: ["miyako", "মিয়াকো"], brandValue: "miyako", modelKeywords: [] },
                    { brandKeywords: ["nova", "নোভা"], brandValue: "nova", modelKeywords: [] },
                    { brandKeywords: ["rfl", "আরএফএল"], brandValue: "rfl", modelKeywords: [] },
                    { brandKeywords: ["vision", "ভিশন"], brandValue: "vision", modelKeywords: [] },
                    { brandKeywords: ["noah"], brandValue: "noah", modelKeywords: [] }
                ]},
                { itemTypeValue: "kitchen_dining", name: "kitchen hood", keywords: ["kitchen hood", "কিচেন হুড"], brandsAndModels: [ // 'kitchen_dining' value for 'Kitchen Hood'
                    { brandKeywords: ["faber", "ফেবার"], brandValue: "other", modelKeywords: [] }, // Assuming 'other'
                    { brandKeywords: ["whirlpool", "হুইরপুল"], brandValue: "whirlpool", modelKeywords: [] }
                ]},
                { itemTypeValue: "maker_toaster", keywords: ["roti maker", "ruti maker", "yogurt maker", "kima maker", "salad maker", "sandwich maker", "রুটি মেকার", "কিমা মেকার", "সালাদ মেকার", "স্যান্ডউইচ মেকার", "দই মেকার", "toaster", "টোস্টার"], brandsAndModels: [
                    { brandKeywords: ["singer", "সিঙ্গার"], brandValue: "singer", modelKeywords: [] },
                    { brandKeywords: ["prestige", "প্রেষ্টিজ"], brandValue: "prestige", modelKeywords: [] },
                    { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                    { brandKeywords: ["rfl", "আরএফএল"], brandValue: "rfl", modelKeywords: [] },
                    { brandKeywords: ["nova", "নোভা"], brandValue: "nova", modelKeywords: [] }
                ]},
                { itemTypeValue: "power_supply", keywords: ["power supply", "পাওয়ার সাপ্লাই", "voltage regulator"], brandsAndModels: [
                    { brandKeywords: ["stabilizer", "স্ট্যাবিলাইজার", "voltage stabilizer"], brandValue: "stabilizer", modelKeywords: [] }, // Grouping stabilizer here
                    { brandKeywords: ["rfl", "আরএফএল"], brandValue: "rfl", modelKeywords: [] },
                    { brandKeywords: ["vision", "ভিশন"], brandValue: "vision", modelKeywords: [] },
                    { brandKeywords: ["v_guard", "ভি-গার্ড"], brandValue: "v_guard", modelKeywords: [] }
                ]},
                { itemTypeValue: "sealer", keywords: ["sealer", "সিলার", "vacuum sealer"], brandsAndModels: [] },
                { itemTypeValue: "stabilizer", keywords: ["stabilizer", "voltage stabilizer", "স্ট্যাবিলাইজার", "স্টেব্লাইজার"], brandsAndModels: [ // Separated from power_supply, if it's a distinct item type
                    { brandKeywords: ["rfl", "আরএফএল"], brandValue: "rfl", modelKeywords: [] },
                    { brandKeywords: ["vision", "ভিশন"], brandValue: "vision", modelKeywords: [] },
                    { brandKeywords: ["energypac", "এনার্জিপ্যাক"], brandValue: "energypac", modelKeywords: [] },
                    { brandKeywords: ["hamko", "হামকো"], brandValue: "hamko", modelKeywords: [] },
                    { brandKeywords: ["luminous", "লুমিনাস"], brandValue: "luminous", modelKeywords: [] },
                    { brandKeywords: ["v_guard", "ভি-গার্ড"], brandValue: "v_guard", modelKeywords: [] }
                ]},
                { itemTypeValue: "stove_oven", name: "microwave oven", keywords: ["oven", "microwave", "ওভেন", "মাইক্রোওয়েভ ওভেন"], brandsAndModels: [ // 'stove_oven' for Ovens & Microwaves
                    { brandKeywords: ["philips", "ফিলিপস"], brandValue: "philips", modelKeywords: [] },
                    { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", modelKeywords: [] },
                    { brandKeywords: ["singer", "সিঙ্গার"], brandValue: "singer", modelKeywords: [] },
                    { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                    { brandKeywords: ["prestige", "প্রেষ্টিজ"], brandValue: "prestige", modelKeywords: [] },
                    { brandKeywords: ["miyako", "মিয়াকো"], brandValue: "miyako", modelKeywords: [] },
                    { brandKeywords: ["minister", "মিনিস্টার"], brandValue: "minister", modelKeywords: [] },
                    { brandKeywords: ["nova", "নোভা"], brandValue: "nova", modelKeywords: [] }
                ]},
                { itemTypeValue: "stoves", name: "infrared cooker", keywords: ["stove", "gas stove", "induction cooker", "infrared cooker", "electric cooker", "চুলা", "স্টোভ", "ইলেক্ট্রিক কুকার"], brandsAndModels: [
                    { brandKeywords: ["rfl", "আরএফএল", "আর এফ এল"], brandValue: "rfl", modelKeywords: [] },
                    { brandKeywords: ["vision", "ভিশন"], brandValue: "vision", modelKeywords: [] },
                    { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                    { brandKeywords: ["singer", "সিঙ্গার"], brandValue: "singer", modelKeywords: [] },
                    { brandKeywords: ["miyako", "মিয়াকো"], brandValue: "miyako", modelKeywords: [] },
                ]},
                { itemTypeValue: "utensil_cooker", keywords: ["rice cooker", "curry cooker", "frying pan", "pressure cooker", "রাইস কুকার", "ফ্রাইং পেন", "প্রেসার কুকার", "কারি কুকার"], brandsAndModels: [ // 'utensil_cooker' for Cookers
                    { brandKeywords: ["singer", "সিঙ্গার"], brandValue: "singer", modelKeywords: [] },
                    { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                    { brandKeywords: ["miyako", "মিয়াকো"], brandValue: "miyako", modelKeywords: [] },
                    { brandKeywords: ["nova", "নোভা"], brandValue: "nova", modelKeywords: [] },
                    { brandKeywords: ["rfl", "আরএফএল"], brandValue: "rfl", modelKeywords: [] },
                    { brandKeywords: ["prestige", "প্রেষ্টিজ"], brandValue: "prestige", modelKeywords: [] },
                    { brandKeywords: ["vision", "ভিশন"], brandValue: "vision", modelKeywords: [] }
                ]},
                { itemTypeValue: "washing_machine_dishwasher", name: "washing machine", keywords: ["washing machine", "ওয়াশিং মেশিন", "dishwasher", "ডিশওয়াশার"], brandsAndModels: [
                    { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: ["front load", "top load", "addwash"] },
                    { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: ["direct drive", "twinwash"] },
                    { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                    { brandKeywords: ["bosch", "বশ"], brandValue: "bosch", modelKeywords: [] },
                    { brandKeywords: ["hitachi", "হিটাচি"], brandValue: "hitachi", modelKeywords: [] },
                    { brandKeywords: ["minister", "মিনিস্টার"], brandValue: "minister", modelKeywords: [] },
                    { brandKeywords: ["sharp", "শার্প"], brandValue: "sharp", modelKeywords: [] },
                    { brandKeywords: ["singer", "সিঙ্গার"], brandValue: "singer", modelKeywords: [] },
                    { brandKeywords: ["videocon", "ভিডিওকন"], brandValue: "videocon", modelKeywords: [] },
                    { brandKeywords: ["whirlpool", "হুইরপুল"], brandValue: "whirlpool", modelKeywords: [] }
                ]},
                { itemTypeValue: "water_purifier", name: "water purifier", keywords: ["water filter", "water purifier", "filter", "ওয়াটার ফিল্টার", "পানির ফিল্টার", "ফিল্টার", "ওয়াটার পিউরিফায়ার"], brandsAndModels: [
                    { brandKeywords: ["pureit", "পিউরিট"], brandValue: "pureit", modelKeywords: [] },
                    { brandKeywords: ["kent", "কেন্ট"], brandValue: "kent", modelKeywords: [] },
                    { brandKeywords: ["aquafresh", "অ্যাকোয়াফ্রেশ"], brandValue: "aquafresh", modelKeywords: [] },
                    { brandKeywords: ["nova", "নোভা"], brandValue: "nova", modelKeywords: [] },
                    { brandKeywords: ["rfl", "আরএফএল"], brandValue: "rfl", modelKeywords: [] },
                    { brandKeywords: ["vision", "ভিশন"], brandValue: "vision", modelKeywords: [] }
                ]},
                { itemTypeValue: "other_appliance", keywords: ["other appliance", "অন্যান্য অ্যাপ্লায়েন্স", "general appliance"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // All brands/models are now nested under itemTypes for Home Appliances
        },

        // Electronics - ACs & Home Electronics (Category -> Item Type -> Brand -> Model)
        {
            categoryValue: "899", // ACs & Home Electronics
            keywords: ["air conditioner", "window ac", "split ac", "central ac", "portable ac", "inverter ac", "\\bfan\\b", "stand fan", "table fan", "desk fan", "ceiling fan", "exhaust fan", "cabin fan",
                       "air cooler", "cooler", "heater", "humidifier", "solar", "generator", "lighting", "ips battery", "ips machine", // Core keywords for this category
                       "এসি", "উইন্ডো এসি", "স্প্লিট এসি", "সেন্ট্রাল এসি", "পোর্টেবল এসি", "ইনভার্টার এসি", "এয়ার কুলার", "ফ্যান", "স্ট্যান্ড ফ্যান", "টেবিল ফ্যান", "ডেস্ক ফ্যান", "সিলিং ফ্যান", "এক্সহস্ট ফ্যান",
                       "হিটার", "টেবিল লাইট", "হিউমিডিফায়ার", "সোলার", "জেনারেটর", "আলো", "লাইটিং", "আইপিএস"
                      ],
            itemTypes: [
                {
                    itemTypeValue: "window_ac",
                    name: "Window AC",
                    keywords: ["window ac", "window air conditioner", "উইন্ডো এসি", "উইন্ডো এয়ার কন্ডিশনার"],
                    brandsAndModels: [
                        { brandKeywords: ["gree", "গ্রি"], brandValue: "gree", modelKeywords: ["gree inverter", "gree non-inverter", "gree split", "gree cassette"] },
                        { brandKeywords: ["general", "জেনারেল"], brandValue: "general", modelKeywords: ["general inverter", "general split"] },
                        { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: ["samsung inverter", "samsung windfree"] },
                        { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: ["lg dual inverter", "lg artcool"] },
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: ["walton inverter", "walton non-inverter"] },
                        { brandKeywords: ["carrier", "ক্যারিয়ার"], brandValue: "carrier", modelKeywords: [] },
                        { brandKeywords: ["chigo", "চিগো"], brandValue: "chigo", modelKeywords: [] },
                        { brandKeywords: ["daikin", "ডাইকিন"], brandValue: "daikin", modelKeywords: [] },
                        { brandKeywords: ["electra", "ইলেক্ট্রা"], brandValue: "electra", modelKeywords: [] },
                        { brandKeywords: ["fujitsu", "ফুজিৎসু"], brandValue: "fujitsu", modelKeywords: [] },
                        { brandKeywords: ["midea", "মিডিয়া"], brandValue: "midea", modelKeywords: [] },
                        { brandKeywords: ["mitsubishi", "মিতসুবিশি"], brandValue: "mitsubishi", modelKeywords: [] },
                        { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", modelKeywords: [] },
                        { brandKeywords: ["sharp", "শার্প"], brandValue: "sharp", modelKeywords: [] },
                        { brandKeywords: ["toshiba", "তোশিবা"], brandValue: "toshiba", modelKeywords: [] },
                        { brandKeywords: ["voltas", "ভোল্টাস"], brandValue: "voltas", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "split_ac",
                    name: "Split AC",
                    keywords: ["split ac", "split air conditioner", "split unit ac", "স্প্লিট এসি"],
                    brandsAndModels: [
                        { brandKeywords: ["gree", "গ্রি"], brandValue: "gree", modelKeywords: ["gree inverter", "gree non-inverter", "gree split", "gree cassette"] },
                        { brandKeywords: ["general", "জেনারেল"], brandValue: "general", modelKeywords: ["general inverter", "general split"] },
                        { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: ["samsung inverter", "samsung windfree"] },
                        { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: ["lg dual inverter", "lg artcool"] },
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: ["walton inverter", "walton non-inverter"] },
                        { brandKeywords: ["carrier", "ক্যারিয়ার"], brandValue: "carrier", modelKeywords: [] },
                        { brandKeywords: ["chigo", "চিগো"], brandValue: "chigo", modelKeywords: [] },
                        { brandKeywords: ["daikin", "ডাইকিন"], brandValue: "daikin", modelKeywords: [] },
                        { brandKeywords: ["electra", "ইলেক্ট্রা"], brandValue: "electra", modelKeywords: [] },
                        { brandKeywords: ["fujitsu", "ফুজিৎসু"], brandValue: "fujitsu", modelKeywords: [] },
                        { brandKeywords: ["midea", "মিডিয়া"], brandValue: "midea", modelKeywords: [] },
                        { brandKeywords: ["mitsubishi", "মিতসুবিশি"], brandValue: "mitsubishi", modelKeywords: [] },
                        { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", modelKeywords: [] },
                        { brandKeywords: ["sharp", "শার্প"], brandValue: "sharp", modelKeywords: [] },
                        { brandKeywords: ["toshiba", "তোশিবা"], brandValue: "toshiba", modelKeywords: [] },
                        { brandKeywords: ["voltas", "ভোল্টাস"], brandValue: "voltas", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "central_ac",
                    name: "Central AC",
                    keywords: ["central ac", "central air", "central air conditioner", "সেন্ট্রাল এসি"],
                    brandsAndModels: [
                        { brandKeywords: ["gree", "গ্রি"], brandValue: "gree", modelKeywords: [] },
                        { brandKeywords: ["general", "জেনারেল"], brandValue: "general", modelKeywords: [] },
                        { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: [] },
                        { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: [] },
                        { brandKeywords: ["carrier", "ক্যারিয়ার"], brandValue: "carrier", modelKeywords: [] },
                        { brandKeywords: ["daikin", "ডাইকিন"], brandValue: "daikin", modelKeywords: [] },
                        { brandKeywords: ["mitsubishi", "মিতসুবিশি"], brandValue: "mitsubishi", modelKeywords: [] },
                        { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "portable_ac",
                    name: "Portable AC",
                    keywords: ["portable ac", "portable air conditioner", "পোর্টেবল এসি"],
                    brandsAndModels: [
                        { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: [] },
                        { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: [] },
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                        { brandKeywords: ["daikin", "ডাইকিন"], brandValue: "daikin", modelKeywords: [] },
                        { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "inverter_ac",
                    name: "Inverter AC",
                    keywords: ["inverter ac", "inverter air conditioner", "ইনভার্টার এসি"],
                    brandsAndModels: [
                        { brandKeywords: ["gree", "গ্রি"], brandValue: "gree", modelKeywords: [] },
                        { brandKeywords: ["general", "জেনারেল"], brandValue: "general", modelKeywords: [] },
                        { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: [] },
                        { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: [] },
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                        { brandKeywords: ["daikin", "ডাইকিন"], brandValue: "daikin", modelKeywords: [] },
                        { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "ac_coolers",
                    name: "ACs & Coolers",
                    keywords: ["air conditioner", "air cooler", "cooler", "এসি", "এয়ার কুলার"],
                    brandsAndModels: [
                        { brandKeywords: ["gree", "গ্রি"], brandValue: "gree", modelKeywords: ["gree inverter", "gree non-inverter", "gree split", "gree cassette"] },
                        { brandKeywords: ["general", "জেনারেল"], brandValue: "general", modelKeywords: ["general inverter", "general split"] },
                        { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: ["samsung inverter", "samsung windfree"] },
                        { brandKeywords: ["lg", "এলজি"], brandValue: "lg", modelKeywords: ["lg dual inverter", "lg artcool"] },
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: ["walton inverter", "walton non-inverter"] },
                        { brandKeywords: ["carrier", "ক্যারিয়ার"], brandValue: "carrier", modelKeywords: [] },
                        { brandKeywords: ["chigo", "চিগো"], brandValue: "chigo", modelKeywords: [] },
                        { brandKeywords: ["daikin", "ডাইকিন"], brandValue: "daikin", modelKeywords: [] },
                        { brandKeywords: ["electra", "ইলেক্ট্রা"], brandValue: "electra", modelKeywords: [] },
                        { brandKeywords: ["fujitsu", "ফুজিৎসু"], brandValue: "fujitsu", modelKeywords: [] },
                        { brandKeywords: ["midea", "মিডিয়া"], brandValue: "midea", modelKeywords: [] },
                        { brandKeywords: ["mitsubishi", "মিতসুবিশি"], brandValue: "mitsubishi", modelKeywords: [] },
                        { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", modelKeywords: [] },
                        { brandKeywords: ["sharp", "শার্প"], brandValue: "sharp", modelKeywords: [] },
                        { brandKeywords: ["toshiba", "তোশিবা"], brandValue: "toshiba", modelKeywords: [] },
                        { brandKeywords: ["voltas", "ভোল্টাস"], brandValue: "voltas", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "ips",
                    name: "IPS", keywords: ["ips machine", "আইপিএস মেশিন"],
                    brandsAndModels: [
                        { brandKeywords: ["lumin", "লুমিন"], brandValue: "luminous", modelKeywords: [] }, // Adjusted to match 'luminous' in dropdown
                        { brandKeywords: ["hamko", "হামকো"], brandValue: "hamko", modelKeywords: [] },
                        { brandKeywords: ["rahimafrooz", "রহিমাফ্রোজ"], brandValue: "rahimafrooz", modelKeywords: [] },
                        { brandKeywords: ["energypac", "এনার্জিপ্যাক"], brandValue: "energypac", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "battery",
                    keywords: ["ips battery"],
                    brandsAndModels: [
                        { brandKeywords: ["hamko", "হামকো"], brandValue: "hamko", modelKeywords: ["hamko hpd", "hamko super", "hamko ips"] },
                        { brandKeywords: ["rahimafrooz", "রহিমাফ্রোজ"], brandValue: "rahimafrooz", modelKeywords: ["rahimafrooz ips", "rahimafrooz tubular"] },
                        { brandKeywords: ["lucas", "লুকাস"], brandValue: "lucas", modelKeywords: [] },
                        { brandKeywords: ["luminous", "লুমিনাস"], brandValue: "luminous", modelKeywords: [] },
                        { brandKeywords: ["saif_power", "সাইফ পাওয়ার"], brandValue: "saif_power", modelKeywords: [] },
                        { brandKeywords: ["rimso", "রিমসো"], brandValue: "rimso", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "stand_fan",
                    name: "Stand Fan",
                    keywords: ["stand fan", "pedestal fan", "স্ট্যান্ড ফ্যান", "পেডেস্টাল ফ্যান"],
                    brandsAndModels: [
                        { brandKeywords: ["orient", "ওরিয়েন্ট"], brandValue: "orient", modelKeywords: [] },
                        { brandKeywords: ["usha", "উষা"], brandValue: "usha", modelKeywords: [] },
                        { brandKeywords: ["kent", "কেন্ট"], brandValue: "kent", modelKeywords: [] },
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                        { brandKeywords: ["crompton", "ক্রোমটন"], brandValue: "crompton", modelKeywords: [] },
                        { brandKeywords: ["gfc", "জিএফসি"], brandValue: "gfc", modelKeywords: [] },
                        { brandKeywords: ["havells", "হ্যাভেলস"], brandValue: "havells", modelKeywords: [] },
                        { brandKeywords: ["super_star", "সুপার স্টার"], brandValue: "super_star", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "table_desk_fan",
                    name: "Table / Desk Fan",
                    keywords: ["table fan", "desk fan", "টেবিল ফ্যান", "ডেস্ক ফ্যান"],
                    brandsAndModels: [
                        { brandKeywords: ["orient", "ওরিয়েন্ট"], brandValue: "orient", modelKeywords: [] },
                        { brandKeywords: ["usha", "উষা"], brandValue: "usha", modelKeywords: [] },
                        { brandKeywords: ["kent", "কেন্ট"], brandValue: "kent", modelKeywords: [] },
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                        { brandKeywords: ["crompton", "ক্রোমটন"], brandValue: "crompton", modelKeywords: [] },
                        { brandKeywords: ["gfc", "জিএফসি"], brandValue: "gfc", modelKeywords: [] },
                        { brandKeywords: ["havells", "হ্যাভেলস"], brandValue: "havells", modelKeywords: [] },
                        { brandKeywords: ["super_star", "সুপার স্টার"], brandValue: "super_star", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "exhaust_fan",
                    name: "Exhaust Fan",
                    keywords: ["exhaust fan", "এক্সহস্ট ফ্যান"],
                    brandsAndModels: [
                        { brandKeywords: ["orient", "ওরিয়েন্ট"], brandValue: "orient", modelKeywords: [] },
                        { brandKeywords: ["usha", "উষা"], brandValue: "usha", modelKeywords: [] },
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                        { brandKeywords: ["crompton", "ক্রোমটন"], brandValue: "crompton", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "cabin_fan",
                    name: "Cabin Fan",
                    keywords: ["cabin fan", "ক্যাবিন ফ্যান"],
                    brandsAndModels: [
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                        { brandKeywords: ["gfc", "জিএফসি"], brandValue: "gfc", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "ceiling_fan",
                    name: "Ceiling Fan",
                    keywords: ["ceiling fan", "সিলিং ফ্যান"],
                    brandsAndModels: [
                        { brandKeywords: ["orient", "ওরিয়েন্ট"], brandValue: "orient", modelKeywords: [] },
                        { brandKeywords: ["usha", "উষা"], brandValue: "usha", modelKeywords: [] },
                        { brandKeywords: ["kent", "কেন্ট"], brandValue: "kent", modelKeywords: [] },
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: [] },
                        { brandKeywords: ["crompton", "ক্রোমটন"], brandValue: "crompton", modelKeywords: [] },
                        { brandKeywords: ["gfc", "জিএফসি"], brandValue: "gfc", modelKeywords: [] },
                        { brandKeywords: ["havells", "হ্যাভেলস"], brandValue: "havells", modelKeywords: [] },
                        { brandKeywords: ["super_star", "সুপার স্টার"], brandValue: "super_star", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "fans",
                    name: "Fan", keywords: ["\\bfan\\b", "ফ্যান"], // Using fanKeywords
                    brandsAndModels: [
                        { brandKeywords: ["orient", "ওরিয়েন্ট"], brandValue: "orient", modelKeywords: ["orient super deluxe"] },
                        { brandKeywords: ["usha", "উষা"], brandValue: "usha", modelKeywords: ["usha whirlwind"] },
                        { brandKeywords: ["kent", "কেন্ট"], brandValue: "kent", modelKeywords: [] },
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: ["walton wf-e16r", "walton wf-c56"] },
                        { brandKeywords: ["crompton", "ক্রোমটন"], brandValue: "crompton", modelKeywords: [] },
                        { brandKeywords: ["gfc", "জিএফসি"], brandValue: "gfc", modelKeywords: [] },
                        { brandKeywords: ["havells", "হ্যাভেলস"], brandValue: "havells", modelKeywords: [] },
                        { brandKeywords: ["super_star", "সুপার স্টার"], brandValue: "super_star", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "heaters",
                    name: "room heater", keywords: ["humidifier", "room heater", "হিউমিডিফায়ার"], // Using heaterKeywords
                    brandsAndModels: [
                        { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", modelKeywords: ["walton wf-rh"] },
                        { brandKeywords: ["nova", "নোভা"], brandValue: "nova", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "solar_system",
                    keywords: ["solar", "সোলার", "সোলার প্যানেল"],
                    brandsAndModels: [
                        { brandKeywords: ["lumin", "লুমিন"], brandValue: "luminous", modelKeywords: [] }, // Adjusted to match 'luminous' in dropdown
                        { brandKeywords: ["hamko", "হামকো"], brandValue: "hamko", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "generators",
                    name: "generator", keywords: ["generator", "জেনারেটর"],
                    brandsAndModels: [
                        { brandKeywords: ["kipor", "কিপোর"], brandValue: "kipor", modelKeywords: [] },
                        { brandKeywords: ["yamaha", "ইয়ামাহা"], brandValue: "yamaha", modelKeywords: [] },
                        { brandKeywords: ["cummins", "কামিন্স"], brandValue: "cummins", modelKeywords: [] },
                        { brandKeywords: ["honda", "হোন্ডা"], brandValue: "honda", modelKeywords: [] },
                        { brandKeywords: ["perkins", "পার্কিন্স"], brandValue: "perkins", modelKeywords: [] },
                        { brandKeywords: ["ricardo", "রিকার্ডো"], brandValue: "ricardo", modelKeywords: [] },
                        { brandKeywords: ["sinocat", "সিনোক্যাট"], brandValue: "sinocat", modelKeywords: [] },
                        { brandKeywords: ["volvo", "ভলভো"], brandValue: "volvo", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "lighting",
                    name: "light", keywords: ["lighting", "light", "led light", "টিউব লাইট", "টেবিল লাইট"],
                    excludedKeywords: ["ring light", "usb light", "surgical light", "light stick", "mosquito killing light", "mosquito repellent light", "light holder", "laser light", "fog light", "flash light", "dj light", "lightning", "lightning cable"], // Excluded keywords
                    brandsAndModels: [
                        { brandKeywords: ["philips", "ফিলিপস"], brandValue: "philips", modelKeywords: [] },
                        { brandKeywords: ["osram", "অসরাম"], brandValue: "osram", modelKeywords: [] },
                        { brandKeywords: ["brb", "বিআরবি"], brandValue: "brb", modelKeywords: [] },
                        { brandKeywords: ["super_star", "সুপার স্টার"], brandValue: "super_star", modelKeywords: [] }
                    ]
                },
                { itemTypeValue: "other_home_electronics", keywords: ["other home electronics", "general home electronics", "অন্যান্য গৃহস্থালী ইলেকট্রনিক্স"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // This category now has no direct brands/models, only through its itemTypes
        },

        // Other Electronics Direct Categories (Category -> Brand -> Model, if applicable)
        {
            categoryValue: "846", // Audio & Sound Systems
            keywords: [
                "audio system", "sound system", "speaker", "headphone", "microphone", "amplifier", "car audio", "home theater", "home theatre", "neckband",
                "অডিও সিস্টেম", "সাউন্ড সিস্টেম", "স্পিকার", "হেডফোন", "মাইক্রোফোন", "অ্যামপ্লিফায়ার",
                "earphone", "tws", "airpods", "airpods pro", "airbuds", "headset", "wireless earphone",
                "wireless headphone", "ear buds", "earbuds", "ইয়ারফোন", "ইয়ারবাডস", "এয়ারবাডস",
                "sound box", "bluetooth speaker", "wireless speaker", "hand mike", "হ্যান্ড মাইক", "সাউন্ড বক্স", "ব্লুটুথ",
                "audio adapter", "cassette player", "mp3 player", "radio", "voice changer", "voice recorder"
            ],
            itemTypes: [
                { itemTypeValue: "audio_adapter", name: "Audio Adapter", keywords: ["audio adapter", "অডিও অ্যাডাপ্টার"], brandsAndModels: [] },
                { itemTypeValue: "cassette_player", name: "Cassette Player", keywords: ["cassette player", "ক্যাসেট প্লেয়ার"], brandsAndModels: [] },
                {
                    itemTypeValue: "headphones", // Earphones & Headphones
                    name: "Earbuds", // Added name for title generation
                    keywords: ["headphone", "earphone", "neckband", "headset", "earbuds", "tws", "airpods", "wireless headphone", "wireless earphone", "হেডফোন", "ইয়ারফোন", "ইয়ারবাডস", "এয়ারবাডস"],
                    brandsAndModels: [
                        { brandKeywords: ["jbl", "জেবিএল"], brandValue: "jbl", name: "JBL", modelKeywords: ["jbl tune", "jbl wave", "jbl live"] },
                        { brandKeywords: ["sony", "সনি"], brandValue: "sony", name: "Sony", modelKeywords: ["sony wh-", "sony wf-", "sony xb"] },
                        { brandKeywords: ["bose", "বোস"], brandValue: "bose", name: "Bose", modelKeywords: ["bose qc", "bose sport"] },
                        { brandKeywords: ["xiaomi", "শাওমি", "mi"], brandValue: "mi", name: "Xiaomi", modelKeywords: ["redmi earbuds", "mi true wireless"] },
                        { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", name: "Samsung", modelKeywords: ["galaxy buds"] },
                        { brandKeywords: ["apple", "অ্যাপল"], brandValue: "apple", name: "Apple", modelKeywords: ["airpods", "airpods pro", "airpods max"] },
                        { brandKeywords: ["oneplus", "ওয়ানপ্লাস"], brandValue: "oneplus", name: "OnePlus", modelKeywords: ["oneplus buds"] },
                        { brandKeywords: ["anker", "অ্যাঙ্কার"], brandValue: "other", name: "Anker", modelKeywords: ["soundcore"] },
                        { brandKeywords: ["realme", "রিয়েলমি"], brandValue: "realme", name: "Realme", modelKeywords: ["realme buds"] },
                        { brandKeywords: ["oppo", "অপো"], brandValue: "oppo", name: "Oppo", modelKeywords: ["oppo enco"] },
                        { brandKeywords: ["logitech", "লজিটেক"], brandValue: "logitech", name: "Logitech", modelKeywords: [] },
                        { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other"], brandValue: "other", name: "Other Brand", modelKeywords: [] }
                    ]
                },
                { itemTypeValue: "ipod_mp3_player", name: "MP3 Player", keywords: ["ipod", "mp3 player", "এমপিথ্রি প্লেয়ার"], brandsAndModels: [
                    { brandKeywords: ["sony", "সনি"], brandValue: "sony", name: "Sony", modelKeywords: ["walkman"] },
                    { brandKeywords: ["apple", "অ্যাপল"], brandValue: "apple", name: "Apple", modelKeywords: ["ipod"] }
                ]},
                { itemTypeValue: "radio", name: "Radio", keywords: ["radio", "রেডিও"], brandsAndModels: [
                    { brandKeywords: ["philips", "ফিলিপস"], brandValue: "philips", name: "Philips", modelKeywords: [] },
                    { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", name: "Panasonic", modelKeywords: [] }
                ]},
                {
                    itemTypeValue: "speakers_sound_system", // Sound Systems
                    name: "Speaker", // Added name for title generation
                    keywords: ["speaker", "sound system", "home theater", "home theatre", "amplifier", "car audio", "sound box", "bluetooth speaker", "wireless speaker", "hand mike", "হ্যান্ড মাইক", "সাউন্ড সিস্টেম", "স্পিকার", "হোম থিয়েটার", "অ্যামপ্লিফায়ার", "ব্লুটুথ স্পিকার"],
                    brandsAndModels: [
                        { brandKeywords: ["jbl", "জেবিএল"], brandValue: "jbl", name: "JBL", modelKeywords: ["flip", "charge", "xtreme", "boombox", "partybox"] },
                        { brandKeywords: ["sony", "সনি"], brandValue: "sony", name: "Sony", modelKeywords: ["এক্সবি সিরিজ", "ht-s", "soundbar", "home theatre"] },
                        { brandKeywords: ["bose", "বোস"], brandValue: "bose", name: "Bose", modelKeywords: ["soundlink", "soundbar", "home speaker"] },
                        { brandKeywords: ["xiaomi", "শাওমি", "mi"], brandValue: "mi", name: "Xiaomi", modelKeywords: ["mi soundbar", "redmi speaker"] },
                        { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", name: "Samsung", modelKeywords: ["soundbar", "q-series", "t-series"] },
                        { brandKeywords: ["lg", "এলজি"], brandValue: "lg", name: "LG", modelKeywords: ["xboom", "soundbar"] },
                        { brandKeywords: ["logitech", "লজিটেক"], brandValue: "logitech", name: "Logitech", modelKeywords: ["z623", "z906", "g560"] },
                        { brandKeywords: ["harman kardon", "হারমান কার্ডন"], brandValue: "harman-kardon", name: "Harman Kardon", modelKeywords: ["onyx studio", "aura"] },
                        { brandKeywords: ["microlab", "মাইক্রোল্যাব"], brandValue: "microlab", name: "Microlab", modelKeywords: ["solo", "m-200", "m-108"] },
                        { brandKeywords: ["creative", "ক্রিয়েটিভ"], brandValue: "creative", name: "Creative", modelKeywords: ["gigaworks", "sbs"] },
                        { brandKeywords: ["edifier", "ইডিফায়ার"], brandValue: "edifier", name: "Edifier", modelKeywords: ["r1280db", "s3000pro"] },
                        { brandKeywords: ["pioneer", "পাওনিয়ার"], brandValue: "other", name: "Pioneer", modelKeywords: ["home cinema system", "av receiver"] },
                        { brandKeywords: ["yamaha", "ইয়ামাহা"], brandValue: "yamaha", name: "Yamaha", modelKeywords: ["soundbar", "receiver"] },
                        { brandKeywords: ["anker", "অ্যাঙ্কার"], brandValue: "other", name: "Anker", modelKeywords: ["soundcore speaker", "flare"] },
                        { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other"], brandValue: "other", name: "Other Brand", modelKeywords: [] }
                    ]
                },
                { itemTypeValue: "voice_changer", name: "Voice Changer", keywords: ["voice changer", "ভয়েস চেঞ্জার"], brandsAndModels: [] },
                { itemTypeValue: "voice_recorder", name: "Voice Recorder", keywords: ["voice recorder", "ভয়েস রেকর্ডার"], brandsAndModels: [
                    { brandKeywords: ["sony", "সনি"], brandValue: "sony", name: "Sony", modelKeywords: [] },
                    { brandKeywords: ["olympus", "অলিম্পাস"], brandValue: "other", name: "Olympus", modelKeywords: [] }
                ]},
                { itemTypeValue: "other_audio", name: "Other Audio", keywords: ["other audio", "অন্যান্য অডিও"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // No direct brands/models here; they all live under itemTypes
        },
        {
            categoryValue: "855", // Cameras & Accessories
            keywords: ["camera", "camcorder", "action camera", "dslr", "mirrorless", "ক্যামেরা", "ক্যামকর্ডার",
                       "digital camera", "security camera", "cc camera", "ip camera", "cctv", "ezviz" // Added more specific keywords
                      ],
            itemTypes: [
                                {
                    itemTypeValue: "camera_accessory", // Camera Accessories
                    keywords: ["camera accessory", "camera tripod", "camera bag", "flash light", "battery grip", "camera strap", "ক্যামেরা এক্সেসরিজ", "ক্যামেরা ট্রাইপড", "ক্যামেরা ব্যাগ"],
                    brandsAndModels: [
                        { brandKeywords: ["joby", "jobby"], brandValue: "other", modelKeywords: ["gorillapod"] }, // Assuming 'other'
                        { brandKeywords: ["manfrotto", "ম্যানফ্রোটো"], brandValue: "other", modelKeywords: [] } // Assuming 'other'
                    ]
                },
                {
                    itemTypeValue: "security_surveillance", // Security & Surveillance Cameras
                    keywords: ["cc camera", "surveillance camera", "ip camera", "cctv", "security system", "ezviz", "wifi camera", "নিরাপত্তা ক্যামেরা", "সিসিটিভি", "আইপি ক্যামেরা"],
                    brandsAndModels: [
                        { brandKeywords: ["hikvision", "হিকভিশন"], brandValue: "other", modelKeywords: [] }, // Assuming 'other'
                        { brandKeywords: ["dahua", "দahua"], brandValue: "other", modelKeywords: [] }, // Assuming 'other'
                        { brandKeywords: ["ezviz", "ইজভিজ"], brandValue: "other", modelKeywords: [] }, // Assuming 'other'
                        { brandKeywords: ["tp-link", "টিপি-লিঙ্ক"], brandValue: "tp-link", modelKeywords: ["tapo", "kasa"] }
                    ]
                },
                {
                    itemTypeValue: "digital_camcorder", // Camcorders
                    keywords: ["camcorder", "action camera", "go pro", "action cam", "ভিডিও ক্যামেরা", "ক্যামকর্ডার"],
                    brandsAndModels: [
                        { brandKeywords: ["sony", "সনি"], brandValue: "sony", modelKeywords: ["handycam"] },
                        { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", modelKeywords: [] },
                        { brandKeywords: ["canon", "ক্যানন"], brandValue: "canon", modelKeywords: [] }
                    ]
                },
                {
                    itemTypeValue: "lens", // Lens
                    keywords: ["lens", "lenses", "ক্যামেরা লেন্স"],
                    brandsAndModels: [
                        { brandKeywords: ["canon", "ক্যানন"], brandValue: "canon", modelKeywords: ["ef-s", "rf", "l series"] },
                        { brandKeywords: ["nikon", "নিকন"], brandValue: "nikon", modelKeywords: ["nikkor", "dx", "fx"] },
                        { brandKeywords: ["sony", "সনি"], brandValue: "sony", modelKeywords: ["fe mount", "e mount"] },
                        { brandKeywords: ["sigma", "সিগমা"], brandValue: "other", modelKeywords: ["art series"] }, // Assuming 'other'
                        { brandKeywords: ["tamron", "তামরন"], brandValue: "other", modelKeywords: [] } // Assuming 'other'
                    ]
                },
                {
                    itemTypeValue: "digital_camera", // Cameras
                    keywords: ["digital camera", "camera", "dslr", "mirrorless", "point and shoot", "ক্যামেরা"],
                    brandsAndModels: [
                        { brandKeywords: ["canon", "ক্যানন"], brandValue: "canon", modelKeywords: ["eos", "rebels", "r series"] },
                        { brandKeywords: ["nikon", "নিকন"], brandValue: "nikon", modelKeywords: ["d series", "z series", "coolpix"] },
                        { brandKeywords: ["sony", "সনি"], brandValue: "sony", modelKeywords: ["alpha", "cybershot", "a7", "a6000"] },
                        { brandKeywords: ["fujifilm", "ফুজিফিল্ম"], brandValue: "fujifilm", modelKeywords: ["x-t", "x-pro", "gfx"] },
                        { brandKeywords: ["panasonic", "প্যানাসনিক"], brandValue: "panasonic", modelKeywords: ["lumix", "gh series"] },
                        { brandKeywords: ["olympus", "অলিম্পাস"], brandValue: "other", modelKeywords: ["om-d", "pen"] } // Assuming 'other' if Olympus not in dropdown
                    ]
                },
                { itemTypeValue: "other_camera", keywords: ["other camera", "অন্যান্য ক্যামেরা"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // No direct brands/models here; they are now under itemTypes
        },

        // Healthcare
        {
            categoryValue: "1205",
            keywords: ["first aid", "thermometer", "foot massager", "blood pressure monitor", "pressure monitor", "ফার্স্ট এইড", "থার্মোমিটার"],
            itemTypes: [
                { itemTypeValue: "handcare", keywords: ["hand sanitizer", "hand wash", "হ্যান্ড স্যানিটাইজার"], brandsAndModels: [] },
                { itemTypeValue: "face_mask", keywords: ["face mask", "surgical mask", "n95 mask", "ফেস মাস্ক", "মাস্ক"], brandsAndModels: [] },
                { itemTypeValue: "other", keywords: ["first aid", "thermometer", "foot massager", "blood pressure monitor", "pressure monitor", "ফার্স্ট এইড", "থার্মোমিটার"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // Brands for healthcare items are typically not in a dropdown for classifieds
        },
        {
            categoryValue: "896", // Laptops
            name: "Laptop",
            keywords: ["laptop", "notebook", "ল্যাপটপ", "নোটবুক", "গেমিং ল্যাপটপ"],
            itemTypes: [],
            brandsAndModels: [
                { brandKeywords: ["hp", "এইচপি"], brandValue: "hp", name: "HP Laptop for sale", modelKeywords: ["pavilion", "envy", "spectre", "প্রোবুক"] },
                { brandKeywords: ["dell", "ডেল"], brandValue: "dell", name: "Dell Laptop for sale", modelKeywords: ["xps", "inspiron", "latitude", "এলিয়েনওয়্যার"] },
                { brandKeywords: ["lenovo", "লেনোভো"], brandValue: "lenovo", name: "Lenovo Laptop for sale", modelKeywords: ["thinkpad", "ideapad", "yoga", "T Series"] },
                { brandKeywords: ["asus", "আসুস"], brandValue: "asus", name: "Asus Laptop for sale", modelKeywords: ["rog", "tuf", "জেনবুক", "immenar"] },
                { brandKeywords: ["acer", "এসার"], brandValue: "acer", name: "Acer Laptop for sale", modelKeywords: ["swift", "nitro"] },
                { brandKeywords: ["apple", "অ্যাপল"], brandValue: "apple", name: "Macbook for sale", modelKeywords: ["macbook pro", "macbook air", "ম্যাকবুক"] },
                { brandKeywords: ["microsoft", "মাইক্রোসফট"], brandValue: "microsoft", name: "Microsoft Surfacebook for sale", modelKeywords: ["surface laptop", "সার্ফেস"] },
                { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other", "অন্যান্য"], name: "Laptop for sale", brandValue: "other", modelKeywords: [] }
            ]
        },
        {
            categoryValue: "897", // Laptop Accessory / Computer Accessory
            keywords: ["keyboard", "mouse", "monitor", "ssd drive", "usb drive", "ল্যাপটপ এক্সেসরিজ", "কম্পিউটার এক্সেসরিজ", "কীবোর্ড", "মাউস", "মনিটর", "graphics card", "processor", "hard drive", "cooler", "casing", "\\bcpu\\b", "gpu", "webcam", "printer",
                       "cpu casing", "\\bonu\\b", "cooling fan", "flash drive", "hard disk", "memory card", "printer", "scanner", "pendrive", "ups", "webcam", "access point", // Specific item type keywords
                       "dvd writer", "server rack", "card reader", "laser light", "laser pointer", "লেজার লাইট", "লেজার পয়েন্টার", "ethernet cable",
                       "router", "modem", "repeater", "রাউটার", "মডেম", "wifi router", "wireless router", "network device", "নেটওয়ার্ক ডিভাইস" // Added network device keywords
                      ],
            itemTypes: [
                { itemTypeValue: "casing", name: "Casing", keywords: ["cpu casing", "casing", "pc casing", "desktop casing"], brandsAndModels: [
                    { brandKeywords: ["thermaltake", "থার্মালটেক"], brandValue: "other", name: "Thermaltake", modelKeywords: [] }, // Assuming 'other'
                    { brandKeywords: ["cooler master", "কুলার মাস্টার"], brandValue: "other", name: "Cooler Master", modelKeywords: [] }, // Assuming 'other'
                    { brandKeywords: ["deepcool", "ডিপকুল"], brandValue: "other", name: "Deepcool", modelKeywords: [] } // Assuming 'other'
                ]},
                { itemTypeValue: "cooling_fan", name: "Cooling Fan", keywords: ["cooling fan", "cpu cooler", "cpu cooling fan", "pc cooler", "pc cooling fan"], brandsAndModels: [
                    { brandKeywords: ["cooler master", "কুলার মাস্টার"], brandValue: "other", name: "Cooler Master", modelKeywords: [] }, // Assuming 'other'
                    { brandKeywords: ["noctua", "নকচুয়া"], brandValue: "other", name: "Noctua", modelKeywords: [] } // Assuming 'other'
                ]},
                { itemTypeValue: "motherboard", name: "Motherboard", keywords: ["motherboard", "মাদারবোর্ড"], brandsAndModels: [
                    { brandKeywords: ["asus", "আসুস"], brandValue: "asus", name: "Asus", modelKeywords: ["rog", "prime"] },
                    { brandKeywords: ["gigabyte", "গিগাবাইট"], brandValue: "other", name: "Gigabyte", modelKeywords: ["aorus"] }, // Assuming 'other'
                    { brandKeywords: ["msi", "এমএসআই"], brandValue: "other", name: "MSI", modelKeywords: ["mag", "mpg"] } // Assuming 'other'
                ]},
                { itemTypeValue: "mouse", name: "Mouse", keywords: ["mouse", "মাউস"], brandsAndModels: [
                    { brandKeywords: ["logitech", "লজিটেক"], brandValue: "logitech", name: "Logitech", modelKeywords: ["mx master", "g series"] },
                    { brandKeywords: ["razer", "রেজার"], brandValue: "other", name: "Razer", modelKeywords: ["deathadder"] }, // Assuming 'other'
                    { brandKeywords: ["a4tech", "এফোরটেক"], brandValue: "a4tech", name: "A4Tech", modelKeywords: [] }, // Assuming 'other'
                    { brandKeywords: ["hp", "এইচপি"], brandValue: "hp", name: "HP", modelKeywords: [] },
                    { brandKeywords: ["dell", "ডেল"], brandValue: "dell", name: "Dell", modelKeywords: [] },
                    { brandKeywords: ["asus", "আসুস"], brandValue: "asus", name: "Asus", modelKeywords: [] },
                    { brandKeywords: ["xiaomi", "শাওমি"], brandValue: "xiaomi", name: "Xiaomi", modelKeywords: [] }
                ]},
                { itemTypeValue: "monitor", name: "Monitor", keywords: ["monitor", "মনিটর"], brandsAndModels: [
                    { brandKeywords: ["dell", "ডেল"], brandValue: "dell", name: "Dell", modelKeywords: ["ultrasharp", "alienware"] },
                    { brandKeywords: ["hp", "এইচপি"], brandValue: "hp", name: "HP", modelKeywords: ["omen"] },
                    { brandKeywords: ["lg", "এলজি"], brandValue: "lg", name: "LG", modelKeywords: ["ultragear"] },
                    { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", name: "Samsung", modelKeywords: ["odyssey", "viewfinity"] },
                    { brandKeywords: ["asus", "আসুস"], brandValue: "asus", name: "Asus", modelKeywords: ["rog swift"] },
                    { brandKeywords: ["acer", "এসার"], brandValue: "acer", name: "Acer", modelKeywords: ["nitro", "predator"] },
                    { brandKeywords: ["walton", "ওয়ালটন"], brandValue: "walton", name: "Walton", modelKeywords: [] },
                    { brandKeywords: ["benq", "বেনকিউ"], brandValue: "other", name: "BenQ", modelKeywords: [] } // Assuming 'other'
                ]},
                { itemTypeValue: "hard_drive_memory", name: "Hard Disk", keywords: ["nvme ssd", "hard disk", "hard drive", "হার্ড ড্রাইভ", "হার্ড ডিস্ক", "ssd"], brandsAndModels: [
                    { brandKeywords: ["seagate", "সিগেট"], brandValue: "seagate", name: "Seagate", modelKeywords: ["barracuda", "ironwolf"] },
                    { brandKeywords: ["wd", "ডব্লিউডি"], brandValue: "wd", name: "WD", modelKeywords: ["wd blue", "wd black"] },
                    { brandKeywords: ["kingston", "কিংস্টন"], brandValue: "kingston", name: "Kingston", modelKeywords: ["a400", "nv2", "fury"] },
                    { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", name: "Samsung", modelKeywords: ["970 evo", "870 evo"] },
                    { brandKeywords: ["adata", "এডাটা"], brandValue: "other", name: "ADATA", modelKeywords: [] },
                    { brandKeywords: ["corsair", "করসায়ার"], brandValue: "other", name: "Corsair", modelKeywords: ["vengeance"] }
                ]},
                { itemTypeValue: "memory_card", name: "Memory Card", keywords: ["memory card", "এসডি কার্ড", "মাইক্রো এসডি"], brandsAndModels: [
                    { brandKeywords: ["sandisk", "স্যানডিস্ক"], brandValue: "sandisk", name: "SanDisk", modelKeywords: ["ultra", "extreme pro"] },
                    { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", name: "Samsung", modelKeywords: ["evo plus"] },
                    { brandKeywords: ["kingston", "কিংস্টন"], brandValue: "kingston", name: "Kingston", modelKeywords: [] }
                ]},
                { itemTypeValue: "printer_scanner", name: "Printer", keywords: ["printer", "scanner", "laser printer", "barcode scanner", "fingerprint scanner", "প্রিন্টার", "স্ক্যানার"], brandsAndModels: [
                    { brandKeywords: ["epson", "ইপসন"], brandValue: "epson", name: "Epson", modelKeywords: ["ecotank", "l series"] },
                    { brandKeywords: ["canon", "ক্যানন"], brandValue: "canon", name: "Canon", modelKeywords: ["pixma", "imageclass"] },
                    { brandKeywords: ["hp", "এইচপি"], brandValue: "hp", name: "HP", modelKeywords: ["laserjet", "deskjet"] },
                    { brandKeywords: ["brother", "ব্রাদার"], brandValue: "other", name: "Brother", modelKeywords: [] }
                ]},
                { itemTypeValue: "pendrive", name: "Pendrive", keywords: ["pendrive", "flash drive", "pen drive", "পেন ড্রাইভ", "পেন্ড্রাইভ"], brandsAndModels: [
                    { brandKeywords: ["sandisk", "স্যানডিস্ক"], brandValue: "sandisk", name: "SanDisk", modelKeywords: ["ultra flair", "cruzer blade"] },
                    { brandKeywords: ["kingston", "কিংস্টন"], brandValue: "kingston", name: "Kingston", modelKeywords: [] }
                ]},
                { itemTypeValue: "ups", name: "UPS", keywords: ["ups", "ইউ পি এস"], brandsAndModels: [
                    { brandKeywords: ["apc", "এপিসি"], brandValue: "other", name: "APC", modelKeywords: ["back-ups"] },
                    { brandKeywords: ["east delta", "ইস্ট ডেল্টা"], brandValue: "other", name: "East Delta", modelKeywords: [] }
                ]},
                { itemTypeValue: "web_cam", name: "Webcam", keywords: ["webcam", "ওয়েব ক্যাম"], brandsAndModels: [
                    { brandKeywords: ["logitech", "লজিটেক"], brandValue: "logitech", name: "Logitech", modelKeywords: ["c920", "brio"] },
                    { brandKeywords: ["razer", "রেজার"], brandValue: "other", name: "Razer", modelKeywords: ["kiyoo"] }
                ]},
                {
                    itemTypeValue: "modem_router",
                    name: "Router", // Added name for title generation
                    keywords: ["router", "repeater", "\\bonu\\b", "modem", "wifi router", "wireless router", "access point", "raut er", "rawtar", "raotar", "ethernet switch", "network switch", "ethernet cable", "রাউটার", "মডেম"],
                    brandsAndModels: [
                        { brandKeywords: ["tp-link", "tp link", "tplink", "টিপি-লিঙ্ক"], brandValue: "tp-link", name: "TP-Link", modelKeywords: ["archer", "deco", "tl-wr", "wr"] },
                        { brandKeywords: ["tenda", "টেন্ডা"], brandValue: "tenda", name: "Tenda", modelKeywords: [] },
                        { brandKeywords: ["d-link", "ডি-লিঙ্ক"], brandValue: "d-link", name: "D-Link", modelKeywords: [] },
                        { brandKeywords: ["netis"], brandValue: "netis", name: "Netis", modelKeywords: [] },
                        { brandKeywords: ["asus", "আসুস"], brandValue: "asus", name: "Asus", modelKeywords: ["rog router"] },
                        { brandKeywords: ["mi"], brandValue: "mi", name: "MI", modelKeywords: ["rog router"] },
                        { brandKeywords: ["xiaomi", "শাওমি"], brandValue: "xiaomi", name: "Xiaomi", modelKeywords: ["mi router"] },
                        { brandKeywords: ["\\bonu\\b", "mercusys"], brandValue: "other", modelKeywords: [] },
                    ]
                },
                {
                    itemTypeValue: "other",
                    name: "Other Accessory", // Added name for title generation
                    keywords: ["dvd writer", "server rack", "network server rack", "card reader", "laser light", "laser pointer", "লেজার লাইট", "লেজার পয়েন্টার"],
                    brandsAndModels: []
                }
            ],
            brandsAndModels: [] // No direct brands/models here; they all live under itemTypes
        },
        // Desktop Computers
        {
            categoryValue: "893",
            name: "Computer",
            keywords: ["desktop computer", "\\bpc\\b", "ডেস্কটপ কম্পিউটার", "ডেস্কটপ", "পিসি", "gaming pc", "গেমিং পিসি"],
            itemTypes: [], // No item type dropdown for Desktop Computers
            brandsAndModels: [
                {
                    // This entry will now catch all Desktop Computer related titles
                    brandKeywords: ["desktop", "\\bpc\\b", "ডেস্কটপ", "পিসি", "gaming pc", "গেমিং পিসি", "custom pc", "কাস্টম পিসি", "assembled pc", "built pc"],
                    brandValue: "customized", // Matches the 'Customized Desktops' brand option
                    name: "Desktop",
                    modelKeywords: ["customized-other-model"] // Matches the 'Other' model option under 'Customized Desktops'
                }
            ]
        },
        {
            categoryValue: "894", // Tablets
            keywords: ["tablet", "ipad", "ট্যাবলেট", "আইপ্যাড", "walpad", "galaxy tab", "symtab", "galaxy tab"],
            itemTypes: [],
            brandsAndModels: [
                { brandKeywords: ["apple", "অ্যাপল"], brandValue: "apple", modelKeywords: ["ipad", "আইপ্যাড প্রো", "আইপ্যাড এয়ার"] },
                { brandKeywords: ["samsung", "স্যামসাং"], brandValue: "samsung", modelKeywords: ["galaxy tab", "গ্যালাক্সি ট্যাব"] },
                { brandKeywords: ["microsoft", "মাইক্রোসফট"], brandValue: "microsoft", modelKeywords: ["surface pro", "সার্ফেস প্রো"] },
                { brandKeywords: ["lenovo", "লেনোভো"], brandValue: "lenovo", modelKeywords: ["ট্যাব পি সিরিজ"] },
                { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other", "অন্যান্য"], brandValue: "other", modelKeywords: [] }
            ]
        },

        // Vehicles - Top-level category with direct brands/models
        {
            categoryValue: "203", // Motorbikes
            keywords: ["E-Bike", "E Bike"],
            itemTypes: [],
            brandsAndModels: [
                { brandKeywords: ["honda", "হোন্ডা"], brandValue: "honda", modelKeywords: ["cb hornet", "livo", "cb trigger", "dream neo", "হর্নেট", "লিভো"] },
                { brandKeywords: ["yamaha", "ইয়ামাহা"], brandValue: "yamaha", modelKeywords: ["fz", "r15", "saluto", "ফেজার", "আর১৫"] },
                { brandKeywords: ["suzuki", "সুজুকি"], brandValue: "suzuki", modelKeywords: ["gixxer", "burgman", "অ্যাক্সেস"] },
                { brandKeywords: ["bajaj", "বাজাজ"], brandValue: "bajaj", modelKeywords: ["pulsar", "discover", "platina", "পালসার", "ডিসকভার", "প্লাটিনা"] },
                { brandKeywords: ["tvs", "টিভিএস"], brandValue: "tvs", modelKeywords: ["apache", "metro", "star city", "অ্যাপাচি", "মেট্রো"] },
                { brandKeywords: ["hero", "হিরো"], brandValue: "hero", modelKeywords: ["splendor", "ignitor", "passion", "স্প্লেন্ডার", "ইগনাইটর"] },
                { brandKeywords: ["ktm", "কেটিএম"], brandValue: "ktm", modelKeywords: ["duke", "rc"] },
                { brandKeywords: ["runner", "রানার"], brandValue: "runner", modelKeywords: ["দুরন্ত", "বোল্ট"] },
                { brandKeywords: ["lifan", "লিফান"], brandValue: "lifan", modelKeywords: ["কেপিআর", "কেপিএস"] },
                { brandKeywords: ["zontes", "জনটেস"], brandValue: "zontes", modelKeywords: [] },
                { brandKeywords: ["cfmoto", "সিএফমোটো"], brandValue: "cfmoto", modelKeywords: [] },
                { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other", "অন্যান্য"], brandValue: "other", modelKeywords: [] }
            ]
        },

        {
            categoryValue: "205", // Trucks & Pickups
            keywords: ["truck", "lorry", "ট্রাক", "লরি", "pickup", "পিকআপ"],
            itemTypes: [],
            brandsAndModels: [
                { brandKeywords: ["isuzu", "ইসুজু"], brandValue: "isuzu", modelKeywords: ["Dump"] },
                { brandKeywords: ["tata", "টাটা"], brandValue: "tata", modelKeywords: ["ACE EX2", "ACE Mega Xl", "Super Ace"] },
                { brandKeywords: ["mahindra", "মাহিন্দ্রা"], brandValue: "mahindra", modelKeywords: ["Bolero", "Bolero PikUp", "Maxximo HD"] },
                { brandKeywords: ["ashok leyland", "অশোক লেল্যান্ড"], brandValue: "ashok-leyland", modelKeywords: ["Dost", "Dost Plus"] },
                { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other", "অন্যান্য"], brandValue: "other", modelKeywords: [] }
            ]
        },
        {
            categoryValue: "206", // Vans
            keywords: ["covered van", "কাভার্ড ভ্যান", "cargo van"],
            itemTypes: [],
            brandsAndModels: [
                { brandKeywords: ["toyota", "টয়োটা"], brandValue: "toyota", modelKeywords: ["hiace", "হাইএস"] },
                { brandKeywords: ["nissan", "নিসান"], brandValue: "nissan", modelKeywords: ["urvan"] },
                { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other", "অন্যান্য"], brandValue: "other", modelKeywords: [] }
            ]
        },
        {
            categoryValue: "915", // Heavy Duty
            keywords: ["heavy duty", "heavy vehicle", "crane", "excavator", "loader", "dumper", "ভারী যানবাহন", "ক্রেন", "খননকারী", "লোডার", "ডাম্পার", "ট্রাক্টর", "বুলডোজার"],
            itemTypes: [],
            brandsAndModels: [
                { brandKeywords: ["caterpillar", "ক্যাটারপিলার"], brandValue: "caterpillar", modelKeywords: [] },
                { brandKeywords: ["komatsu", "কোমাটসু"], brandValue: "komatsu", modelKeywords: [] },
                { brandKeywords: ["jcb", "জেসিবি"], brandValue: "jcb", modelKeywords: [] },
                { brandKeywords: ["hitachi", "হিটাচি"], brandValue: "hitachi", modelKeywords: [] },
                { brandKeywords: ["volvo", "ভলভো"], brandValue: "volvo", modelKeywords: [] },
                { brandKeywords: ["sany", "সানি"], brandValue: "sany", modelKeywords: [] },
                { brandKeywords: ["xcmg"], brandValue: "xcmg", modelKeywords: [] },
                { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other", "অন্যান্য"], brandValue: "other", modelKeywords: [] }
            ]
        },
        {
            categoryValue: "194", // Auto Parts & Accessories
            keywords: ["bike battery", "car battery","car parts", "bike parts", "vehicle accessory", "গাড়ির যন্ত্রাংশ", "মোটরসাইকেলের যন্ত্রাংশ", "গাড়ির এক্সেসরিজ",
                       "tyre", "\\brim\\b", "headlight", "spark plug", "shock absorber", "gearbox", "clutch", "radiator", "suspension",
                       "ac compressor", "air filter", "alternator", "bearing", "ball joint", "chain cover", "bike light", "side panel", "visor", "bike lock",
                       "camshaft", "android player", "bulb", "dvd player", "seat storage box", "trash can", "car cover", "dashboard smiley", "metal sticker",
                       "rear mirror", "vacuum cleaner", "car window", "catalytic converter", "chassis", "coolant", "cowling", "crankcase", "crash bar",
                       "cycling gloves", "cylinder headcover", "dashboard cover", "duster", "exhaust pipe", "fog light", "foot stand", "footpeg", "front axle", "fuel injector", "fuel pump", "fuel tank",
                       "gear cover", "gear change drum", "gear shift knob", "hand clutch", "handle", "handlebar", "helmet", "hood handle", "ignition lock", "jumper cable",
                       "backrest", "bike chain", "motorcycle seat", "mudguard", "muffler", "neutral safety switch", "odometer", "oil filter", "oil cooler", "parking sensor", "piston",
                       "power steering fluid", "radiator support", "rear view mirror", "rear brake", "roof plate", "seat belt", "seat cover", "security lock", "shock absorber",
                       "side mirror", "silencer ring", "socket jumper", "spare tyre", "starter solenoid", "steering damper", "steering wheel cover", "step bumper", "sticker",
                       "suspension bump stop", "swingarm", "tire pressure gauge", "transmission", "two wheeler cable", "rubber", "valve", "voltage regulator", "wheel nut", "wheel cover", "wheel cap" // Extensive keywords from your itemTypeMap
                      ],
            itemTypes: [
                { itemTypeValue: "air_filter", keywords: ["air filter"], brandsAndModels: [{brandKeywords: ["k&n", "কে এন"], brandValue: "other", modelKeywords: []}] },
                { itemTypeValue: "alternator", keywords: ["alternator"], brandsAndModels: [] },
                { itemTypeValue: "auto_bearing", keywords: ["auto bearing"], brandsAndModels: [] },
                { itemTypeValue: "back_glass", keywords: ["back glass"], brandsAndModels: [] },
                { itemTypeValue: "ball_joint_lower", keywords: ["ball joint lower"], brandsAndModels: [] },
                { itemTypeValue: "battery", keywords: ["bike battery", "car battery", "vehicle battery"], brandsAndModels: [
                    { brandKeywords: ["hamko", "হামকো"], brandValue: "hamko", modelKeywords: [] },
                    { brandKeywords: ["rahimafrooz", "রহিমাফ্রোজ"], brandValue: "rahimafrooz", modelKeywords: [] },
                    { brandKeywords: ["lucas", "লুকাস"], brandValue: "lucas", modelKeywords: [] }
                ]},
                { itemTypeValue: "battery_cable", keywords: ["battery cable"], brandsAndModels: [] },
                { itemTypeValue: "battery_current_sensor_connector", keywords: ["battery sensor connector"], brandsAndModels: [] },
                { itemTypeValue: "battery_terminal", keywords: ["battery terminal"], brandsAndModels: [] },
                { itemTypeValue: "bicycle_pumper", keywords: ["bicycle pumper", "bike pump"], brandsAndModels: [] },
                { itemTypeValue: "bike_cable_lock", keywords: ["bike lock", "cable lock"], brandsAndModels: [] },
                { itemTypeValue: "bike_chain_cover", keywords: ["bike chain cover"], brandsAndModels: [] },
                { itemTypeValue: "bike_light", keywords: ["bike light"], brandsAndModels: [] },
                { itemTypeValue: "bike_side_panel", keywords: ["bike side panel"], brandsAndModels: [] },
                { itemTypeValue: "bike_visor_glass", keywords: ["visor glass", "bike visor"], brandsAndModels: [] },
                { itemTypeValue: "brakes", keywords: ["brake", "brakes", "brake pad", "brake shoe", "brake fluid"], brandsAndModels: [] },
                { itemTypeValue: "bumper", keywords: ["bumper"], brandsAndModels: [] },
                { itemTypeValue: "cabin_air_filter", keywords: ["cabin air filter"], brandsAndModels: [] },
                { itemTypeValue: "camshaft", keywords: ["camshaft"], brandsAndModels: [] },
                { itemTypeValue: "car_android_player", keywords: ["android player", "car android"], brandsAndModels: [{brandKeywords: ["pioneer", "পাওনিয়ার"], brandValue: "other", modelKeywords: []}, {brandKeywords: ["sony", "সনি"], brandValue: "sony", modelKeywords: []}] },
                { itemTypeValue: "car_bulb", keywords: ["car bulb", "headlight bulb"], brandsAndModels: [{brandKeywords: ["philips", "ফিলিপস"], brandValue: "philips", modelKeywords: []}] },
                { itemTypeValue: "car_dvd_player", keywords: ["car dvd"], brandsAndModels: [] },
                { itemTypeValue: "car_jack", keywords: ["car jack"], brandsAndModels: [] },
                { itemTypeValue: "car_seat_gap_storage_box", keywords: ["seat gap box"], brandsAndModels: [] },
                { itemTypeValue: "car_trash_can", keywords: ["trash can"], brandsAndModels: [] },
                { itemTypeValue: "car_usb_charger", keywords: ["usb charger"], brandsAndModels: [] },
                { itemTypeValue: "car_belt", keywords: ["car belt"], brandsAndModels: [] },
                { itemTypeValue: "car_cover", keywords: ["car cover"], brandsAndModels: [] },
                { itemTypeValue: "car_dashboard_smiley", keywords: ["dashboard smiley"], brandsAndModels: [] },
                { itemTypeValue: "car_metal_sticker", keywords: ["metal sticker"], brandsAndModels: [] },
                { itemTypeValue: "car_rear_mirror", keywords: ["rear mirror"], brandsAndModels: [] },
                { itemTypeValue: "car_vaccum_cleaner", keywords: ["vacuum cleaner"], brandsAndModels: [] },
                { itemTypeValue: "car_windows", keywords: ["car window"], brandsAndModels: [] },
                { itemTypeValue: "carpet", keywords: ["car carpet"], brandsAndModels: [] },
                { itemTypeValue: "catalytic_converter", keywords: ["catalytic converter"], brandsAndModels: [] },
                { itemTypeValue: "chassis", keywords: ["chassis"], brandsAndModels: [] },
                { itemTypeValue: "clutch", keywords: ["clutch", "clutch plate"], brandsAndModels: [] },
                { itemTypeValue: "coolant", keywords: ["coolant"], brandsAndModels: [] },
                { itemTypeValue: "cowling", keywords: ["cowling"], brandsAndModels: [] },
                { itemTypeValue: "crankcase", keywords: ["crankcase"], brandsAndModels: [] },
                { itemTypeValue: "crash_bars", keywords: ["crash bar"], brandsAndModels: [] },
                { itemTypeValue: "cycling_gloves", keywords: ["cycling gloves"], brandsAndModels: [] },
                { itemTypeValue: "cylinder_headcover", keywords: ["headcover"], brandsAndModels: [] },
                { itemTypeValue: "dashboard_cover", keywords: ["dashboard cover"], brandsAndModels: [] },
                { itemTypeValue: "duster", keywords: ["duster", "car duster"], brandsAndModels: [] },
                { itemTypeValue: "engine_fan", keywords: ["engine fan"], brandsAndModels: [] },
                { itemTypeValue: "engine_oil", keywords: ["engine oil", "engine lubricant"], brandsAndModels: [
                    { brandKeywords: ["mobil", "মবিল"], brandValue: "other", modelKeywords: [] }, // Assuming 'other'
                    { brandKeywords: ["castrol", "ক্যাস্ট্রল"], brandValue: "other", modelKeywords: [] } // Assuming 'other'
                ]},
                { itemTypeValue: "exhaust_pipe", keywords: ["exhaust", "exhaust pipe", "মাফলার"], brandsAndModels: [] },
                { itemTypeValue: "fog_lights_headlamp", keywords: ["fog light", "headlamp", "কুয়াশা বাতি"], brandsAndModels: [] },
                { itemTypeValue: "foot_stand", keywords: ["foot stand"], brandsAndModels: [] },
                { itemTypeValue: "footpegs", keywords: ["footpeg"], brandsAndModels: [] },
                { itemTypeValue: "front_axle", keywords: ["front axle"], brandsAndModels: [] },
                { itemTypeValue: "front_glass", keywords: ["front glass"], brandsAndModels: [] },
                { itemTypeValue: "fuel_injector", keywords: ["fuel injector"], brandsAndModels: [] },
                { itemTypeValue: "fuel_pump", keywords: ["fuel pump"], brandsAndModels: [] },
                { itemTypeValue: "fuel_tank", keywords: ["fuel tank"], brandsAndModels: [] },
                { itemTypeValue: "gps_navigators", keywords: ["gps", "gps navigator"], brandsAndModels: [] },
                { itemTypeValue: "gear_cover", keywords: ["gear cover"], brandsAndModels: [] },
                { itemTypeValue: "gear_change_drum", keywords: ["gear change drum"], brandsAndModels: [] },
                { itemTypeValue: "gear_shift_knob", keywords: ["shift knob"], brandsAndModels: [] },
                { itemTypeValue: "hand_clutch", keywords: ["hand clutch"], brandsAndModels: [] },
                { itemTypeValue: "handle", keywords: ["handle"], brandsAndModels: [] },
                { itemTypeValue: "handlebars", keywords: ["handlebar"], brandsAndModels: [] },
                { itemTypeValue: "headlight", keywords: ["headlight"], brandsAndModels: [] },
                { itemTypeValue: "helmet", keywords: ["helmet", "হেলমেট"], brandsAndModels: [] },
                { itemTypeValue: "hood_release_handle", keywords: ["hood handle"], brandsAndModels: [] },
                { itemTypeValue: "ignition_lock_cylinder", keywords: ["ignition cylinder"], brandsAndModels: [] },
                { itemTypeValue: "ignition_switch", keywords: ["ignition switch"], brandsAndModels: [] },
                { itemTypeValue: "jacks_lifts_stands", keywords: ["car jack", "car lift", "car stand", "গাড়ির জ্যাক"], brandsAndModels: [] },
                { itemTypeValue: "jumper_cable", keywords: ["jumper cable"], brandsAndModels: [] },
                { itemTypeValue: "led_light", keywords: ["led light", "led car light"], brandsAndModels: [] },
                { itemTypeValue: "meters", keywords: ["meter", "speedometer", "odometer"], brandsAndModels: [] },
                { itemTypeValue: "motorcycle_backrest", keywords: ["motorcycle backrest"], brandsAndModels: [] },
                { itemTypeValue: "motorcycle_chain", keywords: ["motorcycle chain"], brandsAndModels: [] },
                { itemTypeValue: "motorcyle_seats", keywords: ["motorcycle seat"], brandsAndModels: [] },
                { itemTypeValue: "mudguard", keywords: ["mudguard"], brandsAndModels: [] },
                { itemTypeValue: "muffler", keywords: ["muffler"], brandsAndModels: [] },
                { itemTypeValue: "neutral_safety_switch", keywords: ["neutral switch"], brandsAndModels: [] },
                { itemTypeValue: "odometer", keywords: ["odometer"], brandsAndModels: [] },
                { itemTypeValue: "oil_filter", keywords: ["oil filter"], brandsAndModels: [] },
                { itemTypeValue: "oil_cooler", keywords: ["oil cooler"], brandsAndModels: [] },
                { itemTypeValue: "parking_sensors_camera", keywords: ["parking sensor", "parking camera", "রিভার্স ক্যামেরা"], brandsAndModels: [] },
                { itemTypeValue: "piston", keywords: ["piston"], brandsAndModels: [] },
                { itemTypeValue: "power_steering_fluid", keywords: ["steering fluid"], brandsAndModels: [] },
                { itemTypeValue: "radiator", keywords: ["radiator"], brandsAndModels: [] },
                { itemTypeValue: "radiator_supports", keywords: ["radiator support"], brandsAndModels: [] },
                { itemTypeValue: "rear_view_mirror_motorcycle", keywords: ["rear view mirror motorcycle"], brandsAndModels: [] },
                { itemTypeValue: "rear_brake", keywords: ["rear brake"], brandsAndModels: [] },
                { itemTypeValue: "\\brim\\b", keywords: ["car rim", "rim", "wheel rim", "রিং"], brandsAndModels: [] },
                { itemTypeValue: "roof_plate", keywords: ["roof plate"], brandsAndModels: [] },
                { itemTypeValue: "seat_belt", keywords: ["seat belt", "সিট বেল্ট"], brandsAndModels: [] },
                { itemTypeValue: "seat_cover_floor_mats", keywords: ["seat cover", "floor mat", "সিট কভার", "ফ্লোর ম্যাট"], brandsAndModels: [] },
                { itemTypeValue: "security_locks_accessories", keywords: ["bicycle lock", "disc lock", "bike lock", "Tasslock", "গাড়ির লক"], brandsAndModels: [] },
                { itemTypeValue: "shock_absorbers", keywords: ["shock absorber", "শক অ্যাবজরবার"], brandsAndModels: [] },
                { itemTypeValue: "side_mirror", keywords: ["side mirror", "সাইড মিরর"], brandsAndModels: [] },
                { itemTypeValue: "silencer_ring", keywords: ["silencer ring"], brandsAndModels: [] },
                { itemTypeValue: "socket_jumper", keywords: ["socket jumper"], brandsAndModels: [] },
                { itemTypeValue: "spare_tyre", keywords: ["spare tyre", "spare tire", "স্পেয়ার টায়ার"], brandsAndModels: [] },
                { itemTypeValue: "spark_plug", keywords: ["spark plug", "স্পার্ক প্লাগ"], brandsAndModels: [] },
                { itemTypeValue: "starter_solenoid", keywords: ["starter solenoid"], brandsAndModels: [] },
                { itemTypeValue: "steering_damper", keywords: ["steering damper"], brandsAndModels: [] },
                { itemTypeValue: "steering_wheel_cover", keywords: ["steering wheel cover"], brandsAndModels: [] },
                { itemTypeValue: "step_bumpers", keywords: ["step bumper"], brandsAndModels: [] },
                { itemTypeValue: "sticker", keywords: ["sticker", "car sticker"], brandsAndModels: [] },
                { itemTypeValue: "suspension_bump_stop", keywords: ["suspension bump stop"], brandsAndModels: [] },
                { itemTypeValue: "swingarm", keywords: ["swingarm"], brandsAndModels: [] },
                { itemTypeValue: "tire_pressure_gauge", keywords: ["tire pressure gauge"], brandsAndModels: [] },
                { itemTypeValue: "tires", keywords: ["tire", "tyre", "টায়ার"], brandsAndModels: [
                    { brandKeywords: ["mrf", "এমআরএফ"], brandValue: "mrf", modelKeywords: [] },
                    { brandKeywords: ["apollo", "অ্যাপোলো"], brandValue: "apollo", modelKeywords: [] },
                    { brandKeywords: ["ceat", "সিয়েট"], brandValue: "other", modelKeywords: [] }, // Assuming 'other'
                    { brandKeywords: ["goodyear", "গুডইয়ার"], brandValue: "other", modelKeywords: [] } // Assuming 'other'
                ]},
                { itemTypeValue: "transmission", keywords: ["transmission", "গিয়ারবক্স"], brandsAndModels: [] },
                { itemTypeValue: "tube", keywords: ["tube"], brandsAndModels: [] },
                { itemTypeValue: "two_wheeler_cable_rubber", keywords: ["two wheeler cable rubber"], brandsAndModels: [] },
                { itemTypeValue: "valves", keywords: ["valve"], brandsAndModels: [] },
                { itemTypeValue: "voltage_regulator", keywords: ["voltage regulator"], brandsAndModels: [] },
                { itemTypeValue: "wheel_nut", keywords: ["wheel nut"], brandsAndModels: [] },
                { itemTypeValue: "wheel_covers_caps", keywords: ["wheel cover", "wheel cap"], brandsAndModels: [] },
                // Generic 'Other' for parts not specifically listed above
                { itemTypeValue: "other", keywords: ["other auto parts", "অন্যান্য গাড়ির যন্ত্রাংশ", "general auto parts"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // All brands/models are now nested under itemTypes
        },
        {
            categoryValue: "926",
            keywords: ["auto service", "car wash", "vehicle repair", "maintenance", "repair", "tune up", "hybrid battery service", "ac repair", "painting", "tyre service", "wheel service", "windshield service", "inspection service",
                       "গাড়ি সার্ভিস", "গাড়ি মেরামত", "বাইক সার্ভিস", "গ্যাস কনভার্সন", "পেইন্টিং সার্ভিস", "ডেন্টাল সার্ভিস", "ইঞ্জিন মেরামত", "গাড়ির রক্ষণাবেক্ষণ"],
            itemTypes: [
                { itemTypeValue: "car_wash_detailing", keywords: ["car wash", "detailing", "গাড়ি ধোয়া"], brandsAndModels: [] },
                { itemTypeValue: "key_programme", keywords: ["key programme", "key programming", "গাড়ির চাবি প্রোগ্রাম"], brandsAndModels: [] },
                { itemTypeValue: "tune_up", keywords: ["tune up", "tuneup"], brandsAndModels: [] },
                { itemTypeValue: "hybrid_battery_services", keywords: ["hybrid battery", "hybrid battery service"], brandsAndModels: [] },
                { itemTypeValue: "ac_repair", keywords: ["ac repair", "air conditioning repair", "এসি রিপেয়ার"], brandsAndModels: [] },
                { itemTypeValue: "painting", keywords: ["painting", "paint", "পেইন্টিং"], brandsAndModels: [] },
                { itemTypeValue: "tyre_wheel_service", keywords: ["tyre service", "tire service", "wheel service", "চাকা সার্ভিস"], brandsAndModels: [] },
                { itemTypeValue: "windshield_service", keywords: ["windshield", "glass repair", "windshield service"], brandsAndModels: [] },
                { itemTypeValue: "vehicle_inspection_services", keywords: ["vehicle inspection", "inspection service", "ফিটনেস চেক"], brandsAndModels: [] },
                { itemTypeValue: "bodywork_accident_repair", keywords: ["bodywork", "accident repair", "body repair", "ডেন্ট রিপেয়ার"], brandsAndModels: [] },
                { itemTypeValue: "engine_and_gear_box_repair", keywords: ["engine repair", "gear box repair", "gearbox repair", "ইঞ্জিন রিপেয়ার"], brandsAndModels: [] },
                { itemTypeValue: "seat_covers_interior_repair", keywords: ["seat cover", "interior repair", "সিট কভার", "ইন্টেরিয়র রিপেয়ার"], brandsAndModels: [] },
                { itemTypeValue: "vehicle_bodykit_modifications", keywords: ["bodykit", "body kit", "modification", "মডিফিকেশন"], brandsAndModels: [] },
                { itemTypeValue: "electrical_electronic_repair", keywords: ["electrical repair", "electronic repair", "ইলেকট্রিক রিপেয়ার", "ইলেকট্রনিক রিপেয়ার"], brandsAndModels: [] },
                { itemTypeValue: "car_maintainance", keywords: ["car maintenance", "car maintainance", "গাড়ির রক্ষণাবেক্ষণ"], brandsAndModels: [] },
                { itemTypeValue: "two_wheeler_maintanance", keywords: ["two wheeler maintenance", "two wheeler maintainance", "বাইক সার্ভিস"], brandsAndModels: [] },
                { itemTypeValue: "vehicle_denting_and_painting", keywords: ["denting", "denting and painting", "ডেন্টিং পেইন্টিং"], brandsAndModels: [] },
                { itemTypeValue: "vehicle_wasing_and_servicing", keywords: ["vehicle washing", "washing and servicing", "গাড়ি ধোয়া সার্ভিস"], brandsAndModels: [] },
                { itemTypeValue: "other", keywords: ["other", "others", "অন্যান্য"], brandsAndModels: [] }
            ]
        },
        { categoryValue: "909",
            name: "Bicycle", // Added name for title generation
            keywords: ["bicycle", "বাইসাইকেল", "সাইকেল", "গিয়ার সাইকেল", "gear cycle", "mountain bike", "electric bike", "road bike", "phoenix"],
            itemTypes: [], // Assuming no specific item_type dropdown
            brandsAndModels: [
                { brandKeywords: ["phoenix", "ফিনিক্স"], brandValue: "phoenix", name: "Phoenix", modelKeywords: ["phoenix thunder", "phoenix super", "phoenix ladybird", "phoenix challenger", "phoenix atom"] },
                { brandKeywords: ["duranta", "দুরন্ত"], brandValue: "duranta", name: "Duranta", modelKeywords: ["duranta alloy", "duranta venom", "duranta rider", "duranta durjoy", "duranta recoil", "duranta scorpion"] },
                { brandKeywords: ["hero", "হিরো"], brandValue: "hero", name: "Hero", modelKeywords: ["hero sprint", "hero octane", "hero lectro"] }, // Hero has many models, added generic types
                { brandKeywords: ["veloce", "ভেলোস"], brandValue: "veloce", name: "Veloce", modelKeywords: ["veloce legion", "veloce v series", "veloce v400", "veloce legion 30"] },
                { brandKeywords: ["peerless", "পিয়ারলেস"], brandValue: "peerless", name: "Peerless", modelKeywords: [] },
                { brandKeywords: ["avon", "এভন"], brandValue: "avon", name: "Avon", modelKeywords: ["avon new attack", "avon cyclux"] },
                { brandKeywords: ["combat", "কমবাট"], brandValue: "combat", name: "Combat", modelKeywords: [] },
                { brandKeywords: ["core"], brandValue: "core", name: "Core", modelKeywords: ["core massive", "core harvard", "core hydro"] }, // Assuming 'combat' value for 'core'
                { brandKeywords: ["diamondback"], brandValue: "diamond-back", name: "Diamondback", modelKeywords: [] },
                { brandKeywords: ["duranta extreme", "দুরন্ত এক্সট্রিম"], brandValue: "duranta_extreme", name: "Duranta Extreme", modelKeywords: [] },
                { brandKeywords: ["express"], brandValue: "express", name: "Express", modelKeywords: [] },
                { brandKeywords: ["falcon"], brandValue: "falcon", name: "Falcon", modelKeywords: ["falcon m8", "falcon xn3000"] },
                { brandKeywords: ["finiss"], brandValue: "finiss", name: "Finiss", modelKeywords: [] },
                { brandKeywords: ["forever"], brandValue: "forever", name: "Forever", modelKeywords: ["forever 2020"] },
                { brandKeywords: ["foxter"], brandValue: "foxter", name: "Foxter", modelKeywords: ["foxter ft6.2", "foxter 9.0 mtb"] },
                { brandKeywords: ["galaxy"], brandValue: "galaxy", name: "Galaxy", modelKeywords: ["galaxy sport"] },
                { brandKeywords: ["kiesel"], brandValue: "kiesel", name: "Kiesel", modelKeywords: [] },
                { brandKeywords: ["landao"], brandValue: "landao", name: "Landao", modelKeywords: ["landao 27.5t"] },
                { brandKeywords: ["laux"], brandValue: "laux", name: "Laux", modelKeywords: ["laux hurricane", "laux jack"] },
                { brandKeywords: ["marine"], brandValue: "marine", name: "Marine", modelKeywords: ["marine sportslife"] },
                { brandKeywords: ["mark"], brandValue: "mark", name: "Mark", modelKeywords: [] },
                { brandKeywords: ["optimus"], brandValue: "optimus", name: "Optimus", modelKeywords: ["optimus cycle"] },
                { brandKeywords: ["pelican"], brandValue: "pelican", name: "Pelican", modelKeywords: ["pelicantrain"] },
                { brandKeywords: ["nekro", "নেক্রো"], brandValue: "nekro", name: "Nekro", modelKeywords: ["nekro blaze", "nekro ash", "nekro hades"] },
                { brandKeywords: ["raleigh"], brandValue: "raleigh", name: "Raleigh", modelKeywords: [] },
                { brandKeywords: ["precious"], brandValue: "precious", name: "Precious", modelKeywords: [] },
                { brandKeywords: ["prince"], brandValue: "prince", name: "Prince", modelKeywords: [] },
                { brandKeywords: ["serious"], brandValue: "serious", name: "Serious", modelKeywords: [] },
                { brandKeywords: ["rock rider"], brandValue: "rock-rider", name: "Rock Rider", modelKeywords: ["rockrider pro"] },
                { brandKeywords: ["typhoon"], brandValue: "typhoon", name: "Typhoon", modelKeywords: [] },
                { brandKeywords: ["viking"], brandValue: "viking", name: "Viking", modelKeywords: [] },
                { brandKeywords: ["venom"], brandValue: "venom", name: "Venom", modelKeywords: [] },
                { brandKeywords: ["other brand", "অন্যান্য ব্র্যান্ড", "other", "অন্যান্য"], brandValue: "other", name: "Other Brand", modelKeywords: [] }
            ]
        },
        { categoryValue: "924", keywords: ["water transport", "boat", "ship", "launch", "জলযান", "নৌকা", "জাহাজ", "লঞ্চ", "স্পিডবোট", "ট্রলার", "ফেরী"], itemTypes: [] },
        {
            categoryValue: "910", // Three Wheelers
            keywords: ["three wheeler", "auto rickshaw", "\\bvan\\b","সি এন জি", "সিএনজি", "ভ্যান", "রিকশা", "অটো রিকশা", "রিক্সা", "তিন চাকার গাড়ি", "টেম্পো", "ইজি বাইক", "ই-রিকশা"],
            itemTypes: [],
            brandsAndModels: [
                { brandKeywords: ["bajaj", "বাজাজ"], brandValue: "bajaj", modelKeywords: ["সি এন জি", "সিএনজি"] },
                { brandKeywords: ["auto rickshaw", "রিকশা", "অটো রিকশা", "টেম্পো", "ইজি বাইক", "ই-রিকশা"], brandValue: "other", modelKeywords: [] }
            ]
        },
        { categoryValue: "195", keywords: ["maintenance", "repair", "গাড়ি মেরামত", "কার সার্ভিস", "বাইক সার্ভিস"], itemTypes: [] },
        { categoryValue: "244", keywords: ["laminating machine", "sign board", "pos machine", "digital sign board", "calling bell", "door bell"], itemTypes: [] },

        // Agriculture
        { categoryValue: "599", keywords: ["seed", "গাছ", "চারা"], itemTypes: [] },
        { categoryValue: "1009", keywords: ["farming machinery", "tractor", "plow", "cultivator", "thresher", "power tiller", "কৃষি সরঞ্জাম", "ট্রাক্টর", "লাঙল", "পাওয়ার টিলার"], itemTypes: [] },
        { categoryValue: "600", keywords: ["other agriculture", "অন্যান্য কৃষি"], itemTypes: [] }, // "Food (deactivated)" (595) is skipped

        // Business & Industry
        {
            categoryValue: "1006",
            keywords: ["air compressor", "industrial tool", "factory machine", "overlock machine", "sewing machine", "grinder", "generator", "ice cream machine", "packing machine",
                       "শিল্প যন্ত্রপাতি", "কলকারখানার সরঞ্জাম", "এয়ার কম্প্রেসার", "সেলাই মেশিন", "ওভারলক মেশিন", "গ্রাইন্ডার", "জেনারেটর", "আইসক্রিম মেশিন", "প্যাকিং মেশিন"],
            itemTypes: [
                { itemTypeValue: "overlock_machine", keywords: ["overlock machine", "overlock", "ওভারলক মেশিন"], brandsAndModels: [] },
                { itemTypeValue: "grinder", keywords: ["grinder", "grinding machine", "গ্রাইন্ডার", "গ্রাইন্ডিং মেশিন"], brandsAndModels: [] },
                { itemTypeValue: "air_compressor", keywords: ["air compressor", "এয়ার কম্প্রেসার"], brandsAndModels: [] },
                { itemTypeValue: "generator", keywords: ["generator", "জেনারেটর"], brandsAndModels: [] },
                { itemTypeValue: "sewing_machine", keywords: ["sewing machine", "সেলাই মেশিন"], brandsAndModels: [] },
                { itemTypeValue: "ice_cream_machine", keywords: ["ice cream machine", "icecream machine", "আইসক্রিম মেশিন"], brandsAndModels: [] },
                { itemTypeValue: "packing_machine", keywords: ["packing machine", "packing", "প্যাকিং মেশিন"], brandsAndModels: [] },
                { itemTypeValue: "other", keywords: ["other", "others", "অন্যান্য"], brandsAndModels: [] }
            ]
        },
        { categoryValue: "1008", keywords: ["dokan psition", "running shop position", "shop position", "দোকান পজিশন"], itemTypes: [] },
        { categoryValue: "1023", keywords: ["wheel chair", "Wheelchair", "X-ray", "chair commode", "commode chair", "crutches", "icu bed", "medical bed", "হুইল চেয়ার", "oxygen cylinder", "অক্সিজেন সিলিন্ডার", "চেয়ার কমোড", "ক্রাচ", "আইসিইউ বেড", "মেডিকেল বেড"] },
        { categoryValue: "1005", keywords: ["Casio Fx", "stationary", "white board", "whiteboard", "calculator", "Calculator", "ক্যালকুলেটর", "দাপ্তরিক সরঞ্জাম", "স্টেশনারি", "কলম"] },
        { categoryValue: "1011", // Other Business & Industry Items
            keywords: ["digital scale", "foodcart", "food cart", "coffee maker", "coffee machine", "manequinn doll", "display doll", "কফি মেশিন", "ফুড কার্ট", "ফুডভ্যান", "ডিজিটাল স্কেল", "ডিজিটাল ওজন স্কেল", "চটপটির গাড়ি"],
            itemTypes: [], // Assuming there is no item_type dropdown for this category
            brandsAndModels: [] // Add specific food cart brands here if they appear in a dropdown, e.g., { brandKeywords: ["foodcart brand name"], brandValue: "foodcart_brand_value", modelKeywords: [] }
        },
        { categoryValue: "1007", keywords: ["raw material", "কাঁচামাল", "শিল্প কাঁচামাল", "সিমেন্ট", "বালি"], itemTypes: [] },
        { categoryValue: "1010", keywords: ["security system", "নিরাপত্তা সরঞ্জাম", "ফায়ার এক্সটিংগুইশার"], itemTypes: [] },

        // Education
        { categoryValue: "384", keywords: ["course", "training", "arabic course", "কোর্স", "প্রশিক্ষণ", "শিক্ষা কোর্স", "ভাষাশিক্ষা", "আরবি কোর্স", "আরবি শিক্ষা", "আরবি", "কম্পিউটার কোর্স"], itemTypes: [] },
        { categoryValue: "383", keywords: ["study abroad", "student visa", "abroad admission", "বিদেশী পড়াশোনা", "বিদেশে ভর্তি", "স্টুডেন্ট ভিসা"], itemTypes: [] },
        {
            categoryValue: "382", // Books & Learning
            name: "Book & Learning Material",
            keywords: ["textbook", "guide book", "ssc", "hsc", "admission", "পাঠ্যবই", "গাইড বই", "উপন্যাস", "magazine", // Main category keywords
                      ], // Added general item type keywords
            itemTypes: [
                { itemTypeValue: "college_university", name: "College / University Book", keywords: ["hsc", "college", "university", "admission book", "ভার্সিটি ভর্তি বই", "ভার্সিটি বই", "textbook college", "university textbook", "hsc book", "এইচএসসি বই"], brandsAndModels: [] },
                { itemTypeValue: "school", name: "School Books", keywords: ["ssc", "school book", "স্কুল বই", "ssc book", "এসএসসি বই", "class 10 book", "class 9 book"], brandsAndModels: [] },
                { itemTypeValue: "other", name: "Other Book", keywords: ["job solution"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        { categoryValue: "385", keywords: ["tuition", "tutor", "coaching", "গৃহশিক্ষক", "কোচিং", "টিউশন", "টিউটর"], itemTypes: [] },

        // Pets & Animals
        {
            categoryValue: "307", // Farm Animals
            keywords: ["farm animal", "cow", "goat", "rooster", "poultry", "murga", "murog", "murgi", "quail", "faumi", "ব্রাহমা", "কোয়েল", "কিং কোয়েল", "গরু", "ষাড়", "ছাগল", "ছাগী", "পাঠা", "মুরগ", "গাভী", "বাছুর", "খাসি", "মুরগি", "পশু", "কৃষি প্রাণী", "হাঁস", "হাস", "হাসের বাচ্চা", "ভেড়া", "মহিষ"],
            itemTypes: [
                { itemTypeValue: "goats", keywords: ["goat", "goats", "chagol", "ছাগল", "ছাগী", "পাঠা", "খাসি"], brandsAndModels: [] },
                { itemTypeValue: "cows", keywords: ["cow", "cows", "bull", "গরু", "ষাড়", "গাভী", "বাছুর", "ফ্রিজিয়ান"], brandsAndModels: [] },
                { itemTypeValue: "chickens", keywords: ["chicken", "chickens", "murga", "murgi", "rooster", "মুরগি", "মুরগ", "মোরগ", "ব্রাহমা"], brandsAndModels: [] },
                { itemTypeValue: "ducks", keywords: ["duck", "ducks", "হাঁস", "হাস", "হাসের বাচ্চা"], brandsAndModels: [] },
                { itemTypeValue: "livestock", keywords: ["livestock", "ফার্ম পশু", "পশু", "কৃষি প্রাণী", "ভেড়া", "মহিষ"], brandsAndModels: [] },
                { itemTypeValue: "poultry", keywords: ["poultry", "quail", "faumi", "কোয়েল", "কিং কোয়েল", "ফাওমি", "ফাউমি", "তিতির"], brandsAndModels: [] },
                { itemTypeValue: "other", keywords: ["other", "others", "অন্যান্য"], brandsAndModels: [] }
            ],
            brandsAndModels: [] // No direct brands/models, all under itemTypes
        },

        {
            categoryValue: "310", // Pet Accessories
            keywords: ["cage", "khaca", "pinjira", "incubator", "খাচা", "খাঁচা", "aquarium", "খোপ", "ডিম ফুটানোর মেশিন", "ইনকুবেটর", "ইনকিউবেটর"],
            itemTypes: [], // No item type dropdown
            accessoryTypes: [
                { accessoryTypeValue: "dog_collars", keywords: ["dog collar", "dog collars", "কুকুরের কলার"] },
                { accessoryTypeValue: "bird_cages", keywords: ["bird cage", "bird cages", "খাঁচা", "পাখির খাঁচা", "pinjira"] },
                { accessoryTypeValue: "cat_carriers", keywords: ["cat carrier", "cat carriers", "বিড়াল ক্যারিয়ার"] },
                { accessoryTypeValue: "feeding_bowls", keywords: ["feeding bowl", "feeding bowls", "পোষা প্রাণীর খাবার বাটি", "খাবার বাটি"] },
                { accessoryTypeValue: "fish_tank", keywords: ["fish tank", "aquarium", "মাছের ট্যাংক", "অ্যাকুরিয়াম"] },
                { accessoryTypeValue: "other", keywords: ["other", "others", "অন্যান্য"] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "311", // Pet Food
            keywords: ["pet food", "meal worm", "mil worm", "বিটল পোকা", "বিটল লার্ভা", "মিল ওর্ম", " পোষা প্রাণীর খাবার", "পশুর খাবার", "কুকুরের খাবার", "মাছের খাবার", "cat food", "bird food"],
            itemTypes: [
                { itemTypeValue: "dog_food", keywords: ["dog food", "কুকুরের খাবার"], brandsAndModels: [] },
                { itemTypeValue: "cat_treats", keywords: ["cat treats", "cat food", "বিড়ালের খাবার"], brandsAndModels: [] },
                { itemTypeValue: "bird_seeds", keywords: ["bird seeds", "bird food", "পাখির খাবার", "বীজ"], brandsAndModels: [] },
                { itemTypeValue: "fish_pellets", keywords: ["fish pellets", "fish food", "মাছের খাবার"], brandsAndModels: [] },
                { itemTypeValue: "other", keywords: ["other", "others", "অন্যান্য"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },

        // Pets (Dogs, Cats, Birds, Fish, etc.)
        {
            categoryValue: "300",
            keywords: ["dog", "\\bcat\\b", "fish", "macow", "love bird", "love birds", "rodent", "kobotor", "rabbit", "hamster", "dove", "finch", "budgerigar", "bajigar", "budgie", "cockatiel", "cokatel", "kobutor", "bagigar", "budgigar", "budjigar", "ring neck", "ring net", "madi", "পোষা প্রাণী", "কুকুর", "বিড়াল", "মাছ", "হ্যামস্টার", "খরগোশ", "বাজরিগার", "ঘুঘু", "কবুতর", "কোবতর", "জাভা", "কোবুতর", "ফিন্স", "বাজিগর", "বাজিগার", "বাজ্রিকা", "বাজরিকা", "ডাভ", "বাজ্রিগার", "লাভ বার্ড", "লাভ বার্ডস", "রিং নেক", "রিং নেট", "নর", "মাদি"],
            itemTypes: [
                { itemTypeValue: "bird", keywords: ["কবুতর", "কোবতর", "জাভা", "কোবুতর", "বাজরিগার", "ফিন্স", "love bird", "love birds", "finch", "budgerigar", "bajigar", "budgie", "cockateil", "kobutor", "bagigar", "বাজিগর", "বাজিগার", "বাজ্রিকা", "বাজরিকা", "ঘুঘু", "ডাভ", "Dove", "budgigar", "budjigar", "বাজ্রিগার", "লাভ বার্ড", "লাভ বার্ডস", "রিং নেক", "রিং নেট", "নর", "মাদি"], brandsAndModels: [] },
                { itemTypeValue: "cat", keywords: ["বিড়াল", "পার্শিয়ান", "পার্সিয়ান", "\\bCat\\b", "Persian", "Kitten", "Parsian", "Persien", "বিলাই"], brandsAndModels: [] },
                { itemTypeValue: "rodent", keywords: ["হ্যামস্টার", "হেমস্টার", "Hamster", "Hamstar", "guinea pig", "mouse", "rat", "ইঁদুর"], brandsAndModels: [] },
                { itemTypeValue: "rabbit", keywords: ["rabbit", "খরগশ", "খরগোশ", "খরগোস"], brandsAndModels: [] },
                { itemTypeValue: "dog", keywords: ["dog", "কুকুর", "puppy", "labrador", "german shepherd", "husky", "poodle", "pug", "দেশি কুকুর"], brandsAndModels: [] },
                { itemTypeValue: "fish", keywords: ["fish", "মাছ", "aquarium fish", "গোল্ডফিশ", "guppy"], brandsAndModels: [] },
                { itemTypeValue: "other_pet", keywords: ["other pet"], brandsAndModels: [] } // 'other_pet' instead of 313
            ],
            brandsAndModels: [] // No direct brands/models, all under itemTypes
        },

        // Property
        { categoryValue: "220", keywords: ["apartment rental", "flat rent", "apartment for rent", "ফ্ল্যাট ভাড়া", "অ্যাপার্টমেন্ট ভাড়া"], itemTypes: [] },
        { categoryValue: "219", keywords: ["apartment for sale", "flat sale", "ফ্ল্যাট বিক্রি", "অ্যাপার্টমেন্ট বিক্রি", "বিক্রির জন্য ফ্ল্যাট"], itemTypes: [] },
        { categoryValue: "224", keywords: ["commercial property for sale", "shop for sale", "office for sale", "দোকান বিক্রি", "অফিস বিক্রি", "বাণিজ্যিক সম্পত্তি বিক্রি", "শো-রুম বিক্রি"], itemTypes: [] },
        { categoryValue: "225", keywords: ["commercial space rent", "shop rent", "office rent", "দোকান ভাড়া", "অফিস ভাড়া", "বাণিজ্যিক সম্পত্তি ভাড়া", "গোডাউন ভাড়া"], itemTypes: [] },
        { categoryValue: "222", keywords: ["house rental"], itemTypes: [] },
        { categoryValue: "221", keywords: ["house for sale", "home sale", "বাড়ি বিক্রি", "বিক্রির জন্য বাড়ি"], itemTypes: [] },
        { categoryValue: "227", keywords: ["land for sale", "plot for sale", "জমি বিক্রি", "প্লট বিক্রি", "জমির প্লট", "শিল্প প্লট"], itemTypes: [] },
        { categoryValue: "228", keywords: ["land rental", "plot rent", "জমি ভাড়া", "প্লট ভাড়া", "জমির লিজ"], itemTypes: [] },
        { categoryValue: "217", keywords: ["room rental", "room for rent", "রুম ভাড়া", "সিট ভাড়া"], itemTypes: [] },

        // Services
        { categoryValue: "1115", keywords: ["interior design", "construction service", "repair service", "নির্মাণ কাজ", "মেরামত কাজ", "ভবন রক্ষণাবেক্ষণ", "পেইন্টিং সার্ভিস", "ইলেকট্রিক সার্ভিস"], itemTypes: [] },
        { categoryValue: "1107", keywords: ["domestic service", "daycare", "housekeeping", "গৃহকর্মী", "ডে কেয়ার", "ঘরোয়া সেবা"], itemTypes: [] },
        { categoryValue: "1108", keywords: ["fitness service"], itemTypes: [] },
        { categoryValue: "1109", keywords: ["it service", "software development", "web design", "নেটওয়ার্কিং", "আইটি সেবা", "সফটওয়্যার ডেভেলপমেন্ট", "ওয়েব ডিজাইন", "গ্রাফিক্স ডিজাইন", "সার্ভার সার্ভিস"], itemTypes: [] },
        { categoryValue: "1110", keywords: ["matrimonial", "ম্যাচমেকিং"], itemTypes: [] },
        { categoryValue: "1111", keywords: ["media service", "event management", "photography service", "videography service", "মিডিয়া সার্ভিস", "ইভেন্ট ম্যানেজমেন্ট", "ফটোগ্রাফি", "ভিডিওগ্রাফি", "সাউন্ড সিস্টেম রেন্টাল"], itemTypes: [] },
        { categoryValue: "1112", keywords: ["professional service", "legal service", "consultancy", "accounting service", "আইনি সেবা", "পরামর্শ", "পেশাদার সেবা", "অ্যাকাউন্টিং", "ট্যাক্স সার্ভিস"], itemTypes: [] },
        { categoryValue: "1113", keywords: ["servicing", "repair", "appliance repair", "মেরামত", "সার্ভিসিং", "ইলেকট্রনিক্স মেরামত", "এসি সার্ভিস"], itemTypes: [] },
        { categoryValue: "1114", keywords: ["tour", "travel", "travel package", "tour package", "ভ্রমণ", "ট্যুর", "ট্যুর প্যাকেজ", "হোটেল বুকিং", "বিমান টিকিট"], itemTypes: [] },

        //Mens Fashion Category
        {
            categoryValue: "519", // Baby Boy's Fashion
            name: "Baby Boy's Fashion",
            keywords: ["kids dress", "kids shirt", "kids pant", "kids shoe", "baby shoe", "baby boy shoe", "baby socks"], // Added general item type keywords
            itemTypes: [
                { itemTypeValue: "clothing", name: "Clothing", keywords: ["kids dress", "kids shirt", "kids pant"], brandsAndModels: [] },
                { itemTypeValue: "shoes_accessories", name: "Shoes & Accessories", keywords: ["kids shoe", "baby shoe", "baby boy shoe", "baby socks"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "515", // Bags & Accessories
            name: "Men's Bags & Accessories",
            keywords: ["men's bag", "পুরুষদের ব্যাগ", "পুরুষদের এক্সেসরিজ", // Main category keywords
                       "men's backpack", "suitcases", "messenger bag", "crossbody bag", "travel bag", "belt", "wallet", "\\bcap\\b", "\\bhat\\b", "\\btie\\b", "bow tie", "underwear", "lighter", "umbrella"], // Added general item type keywords
            itemTypes: [
                { itemTypeValue: "backpack", name: "Backpack", keywords: ["men's backpack"], brandsAndModels: [] },
                { itemTypeValue: "suitcases", name: "Suitcase", keywords: ["suitcases", "স্যুটকেস", "luggage", "লাগেজ", "travel luggage"], brandsAndModels: [] },
                { itemTypeValue: "messenger", name: "Messenger Bag", keywords: ["messenger bags", "মেসেঞ্জার ব্যাগ", "men's messenger bag"], brandsAndModels: [] },
                { itemTypeValue: "crossbody", name: "Crossbody Bag", keywords: ["crossbody bags", "ক্রসবডি ব্যাগ", "men's crossbody bag"], brandsAndModels: [] },
                { itemTypeValue: "travel", name: "Travel Bag", keywords: ["travel bags", "ট্রাভেল ব্যাগ", "duffle bag", "ডাফেল ব্যাগ"], brandsAndModels: [] },
                { itemTypeValue: "belts", name: "Belt", keywords: ["belt", "বেল্ট", "men's belt", "leather belt"], brandsAndModels: [] },
                { itemTypeValue: "wallets", name: "Wallet", keywords: ["wallets", "ওয়ালেট", "men's wallet", "leather wallet"], brandsAndModels: [] },
                { itemTypeValue: "caps", name: "Cap & Hat", keywords: ["\\bcap\\b", "\\bhat\\b", "টুপি", "ক্যাপ", "men's cap", "men's hat"], brandsAndModels: [] },
                { itemTypeValue: "ties", name: "Tie & Bow Tie", keywords: ["\\btie\\b", "bow ties", "বো টাই", "men's tie"], brandsAndModels: [] },
                { itemTypeValue: "jewellery", name: "Jewellery", keywords: ["mens chain", "mens bracelet"], brandsAndModels: [] },
                { itemTypeValue: "innerwear", name: "Underwear", keywords: ["আন্ডারওয়্যার", "men's underwear", "boxers"], brandsAndModels: [] },
                { itemTypeValue: "lighters", name: "Lighter", keywords: ["lighter", "লাইটার", "gas lighter"], brandsAndModels: [] },
                { itemTypeValue: "umbrellas", name: "Umbrella", keywords: ["umbrella", "ছাতা", "men's umbrella"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "517", // Grooming & Bodycare
            name: "Men's Grooming & Bodycare",
            keywords: ["ator", "attar", "পুরুষদের গ্রুমিং", "বডিকয়ার", "ট্রিমার", // Main category keywords
                       "deodorant", "body spray", "trimmer", "razor", "shaving cream", "shaving gel"], // Added general item type keywords
            itemTypes: [
                { itemTypeValue: "deodorants", name: "Deodorant & Body Spray", keywords: ["deodorants", "body spray", "ডিওডোরেন্ট", "বডি স্প্রে", "ator", "attar"], brandsAndModels: [] },
                { itemTypeValue: "haircare", name: "Hair Care", keywords: ["hair oil men"], brandsAndModels: [] },
                { itemTypeValue: "skincare", name: "Skin & Body Care", keywords: ["mens cream", "mens facewash", "mens shampoo"], brandsAndModels: [] },
                { itemTypeValue: "razor", name: "Trimmer, Razor & Blade", keywords: ["trimmer", "razor", "ট্রিমার", "রেজার", "electric shaver"], brandsAndModels: [] },
                { itemTypeValue: "shaving_cream", name: "Shaving Cream & Gel", keywords: ["shaving cream", "shaving gel", "শেভিং ক্রিম", "শেভিং জেল", "aftershave"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য গ্রুমিং পণ্য"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "511", // Jacket & Coat
            name: "Men's Jacket & Coat",
            keywords: ["jacket", "জ্যাকেট", "men's jacket", "men's coat", // Main category keywords
                       "blazer", "denim jackets", "leather jackets", "rain coat", "boys hoodie", "sweatshirt", "boys sweater"], // Added general item type keywords
            itemTypes: [
                { itemTypeValue: "suits", name: "Suit & Blazer", keywords: ["blazer", "ব্লেজার", "men's suit", "men's blazer"], brandsAndModels: [] },
                { itemTypeValue: "denim", name: "Denim Jacket", keywords: ["denim jackets", "ডেনিমি জ্যাকেট", "jeans jacket"], brandsAndModels: [] },
                { itemTypeValue: "leather", name: "Leather Jacket", keywords: ["leather jackets", "লেদার জ্যাকেট", "leather coat"], brandsAndModels: [] },
                { itemTypeValue: "rain_coats", name: "Rain Coat & Trench", keywords: ["rain coat", "রেইনকোট", "ট্রেঞ্চ কোট", "men's raincoat"], brandsAndModels: [] },
                { itemTypeValue: "hoodies", name: "Hoodie & Sweatshirt", keywords: ["boys hoodie", "হুডি", "boys sweatshirt", "সোয়েটশার্ট"], brandsAndModels: [] },
                { itemTypeValue: "sweaters", name: "Sweater", keywords: ["boys sweaters", "সোয়েটার", "men's sweater", "cardigan men"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য জ্যাকেট ও কোট"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "518", // Optical & Sunglasses
            name: "Men's Optical & Sunglasses",
            keywords: ["men's optical", "men's sunglasses", "পুরুষদের চশমা", "eyewear men", // Main category keywords
                       "contact lens"], // Added general item type keywords
            itemTypes: [
                { itemTypeValue: "sunglass", name: "Men's Sunglass", keywords: ["sunglass", "সানগ্লাস", "men's sunglass", "polarized sunglasses"], brandsAndModels: [
                    { brandKeywords: ["ray-ban", "রে-ব্যান"], brandValue: "other", name: "Ray-Ban", modelKeywords: [] }, // Assuming 'other' if not in dropdown
                    { brandKeywords: ["oakley", "ওকলে"], brandValue: "other", name: "Oakley", modelKeywords: [] }
                ]},
                { itemTypeValue: "lens", name: "Eye Glass & Lens", keywords: ["eye glasses", "contact lens", "চশমা", "দৃষ্টি সংশোধক লেন্স"], brandsAndModels: [
                    { brandKeywords: ["ciba vision", "সিবা ভিশন"], brandValue: "other", name: "Ciba Vision", modelKeywords: [] },
                    { brandKeywords: ["bausch & lomb", "বশ অ্যান্ড লম্ব"], brandValue: "other", name: "Bausch & Lomb", modelKeywords: [] }
                ]}
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "513", // Pants
            name: "Men's Pants",
            keywords: ["jeans pants", "গ্যাবাডিন প্যান্ট", "গেবাডিন পেন্ট", "গেবাডিন প্যান্ট", "men's pants", "denim", "trouser", "cargo pants", "জিন্স"], // Main category keywords (kept as is)
            itemTypes: [
                { itemTypeValue: "jeans", name: "Jeans", keywords: ["jeans pant", "jeans", "জিন্স", "denim jeans", "men's jeans"], brandsAndModels: [] },
                { itemTypeValue: "cargo", name: "Cargo Pants", keywords: ["cargo", "cargo pants", "কার্গো প্যান্ট"], brandsAndModels: [] },
                { itemTypeValue: "joggers", name: "Jogger & Sweatpants", keywords: ["joggers", "jogger pants", "trouser", "trousers", "sweatpants", "সুইটপ্যান্ট", "জগার্স"], brandsAndModels: [] },
                { itemTypeValue: "shorts", name: "Shorts & Bermudas", keywords: ["shorts", "শর্টস", "bermudas", "বারমুডাস", "men's shorts"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য প্যান্ট"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "512", // Shirts & T-Shirts
            name: "Men's Shirts & T-Shirts",
            keywords: ["shirts", "t-shirts", "শার্ট", "টি-শার্ট", "men's shirt", "men's t-shirt", "polo shirt", "পোলো শার্ট", "casual shirt", "formal shirt"], // Main category keywords (kept as is)
            itemTypes: [
                { itemTypeValue: "t_shirts", name: "T-Shirt", keywords: ["t-shirt", "টি-শার্ট", "men's t-shirt", "graphic t-shirt", "v-neck t-shirt"], brandsAndModels: [] },
                { itemTypeValue: "polo", name: "Polo Shirt", keywords: ["polo", "polo shirt", "পোলো শার্ট", "men's polo"], brandsAndModels: [] },
                { itemTypeValue: "shirts", name: "Shirt", keywords: ["shirt", "শার্ট", "men's shirt", "casual shirt", "formal shirt", "denim shirt"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য শার্ট ও টি-শার্ট"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "516", // Traditional Clothing
            name: "Men's Traditional Clothing",
            keywords: ["panjabi", "punjabi", "পাজামা", "sherwani", "lungi", "লুঙ্গি", "পাঞ্জাবি", "শাওয়ানি", "fatua", "ফতুয়া"], // Main category keywords
            itemTypes: [
                { itemTypeValue: "punjabi", name: "Panjabi & Sherwani", keywords: ["punjabi", "panjabi", "পাঞ্জাবি", "sherwani", "শাওয়ানি"], brandsAndModels: [] },
                { itemTypeValue: "lungi", name: "Lungi & Fotua", keywords: ["lungi", "লুঙ্গি", "fotua", "ফতুয়া"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য ঐতিহ্যবাহী পোশাক"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "520", // Watches
            name: "Men's Watch",
            keywords: ["men's watch", "পুরুষদের ঘড়ি", "wrist watch", "digital watch", "analog watch", // Main category keywords
                       "analog", "analogue", "chronograph"], // Added general item type keywords
            itemTypes: [
                { itemTypeValue: "digital", name: "Digital Watch", keywords: ["digital", "digital watch", "ডিজিটাল ঘড়ি"], brandsAndModels: [
                    { brandKeywords: ["casio", "ক্যাসিও"], brandValue: "casio", name: "Casio", modelKeywords: ["g-shock", "edifice", "f-91w"] },
                    { brandKeywords: ["skmei", "স্কমে"], brandValue: "other", name: "Skmei", modelKeywords: [] }
                ]},
                { itemTypeValue: "analog", name: "Analogue Watch", keywords: ["analog", "analogue", "এনালগ ঘড়ি", "analog watch"], brandsAndModels: [
                    { brandKeywords: ["titan", "টাইটান"], brandValue: "other", name: "Titan", modelKeywords: [] },
                    { brandKeywords: ["fastrack", "ফাস্টট্র্যাক"], brandValue: "other", name: "Fastrack", modelKeywords: [] },
                    { brandKeywords: ["rolex", "রোলেক্স"], brandValue: "other", name: "Rolex", modelKeywords: [] }
                ]},
                { itemTypeValue: "chronograph", name: "Chronograph Watch", keywords: ["chronograph", "ক্রোনোগ্রাফ", "stopwatch watch"], brandsAndModels: [] },
                { itemTypeValue: "other", name: "Other Watch", keywords: ["other watch", "অন্যান্য ঘড়ি"], brandsAndModels: [] } // Added if the dropdown has an "Others"
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "521", // Wholesale - Bulk
            name: "Men's Fashion Wholesale",
            keywords: ["men's fashion wholesale", "bulk men's clothing", "পুরুষদের পোশাক পাইকারি", "পাইকারি পোশাক", "wholesale fashion men"],
            itemTypes: [], // Assuming no further item_type dropdown
            brandsAndModels: []
        },

        // Women's Fashion & Beauty
        {
            categoryValue: "551", // Baby Girl's Fashion
            name: "Baby Girl's Fashion",
            keywords: ["baby dress", "baby party dress", "girl's dress", "baby frock", "baby kurti", "ছোট মেয়ের জামা", "ছোট মেয়ের মোজা", "ছোট মেয়ের জুতা", "বেবি গার্লস ফ্যাশন", "বাচ্চাদের পোশাক", // Main category keywords
                      ], // Added general item type keywords
            itemTypes: [
                { itemTypeValue: "clothings", name: "Clothing", keywords: ["baby girl clothing", "ছোট মেয়ের পোশাক", "baby dress", "baby party dress", "girl's dress", "baby frock", "baby kurti"], brandsAndModels: [] },
                { itemTypeValue: "accessories", name: "Shoes & Accessories", keywords: ["baby girl shoes", "baby girl accessories", "ছোট মেয়ের জুতা", "শিশুদের জুতা", "baby socks", "baby cap", "baby shoes"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "544", // Women's Bag & Accessories
            name: "Women's Bag & Accessory",
            keywords: ["women's bag", "ladies bag", "women's accessory", "hand bag", "handbag", "হ্যান্ডব্যাগ", "লেডিস ব্যাগ", "মহিলাদের এক্সেসরিজ", "ladies umbrella", "shoulder bag"], // Added general item type keywords
            itemTypes: [
                { itemTypeValue: "bags", name: "Cross Body & Shoulder Bag", keywords: ["cross body bag", "shoulder bag", "ladies backpack", "ক্রস বডি ব্যাগ", "শোল্ডার ব্যাগ", "ladies backpack", "ladies bag"], brandsAndModels: [] },
                { itemTypeValue: "purses", name: "Coin Purse & Pouch", keywords: ["purses", "coin purse", "পাউচ", "ladies wallet", "ladies purse", "ওয়ালেট", "কয়েন পার্স"], brandsAndModels: [] },
                { itemTypeValue: "handbags", name: "Handbag", keywords: ["handbag", "হ্যান্ডব্যাগ", "ladies handbag"], brandsAndModels: [] },
                { itemTypeValue: "belts", name: "Belt", keywords: ["ladies belt"], brandsAndModels: [] },
                { itemTypeValue: "umbrella", name: "Umbrella", keywords: ["ladies umbrella", "লেডিস ছাতা"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "548", // Beauty & Personal Care
            name: "Beauty & Personal Care",
            keywords: ["makeup", "মেকআপ", "foundation", "primer", "concealer", "blush", "ফাউন্ডেশন", "ব্লাশ", "cream", "lotion", "serum", "sunscreen", "ক্রিম", "লোশন", "সিরাম", "body lotion", "body wash", "body scrub", "বডি লোশন", "বডি ওয়াশ", "haircare", "চুলের যত্ন", "shampoo", "conditioner", "hair oil", "শ্যাম্পু", "কন্ডিশনার", "চুলের তেল", "face wash", "face mask", "scrub", "ফেস ওয়াশ", "hair straightner", "straightner", "makeup brushes", "hair dryer", "makeup sponge", "mehedi", "মেহেদি", "মেকআপ ব্রাশ"], // Main category keywords
            itemTypes: [
                { itemTypeValue: "makeup", name: "Makeup", keywords: ["makeup", "মেকআপ", "foundation", "primer", "concealer", "blush", "ফাউন্ডেশন", "ব্লাশ"], brandsAndModels: [] },
                { itemTypeValue: "skincare", name: "Skincare", keywords: ["skincare", "ত্বকের যত্ন", "cream", "lotion", "serum", "sunscreen", "ক্রিম", "লোশন", "সিরাম"], brandsAndModels: [] },
                { itemTypeValue: "lipsticks", name: "Lipstick", keywords: ["lipsticks", "লিপস্টিক", "lip gloss", "lip balm"], brandsAndModels: [] },
                { itemTypeValue: "perfumes", name: "Perfume & Fragrance", keywords: ["perfumes", "fragrances", "পারফিউম", "সুগন্ধি", "deodorant", "ডিওডোরেন্ট"], brandsAndModels: [] },
                { itemTypeValue: "bodycare", name: "Bodycare", keywords: ["bodycare", "বডিকয়ার", "body lotion", "body wash", "body scrub", "বডি লোশন", "বডি ওয়াশ"], brandsAndModels: [] },
                { itemTypeValue: "haircare", name: "Haircare", keywords: ["haircare", "চুলের যত্ন", "shampoo", "conditioner", "hair oil", "শ্যাম্পু", "কন্ডিশনার", "চুলের তেল"], brandsAndModels: [] },
                { itemTypeValue: "facecare", name: "Facecare", keywords: ["facecare", "ফেসকেয়ার", "face wash", "face mask", "scrub", "ফেস ওয়াশ", "ফেস মাস্ক"], brandsAndModels: [] },
                { itemTypeValue: "tools", name: "Tools & Accessories", keywords: ["hair straightner", "straightner", "makeup brushes", "hair dryer", "makeup sponge", "mehedi", "মেহেদি", "মেকআপ ব্রাশ"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "545", // Women's Footwear
            name: "Women's Footwear",
            keywords: ["heel", "women's shoe", "ladies shoe", "high heel", "মহিলাদের জুতা", "হিল", "লেডিস স্যান্ডেল", "লেডিস সু"], // Main category keywords
            itemTypes: [
                { itemTypeValue: "heels", name: "Sandal & Heel", keywords: ["heels", "high heel", "হিল", "ladies sandal", "ladies heels"], brandsAndModels: [] },
                { itemTypeValue: "shoes", name: "Shoe", keywords: ["ladies shoes", "sneakers women"], brandsAndModels: [] },
                { itemTypeValue: "flip_flops", name: "Flip Flop", keywords: ["flip flops", "ফ্লিপ ফ্লপ", "ladies flip flops"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য জুতা"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "547", // Women's Jewellery & Watches
            name: "Women's Jewellery & Watch",
            keywords: ["ladies watch", "womens ring", "necklace", "earring", "jewellery set", "nosepin", "গহনা", "জুয়েলারি", "মেয়েদের ঘড়ি", "আংটি", "নেকলেস", "কানের দুল", "চুড়ি", "ব্রেসলেট"], // Main category keywords
            itemTypes: [
                { itemTypeValue: "watches", name: "Women's Watch", keywords: ["ladies watch", "মেয়েদের ঘড়ি"], brandsAndModels: [] },
                { itemTypeValue: "rings", name: "Ring", keywords: ["rings", "আংটি", "finger ring", "gold ring", "silver ring", "diamond ring"], brandsAndModels: [] },
                { itemTypeValue: "necklaces", name: "Necklace", keywords: ["necklaces", "নেকলেস", "chain", "চেইন"], brandsAndModels: [] },
                { itemTypeValue: "pendants", name: "Pendant", keywords: ["pendants", "পেন্ডেন্ট"], brandsAndModels: [] },
                { itemTypeValue: "earrings", name: "Earring", keywords: ["earrings", "কানের দুল"], brandsAndModels: [] },
                { itemTypeValue: "nosepin", name: "Nose Pin", keywords: ["nosepin", "নোজ পিন", "নাকফুল"], brandsAndModels: [] },
                { itemTypeValue: "jewellery", name: "Jewellery Set", keywords: ["jewellery", "jewellery set", "গহনা সেট", "bridal jewellery"], brandsAndModels: [] },
                { itemTypeValue: "bracelets", name: "Bracelet", keywords: ["bracelets", "ব্রেসলেট", "bangles", "churi", "চুড়ি"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য জুয়েলারি"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        { categoryValue: "546", keywords: ["lingerie"], itemTypes: [] },
        {
            categoryValue: "549", // Women's Optical & Sunglasses
            name: "Women's Optical & Sunglass",
            keywords: ["women's optical", "women's sunglass", "মহিলাদের চশমা", "মহিলাদের সানগ্লাস", "চশমা ফ্রেম"], // Main category keywords
            itemTypes: [
                { itemTypeValue: "sunglasses", name: "Women Sunglasses", keywords: ["women sunglass", "ladies sunglass"], brandsAndModels: [] },
                { itemTypeValue: "kids_glasses", name: "Kids Sunglasses", keywords: ["kids glass", "বাচ্চাদের চশমা", "children's sunglass"], brandsAndModels: [] },
                { itemTypeValue: "lens", name: "Eye Glass, Lens & Frame", keywords: ["eye glass", "frames", "চোখের চশমা", "চশমা ফ্রেম", "contact lens"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "541", // Traditional Wear
            name: "Women's Traditional Wear",
            keywords: ["saree", "\\bsari\\b", "saree", "katan", "কাতান", "শাড়ি", "বোরকা", "বেনারসি শাড়ি", "জামদানি শাড়ি", "কাতান শাড়ি", "লেহেঙ্গা", "kurti", "shalwar kameez", "shalwar kamiz", "kurti", "স্যালোয়ার কামিজ", "কুর্তি", "ladies kurti", "three piece", "থ্রি পিস", "থ্রি পিচ", "থ্রি পিছ", "থ্রিপিস", "hijab", "abaya", "borka", "borkah", "borkha", "হিজাব", "আবায়া", "burqa", "বোরখা"], // Main category keywords
            itemTypes: [
                { itemTypeValue: "sarees", name: "Saree", keywords: ["saree", "\\bsari\\b", "saree", "katan", "কাতান", "শাড়ি", "বেনারসি শাড়ি", "জামদানি শাড়ি", "কাতান শাড়ি"], brandsAndModels: [] },
                { itemTypeValue: "kurtis", name: "Shalwar Kameez & Kurti", keywords: ["kurti", "shalwar kameez", "shalwar kamiz", "kurti", "স্যালোয়ার কামিজ", "কুর্তি", "ladies kurti", "three piece", "থ্রি পিস", "থ্রি পিচ", "থ্রি পিছ", "থ্রিপিস"], brandsAndModels: [] },
                { itemTypeValue: "unstitched", name: "Unstitched Fabric", keywords: ["unstitched fabric", "আনস্টিচড", "কাপড়", "ladies fabric", "ladies cloth"], brandsAndModels: [] },
                { itemTypeValue: "hijab", name: "Hijab & Abaya", keywords: ["hijab", "abaya", "borka", "borkah", "borkha", "বোরকা", "হিজাব", "আবায়া", "burqa", "বোরখা"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য ঐতিহ্যবাহী পোশাক", "lehenga", "লেহেঙ্গা", "bridal wear"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        {
            categoryValue: "543", // Western Wear
            name: "Women's Western Wear",
            keywords: ["skirt", "ladies top", "ladies jeans", "gown", "ওয়েস্টার্ন পোশাক", "স্কার্ট", "টপস", "লেডিস জিন্স", "লেডিস শার্ট", "লেডিস প্যান্ট"], // Main category keywords
            itemTypes: [
                { itemTypeValue: "gowns", name: "Gown", keywords: ["gown", "গাউন", "gawn", "evening gown", "পার্টি গাউন", "party gown"], brandsAndModels: [] },
                { itemTypeValue: "tops", name: "Top & T-Shirt", keywords: ["tops", "টপস", "লেডিস টি-শার্ট", "ladies top", "ladies t-shirt"], brandsAndModels: [] },
                { itemTypeValue: "shirts", name: "Shirt", keywords: ["ladies shirt", "লেডিস শার্ট", "ladies shirt", "women's shirt"], brandsAndModels: [] },
                { itemTypeValue: "pants", name: "Pant", keywords: ["ladies pants", "ladies jeans", "লেডিস জিন্স", "ladies trouser"], brandsAndModels: [] },
                { itemTypeValue: "skirts", name: "Skirt", keywords: ["skirts", "স্কার্ট", "ladies skirt"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য ওয়েস্টার্ন পোশাক", "jumpsuit", "ওভারঅল"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },
        { categoryValue: "550", keywords: ["women's fashion wholesale", "bulk fashion women", "মহিলাদের ফ্যাশন পাইকারি"], itemTypes: [] },
        {
            categoryValue: "542", // Winter Wear
            name: "Women's Winter Wear",
            keywords: ["ladies sweater", "shawl", "লেডিস সোয়েটার", "লেডিস জ্যাকেট", "ladies hoodie", "cardigan"], // Main category keywords
            itemTypes: [
                { itemTypeValue: "sweaters", name: "Sweater & Cardigan", keywords: ["লেডিস সোয়েটার", "cardigans", "কার্ডিগান", "ladies sweater", "ladies cardigan", "ladies hoodie"], brandsAndModels: [] },
                { itemTypeValue: "jackets", name: "Jacket", keywords: ["ladies jacket", "women's jacket"], brandsAndModels: [] },
                { itemTypeValue: "coats", name: "Coat", keywords: ["ladies coat", "লেডিস কোট", "women's coat"], brandsAndModels: [] },
                { itemTypeValue: "others", name: "Other Item", keywords: ["others", "অন্যান্য শীতের পোশাক", "shawl", "muffler"], brandsAndModels: [] }
            ],
            brandsAndModels: []
        },

        // Jobs (top-level categories, no item_type or brand/model)
        { categoryValue: "349", keywords: ["local job"], itemTypes: [] },
        { categoryValue: "400", keywords: ["overseas job"], itemTypes: [] },
        { categoryValue: "1401", keywords: ["accountant", "হিসাবরক্ষক"], itemTypes: [] },
        { categoryValue: "1404", keywords: ["beautician", "বিউটিশিয়ান", "beauty expert", "সৌন্দর্য বিশেষজ্ঞ"], itemTypes: [] },
        { categoryValue: "1405", keywords: ["business analyst", "বিজনেস অ্যানালিস্ট"], itemTypes: [] },
        { categoryValue: "1409", keywords: ["chef", "বাবুর্চি", "শেফ", "খাবার প্রস্তুতকারী"], itemTypes: [] },
        { categoryValue: "1411", keywords: ["collection agent", "recovery agent", "কালেকশন এজেন্ট", "সংগ্রহকারী"], itemTypes: [] },
        { categoryValue: "1412", keywords: ["construction worker", "রাজমিস্ত্রি", "নির্মাণ শ্রমিক", "মিস্ত্রি"], itemTypes: [] },
        { categoryValue: "1413", keywords: ["content writer", "কন্টেন্ট রাইটার", "copywriter", "লেখক", "অনুবাদক"], itemTypes: [] },
        { categoryValue: "1414", keywords: ["counsellor", "কাউন্সেলর", "consultant", "পরামর্শক"], itemTypes: [] },
        { categoryValue: "1415", keywords: ["customer service", "কাস্টমার সার্ভিস", "call center", "কল সেন্টার"], itemTypes: [] },
        { categoryValue: "1487", keywords: ["customer support manager", "কাস্টমার সাপোর্ট ম্যানেজার"], itemTypes: [] },
        { categoryValue: "1416", keywords: ["delivery rider", "ডেলিভারি রাইডার", "delivery boy", "ডেলিভারি ম্যান", "ডেলিভারি"], itemTypes: [] },
        { categoryValue: "1417", keywords: ["designer", "ডিজাইনার", "graphic designer", "web designer", "ফ্যাশন ডিজাইনার"], itemTypes: [] },
        { categoryValue: "1488", keywords: ["digital marketing executive", "ডিজিটাল মার্কেটিং এক্সিকিউটিভ"], itemTypes: [] },
        { categoryValue: "1489", keywords: ["digital marketing manager", "ডিজিটাল মার্কেটিং ম্যানেজার"], itemTypes: [] },
        { categoryValue: "1501", keywords: ["doctor", "ডাক্তার", "চিকিৎসক", "physician", "নার্স", "ফার্মাসিস্ট"], itemTypes: [] },
        { categoryValue: "1419", keywords: ["driver", "চালক", "ড্রাইভার", "car driver", "bike driver", "গাড়ি চালক", "মোটরসাইকেল চালক", "হেভি ড্রাইভার"], itemTypes: [] },
        { categoryValue: "1421", keywords: ["electrician", "ইলেকট্রিশিয়ান"], itemTypes: [] },
        { categoryValue: "1422", keywords: ["engineer", "প্রকৌশলী", "ইঞ্জিনিয়ার", "software engineer", "civil engineer", "মেকানিক্যাল ইঞ্জিনিয়ার", "ইলেকট্রিক্যাল ইঞ্জিনিয়ার"], itemTypes: [] },
        { categoryValue: "1423", keywords: ["event planner", "ইভেন্ট প্ল্যানার"], itemTypes: [] },
        { categoryValue: "1426", keywords: ["fire fighter", "ফায়ার ফাইটার"], itemTypes: [] },
        { categoryValue: "1490", keywords: ["flight attendant", "ফ্লাইট অ্যাটেনডেন্ট"], itemTypes: [] },
        { categoryValue: "1428", keywords: ["florist", "ফ্লোরিস্ট"], itemTypes: [] },
        { categoryValue: "1429", keywords: ["gardener", "মালী", "গার্ডেনার"], itemTypes: [] },
        { categoryValue: "1430", keywords: ["garments worker", "পোশাক কর্মী", "গার্মেন্টস কর্মী", "শ্রমিক"], itemTypes: [] },
        { categoryValue: "1482", keywords: ["government job", "সরকারি চাকরি"], itemTypes: [] },
        { categoryValue: "1434", keywords: ["hr executive", "এইচআর এক্সিকিউটিভ"], itemTypes: [] },
        { categoryValue: "1491", keywords: ["hr manager", "এইচআর ম্যানেজার"], itemTypes: [] },
        { categoryValue: "1432", keywords: ["hospitality executive", "হসপিটালিটি এক্সিকিউটিভ"], itemTypes: [] },
        { categoryValue: "1433", keywords: ["house keeper", "গৃহকর্মী", "হাউস কিপার"], itemTypes: [] },
        { categoryValue: "1492", keywords: ["interior designer", "ইন্টেরিয়র ডিজাইনার"], itemTypes: [] },
        { categoryValue: "1493", keywords: ["journalist", "সাংবাদিক"], itemTypes: [] },
        { categoryValue: "1435", keywords: ["lab assistant", "ল্যাব অ্যাসিস্ট্যান্ট"], itemTypes: [] },
        { categoryValue: "1438", keywords: ["maid", "ঝি", "পরিচারিকা"], itemTypes: [] },
        { categoryValue: "1439", keywords: ["management trainee", "ম্যানেজমেন্ট ট্রেইনি"], itemTypes: [] },
        { categoryValue: "1440", keywords: ["market research analyst", "মার্কেট রিসার্চ অ্যানালিস্ট"], itemTypes: [] },
        { categoryValue: "1494", keywords: ["marketing executive", "মার্কেটিং এক্সিকিউটিভ"], itemTypes: [] },
        { categoryValue: "1495", keywords: ["marketing manager", "মার্কেটিং ম্যানেজার"], itemTypes: [] },
        { categoryValue: "1442", keywords: ["mechanic", "মিস্ত্রি", "মেকানিক"], itemTypes: [] },
        { categoryValue: "1443", keywords: ["medical representative", "মেডিকেল রিপ্রেজেন্টেটিভ"], itemTypes: [] },
        { categoryValue: "1444", keywords: ["merchandiser", "মার্চেন্ডাইজার"], itemTypes: [] },
        { categoryValue: "1445", keywords: ["nurse", "নার্স"], itemTypes: [] },
        { categoryValue: "1447", keywords: ["office admin", "অফিস অ্যাডমিন"], itemTypes: [] },
        { categoryValue: "1450", keywords: ["operator", "অপারেটর"], itemTypes: [] },
        { categoryValue: "1451", keywords: ["other job", "অন্যান্য চাকরি", "others", "অন্যান্য"], itemTypes: [] }, // "Other" for jobs
        { categoryValue: "1456", keywords: ["pharmacist", "ফার্মাসিস্ট"], itemTypes: [] },
        { categoryValue: "1457", keywords: ["photographer", "ফটোগ্রাফার"], itemTypes: [] },
        { categoryValue: "1496", keywords: ["product sourcing executive", "প্রোডাক্ট সোর্সিং এক্সিকিউটিভ"], itemTypes: [] },
        { categoryValue: "1497", keywords: ["production executive", "প্রোডাকশন এক্সিকিউটিভ"], itemTypes: [] },
        { categoryValue: "1461", keywords: ["public relations officer", "পাবলিক রিলেশন্স অফিসার"], itemTypes: [] },
        { categoryValue: "1462", keywords: ["purchase officer", "পার্চেজ অফিসার"], itemTypes: [] },
        { categoryValue: "1463", keywords: ["quality checker", "কোয়ালিটি চেকার"], itemTypes: [] },
        { categoryValue: "1502", keywords: ["quality controller", "কোয়ালিটি কন্ট্রোলার"], itemTypes: [] },
        { categoryValue: "1499", keywords: ["seo specialist", "এসইও স্পেশালিস্ট"], itemTypes: [] },
        { categoryValue: "1467", keywords: ["sales executive", "সেলস এক্সিকিউটিভ"], itemTypes: [] },
        { categoryValue: "1498", keywords: ["sales manager field", "ফিল্ড সেলস ম্যানেজার"], itemTypes: [] },
        { categoryValue: "1468", keywords: ["security guard", "নিরাপত্তা কর্মী", "সিকিউরিটি গার্ড"], itemTypes: [] },
        { categoryValue: "1500", keywords: ["social media presenter", "সোশ্যাল মিডিয়া উপস্থাপক"], itemTypes: [] },
        { categoryValue: "1470", keywords: ["software engineer", "সফটওয়্যার ইঞ্জিনিয়ার"], itemTypes: [] },
        { categoryValue: "1472", keywords: ["supervisor", "সুপারভাইজার"], itemTypes: [] },
        { categoryValue: "1478", keywords: ["videographer", "ভিডিওগ্রাফার"], itemTypes: [] },

        // Single-level categories (General "Other" is a catch-all)
        { categoryValue: "390", keywords: ["অন্যান্য পণ্য"], itemTypes: [] }, // General "Other" category
    ];

    // --- Deactivated Ad Check ---
    function checkIfAdIsDeactivated() {
        const reviewHeader = document.querySelector('.ui-panel.is-AdState_DEACTIVATED.review-header');
        if (reviewHeader) {
            isAdDeactivated = true;
            console.log("[Script Halt] Ad is DEACTIVATED. Halting all auto-actions.");
            return true;
        }
        isAdDeactivated = false;
        return false;
    }
    // --- End Deactivated Ad Check ---

    // Function to check audit log for blacklist rejection reasons and tick the checkbox
    function checkAuditLogForRejectionReason() {
        if (isMembershipAd) {
            console.log("[Rejection Reason] Action halted due to special membership status.");
            return;
        }
        const auditLogDiv = document.querySelector('.ui-info-box.review-logs');
        if (auditLogDiv) {
            // Get the entire text content of the audit log, normalize spaces and newlines
            const auditLogText = auditLogDiv.textContent.replace(/\s+/g, ' ').trim();
            console.log("[Rejection Reason] Audit log content:", auditLogText);

            // More robust checks for blacklisted/fraud account rejections
            // Using regex for more flexible matching, considering different phrasing
            isAdBlacklistedOrFraud =
                /(Rejected\s+(?:from\s+verification\s+)?with\s+Blacklisted account)/i.test(auditLogText) ||
                /(Rejected\s+with\s+Fraud)/i.test(auditLogText) ||
                /(Account flagged as blacklisted)/i.test(auditLogText);

            if (blacklistedAccountCheckbox) {
                if (isAdBlacklistedOrFraud) {
                    if (!blacklistedAccountCheckbox.checked) {
                        blacklistedAccountCheckbox.checked = true;
                        triggerChangeEvent(blacklistedAccountCheckbox);
                        console.log("[Rejection Reason] 'Blacklisted Account' checkbox automatically selected.");
                    } else {
                        console.log("[Rejection Reason] 'Blacklisted Account' checkbox already selected.");
                    }
                } else {
                    // If the conditions for blacklisted account are NOT met, uncheck it if it was checked.
                    if (blacklistedAccountCheckbox.checked) {
                        blacklistedAccountCheckbox.checked = false;
                        triggerChangeEvent(blacklistedAccountCheckbox);
                        console.log("[Rejection Reason] 'Blacklisted Account' checkbox unchecked as condition not met.");
                    } else {
                        console.log("[Rejection Reason] No blacklisted account or fraud detected in audit log, and checkbox is already unchecked.");
                    }
                }
            } else {
                console.warn("[Rejection Reason] 'Blacklisted Account' checkbox not found!");
            }
        } else {
            console.log("[Rejection Reason] Audit log not found.");
        }
    }
    // --- End Auto-select Rejection Reason ---

// --- Auto-Click Continue Button Feature for Deactivated Ads on Verification Page ---
function autoClickContinueForDeactivatedAd() {
    const targetUrl = "https://admin.bikroy.com/review/item/verification";
    const currentUrl = window.location.href;

    // Check if the current URL is the exact target verification page
    const isVerificationPage = currentUrl === targetUrl;
    const continueButton = document.querySelector('.ui-btn.is-secondary.btn-submit.has-busy.is-auto');

    // The script will now only proceed if on the specific verification page
    if (isAdDeactivated && !isAdBlacklistedOrFraud && isVerificationPage) {
        if (continueButton && !continueButton.disabled) {
            console.log("[Auto-Continue] Deactivated ad detected on the verification page. Attempting to click 'Continue'.");
            continueButton.click();
        } else {
            console.log("[Auto-Continue] 'Continue' button not found or disabled on the verification page.");
        }
    } else {
        // Updated log to be more specific about why the script didn't run
        if (!isVerificationPage) {
             console.log(`[Auto-Continue] Script ignored. Current page (${currentUrl}) is not the target verification page.`);
        } else {
             console.log("[Auto-Continue] Auto-click conditions not met (e.g., ad not deactivated or is blacklisted/fraud).");
        }
    }
}
// --- End Auto-Click Continue Button Feature ---

    // Helper function to trigger a change event on an element
    function triggerChangeEvent(element) {
        const event = new Event('change', { bubbles: true });
        element.dispatchEvent(event);
        console.log(`[Auto-Select] Triggered change event for: ${element.id || element.name || element.tagName}`);
    }

    // Function to check if title contains any keyword from a list (case-insensitive, whole word for regex keywords)
    function containsKeyword(title, keywords, excludedKeywords = []) {
        const lowerTitle = title.toLowerCase();

        // Check for exclusions first
        if (excludedKeywords.some(keyword => lowerTitle.includes(keyword.toLowerCase()))) {
            console.log(`[Auto-Select] Excluded due to keyword: '${excludedKeywords.find(k => lowerTitle.includes(k.toLowerCase()))}' in title: '${title}'`);
            return false;
        }

        // Check for positive keywords
        return keywords.some(keyword => {
            if (keyword.startsWith('\\b') && keyword.endsWith('\\b')) {
                // Use regex for whole word match if specified (e.g., "\\bfan\\b")
                try {
                    const regex = new RegExp(keyword, 'i'); // 'i' for case-insensitive
                    const match = regex.test(lowerTitle);
                    if (match) {
                        console.log(`[Auto-Select] Regex keyword match: '${keyword}' in title: '${title}'`);
                    }
                    return match;
                } catch (e) {
                    console.error(`[Auto-Select] Invalid regex keyword: ${keyword}`, e);
                    return false;
                }
            }
            // Otherwise, use simple inclusion
            const match = lowerTitle.includes(keyword.toLowerCase());
            if (match) {
                console.log(`[Auto-Select] Keyword match: '${keyword}' in title: '${title}'`);
            }
            return match;
        });
    }


    function getMatchedKeywords(title, keywords = [], excludedKeywords = []) {
        const lowerTitle = title.toLowerCase();

        if (excludedKeywords.some(keyword => lowerTitle.includes(String(keyword).toLowerCase()))) {
            return [];
        }

        return (keywords || []).filter(keyword => {
            const text = String(keyword);
            if (text.startsWith('\\b') && text.endsWith('\\b')) {
                try {
                    return new RegExp(text, 'i').test(lowerTitle);
                } catch (_) {
                    return false;
                }
            }
            return lowerTitle.includes(text.toLowerCase());
        });
    }

    function selectBestCategoryMatch(title, matchingCategories) {
        if (!matchingCategories || matchingCategories.length <= 1) return matchingCategories[0] || null;

        const scored = matchingCategories.map(entry => {
            const matchedKeywords = getMatchedKeywords(title, entry.keywords, entry.excludedKeywords);
            const maxKeywordLength = matchedKeywords.length
                ? Math.max(...matchedKeywords.map(k => String(k).replace(/\\b/g, '').length))
                : 0;
            const regexKeywordCount = matchedKeywords.filter(k => String(k).startsWith('\\b') && String(k).endsWith('\\b')).length;
            const multiWordCount = matchedKeywords.filter(k => String(k).trim().includes(' ')).length;
            return { entry, matchedKeywords, maxKeywordLength, regexKeywordCount, multiWordCount };
        });

        scored.sort((a, b) =>
            b.maxKeywordLength - a.maxKeywordLength ||
            b.multiWordCount - a.multiWordCount ||
            b.regexKeywordCount - a.regexKeywordCount ||
            b.matchedKeywords.length - a.matchedKeywords.length
        );

        const best = scored[0];
        const tie = scored[1] &&
            scored[1].maxKeywordLength === best.maxKeywordLength &&
            scored[1].multiWordCount === best.multiWordCount &&
            scored[1].regexKeywordCount === best.regexKeywordCount &&
            scored[1].matchedKeywords.length === best.matchedKeywords.length;

        if (tie) {
            console.warn(`[Auto-Select] Multiple category matches detected (${matchingCategories.length}) with equal strength. Keeping original category.`);
            return null;
        }

        console.warn(`[Auto-Select] Multiple category matches detected (${matchingCategories.length}). Selected best match ${best.entry.categoryValue} using specific keyword scoring.`);
        return best.entry;
    }

    // Generic function to observe a select dropdown and select the appropriate value when it appears
    // It will also try to set the value immediately if the element and options are already available.
    function observeAndSetSelectValue(elementId, targetValue, observerRefName) {
        if (isAdDeactivated || isMembershipAd) {
            console.log(`[Auto-Select] Ad is deactivated or has special membership. Skipping setting ${elementId}.`);
            return;
        }

        let selectElement = document.getElementById(elementId);

        // Try to set immediately if the element and options are already loaded
        if (selectElement && selectElement.options.length > 0) {
            const optionExists = Array.from(selectElement.options).some(option => option.value === targetValue);
            if (optionExists && selectElement.value !== targetValue) {
                selectElement.value = targetValue;
                console.log(`[Auto-Select] ${elementId} set immediately to: ${targetValue}`);
                triggerChangeEvent(selectElement);
            } else if (!optionExists) {
                console.log(`[Auto-Select] Target value '${targetValue}' not found immediately for ${elementId}. Observing...`);
            } else if (selectElement.value === targetValue) {
                console.log(`[Auto-Select] ${elementId} already has target value: ${targetValue}.`);
            }
        } else {
            console.log(`[Auto-Select] ${elementId} not found immediately or no options. Observing...`);
        }

        // Disconnect any existing observer for this element to prevent multiple triggers
        if (window[observerRefName]) {
            window[observerRefName].disconnect();
            console.log(`[Auto-Select] Disconnected previous observer for ${elementId}.`);
        }

        // Create a new observer
        window[observerRefName] = new MutationObserver((mutations, observer) => {
            if (isAdDeactivated || isMembershipAd) { // Re-check status inside observer callback
                console.log(`[Auto-Select] Ad status changed (deactivated/membership). Disconnecting observer for ${elementId}.`);
                observer.disconnect();
                return;
            }

            const updatedElement = document.getElementById(elementId); // Get element again, it might have been replaced
            if (updatedElement && updatedElement.tagName === 'SELECT' && updatedElement.options.length > 0) {
                const optionExists = Array.from(updatedElement.options).some(option => option.value === targetValue);

                if (optionExists) {
                    if (updatedElement.value !== targetValue) {
                        updatedElement.value = targetValue;
                        console.log(`[Auto-Select] ${elementId} set via observer to: ${targetValue}`);
                        triggerChangeEvent(updatedElement);
                    } else {
                        console.log(`[Auto-Select] ${elementId} already set to target value '${targetValue}' via observer.`);
                    }
                    observer.disconnect(); // Stop observing once value is successfully set
                } else {
                    // Option not found yet, but dropdown exists and has options. Keep waiting.
                }
            } else if (updatedElement && updatedElement.tagName === 'INPUT') {
                console.log(`[Auto-Select] ${elementId} detected as INPUT, not SELECT. Observer will continue observing.`);
                // Keep observing in case it changes back or to a select later.
            }
        });

        const dynamicFieldsContainer = document.querySelector('.dynamic-fields') || document.body;
        if (dynamicFieldsContainer) {
            window[observerRefName].observe(dynamicFieldsContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ['value', 'id', 'name', 'class', 'type', 'data-qa-id'] });
        } else {
            console.warn(`[Auto-Select] Dynamic fields container not found for ${elementId}. Observing body. Auto-selection may not work as expected.`);
            window[observerRefName].observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['value', 'id', 'name', 'class', 'type', 'data-qa-id'] });
        }
    }

    // Function to set a text input value (or handle a dynamically appearing select for model)
    function setTextInputValue(elementId, targetValue) {
        if (isAdDeactivated || isMembershipAd) {
            console.log(`[Auto-Select] Ad is deactivated or has special membership. Skipping setting ${elementId}.`);
            return;
        }

        let element = document.getElementById(elementId);

        if (elementId === modelInputFieldId) {
            observeAndSetSelectValue(elementId, targetValue, `${elementId}Observer`);
            return;
        }

        if (element) {
            if (element.tagName === 'SELECT') {
                observeAndSetSelectValue(elementId, targetValue, `${elementId}Observer`);
            } else {
                if (element.value.toLowerCase() !== targetValue.toLowerCase()) {
                    element.value = targetValue;
                    console.log(`[Auto-Select] ${elementId} (input) set to: ${targetValue}`);
                    triggerChangeEvent(element);
                } else {
                    console.log(`[Auto-Select] ${elementId} (input) already has target value: ${targetValue}`);
                }
            }
        } else {
            console.log(`[Auto-Select] ${elementId} not found for direct setting. (This is expected if it's a dynamically loaded non-model select)`);
        }
    }

    // Helper function specifically for Desktop Computer Model selection
    function waitForDesktopModelAndSetOther() {
        if (isAdDeactivated || isMembershipAd) {
            console.log("[Auto-Select] Ad is deactivated or has special membership. Skipping Desktop Model setting.");
            return;
        }
        const maxRetries = 25;
        let retryCount = 0;
        const intervalTime = 100;

        const interval = setInterval(() => {
            if (isAdDeactivated || isMembershipAd) { // Re-check status inside polling loop
                console.log("[Auto-Select] Ad status changed. Stopping Desktop Model polling.");
                clearInterval(interval);
                return;
            }

            const modelElement = document.getElementById(modelInputFieldId);
            if (modelElement && modelElement.tagName === 'SELECT' && modelElement.options.length > 1) {
                const targetValue = "customized-other-model";
                const optionExists = Array.from(modelElement.options).some(option => option.value === targetValue);

                if (optionExists && modelElement.value !== targetValue) {
                    modelElement.value = targetValue;
                    triggerChangeEvent(modelElement);
                    console.log("[Auto-Select] Desktop Model set to 'Other' via dedicated wait.");
                    clearInterval(interval);
                } else if (modelElement.value === targetValue) {
                    console.log("[Auto-Select] Desktop Model already 'Other'.");
                    clearInterval(interval);
                }
            } else {
                console.log(`[Auto-Select] Waiting for Desktop Model dropdown (attempt ${retryCount + 1}/${maxRetries})...`);
            }

            retryCount++;
            if (retryCount >= maxRetries) {
                console.warn("[Auto-Select] Desktop Model dropdown not ready after max retries. Could not set 'Other'.");
                clearInterval(interval);
            }
        }, intervalTime);
    }

    // Main function to update category, item type, brand, and model based on title
    function updateCategoryAndSubcategory() {
        if (isAdDeactivated || isMembershipAd) {
            console.log("[Auto-Select] Ad is deactivated or has special membership. Skipping category/subcategory auto-selection.");
            return;
        }

        tmRefreshCoreElements();

        if (!titleField || !categorySelect) {
            console.warn("[Auto-Select] Required fields not found yet (title/category). Waiting for DOM...");
            return;
        }

        // When the script changes Category/ItemType/Brand/Model, the admin UI may re-render parts of the form
        // and steal focus from the Title input. That made it feel like "space" (and other keys) didn't work.
        // Preserve caret + focus while the reviewer is typing in Title.
        const tmWasTypingInTitle = (document.activeElement === titleField);
        const tmCaretStart = tmWasTypingInTitle && typeof titleField.selectionStart === 'number' ? titleField.selectionStart : null;
        const tmCaretEnd = tmWasTypingInTitle && typeof titleField.selectionEnd === 'number' ? titleField.selectionEnd : null;

        try {
            const title = titleField.value;
            if (!title) {
                console.log("[Auto-Select] Title field is empty. No auto-selection.");
                return;
            }
            console.log(`\n--- Processing title: "${title}" ---`);

            let categorySet = false;
            let itemTypeSet = false;
            const matchingCategories = CATEGORY_AND_ITEM_TYPE_MAP.filter((categoryEntry) =>
                containsKeyword(title, categoryEntry.keywords, categoryEntry.excludedKeywords)
            );
            const selectedCategory = selectBestCategoryMatch(title, matchingCategories);

            for (const categoryEntry of CATEGORY_AND_ITEM_TYPE_MAP) {
            if (selectedCategory && categoryEntry.categoryValue === selectedCategory.categoryValue) {
                const isLivingRoomFurnitureCategory = (categoryEntry.categoryValue === "247");
                const childrenFurnitureEntry = CATEGORY_AND_ITEM_TYPE_MAP.find(entry => entry.categoryValue === "251");
                const titleLooksLikeChildrenFurniture = !!childrenFurnitureEntry && (
                    containsKeyword(title, childrenFurnitureEntry.keywords, childrenFurnitureEntry.excludedKeywords) ||
                    (childrenFurnitureEntry.itemTypes || []).some(itemType =>
                        containsKeyword(title, itemType.keywords, itemType.excludedKeywords)
                    )
                );

                // Special overlap rule: if the title also looks like Children's Furniture,
                // do not let Living Room furniture steal it due shared words like "দোলনা"/"swing".
                if (isLivingRoomFurnitureCategory && titleLooksLikeChildrenFurniture) {
                    console.log('[Auto-Select] Living Room match skipped because title also matches Children\'s Furniture (251).');
                    continue;
                }

                const currentUrl = window.location.href;
                // These pages were previously excluded, removing that specific logic as the new membership check is more targeted.
                // const verificationPage = "https://admin.bikroy.com/review/item/verification";
                // const memberPage = "https://admin.bikroy.com/review/item/member";
                // const categoriesToExclude = [
                //     "897", //L C Acessories
                //     "220", "219", "224", "225", "222", "221", "227", "228", "217" // Property categories
                // ];
                // const shouldExcludeThisCategory = categoriesToExclude.includes(categoryEntry.categoryValue);
                // const isTargetUrl = (currentUrl.startsWith(verificationPage) || currentUrl.startsWith(memberPage));
                // if (shouldExcludeThisCategory && isTargetUrl) {
                //     console.log(`[Auto-Select] Skipping auto-selection for "${categoryEntry.name}" (${categoryEntry.categoryValue}) due to URL exclusion: ${currentUrl}`);
                //     continue;
                // }

                const titleContainsStrongLaptopKeyword = containsKeyword(title, [
                    "laptop", "notebook", "macbook", "inspiron", "pavilion", "think pad", "thinkpad", "elitebook", "elite book", "hp", "dell", "zenbook", "microsoft", "surface", // English
                    "ল্যাপটপ", "নোটবুক", "ম্যাকবুক", "ইনস্পাইরন", "প্যাভিলিয়ন", "থিংকপ্যাড", "জেনবুক", "সার্ফেস ল্যাপটপ" // Bangla
                ]);

                const isLaptopAccessoryCategory = (categoryEntry.categoryValue === "897");

                if (titleContainsStrongLaptopKeyword && isLaptopAccessoryCategory) {
                    console.log(`[Auto-Select] Conflict detected: Title contains strong "laptop" keywords but matched "${categoryEntry.name}". Skipping this accessory match to prioritize Laptop.`);
                    continue;
                }

const matchedKeyword = (categoryEntry.keywords || []).find(k => title.toLowerCase().includes(String(k).toLowerCase()));

// If payment was detected, never auto-change category.
// Only proceed with deeper selection when the current category already matches the matched categoryEntry.
if (tmDisableAutoCategoryChange && categorySelect.value !== categoryEntry.categoryValue) {
    console.log(`[Payment Lock] Paid ad detected -> skipping auto category change from ${categorySelect.value} to ${categoryEntry.categoryValue}.`);
    continue;
}

if (!tmDisableAutoCategoryChange && categorySelect.value !== categoryEntry.categoryValue) {
    tmSetCategoryValue(categoryEntry.categoryValue, { auto: true });
    console.log(`[Auto-Select] Category set to: ${categoryEntry.categoryValue} (matched by keyword: "${matchedKeyword || 'keyword-match'}")`);
} else {
    console.log(`[Auto-Select] Category is already ${categoryEntry.categoryValue}.`);
}
                categorySet = true;

                if (categoryEntry.itemTypes && categoryEntry.itemTypes.length > 0) {
                    for (const itemTypeEntry of categoryEntry.itemTypes) {
                        if (containsKeyword(title, itemTypeEntry.keywords, itemTypeEntry.excludedKeywords)) {
                            observeAndSetSelectValue(itemTypeSelectId, itemTypeEntry.itemTypeValue, 'itemTypeObserver');
                            itemTypeSet = true;
                            let brandSet = false;

                            if (itemTypeEntry.brandsAndModels && itemTypeEntry.brandsAndModels.length > 0) {
                                for (const brandModelEntry of itemTypeEntry.brandsAndModels) {
                                    if (containsKeyword(title, brandModelEntry.brandKeywords)) {
                                        const brandValueToUse = brandModelEntry.brandValue || brandModelEntry.brandKeywords[0].toLowerCase();
                                        observeAndSetSelectValue(brandSelectId, brandValueToUse, 'brandSelectObserver');
                                        brandSet = true;

                                        if (categoryEntry.categoryValue === "893" && brandValueToUse === "customized") {
                                            waitForDesktopModelAndSetOther();
                                        } else if (brandModelEntry.modelKeywords && brandModelEntry.modelKeywords.length > 0) {
                                            const matchedModel = brandModelEntry.modelKeywords.find(modelKwd => containsKeyword(title, [modelKwd]));
                                            if (matchedModel) {
                                                setTextInputValue(modelInputFieldId, matchedModel);
                                            }
                                        }
                                        // Once a deeper match is found, exit
                                        return;
                                    }
                                }
                            }
                            if (!brandSet && categoryEntry.brandsAndModels && categoryEntry.brandsAndModels.length > 0) {
                                for (const brandModelEntry of categoryEntry.brandsAndModels) {
                                    if (containsKeyword(title, brandModelEntry.brandKeywords)) {
                                        const brandValueToUse = brandModelEntry.brandValue || brandModelEntry.brandKeywords[0].toLowerCase();
                                        observeAndSetSelectValue(brandSelectId, brandValueToUse, 'brandSelectObserver');

                                        if (categoryEntry.categoryValue === "893" && brandValueToUse === "customized") {
                                            waitForDesktopModelAndSetOther();
                                        } else if (brandModelEntry.modelKeywords && brandModelEntry.modelKeywords.length > 0) {
                                            const matchedModel = brandModelEntry.modelKeywords.find(modelKwd => containsKeyword(title, [modelKwd]));
                                            if (matchedModel) {
                                                setTextInputValue(modelInputFieldId, matchedModel);
                                            }
                                        }
                                        return;
                                    }
                                }
                            }
                            // If itemType matched but no brand/model, exit
                            return;
                        }
                    }
                }

                if (!itemTypeSet && categoryEntry.accessoryTypes && categoryEntry.accessoryTypes.length > 0) {
                    for (const accessoryTypeEntry of categoryEntry.accessoryTypes) {
                        if (containsKeyword(title, accessoryTypeEntry.keywords, accessoryTypeEntry.excludedKeywords)) {
                            observeAndSetSelectValue(accessoryTypeSelectId, accessoryTypeEntry.accessoryTypeValue, 'accessoryTypeObserver');
                            return;
                        }
                    }
                }

                if (!itemTypeSet && categoryEntry.brandsAndModels && categoryEntry.brandsAndModels.length > 0) {
                    for (const brandModelEntry of categoryEntry.brandsAndModels) {
                        if (containsKeyword(title, brandModelEntry.brandKeywords)) {
                            const brandValueToUse = brandModelEntry.brandValue || brandModelEntry.brandKeywords[0].toLowerCase();
                            observeAndSetSelectValue(brandSelectId, brandValueToUse, 'brandSelectObserver');

                            if (categoryEntry.categoryValue === "893" && brandValueToUse === "customized") {
                                waitForDesktopModelAndSetOther();
                            } else if (brandModelEntry.modelKeywords && brandModelEntry.modelKeywords.length > 0) {
                                const matchedModel = brandModelEntry.modelKeywords.find(modelKwd => containsKeyword(title, [modelKwd]));
                                if (matchedModel) {
                                    setTextInputValue(modelInputFieldId, matchedModel);
                                }
                            }
                            // Once a brand/model match is found, exit
                            return;
                        }
                    }
                }
                // If category matched but no deeper match, exit
                return;
            }
        }

            if (!categorySet) {
                console.log("[Auto-Select] No matching category found for the title. Please select manually if needed.");
            }
        } finally {
            // Restore focus/caret after any possible re-render (even if we `return` early from a match)
            if (tmWasTypingInTitle) {
                const s = tmCaretStart;
                const e = tmCaretEnd;
                tmDefer(() => {
                    tmRefreshCoreElements();
                    if (!titleField) return;
                    try { titleField.focus(); } catch (_) { /* ignore */ }
                    if (s !== null && e !== null && typeof titleField.setSelectionRange === 'function') {
                        try { titleField.setSelectionRange(s, e); } catch (_) { /* ignore */ }
                    }
                });
            }
        }
    }

    // Function to find a name by value from the CATEGORY_AND_ITEM_TYPE_MAP
    function getNameByValue(type, value) {
        if (!value || value === "" || value === "none") return null;

        // Special case for Desktop Computer Model "Other"
        if (type === 'model' && value === "customized-other-model") {
            return "Other Model";
        }

        switch (type) {
            case 'category':
                for (const entry of CATEGORY_AND_ITEM_TYPE_MAP) {
                    if (entry.categoryValue === value) return entry.name || entry.categoryValue;
                }
                break;
            case 'itemType':
                for (const categoryEntry of CATEGORY_AND_ITEM_TYPE_MAP) {
                    if (categoryEntry.itemTypes) {
                        for (const itemTypeEntry of categoryEntry.itemTypes) {
                            if (itemTypeEntry.itemTypeValue === value) return itemTypeEntry.name || itemTypeEntry.itemTypeValue;
                        }
                    }
                }
                break;
            case 'brand':
                for (const categoryEntry of CATEGORY_AND_ITEM_TYPE_MAP) {
                    if (categoryEntry.itemTypes) {
                        for (const itemTypeEntry of categoryEntry.itemTypes) {
                            if (itemTypeEntry.brandsAndModels) {
                                for (const brandEntry of itemTypeEntry.brandsAndModels) {
                                    if (brandEntry.brandValue === value) return brandEntry.name || brandEntry.brandValue;
                                }
                            }
                        }
                    }
                    if (categoryEntry.brandsAndModels) { // Check direct brands in category
                        for (const brandEntry of categoryEntry.brandsAndModels) {
                            if (brandEntry.brandValue === value) return brandEntry.name || brandEntry.brandValue;
                        }
                    }
                }
                break;
        }
        return null; // Value not found
    }

    // --- Title Generation Helpers ---
    // Makes the generated title more natural by converting simple English plurals into singular form.
    // Examples: "Bicycles" -> "Bicycle", "Mobile Phones" -> "Mobile Phone", "Accessories" -> "Accessory".
    function tmSingularizeWordForTitle(word) {
        if (!word || typeof word !== 'string') return word;

        // Do not touch acronyms like UPS/IPS/CPU (all caps, short)
        if (word === word.toUpperCase() && /^[A-Z0-9]+$/.test(word) && word.length <= 6) {
            return word;
        }

        const lower = word.toLowerCase();

        // Don't touch possessives (e.g., "Men's")
        if (lower.endsWith("'s")) return word;

        // Words that commonly end with "s" but are not plural nouns in our context
        const exceptions = new Set([
            'lens', 'news', 'series', 'species', 'electronics', 'sports', 'arts'
        ]);
        if (exceptions.has(lower)) return word;

        // "Accessories" -> "Accessory", "Batteries" -> "Battery"
        if (lower.endsWith('ies') && word.length > 3) {
            const y = (word.slice(-3).toUpperCase() === 'IES') ? 'Y' : 'y';
            return word.slice(0, -3) + y;
        }

        // "Boxes" -> "Box", "Watches" -> "Watch", "Brushes" -> "Brush", "Glasses" -> "Glass"
        const esEndings = ['sses', 'shes', 'ches', 'xes', 'zes', 'oes'];
        if (esEndings.some(suf => lower.endsWith(suf)) && word.length > 3) {
            return word.slice(0, -2); // remove "es"
        }

        // Default: remove a trailing 's' (Bicycles -> Bicycle, Laptops -> Laptop, Phones -> Phone)
        if (lower.endsWith('s') && !lower.endsWith('ss') && word.length > 1) {
            return word.slice(0, -1);
        }

        return word;
    }

    function tmSingularizePhraseForTitle(phrase) {
        if (!phrase || typeof phrase !== 'string') return phrase;

        // Singularize only the LAST word so we don't break fixed phrases like "Martial Arts"
        // while still fixing "Mobile Phones" -> "Mobile Phone".
        const match = phrase.match(/^(.*?)([A-Za-z]+(?:'[A-Za-z]+)?)(\s*)$/);
        if (!match) return phrase;

        const prefix = match[1] || '';
        const lastWord = match[2] || '';
        const suffix = match[3] || '';

        return prefix + tmSingularizeWordForTitle(lastWord) + suffix;
    }

    // Function to generate and set the title on backtick press
    function generateTitleFromSelections(event) {
        if (!event) return;

        if (isAdDeactivated || isMembershipAd) {
            console.log("[Title Gen] Ad is deactivated or has special membership. Skipping title generation.");
            return;
        }

        // Backtick (`) hotkey: works even if the user manually changes category after load
        const isBacktick = (event.key === '`' || event.code === 'Backquote' || event.keyCode === 192);
        if (!isBacktick) return;

        const currentTitleField = document.getElementById('fields-title-value') || document.querySelector('#fields-title-value');
        if (!currentTitleField) return;

        // Only trigger when focus is on the Title field (prevents interfering with typing ` elsewhere)
        if (document.activeElement !== currentTitleField) return;

        event.preventDefault(); // Prevent the backtick character from being typed

        // Always re-resolve current selections (the form can re-render after manual category changes)
        const categoryEl = document.getElementById('category') || document.querySelector('#category');
        const itemTypeElement = document.getElementById(itemTypeSelectId);
        const brandElement = document.getElementById(brandSelectId);

        let productDescriptionParts = [];

        const brandName = tmGetSelectedText(brandElement);
        const itemTypeName = tmGetSelectedText(itemTypeElement);
        const categoryName = tmGetSelectedText(categoryEl);

        // 1. Add Brand Name (if specific, not "Other"/"None")
        if (brandName) {
            const b = brandName.toLowerCase();
            if (b !== 'other' && b !== 'other brand' && b !== 'none') {
                productDescriptionParts.push(brandName);
            }
        }

        // 2. Determine the main item descriptor: prioritize Item Type Name, then Category Name
        let itemDescriptor = null;

        if (itemTypeName) {
            const it = itemTypeName.toLowerCase();
            if (it !== 'others' && it !== 'other model' && it !== 'none') {
                itemDescriptor = itemTypeName;
            }
        } else if (categoryName) {
            const c = categoryName.toLowerCase();

            if (c !== 'other' && c !== 'other brand' && c !== 'none') {
                const genericCategoryKeywords = [
                    'accessories', 'fashion', 'hobby', 'products', 'items', 'learning', 'services', 'industry',
                    'property', 'jobs', 'equipment', 'decoration', 'textiles'
                ];
                const isGenericCategory = genericCategoryKeywords.some(keyword => c.includes(keyword));

                if (!isGenericCategory) {
                    itemDescriptor = categoryName;
                }
            }
        }

        if (itemDescriptor) {
            const normalizedDescriptor = tmSingularizePhraseForTitle(itemDescriptor);
            productDescriptionParts.push(normalizedDescriptor);
        }

        let generatedText = "";
        if (productDescriptionParts.length > 0) {
            generatedText = productDescriptionParts.join(' ') + " for sale";
        } else {
            generatedText = "Item for sale";
        }

        generatedText = generatedText.charAt(0).toUpperCase() + generatedText.slice(1);

        if (currentTitleField.value !== generatedText) {
            currentTitleField.value = generatedText;
            triggerChangeEvent(currentTitleField);
            console.log(`[Auto-Select] Generated title: "${generatedText}"`);
        } else {
            console.log("[Auto-Select] Generated title is same as current. No change.");
        }
    }


    // Backtick title hotkey is bound globally via tmEnsureBindings() so it still works after dynamic re-renders.

    // --- Main Initialisation & Event Listeners ---
    function initializeScript() {
        // Resolve core elements (fields may be injected dynamically)
        tmRefreshCoreElements();

        // Capture original category (before any auto-change). Used for paid-ad category lock.
        tmCaptureOriginalCategoryValue();

        // First, check for special membership status which may halt other actions.
        isMembershipAd = checkMembershipStatus();

        // Check audit log for rejection reasons and set isAdBlacklistedOrFraud
        checkAuditLogForRejectionReason();

        // This check must happen AFTER checking for blacklist status
        if (checkIfAdIsDeactivated()) {
            console.log("[Initialization] Ad is DEACTIVATED.");
            // If deactivated, attempt to click continue regardless of membership status.
            autoClickContinueForDeactivatedAd();
            return; // Stop other auto-selection logic if ad is deactivated
        }

        // If it's a membership ad, we don't want to proceed with other modifications.
        if (isMembershipAd) {
             console.log("[Initialization] Halting further script modifications due to special membership.");
             return;
        }

// Add event listener for title field input (idempotent)
if (titleField) {
    if (!titleField.dataset.tmCategoryInputBound) {
        titleField.dataset.tmCategoryInputBound = '1';
        titleField.addEventListener('input', updateCategoryAndSubcategory);
        console.log("[Auto-Select] Listening for 'input' events on the title field for live updates.");
    }
} else {
    console.error("[Auto-Select] Title field (fields-title-value) not found!");
}

        // Initial calls
        updateCategoryAndSubcategory(); // Perform initial category/item type/brand/model check
        console.log("[Auto-Select] Script initialized and running.");
    }

    // Use a MutationObserver to watch for the presence of the main ad review container
    // This helps ensure the script runs even if parts of the page load dynamically.
    const observerTarget = document.body;
    const observerConfig = { childList: true, subtree: true };

    const scriptInitObserver = new MutationObserver((mutations, observer) => {
        // Look for a key element that indicates the ad review page is fully loaded
        // For example, the category dropdown.
        const reviewForm = document.querySelector('.form-ad-review');
        if (reviewForm || document.getElementById('category')) {
            observer.disconnect(); // Stop observing once elements are found
            initializeScript();
        }
    });

    scriptInitObserver.observe(observerTarget, observerConfig);

    // Also run on window load as a fallback/initial trigger
    window.addEventListener('load', () => {
        // Disconnecting a potentially running observer to avoid double-runs
        scriptInitObserver.disconnect();
        initializeScript();
    });
})();

(function() {
    'use strict';

    // --- STYLES ---
    function addNotificationStyles() {
        if (document.getElementById('audit-log-notifier-styles')) {
            return;
        }
        const style = document.createElement('style');
        style.id = 'audit-log-notifier-styles';
        style.innerHTML = `
            @keyframes flash-red {
                0%   { background-color: #e53935; } /* Bright Red */
                50%  { background-color: #b71c1c; } /* Darker Red */
                100% { background-color: #e53935; } /* Bright Red */
            }
            #audit-alert-container {
                position: fixed; top: 60px; left: 15px; z-index: 99999;
                display: flex; flex-direction: column; gap: 6px;
            }
            .audit-alert {
                padding: 6px 12px !important; font-size: 14px !important;
                /* FIXED: Removed !important from background-color to allow override */
                background-color: transparent;
                color: black !important;
                border: none solid #555 !important; box-shadow: none !important;
                border-radius: 5px !important; font-weight: bold !important;
                animation: none !important;
            }
            .payment-alert {
                color: white !important;
                border-color: #b71c1c !important;
                animation: flash-red 1.5s infinite !important;
            }
        `;
        document.head.appendChild(style);
    }

    // --- UI HELPERS ---
    function getAlertContainer() {
        let container = document.getElementById('audit-alert-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'audit-alert-container';
            document.body.appendChild(container);
        }
        return container;
    }

    function createAlert(message, extraClass) {
        const container = getAlertContainer();
        const alertDiv = document.createElement('div');
        alertDiv.className = 'audit-alert';
        if (extraClass) {
            alertDiv.classList.add(extraClass);
        }
        alertDiv.innerText = message;
        container.appendChild(alertDiv);
    }

    function clearAlerts() {
        getAlertContainer().innerHTML = '';
    }

    // --- CORE LOGIC ---
    function clickReadMoreButtons() {
        document.querySelectorAll('a.ui-ellipsis-btn:not([data-readmore-clicked])').forEach(button => {
            button.click();
            button.setAttribute('data-readmore-clicked', 'true');
        });
    }

    function parseDate(logEntryText) {
        const datePattern = /(\d{1,2}:\d{2}:\d{2}\s(?:am|pm),\s\d{1,2}\s\w+\s\d{4})/i;
        const match = logEntryText.match(datePattern);
        return match ? new Date(match[0]) : null;
    }

    function debounce(func, delay) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), delay);
        };
    }

    function checkPageForAllAlerts() {
        clickReadMoreButtons();

        setTimeout(() => {
            let foundEvents = [];
            const logItems = document.querySelectorAll('.review-logs ul li');
            if (logItems.length === 0) return;

            // --- Define all alert types with their display priority ---
            const standardAlerts = [
                // Priority 2
                { id: 'reported', type: 'State', regex: /^Reported/i, message: '🚩Reported AD', priority: 2 },
                // Priority 3
                { id: 'fraud_rejected', type: 'Rejection', regex: /Rejected from fraud/i, message: '🕵️‍♂️Fraud Rejected', priority: 3 },
                // Priority 5
                { id: 'blacklisted', type: 'Rejection', regex: /Account flagged as blacklisted/i, message: '⛔️Blacklisted AD', priority: 5 },
                // Priority 7 (Other rejections)
                { id: 'multiple_items', type: 'Rejection', regex: /Rejected from \w+ with Multiple items in same ad by (.+?) \(\S+\)/i, message: '🗂️Rejected Multiple Items', priority: 7 },
                { id: 'illegal', type: 'Rejection', regex: /Rejected from \w+ with Illegal item or service by (.+?) \(\S+\)/i, message: '🚨Rejected Illegal', priority: 7 },
                { id: 'we_dont_allow', type: 'Rejection', regex: /We do not allow this type of Ad on our website.*by (.+?) \(\S+\)/i, message: '🚫Rejected We Don\'t Allow', priority: 7 },
                { id: 'job_wanted', type: 'Rejection', regex: /we do not allow Job Wanted ads on our website.*by (.+?) \(\S+\)/i, message: '👔Rejected Job Wanted', priority: 7 },
                { id: 'work_from_home', type: 'Rejection', regex: /Membership is required to post a 'Work from Home' Job.*by (.+?) \(\S+\)/i, message: '🏠Rejected Work From Home', priority: 7 },
                { id: 'security_guard', type: 'Rejection', regex: /Rejected from [\s\S]+? by (.+?) \(\S+\)[\s\S]+?Membership is required in order to post ads from security guard company/i, message: '🛡️Rejected Security Guard Job', priority: 7 },
                { id: 'reproduced', type: 'Rejection', regex: /Rejected from \w+ with Reproduced Ad by (.+?) \(\S+\)/i, message: '🔄Rejected Reproduced', priority: 7 },
            ];
            // Priority 1
            const promotionAlerts = [
                { id: 'top_ad', type: 'Promotion', regex: /Products queued Top Ad/i, message: '🔝Top Ad', priority: 1 },
                { id: 'bump_up', type: 'Promotion', regex: /Products queued Bump up/i, message: '⬆️Bump Up', priority: 1 },
                { id: 'urgent', type: 'Promotion', regex: /Products queued Urgent/i, message: '⚡Urgent Ad', priority: 1 },
                { id: 'urgent_bundle', type: 'Promotion', regex: /Products queued Urgent Bundle/i, message: '⚡Urgent Bundle', priority: 1 },
            ];

            let latestPaymentDate = null;

            // 1. First pass: Find the latest payment date.
            logItems.forEach(item => {
                const itemText = item.innerText;
                if (/Made payment[\s\S]*?approved/i.test(itemText)) {
                    const paymentDate = parseDate(itemText);
                    if (paymentDate && (!latestPaymentDate || paymentDate > latestPaymentDate)) {
                        latestPaymentDate = paymentDate;
                    }
                }
            });

            // If a payment was found, add the generic Payment AD alert with priority 1.
            if (latestPaymentDate) {
                foundEvents.push({ id: 'payment_ad', date: latestPaymentDate, message: '💰Payment AD', type: 'Payment', priority: 1 });

                // --- Bridge: notify the Category script that this is a paid ad ---
                // This lets the Category auto-selector keep the original category and stop auto category changes.
                try {
                    if (!window.__TM_PAYMENT_DETECTED__) {
                        window.__TM_PAYMENT_DETECTED__ = true;
                        window.__TM_PAYMENT_DATE_ISO__ = latestPaymentDate.toISOString();
                        window.dispatchEvent(new CustomEvent('tm-payment-detected', {
                            detail: { date: latestPaymentDate.toISOString() }
                        }));
                    }
                } catch (e) {
                    // ignore
                }
            }

            // 2. Second pass: Collect all other relevant events.
            logItems.forEach(item => {
                const itemText = item.innerText;
                const itemDate = parseDate(itemText);

                if (itemDate) {
                    // Check for standard alerts
                    for (const def of standardAlerts) {
                        const match = itemText.match(def.regex);
                        if (match) {
                            let finalMessage = def.message;
                            if (match[1]) finalMessage += ` (${match[1].trim()})`;
                            foundEvents.push({ id: def.id, date: itemDate, message: finalMessage, type: def.type, priority: def.priority });
                        }
                    }
                    // If it's a paid ad, check for specific promotions
                    if (latestPaymentDate) {
                        for (const def of promotionAlerts) {
                            if (def.regex.test(itemText)) {
                                foundEvents.push({ id: def.id, date: itemDate, message: def.message, type: def.type, priority: def.priority });
                            }
                        }
                    }
                }
            });

            // 3. Add non-log based and special logic alerts with their priorities
            if (document.querySelector('.review-header.is-AdState_DEACTIVATED')) {
                // Priority 6
                foundEvents.push({ id: 'deactivated', date: new Date(), message: '⚪Deactivated AD', type: 'State', priority: 6 });
            }

            const rejections = foundEvents.filter(e => e.type === 'Rejection').sort((a, b) => b.date - a.date);
            if (latestPaymentDate && rejections.length > 0 && rejections[0].date > latestPaymentDate) {
                // Priority 4
                foundEvents.push({ id: 'rejected_payment', date: rejections[0].date, message: '📛Rejected Payment AD', type: 'State', priority: 4 });
            }

            // 4. Filter for the latest event of each type (id)
            const latestEventsMap = new Map();
            for (const event of foundEvents) {
                // If we haven't seen this event type, or the current one is newer, update the map
                if (!latestEventsMap.has(event.id) || event.date > latestEventsMap.get(event.id).date) {
                    latestEventsMap.set(event.id, event);
                }
            }
            let uniqueEvents = Array.from(latestEventsMap.values());

            // 5. Sort the final unique alerts by priority, then by time for display
            uniqueEvents.sort((a, b) => {
                const priorityA = a.priority || 99;
                const priorityB = b.priority || 99;
                if (priorityA !== priorityB) {
                    return priorityA - priorityB; // Sort by priority first
                }
                return a.date - b.date; // Then by time
            });

            // 6. Display all alerts in the new priority order
            clearAlerts();
            const paymentAlertIds = ['payment_ad', 'rejected_payment', 'top_ad', 'bump_up', 'urgent', 'urgent_bundle'];
            uniqueEvents.forEach(event => {
                const alertClass = paymentAlertIds.includes(event.id) ? 'payment-alert' : null;
                createAlert(event.message, alertClass);
            });

        }, 300);
    }

    // --- INITIALIZATION ---
    function main() {
        addNotificationStyles();
        const debouncedCheck = debounce(checkPageForAllAlerts, 400);
        const observer = new MutationObserver(() => debouncedCheck());
        observer.observe(document.body, { childList: true, subtree: true });
        checkPageForAllAlerts();
    }

    // Run as soon as DOM is ready, not after full page load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }

})();
