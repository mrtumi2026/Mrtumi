(function () {
  var meta = document.querySelector('meta[name="pb-sid"]');
  var serverSid = meta ? meta.getAttribute('content') : '';

  var storedSid = '';
  try {
    storedSid = sessionStorage.getItem('pb_sid') || localStorage.getItem('pb_sid') || '';
  } catch (_e) {}

  var sid = serverSid || storedSid || '';
  if (sid) {
    try {
      sessionStorage.setItem('pb_sid', sid);
      localStorage.setItem('pb_sid', sid);
    } catch (_e) {}
  }
  window.__PB_SID = sid;

  function withSidUrl(url) {
    if (!sid || !url) return url;
    var s = String(url);
    if (s.startsWith('#') || s.startsWith('javascript:') || s.startsWith('mailto:') || s.startsWith('tel:')) {
      return s;
    }
    try {
      var u = new URL(s, window.location.origin);
      if (u.origin !== window.location.origin) return s;
      if (!u.searchParams.has('_sid')) {
        u.searchParams.set('_sid', sid);
      }
      return u.pathname + u.search + u.hash;
    } catch (_e) {
      return s;
    }
  }
  window.__withPbSid = withSidUrl;

  // 1. Patch window.fetch so every internal AJAX call carries X-PB-Sid
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        var reqUrl = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        var u = new URL(reqUrl || window.location.href, window.location.origin);
        if (u.origin === window.location.origin && sid) {
          init = Object.assign({}, init || {});
          var headers = new Headers(init.headers || (typeof input !== 'string' && input ? input.headers : undefined) || {});
          if (!headers.has('X-PB-Sid')) headers.set('X-PB-Sid', sid);
          init.headers = headers;
          init.credentials = init.credentials || 'same-origin';
        }
      } catch (_e) {}
      return origFetch(input, init).then(function (res) {
        try {
          var newSid = res.headers && res.headers.get ? res.headers.get('X-PB-Sid') : '';
          if (newSid) {
            sid = newSid;
            window.__PB_SID = newSid;
            sessionStorage.setItem('pb_sid', newSid);
            localStorage.setItem('pb_sid', newSid);
          }
        } catch (_e2) {}
        return res;
      });
    };
  }

  function decorateForm(form) {
    if (!form || !sid) return;
    var method = String(form.getAttribute('method') || 'GET').toUpperCase();
    var rawAction = form.getAttribute('action') || window.location.pathname + window.location.search;
    if (method === 'POST') {
      form.setAttribute('action', withSidUrl(rawAction));
    }
    var hidden = form.querySelector('input[name="_sid"]');
    if (!hidden) {
      hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = '_sid';
      form.appendChild(hidden);
    }
    hidden.value = sid;
  }

  // 2. Ensure both user submit and programmatic form.submit() carry _sid
  document.addEventListener(
    'submit',
    function (e) {
      if (e.target && e.target.tagName === 'FORM') {
        decorateForm(e.target);
      }
    },
    true
  );

  if (typeof HTMLFormElement !== 'undefined' && HTMLFormElement.prototype.submit) {
    var origSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      decorateForm(this);
      return origSubmit.apply(this, arguments);
    };
  }

  // 3. When running inside a cross-origin iframe where cookies may be blocked, attach _sid to internal links
  var inIframe = false;
  try {
    inIframe = window.self !== window.top;
  } catch (_e) {
    inIframe = true;
  }

  document.addEventListener(
    'click',
    function (e) {
      if (!inIframe || !sid) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href');
      if (!href || href.startsWith('#') || a.hasAttribute('data-bs-toggle')) return;
      var updated = withSidUrl(href);
      if (updated !== href) {
        a.setAttribute('href', updated);
      }
    },
    true
  );

  document.addEventListener('DOMContentLoaded', function () {
    if (window.jQuery && window.jQuery.ajaxPrefilter && sid) {
      window.jQuery.ajaxPrefilter(function (options, _originalOptions, jqXHR) {
        if (!options.crossDomain) {
          jqXHR.setRequestHeader('X-PB-Sid', sid);
        }
      });
    }
  });
})();
