(function () {
  function navUrl(url) {
    return window.__withPbSid ? window.__withPbSid(url) : url;
  }

  function i18nStr(key, fallback) {
    var dict = window.__MT_I18N || {};
    return dict[key] || fallback;
  }

  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') || '' : '';
  }

  function jsonHeaders() {
    var headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    var csrf = getCsrfToken();
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
    }
    return headers;
  }

  function notify(type, msg) {
    if (window.toastr) {
      window.toastr.options = { positionClass: 'toast-top-right', timeOut: 3200 };
      window.toastr[type === 'error' ? 'error' : 'success'](msg);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Sync All Cart Badges, Subtotals, and Mini Cart Drawer ───
  window.syncCartUI = function (cartData, openDrawer) {
    var cart = (cartData && cartData.cart) || [];
    var count = typeof (cartData && cartData.cartCount) === 'number'
      ? cartData.cartCount
      : cart.reduce(function (s, i) { return s + (Number(i.qty) || 1); }, 0);
    var subtotal = typeof (cartData && cartData.cartSubtotal) === 'number'
      ? cartData.cartSubtotal
      : cart.reduce(function (s, i) { return s + (Number(i.price) || 0) * (Number(i.qty) || 1); }, 0);

    try {
      localStorage.setItem('pb_cart_backup', JSON.stringify(cart));
    } catch (_e) {}

    document.querySelectorAll('.js-cart-count').forEach(function (el) {
      el.textContent = count;
    });
    document.querySelectorAll('.js-cart-subtotal').forEach(function (el) {
      el.textContent = Number(subtotal).toLocaleString('en-IN');
    });

    var wrap = document.getElementById('miniCartItemsWrap');
    if (wrap) {
      if (!cart.length) {
        wrap.innerHTML =
          '<div class="text-center py-5 text-muted">' +
          '<div style="font-size:44px;" aria-hidden="true">🧺</div>' +
          '<p class="fw-semibold mt-2 mb-1">' + escapeHtml(i18nStr('miniCartEmptyTitle', 'Your cart is empty')) + '</p>' +
          '<small>' + escapeHtml(i18nStr('miniCartEmptySub', 'Add groceries or gift items to get started')) + '</small>' +
          '</div>';
      } else {
        var removeLabel = i18nStr('removeLabel', 'Remove');
        wrap.innerHTML = cart
          .map(function (it) {
            var lineTotal = Number(it.price) * Number(it.qty);
            return (
              '<div class="d-flex align-items-center justify-content-between border-bottom gap-2" style="padding:10px 0;">' +
              '  <div class="d-flex align-items-center gap-2">' +
              '    <img src="' + escapeHtml(it.image) + '" style="width:50px;height:50px;border-radius:10px;object-fit:cover;" alt="" />' +
              '    <div>' +
              '      <a href="' + escapeHtml(navUrl('/product/' + it.slug)) + '" class="fw-bold small text-dark text-decoration-none d-block" style="max-width:170px;">' + escapeHtml(it.name) + '</a>' +
              '      <div class="text-muted" style="font-size:11.5px;">' + escapeHtml(it.size) + (it.color ? ' • ' + escapeHtml(it.color) : '') + ' • ৳' + Number(it.price).toLocaleString('en-IN') + '</div>' +
              '      <div class="input-group input-group-sm mt-1" style="width:96px;">' +
              '        <button type="button" class="btn btn-outline-secondary py-0 px-2" onclick="window.updateCartItemQty(\'' + escapeHtml(it.key) + '\',' + (Number(it.qty) - 1) + ')">−</button>' +
              '        <span class="form-control text-center py-0 px-1 fw-bold" style="font-size:12px;">' + Number(it.qty) + '</span>' +
              '        <button type="button" class="btn btn-outline-secondary py-0 px-2" onclick="window.updateCartItemQty(\'' + escapeHtml(it.key) + '\',' + (Number(it.qty) + 1) + ')">+</button>' +
              '      </div>' +
              '    </div>' +
              '  </div>' +
              '  <div class="text-end">' +
              '    <div class="fw-bold text-success small">৳' + lineTotal.toLocaleString('en-IN') + '</div>' +
              '    <button type="button" class="btn btn-link text-danger p-0 small text-decoration-none" style="font-size:12px;" onclick="window.removeCartItem(\'' + escapeHtml(it.key) + '\')" aria-label="' + escapeHtml(removeLabel) + '" title="' + escapeHtml(removeLabel) + '"><i class="fas fa-trash-alt" aria-hidden="true"></i></button>' +
              '  </div>' +
              '</div>'
            );
          })
          .join('');
      }
    }

    if (typeof window.onCartStateUpdated === 'function') {
      window.onCartStateUpdated({
        cart: cart,
        cartCount: count,
        cartSubtotal: subtotal,
        discount: cartData && typeof cartData.discount === 'number' ? cartData.discount : undefined,
      });
    }

    if (openDrawer && window.bootstrap) {
      var drawerEl = document.getElementById('miniCartDrawer');
      if (drawerEl) {
        window.bootstrap.Offcanvas.getOrCreateInstance(drawerEl).show();
      }
    }
  };

  window.addToCartAjax = function (payload, opts) {
    opts = opts || {};
    return fetch('/cart/add', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.success) {
          notify('error', (d && d.message) || i18nStr('networkErrorMsg', 'Unable to add item to cart.'));
          return d;
        }
        window.syncCartUI(d, Boolean(opts.openDrawer));
        notify('success', d.message);
        if (opts.redirectToCheckout || d.redirect) {
          window.location.href = navUrl(d.redirect || '/customer/checkout');
        }
        return d;
      })
      .catch(function () {
        notify('error', i18nStr('networkErrorMsg', 'Network error — please try again.'));
      });
  };

  window.updateCartItemQty = function (key, newQty) {
    fetch('/cart/update', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ key: key, qty: newQty }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.success) window.syncCartUI(d, false);
      });
  };

  window.removeCartItem = function (key) {
    fetch('/cart/remove', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ key: key }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.success) {
          window.syncCartUI(d, false);
          notify('success', d.message || i18nStr('removedFromCartMsg', 'Item removed from cart.'));
        }
      });
  };

  // ─── Quick Order Modal Helpers ───
  window.changeQoQty = function (delta) {
    var inp = document.getElementById('qoQty');
    if (!inp) return;
    inp.value = Math.max(1, (parseInt(inp.value, 10) || 1) + delta);
    window.recalcQoTotal();
  };

  window.recalcQoTotal = function () {
    var unit = Number((document.getElementById('qoUnitPriceVal') || {}).value || 0);
    var qty = Math.max(1, parseInt((document.getElementById('qoQty') || {}).value || '1', 10));
    var sel = document.getElementById('qoShipArea');
    var ship = sel ? Number(sel.options[sel.selectedIndex].getAttribute('data-ship') || 60) : 60;
    var sub = unit * qty;
    if (window.__FREE_SHIP_MIN > 0 && sub >= window.__FREE_SHIP_MIN) ship = 0;
    var totEl = document.getElementById('qoTotalPayable');
    if (totEl) totEl.textContent = (sub + ship).toLocaleString('en-IN');
  };

  window.openQuickOrder = function (prod) {
    var modalEl = document.getElementById('quickOptionModal');
    if (!modalEl) return;
    document.getElementById('qoProdId').value = prod.id;
    document.getElementById('qoUnitPriceVal').value = prod.price;
    document.getElementById('qoTitle').textContent = prod.name;
    document.getElementById('qoPrice').textContent = '৳' + Number(prod.price).toLocaleString('en-IN');
    var oldEl = document.getElementById('qoOldPrice');
    if (oldEl) {
      oldEl.textContent = Number(prod.oldPrice) > Number(prod.price)
        ? '৳' + Number(prod.oldPrice).toLocaleString('en-IN')
        : '';
    }
    document.getElementById('qoImg').src = prod.image;
    document.getElementById('qoQty').value = 1;

    var sizesWrap = document.getElementById('qoSizesWrap');
    var sizes = String(prod.sizes || 'Standard').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    sizesWrap.innerHTML = sizes
      .map(function (sz, i) {
        return (
          '<input type="radio" class="btn-check" name="qo_size" id="qosz_' + i + '" value="' + escapeHtml(sz) + '" ' + (i === 0 ? 'checked' : '') + ' />' +
          '<label class="btn btn-sm btn-outline-success me-1 mb-1" for="qosz_' + i + '">' + escapeHtml(sz) + '</label>'
        );
      })
      .join('');

    var colorsGroup = document.getElementById('qoColorsGroup');
    var colorsWrap = document.getElementById('qoColorsWrap');
    var colors = String(prod.colors || '').split(',').map(function (c) { return c.trim(); }).filter(Boolean);
    if (colors.length && colorsGroup && colorsWrap) {
      colorsGroup.style.display = 'block';
      colorsWrap.innerHTML = colors
        .map(function (cl, i) {
          return (
            '<input type="radio" class="btn-check" name="qo_color" id="qocl_' + i + '" value="' + escapeHtml(cl) + '" ' + (i === 0 ? 'checked' : '') + ' />' +
            '<label class="btn btn-sm btn-outline-secondary me-1 mb-1" for="qocl_' + i + '">' + escapeHtml(cl) + '</label>'
          );
        })
        .join('');
    } else if (colorsGroup) {
      colorsGroup.style.display = 'none';
      if (colorsWrap) colorsWrap.innerHTML = '';
    }

    window.recalcQoTotal();
    window.bootstrap.Modal.getOrCreateInstance(modalEl).show();
  };

  function getSelectedQoPayload() {
    var szEl = document.querySelector('input[name="qo_size"]:checked');
    var clEl = document.querySelector('input[name="qo_color"]:checked');
    return {
      product_id: Number(document.getElementById('qoProdId').value),
      qty: Math.max(1, parseInt(document.getElementById('qoQty').value || '1', 10)),
      size: szEl ? szEl.value : 'Standard',
      color: clEl ? clEl.value : '',
    };
  }

  // Countdown timers
  function initCountdowns() {
    document.querySelectorAll('[data-countdown]').forEach(function (el) {
      var target = new Date(el.getAttribute('data-countdown')).getTime();
      if (!Number.isFinite(target)) return;
      function tick() {
        var diff = Math.max(0, target - Date.now());
        var d = Math.floor(diff / 86400000);
        var h = Math.floor((diff % 86400000) / 3600000);
        var m = Math.floor((diff % 3600000) / 60000);
        var s = Math.floor((diff % 60000) / 1000);
        var dEl = el.querySelector('.cd-d');
        var hEl = el.querySelector('.cd-h');
        var mEl = el.querySelector('.cd-m');
        var sEl = el.querySelector('.cd-s');
        if (dEl) dEl.textContent = d;
        if (hEl) hEl.textContent = String(h).padStart(2, '0');
        if (mEl) mEl.textContent = String(m).padStart(2, '0');
        if (sEl) sEl.textContent = String(s).padStart(2, '0');
      }
      tick();
      setInterval(tick, 1000);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initCountdowns();
    window.syncCartUI({ cart: window.__INITIAL_CART || [] }, false);

    // Product Detail Image Gallery Thumbnails
    document.querySelectorAll('.js-gallery-thumb').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var src = btn.getAttribute('data-src');
        var mainImg = document.getElementById('mainProdImg');
        if (mainImg && src) {
          mainImg.src = src;
        }
        document.querySelectorAll('.js-gallery-thumb').forEach(function (b) {
          b.classList.remove('border-success', 'border-2');
        });
        btn.classList.add('border-success', 'border-2');
      });
    });

    // Product Detail Structured Variant Radio Sync
    document.querySelectorAll('.js-variant-radio').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        var priceText = radio.getAttribute('data-price-formatted');
        var sku = radio.getAttribute('data-sku');
        var stock = Number(radio.getAttribute('data-stock') || 0);
        var priceEl = document.getElementById('prodActivePrice');
        var skuEl = document.getElementById('prodSkuText');
        var qtyInput = document.getElementById('pQty');
        var addBtn = document.getElementById('prodAddCartBtn');
        var buyBtn = document.getElementById('prodBuyNowBtn');

        if (priceEl && priceText) priceEl.textContent = priceText;
        if (skuEl && sku) skuEl.textContent = sku;
        if (qtyInput) {
          qtyInput.max = String(Math.max(1, stock));
          if (parseInt(qtyInput.value || '1', 10) > Math.max(1, stock)) {
            qtyInput.value = String(Math.max(1, stock));
          }
        }
        if (addBtn) addBtn.disabled = stock <= 0;
        if (buyBtn) buyBtn.disabled = stock <= 0;
      });
    });

    // Delegated clicks for Product Card Add-to-Cart & Quick-Order buttons
    document.addEventListener('click', function (e) {
      var addBtn = e.target.closest('.js-add-to-cart');
      if (addBtn) {
        e.preventDefault();
        var pid = Number(addBtn.getAttribute('data-id'));
        var sz = addBtn.getAttribute('data-size') || 'Standard';
        addBtn.disabled = true;
        window.addToCartAjax({ product_id: pid, qty: 1, size: sz }, { openDrawer: true }).finally(function () {
          addBtn.disabled = false;
        });
        return;
      }

      var qoBtn = e.target.closest('.js-quick-order');
      if (qoBtn) {
        e.preventDefault();
        window.openQuickOrder({
          id: qoBtn.getAttribute('data-id'),
          name: qoBtn.getAttribute('data-name'),
          price: qoBtn.getAttribute('data-price'),
          oldPrice: qoBtn.getAttribute('data-old-price'),
          image: qoBtn.getAttribute('data-image'),
          sizes: qoBtn.getAttribute('data-sizes'),
          colors: qoBtn.getAttribute('data-colors'),
        });
      }
    });

    // Quick Option Modal: Add to Cart & Go to Checkout buttons
    var qoAddBtn = document.getElementById('qoAddToCartBtn');
    if (qoAddBtn) {
      qoAddBtn.addEventListener('click', function () {
        var modalEl = document.getElementById('quickOptionModal');
        window.addToCartAjax(getSelectedQoPayload(), { openDrawer: true }).then(function (d) {
          if (d && d.success && modalEl && window.bootstrap) {
            window.bootstrap.Modal.getOrCreateInstance(modalEl).hide();
          }
        });
      });
    }

    var qoBuyBtn = document.getElementById('qoBuyNowCheckoutBtn');
    if (qoBuyBtn) {
      qoBuyBtn.addEventListener('click', function () {
        var payload = getSelectedQoPayload();
        payload.buy_now = 1;
        window.addToCartAjax(payload, { redirectToCheckout: true });
      });
    }

    // Quick Option Modal: Direct 1-Click COD Order Submit
    var qoDirectForm = document.getElementById('qoDirectOrderForm');
    if (qoDirectForm) {
      qoDirectForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var submitBtn = document.getElementById('qoDirectSubmitBtn');
        var fd = new FormData(qoDirectForm);
        var body = Object.assign(getSelectedQoPayload(), Object.fromEntries(fd.entries()));
        if (submitBtn) submitBtn.disabled = true;
        fetch('/order/quick-submit', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify(body),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.success && d.redirect) {
              notify('success', d.message);
              window.location.href = navUrl(d.redirect);
            } else {
              notify('error', (d && d.message) || i18nStr('networkErrorMsg', 'Unable to place order.'));
              if (submitBtn) submitBtn.disabled = false;
            }
          })
          .catch(function () {
            notify('error', i18nStr('networkErrorMsg', 'Network error — please try again.'));
            if (submitBtn) submitBtn.disabled = false;
          });
      });
    }

    // Single Product Page Add-to-Cart & Buy-Now AJAX handler
    var prodForm = document.getElementById('productCartForm');
    if (prodForm) {
      var buyNowClicked = false;
      var buyBtnEl = prodForm.querySelector('[name="buy_now"]');
      if (buyBtnEl) {
        buyBtnEl.addEventListener('click', function () { buyNowClicked = true; });
      }
      var addCartBtnEl = prodForm.querySelector('.js-prod-add-btn');
      if (addCartBtnEl) {
        addCartBtnEl.addEventListener('click', function () { buyNowClicked = false; });
      }

      prodForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var variantRadios = prodForm.querySelectorAll('input[name="variant_id"]');
        if (variantRadios.length > 0 && !prodForm.querySelector('input[name="variant_id"]:checked')) {
          notify('error', i18nStr('selectRequiredVariant', 'Please select an option first.'));
          return;
        }
        var fd = new FormData(prodForm);
        var payload = Object.fromEntries(fd.entries());
        if (buyNowClicked) payload.buy_now = 1;
        else delete payload.buy_now;

        window.addToCartAjax(payload, {
          openDrawer: !buyNowClicked,
          redirectToCheckout: buyNowClicked,
        });
      });
    }

    // Live Support Widget
    var lsFab = document.getElementById('lsFabBtn');
    var lsBox = document.getElementById('lsChatBox');
    var lsClose = document.getElementById('lsCloseBtn');
    var lsForm = document.getElementById('lsChatForm');
    var lsInput = document.getElementById('lsChatInput');
    var lsMsgs = document.getElementById('lsChatMsgs');

    if (lsFab && lsBox) {
      lsFab.addEventListener('click', function () { lsBox.classList.toggle('open'); });
      lsClose.addEventListener('click', function () { lsBox.classList.remove('open'); });

      function addLsBubble(role, txt) {
        var d = document.createElement('div');
        d.className = 'mb-2 d-flex ' + (role === 'user' ? 'justify-content-end' : 'justify-content-start');
        var b = document.createElement('div');
        b.style.maxWidth = '85%';
        b.style.padding = '8px 12px';
        b.style.borderRadius = '12px';
        b.style.fontSize = '13px';
        b.style.whiteSpace = 'pre-wrap';
        if (role === 'user') { b.style.background = '#0d3b26'; b.style.color = '#fff'; }
        else { b.style.background = '#f1f5f9'; b.style.color = '#1e293b'; }
        b.textContent = txt;
        d.appendChild(b);
        lsMsgs.appendChild(d);
        lsMsgs.scrollTop = lsMsgs.scrollHeight;
      }

      function sendLs(q) {
        if (!q) return;
        addLsBubble('user', q);
        lsInput.value = '';
        fetch('/api/store-assistant', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ message: q }),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) { addLsBubble('bot', d.reply || ''); });
      }

      lsForm.addEventListener('submit', function (e) {
        e.preventDefault();
        sendLs(lsInput.value.trim());
      });

      document.querySelectorAll('.ls-quick-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var action = btn.getAttribute('data-action');
          if (action === 'complaint') {
            lsBox.classList.remove('open');
            new bootstrap.Modal(document.getElementById('complaintModal')).show();
          } else {
            sendLs(btn.getAttribute('data-q'));
          }
        });
      });
    }

    // Complaint Modal Submit
    var compForm = document.getElementById('complaintForm');
    if (compForm) {
      compForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(compForm);
        var payload = Object.fromEntries(fd.entries());
        fetch('/api/complaint', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.success) {
              notify('error', (d && d.message) || i18nStr('networkErrorMsg', 'Error submitting form.'));
              return;
            }
            notify('success', d.message);
            compForm.reset();
            var inst = bootstrap.Modal.getInstance(document.getElementById('complaintModal'));
            if (inst) inst.hide();
          });
      });
    }

    // Verified Order Social Proof Popup
    var voToast = document.getElementById('verifiedOrderToast');
    if (voToast) {
      setTimeout(function () {
        fetch('/api/recent-verified-order')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.enabled) return;
            document.getElementById('voImg').src = d.image;
            document.getElementById('voCust').textContent = d.customer;
            document.getElementById('voProd').textContent = d.product;
            document.getElementById('voLink').href = navUrl(d.url);
            voToast.classList.add('show');
            setTimeout(function () { voToast.classList.remove('show'); }, 6500);
          })
          .catch(function () {});
      }, 4500);
    }
  });
})();
