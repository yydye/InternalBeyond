'use strict';

(function () {
  const params = new URLSearchParams(window.location.search);
  if (params.get('theme') === 'infernal') document.body.classList.add('theme-infernal');

  window.__overlayLifecycle = window.IBOverlayLifecycle.install(document, {
    fallbackFocus: function () { return document.querySelector('main'); },
    onSubmit: function (dialog) {
      if (dialog.id === 'busy-dialog') {
        window.__busySubmitCount = (window.__busySubmitCount || 0) + 1;
        return new Promise(function (resolve) { window.__resolveBusySubmit = resolve; });
      }
      if (dialog.id === 'destructive-dialog') window.__destructiveConfirmCount = (window.__destructiveConfirmCount || 0) + 1;
      if (dialog.id === 'choice-dialog') window.__choiceConfirmCount = (window.__choiceConfirmCount || 0) + 1;
      return true;
    }
  });

  function showRetryableError() {
    const secret = 'sk-D2C-SECRET-SENTINEL-938475';
    const model = window.IBERR.model('network', {
      endpoint: 'https://service.example/v1/chat?key=' + secret,
      detail: 'Authorization: Bearer ' + secret,
      requestId: 'req_d2c_12345678'
    });
    window.__retryCount = 0;
    window.__errorCard = window.IBERR.show(model, {
      onRetry: function () {
        window.__retryCount += 1;
        return new Promise(function (resolve) {
          window.__resolveErrorRetry = function (result) {
            if (result !== false) document.getElementById('error-recovery-status').textContent = 'Connection recovered.';
            resolve(result);
          };
        });
      }
    });
  }

  function showNonRetryableError() {
    const model = window.IBERR.model('auth', {
      reason: 'missing-key',
      detail: 'Authorization: Bearer sk-D2C-SECRET-SENTINEL-938475'
    });
    window.__fixedErrorCard = window.IBERR.show(model, { onRetry: function () { window.__invalidRetryCount = (window.__invalidRetryCount || 0) + 1; } });
  }

  document.getElementById('show-retryable-error').addEventListener('click', showRetryableError);
  document.getElementById('show-fixed-error').addEventListener('click', showNonRetryableError);
  document.getElementById('show-success-toast').addEventListener('click', function () { window.toast.success('Saved'); });
  document.getElementById('show-multiple-toasts').addEventListener('click', function () {
    window.toast.success('Copied');
    window.toast.success('Added');
  });
  document.getElementById('toast-in-dialog').addEventListener('click', function () { window.toast.success('Saved'); });

  window.resolveBusySubmit = function (result) {
    if (typeof window.__resolveBusySubmit === 'function') window.__resolveBusySubmit(result !== false);
  };
})();
