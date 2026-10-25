/* ==========================================================================
   MR. TUMI GROCERY & GIFT — SHARED ACCESSIBILITY, SIDEBAR & FORM UI HELPERS
   ========================================================================== */
(function () {
  'use strict';

  function closeMobilePanels() {
    document.body.classList.remove('sidebar-mobile-open');
    document.body.classList.remove('right-bar-enabled');
    var toggleBtns = document.querySelectorAll('.button-menu-mobile');
    toggleBtns.forEach(function (btn) {
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
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
