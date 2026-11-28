/* Asks for the account password to confirm an order (signed in, or the number has an account). The server checks again. */
(function () {
  'use strict';
  function setUp(form) {
    var phone = form.querySelector('input[name="phone"]');
    var box = form.querySelector('.js-account-pw');
    if (!phone || !box) return;
    var password = box.querySelector('input[name="account_password"]');
    var message = box.querySelector('.js-account-pw-message');
    var cleared = null;
    var busy = false;
    var key = function () { return phone.value.trim() + '\n' + password.value; };
    var usable = function () { return /^(?:\+?88)?01[3-9]\d{8}$/.test(phone.value.replace(/[\s()-]/g, '')); };
    function show(required, text) {
      box.hidden = !required;
      password.required = required;
      if (!required) password.value = '';
      if (text) message.textContent = text;
    }
    function check(typed) {
      var token = form.querySelector('input[name="_csrf"]') || document.querySelector('meta[name="csrf-token"]');
      var csrf = token ? (token.value || token.getAttribute('content') || '') : '';
      return fetch('/api/checkout/account-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ phone: phone.value, password: typed, _csrf: csrf }),
      }).then(function (response) { return response.json(); });
    }
    var lookedUp = '';
    function lookUp() {
      if (!usable()) { lookedUp = ''; show(false); return; }
      var value = phone.value.trim();
      if (value === lookedUp) return;
      lookedUp = value;
      check('').then(function (data) {
        if (data.success && value === phone.value.trim()) show(data.passwordRequired, data.message);
      }).catch(function () { lookedUp = ''; });
    }
    phone.addEventListener('input', function () { cleared = null; lookUp(); });
    phone.addEventListener('change', lookUp);
    // Capture phase: this runs before any other submit handler on the form.
    form.addEventListener('submit', function (event) {
      if (cleared === key()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (busy) return;
      busy = true;
      var attempted = key();
      var submitter = event.submitter;
      var proceed = function () {
        busy = false;
        cleared = attempted;
        if (form.requestSubmit) form.requestSubmit(submitter || undefined); else form.submit();
      };
      check(password.value).then(function (data) {
        // An invalid request (for example a wrong phone format) is explained by the order submit itself.
        if (data.success && (!data.passwordRequired || data.passwordOk)) {
          if (!data.passwordRequired) show(false);
          attempted = key();
          proceed();
          return;
        }
        if (data.success) { show(true, data.message); busy = false; password.focus(); return; }
        if (data.error && data.error.code === 'RATE_LIMITED') { show(true, data.error.message); busy = false; return; }
        proceed();
      }).catch(proceed);
    }, true);
    lookUp();
  }
  Array.prototype.forEach.call(document.querySelectorAll('form[data-checkout-account]'), setUp);

  // Quick order popup: the same field, filled in by the same check as the phone number is typed.
  var quick = document.getElementById('qoDirectOrderForm');
  if (quick) {
    var qPhone = quick.querySelector('input[name="phone"]');
    var qBox = quick.querySelector('.js-account-pw');
    if (qPhone && qBox) {
      var qPassword = qBox.querySelector('input[name="account_password"]');
      qPhone.addEventListener('input', function () { qBox.hidden = true; qPassword.required = false; qPassword.value = ''; });
      window.mtShowAccountPassword = function (text) {
        qBox.hidden = false;
        qPassword.required = true;
        if (text) qBox.querySelector('.js-account-pw-message').textContent = text;
        qPassword.focus();
      };
    }
  }
}());
