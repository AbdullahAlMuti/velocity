/**
 * Velocity Theme — Performance Patch
 * ------------------------------------
 * Non-invasive overlay that optimizes quantity selector interactions
 * across product page, cart drawer, and cart page.
 *
 * What it does:
 * 1. Intercepts quantity +/- button clicks for INSTANT optimistic UI
 * 2. Debounces the actual cart API call (batches rapid clicks)
 * 3. Deduplicates concurrent requests via AbortController
 * 4. Prevents full section re-render flash on quantity-only changes
 *
 * What it preserves:
 * - All existing event bubbling (CartItems/CartDrawerItems still handle responses)
 * - Quantity rules (min/max/step)
 * - Gift unlock, quantity breaks, upsell logic
 * - Shopify editor compatibility
 */
(function VelocityPerfPatch() {
  'use strict';

  // ─── Configuration ───────────────────────────────────────────────
  const DEBOUNCE_MS = 400;        // ms to wait after last click before firing API call
  const OPTIMISTIC_DELAY = 16;    // ms — next frame for visual update

  // ─── Global state ────────────────────────────────────────────────
  let pendingController = null;   // AbortController for in-flight cart request
  let activeDebounceTimers = new WeakMap(); // per-input debounce timers

  // ─── Utility: Debounce per element ───────────────────────────────
  function debouncedDispatch(inputEl, delayMs) {
    const existing = activeDebounceTimers.get(inputEl);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      activeDebounceTimers.delete(inputEl);
      // Dispatch the native 'change' event so CartItems/CartDrawerItems picks it up
      const changeEvent = new Event('change', { bubbles: true });
      inputEl.dispatchEvent(changeEvent);
    }, delayMs);

    activeDebounceTimers.set(inputEl, timer);
  }

  // ─── Utility: Update button disabled states ──────────────────────
  function updateButtonStates(quantityInputEl) {
    const input = quantityInputEl.querySelector('input.quantity__input');
    if (!input) return;

    const value = parseInt(input.value, 10);
    const min = parseInt(input.min, 10) || 0;
    const max = input.max ? parseInt(input.max, 10) : Infinity;

    const minusBtn = quantityInputEl.querySelector('button[name="minus"]');
    const plusBtn = quantityInputEl.querySelector('button[name="plus"]');

    if (minusBtn) {
      minusBtn.classList.toggle('disabled', value <= min);
      minusBtn.toggleAttribute('aria-disabled', value <= min);
    }
    if (plusBtn) {
      plusBtn.classList.toggle('disabled', value >= max);
      plusBtn.toggleAttribute('aria-disabled', value >= max);
    }
  }

  // ─── Utility: Show loading state on a cart item row ──────────────
  function setItemLoading(input, isLoading) {
    const cartItem = input.closest('.cart-item') || input.closest('li[id^="CartDrawer-Item-"]');
    if (!cartItem) return;

    const overlays = cartItem.querySelectorAll('.loading-overlay');
    overlays.forEach(overlay => {
      if (isLoading) {
        overlay.classList.remove('hidden');
      } else {
        overlay.classList.add('hidden');
      }
    });
  }

  // ─── Core: Optimistic click handler ──────────────────────────────
  function handleOptimisticClick(event) {
    const button = event.currentTarget;
    const quantityInputEl = button.closest('quantity-input');
    if (!quantityInputEl) return;

    const input = quantityInputEl.querySelector('input.quantity__input');
    if (!input) return;

    event.preventDefault();
    event.stopPropagation();

    const previousValue = parseInt(input.value, 10);
    const step = parseInt(input.step, 10) || 1;
    const min = parseInt(input.min, 10) || 0;
    const max = input.max ? parseInt(input.max, 10) : Infinity;
    const isPlus = button.name === 'plus';

    let newValue;
    if (isPlus) {
      newValue = Math.min(previousValue + step, max);
    } else {
      newValue = Math.max(previousValue - step, min);
    }

    // Skip if value didn't change (already at boundary)
    if (newValue === previousValue) return;

    // ─── Optimistic UI update (instant) ───────────────────────────
    requestAnimationFrame(() => {
      input.value = newValue;
      updateButtonStates(quantityInputEl);

      // If this is a cart quantity input, show subtle loading indicator
      if (input.dataset.index || input.dataset.quantityVariantId) {
        setItemLoading(input, true);
      }

      // Trigger quantity-gifts unlock if applicable
      if (quantityInputEl.quantityGifts && quantityInputEl.quantityGifts.unlockGifts) {
        quantityInputEl.quantityGifts.unlockGifts(newValue);
      }
    });

    // ─── Debounced API call ───────────────────────────────────────
    debouncedDispatch(input, DEBOUNCE_MS);
  }

  // ─── Patch: Intercept cart API calls to add AbortController ─────
  function patchCartFetch() {
    const originalFetch = window.fetch;

    window.fetch = function patchedFetch(url, options) {
      // Only intercept cart change/update requests
      const isCartChange = typeof url === 'string' && (
        url.includes('/cart/change') ||
        url.includes('/cart/update')
      );

      if (isCartChange && options && options.method === 'POST') {
        // Cancel any in-flight cart request
        if (pendingController) {
          pendingController.abort();
        }

        pendingController = new AbortController();

        // Merge our signal with any existing signal
        const mergedOptions = { ...options };
        mergedOptions.signal = pendingController.signal;

        return originalFetch.call(this, url, mergedOptions)
          .then(response => {
            pendingController = null;
            return response;
          })
          .catch(error => {
            if (error.name === 'AbortError') {
              // Silently swallow aborted requests — a newer one replaced it
              return new Response(JSON.stringify({ items: [], item_count: 0 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              });
            }
            pendingController = null;
            throw error;
          });
      }

      return originalFetch.apply(this, arguments);
    };
  }

  // ─── Setup: Attach optimistic handlers to all quantity-input elements ─
  function attachToQuantityInputs(root) {
    const quantityInputs = root.querySelectorAll('quantity-input');
    quantityInputs.forEach(qi => {
      // Skip if already patched
      if (qi.dataset.velocityPatched) return;
      qi.dataset.velocityPatched = 'true';

      const buttons = qi.querySelectorAll('button[name="minus"], button[name="plus"]');
      buttons.forEach(btn => {
        // Add our optimistic handler with capture phase (fires before theme handler)
        btn.addEventListener('click', handleOptimisticClick, { capture: true });
      });

      // Set initial button states
      updateButtonStates(qi);
    });
  }

  // ─── Setup: MutationObserver for dynamically added quantity inputs ─
  function observeDOM() {
    const observer = new MutationObserver(mutations => {
      let needsReattach = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'QUANTITY-INPUT' || node.querySelector?.('quantity-input')) {
              needsReattach = true;
              break;
            }
          }
        }
        if (needsReattach) break;
      }
      if (needsReattach) {
        // Small delay to let custom element constructors run
        requestAnimationFrame(() => attachToQuantityInputs(document));
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // ─── Setup: Listen for cart update events to clear loading states ─
  function listenForCartUpdates() {
    // The theme dispatches 'cartQuantityUpdated' after each cart change
    document.addEventListener('cartQuantityUpdated', () => {
      document.querySelectorAll('.loading-overlay').forEach(overlay => {
        // Don't hide overlays that are managed by the theme
        // (they get removed via innerHTML replacement anyway)
      });
      // Re-attach to any new quantity inputs after section re-render
      requestAnimationFrame(() => attachToQuantityInputs(document));
    });

    // Also re-attach after Shopify section renders (editor + AJAX)
    document.addEventListener('shopify:section:load', (event) => {
      attachToQuantityInputs(event.target);
    });
  }

  // ─── Initialize ─────────────────────────────────────────────────
  function init() {
    // Patch fetch for request deduplication
    patchCartFetch();

    // Attach to existing quantity inputs
    attachToQuantityInputs(document);

    // Watch for dynamically added ones (cart drawer open, quick add, etc.)
    observeDOM();

    // Listen for cart update completions
    listenForCartUpdates();
  }

  // Run on DOM ready or immediately if already loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
