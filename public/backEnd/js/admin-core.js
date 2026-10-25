(function () {
  function initFeather() {
    if (typeof feather !== 'undefined' && typeof feather.replace === 'function') {
      try {
        feather.replace();
      } catch (_e) {}
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    initFeather();

    // Sidebar Mobile / Desktop Toggle
    var menuBtn = document.querySelector('.button-menu-mobile');
    if (menuBtn) {
      menuBtn.addEventListener('click', function () {
        if (window.innerWidth < 992) {
          document.body.classList.toggle('sidebar-mobile-open');
        } else {
          document.body.classList.toggle('sidebar-collapsed');
        }
      });
    }

    // Highlight active link and expand parent collapse in sidebar
    var curPath = window.location.pathname + window.location.search;
    var sideLinks = document.querySelectorAll('#side-menu a');
    sideLinks.forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      if (href === window.location.pathname || href === curPath) {
        link.classList.add('active');
        var parentLi = link.closest('#side-menu > li');
        if (parentLi) parentLi.classList.add('menuitem-active');
        var collapseDiv = link.closest('.collapse');
        if (collapseDiv) {
          collapseDiv.classList.add('show');
          var trigger = document.querySelector('[href="#' + collapseDiv.id + '"]');
          if (trigger) trigger.setAttribute('aria-expanded', 'true');
        }
      }
    });

    // Fullscreen toggle
    var fsBtn = document.querySelector('[data-toggle="fullscreen"]');
    if (fsBtn) {
      fsBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(function () {});
        } else {
          document.exitFullscreen().catch(function () {});
        }
      });
    }

    // Rightbar Theme Customizer toggle
    document.querySelectorAll('.right-bar-toggle').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        document.body.classList.toggle('right-bar-enabled');
      });
    });
    var rbOverlay = document.querySelector('.rightbar-overlay');
    if (rbOverlay) {
      rbOverlay.addEventListener('click', function () {
        document.body.classList.remove('right-bar-enabled');
      });
    }

    // Theme Settings Controls (Saved in localStorage)
    var savedLeftbar = localStorage.getItem('ub_leftbar_color');
    var savedTopbar = localStorage.getItem('ub_topbar_color');
    var savedTheme = localStorage.getItem('ub_theme');
    if (savedLeftbar) document.body.setAttribute('data-leftbar-color', savedLeftbar);
    if (savedTopbar) document.body.setAttribute('data-topbar-color', savedTopbar);
    if (savedTheme) document.body.setAttribute('data-theme', savedTheme);

    document.querySelectorAll('input[name="leftbar-color"]').forEach(function (el) {
      el.addEventListener('change', function () {
        if (this.checked) {
          document.body.setAttribute('data-leftbar-color', this.value);
          localStorage.setItem('ub_leftbar_color', this.value);
          document.querySelectorAll('input[name="leftbar-color"]').forEach(function (o) {
            if (o !== el) o.checked = false;
          });
        }
      });
    });

    document.querySelectorAll('input[name="topbar-color"]').forEach(function (el) {
      el.addEventListener('change', function () {
        if (this.checked) {
          document.body.setAttribute('data-topbar-color', this.value);
          localStorage.setItem('ub_topbar_color', this.value);
          document.querySelectorAll('input[name="topbar-color"]').forEach(function (o) {
            if (o !== el) o.checked = false;
          });
        }
      });
    });

    document.querySelectorAll('input[name="layout-color"]').forEach(function (el) {
      el.addEventListener('change', function () {
        if (this.checked) {
          document.body.setAttribute('data-theme', this.value);
          localStorage.setItem('ub_theme', this.value);
          document.querySelectorAll('input[name="layout-color"]').forEach(function (o) {
            if (o !== el) o.checked = false;
          });
        }
      });
    });

    var resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        localStorage.removeItem('ub_leftbar_color');
        localStorage.removeItem('ub_topbar_color');
        localStorage.removeItem('ub_theme');
        document.body.setAttribute('data-leftbar-color', 'dark');
        document.body.setAttribute('data-topbar-color', 'dark');
        document.body.setAttribute('data-theme', 'light');
      });
    }

    // SweetAlert2 Real Delete Confirmation (NO Demo Mode block!)
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.delete-confirm');
      if (!btn) return;
      e.preventDefault();
      var form = btn.closest('form');
      if (!form) return;
      var titleTxt = document.body.getAttribute('data-confirm-title') || 'আপনি কি নিশ্চিত?';
      var bodyTxt = document.body.getAttribute('data-confirm-text') || 'এই ডাটা স্থায়ীভাবে মুছে ফেলা হবে!';
      var yesTxt = document.body.getAttribute('data-confirm-yes') || 'হ্যাঁ, মুছে ফেলুন';
      var cancelTxt = document.body.getAttribute('data-confirm-cancel') || 'বাতিল';
      if (typeof Swal !== 'undefined') {
        Swal.fire({
          title: titleTxt,
          text: bodyTxt,
          icon: 'warning',
          showCancelButton: true,
          confirmButtonColor: '#b91c1c',
          cancelButtonColor: '#475569',
          confirmButtonText: yesTxt,
          cancelButtonText: cancelTxt,
        }).then(function (result) {
          if (result.isConfirmed) form.submit();
        });
      } else if (confirm(bodyTxt)) {
        form.submit();
      }
    });
  });
})();
