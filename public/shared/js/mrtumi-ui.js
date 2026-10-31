/* ==========================================================================
   MR. TUMI GROCERY & GIFT — SHARED ACCESSIBILITY, CSRF, SIDEBAR & FORM HELPERS
   ========================================================================== */
(function () {
  'use strict';

  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? (meta.getAttribute('content') || '') : '';
  }

  function injectCsrfIntoForms(root) {
    var token = getCsrfToken();
    if (!token) return;
    var scope = root || document;
    var forms = scope.querySelectorAll ? scope.querySelectorAll('form') : [];
    forms.forEach(function (form) {
      var method = (form.getAttribute('method') || 'get').toLowerCase();
      if (method === 'get') return;
      var existing = form.querySelector('input[name="_csrf"]');
      if (!existing) {
        var inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = '_csrf';
        inp.value = token;
        form.appendChild(inp);
      } else if (!existing.value) {
        existing.value = token;
      }

      // For multipart forms, also append _csrf query fallback if not present
      var enc = (form.getAttribute('enctype') || '').toLowerCase();
      if (enc === 'multipart/form-data') {
        var act = form.getAttribute('action') || '';
        if (act.indexOf('_csrf=') === -1) {
          var sep = act.indexOf('?') === -1 ? '?' : '&';
          form.setAttribute('action', act + sep + '_csrf=' + encodeURIComponent(token));
        }
      }
    });
  }

  // Wrap same-origin non-GET fetch calls so X-CSRF-Token is always sent
  if (typeof window.fetch === 'function' && !window.__mrtumiCsrfWrapped) {
    window.__mrtumiCsrfWrapped = true;
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var token = getCsrfToken();
      if (token) {
        var urlStr = typeof input === 'string' ? input : (input && input.url) || '';
        var isSameOrigin =
          !urlStr ||
          urlStr.charAt(0) === '/' ||
          urlStr.indexOf(window.location.origin) === 0;
        var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (isSameOrigin && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
          init = Object.assign({}, init || {});
          var headers = new Headers(init.headers || {});
          if (!headers.has('X-CSRF-Token')) {
            headers.set('X-CSRF-Token', token);
          }
          init.headers = headers;
        }
      }
      return origFetch(input, init);
    };
  }

  function closeMobilePanels() {
    document.body.classList.remove('sidebar-mobile-open');
    document.body.classList.remove('right-bar-enabled');
    var toggleBtns = document.querySelectorAll('.button-menu-mobile');
    toggleBtns.forEach(function (btn) {
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  function labelScrollableTables(root) {
    var scope = root || document;
    var wrappers = scope.querySelectorAll('.table-responsive, .tbl-card-body');
    wrappers.forEach(function (wrapper) {
      if (wrapper.querySelector('.table-responsive, .tbl-card-body')) return;
      if (!wrapper.querySelector('table')) return;
      if (!wrapper.hasAttribute('tabindex')) wrapper.setAttribute('tabindex', '0');
      if (!wrapper.hasAttribute('role')) wrapper.setAttribute('role', 'region');
      if (!wrapper.hasAttribute('aria-label')) {
        var table = wrapper.querySelector('table');
        var caption = table && table.querySelector('caption');
        var card = wrapper.closest('.card, .tbl-card');
        var heading = card && card.querySelector('.card-header h1,.card-header h2,.card-header h3,.card-header h4,.tbl-card-head h4');
        var lang = document.documentElement.lang === 'bn' ? 'bn' : 'en';
        var label = caption && caption.textContent.trim();
        if (!label && heading) label = heading.textContent.trim();
        wrapper.setAttribute('aria-label', label || (lang === 'bn' ? 'অনুভূমিকভাবে স্ক্রলযোগ্য সারণি' : 'Horizontally scrollable table'));
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    injectCsrfIntoForms(document);
    labelScrollableTables(document);

    // Ensure dynamically constructed forms also carry _csrf before submission
    document.addEventListener(
      'submit',
      function (e) {
        if (e.target && e.target.tagName === 'FORM') {
          injectCsrfIntoForms(e.target.parentNode || document);
        }
      },
      true
    );

    // 1. Mobile sidebar backdrop tap-to-close (Admin, Vendor, Reseller portals)
    var backdrop = document.getElementById('mtSidebarBackdrop');
    if (backdrop) {
      backdrop.addEventListener('click', closeMobilePanels);
    }

    // Sync aria-expanded on mobile menu button
    document.querySelectorAll('.button-menu-mobile').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var expanded = document.body.classList.contains('sidebar-mobile-open');
        btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      });
    });

    // 2. Sync aria-expanded on Bootstrap collapse menu groups in sidebar
    document.querySelectorAll('[data-bs-toggle="collapse"]').forEach(function (trigger) {
      var targetSel = trigger.getAttribute('href') || trigger.getAttribute('data-bs-target');
      if (!targetSel || !targetSel.startsWith('#')) return;
      var targetEl = document.querySelector(targetSel);
      if (!targetEl) return;

      targetEl.addEventListener('shown.bs.collapse', function () {
        trigger.setAttribute('aria-expanded', 'true');
      });
      targetEl.addEventListener('hidden.bs.collapse', function () {
        trigger.setAttribute('aria-expanded', 'false');
      });
    });

    // 3. Global Escape key closes mobile sidebar, theme right-bar, or open custom panels
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (
          document.body.classList.contains('sidebar-mobile-open') ||
          document.body.classList.contains('right-bar-enabled')
        ) {
          closeMobilePanels();
        }
      }
    });

    // 4. Accessible client-side inline validation state (`aria-invalid`)
    document.querySelectorAll('form').forEach(function (form) {
      form.querySelectorAll('input, select, textarea').forEach(function (field) {
        field.addEventListener('invalid', function () {
          field.setAttribute('aria-invalid', 'true');
        });
        field.addEventListener('input', function () {
          if (field.getAttribute('aria-invalid') === 'true' && field.checkValidity()) {
            field.removeAttribute('aria-invalid');
          }
        });
      });
    });
  });
})();
