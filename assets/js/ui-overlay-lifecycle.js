/* P36-VL-D2-C: small adapters around native Popover and Dialog lifecycle. */
(function (root) {
  'use strict';

  var installations = new WeakMap();
  var anchorSequence = 0;

  function closestElement(target, selector) {
    return target && typeof target.closest === 'function' ? target.closest(selector) : null;
  }

  function install(scope, options) {
    scope = scope || document;
    options = options || {};
    if (installations.has(scope)) return installations.get(scope);

    var ownerDocument = scope.nodeType === 9 ? scope : scope.ownerDocument || document;
    var dialogRecords = new WeakMap();

    function findDialog(id) {
      return ownerDocument.getElementById(String(id || ''));
    }

    function isDismissable(dialog, record) {
      if (dialog.getAttribute('data-dismissible') === 'false') return false;
      return !record.busy || dialog.getAttribute('data-cancel-while-busy') === 'true';
    }

    function focusTarget(dialog) {
      var candidate = null;
      if (dialog.getAttribute('data-destructive') === 'true') {
        candidate = dialog.querySelector('[data-dialog-title]');
      }
      candidate = candidate
        || dialog.querySelector('[data-dialog-initial-focus]')
        || dialog.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])')
        || dialog.querySelector('[data-dialog-safe-primary]:not([disabled])')
        || dialog.querySelector('[data-dialog-title]');
      return candidate;
    }

    function focusableElements(dialog) {
      return Array.prototype.filter.call(dialog.querySelectorAll(
        'a[href], area[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ), function (element) {
        return !element.hidden && (!element.getClientRects || element.getClientRects().length > 0);
      });
    }

    function restoreFocus(dialog, record, closedTrigger) {
      var target = closedTrigger || record.trigger;
      if (!target || !target.isConnected || target.disabled || target.closest('[inert]')) {
        target = null;
        var fallbackId = dialog.getAttribute('data-dialog-return-focus');
        if (fallbackId) target = ownerDocument.getElementById(fallbackId);
        if (!target && typeof options.fallbackFocus === 'function') {
          target = options.fallbackFocus(dialog, record.trigger) || null;
        }
      }
      if (target && typeof target.focus === 'function') {
        root.requestAnimationFrame(function () {
          if (target.isConnected && !target.disabled) target.focus({ preventScroll: true });
        });
      }
    }

    function setBusy(dialog, record, busy, submitter) {
      record.busy = busy;
      if (busy) {
        dialog.setAttribute('aria-busy', 'true');
        if (submitter) {
          if (!record.submitter) record.submitter = { element: submitter, disabled: submitter.disabled, text: submitter.textContent };
          submitter.disabled = true;
          submitter.setAttribute('aria-busy', 'true');
          var busyText = submitter.getAttribute('data-busy-label');
          if (busyText) submitter.textContent = busyText;
        }
        dialog.querySelectorAll('[data-ib-dialog-cancel]').forEach(function (button) {
          if (dialog.getAttribute('data-cancel-while-busy') !== 'true') button.disabled = true;
        });
        var busyStatus = dialog.querySelector('[data-dialog-submit-status]');
        if (busyStatus) {
          busyStatus.hidden = false;
          busyStatus.textContent = dialog.getAttribute('data-busy-message') || 'Working…';
        }
        return;
      }

      dialog.removeAttribute('aria-busy');
      if (record.submitter) {
        record.submitter.element.disabled = record.submitter.disabled;
        record.submitter.element.removeAttribute('aria-busy');
        record.submitter.element.textContent = record.submitter.text;
        record.submitter = null;
      }
      dialog.querySelectorAll('[data-ib-dialog-cancel]').forEach(function (button) {
        button.disabled = false;
      });
      var status = dialog.querySelector('[data-dialog-submit-status]');
      if (status) {
        status.hidden = true;
        status.textContent = '';
      }
    }

    function reportSubmitFailure(dialog, error) {
      if (typeof options.onSubmitFailure !== 'function') return;
      try { options.onSubmitFailure(dialog, error); } catch (ignored) { }
    }

    function registerDialog(dialog) {
      if (dialogRecords.has(dialog)) return dialogRecords.get(dialog);
      var record = { trigger: null, busy: false, submitter: null };
      dialogRecords.set(dialog, record);
      dialog.setAttribute('aria-modal', 'true');

      dialog.addEventListener('cancel', function (event) {
        if (!isDismissable(dialog, record)) event.preventDefault();
      });

      /* Native modal behavior remains primary; this closes a WebView edge where Tab from the final control escaped. */
      dialog.addEventListener('keydown', function (event) {
        if (event.key !== 'Tab' || !dialog.open) return;
        var controls = focusableElements(dialog);
        if (!controls.length) {
          event.preventDefault();
          dialog.focus({ preventScroll: true });
          return;
        }
        var first = controls[0];
        var last = controls[controls.length - 1];
        var active = ownerDocument.activeElement;
        if (!controls.includes(active)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus({ preventScroll: true });
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus({ preventScroll: true });
        }
      });

      dialog.addEventListener('click', function (event) {
        if (event.target !== dialog || !isDismissable(dialog, record)) return;
        dialog.close('backdrop');
      });

      dialog.addEventListener('close', function () {
        if (record.busy) setBusy(dialog, record, false);
        if (root.toast && typeof root.toast._restoreFromDialog === 'function') root.toast._restoreFromDialog(dialog);
        var trigger = record.trigger;
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        restoreFocus(dialog, record, trigger);
        record.trigger = null;
      });

      dialog.querySelectorAll('form[data-dialog-submit]').forEach(function (form) {
        form.addEventListener('submit', function (event) {
          event.preventDefault();
          if (record.busy || !dialog.open) return;
          var submitter = event.submitter || form.querySelector('[type="submit"]');
          setBusy(dialog, record, true, submitter);
          var result;
          try {
            result = typeof options.onSubmit === 'function'
              ? options.onSubmit(dialog, form, submitter)
              : true;
          } catch (error) {
            result = Promise.reject(error);
          }
          Promise.resolve(result).then(function (value) {
            if (value !== false && dialog.open) dialog.close('success');
            else if (dialog.open) {
              setBusy(dialog, record, false);
              reportSubmitFailure(dialog, null);
            }
          }, function (error) {
            if (!dialog.open) return;
            setBusy(dialog, record, false);
            reportSubmitFailure(dialog, error);
          });
        });
      });

      return record;
    }

    function openDialog(dialog, trigger) {
      if (!dialog || dialog.open || typeof dialog.showModal !== 'function') return false;
      var record = registerDialog(dialog);
      record.trigger = trigger || ownerDocument.activeElement || null;
      if (record.trigger && record.trigger.setAttribute) record.trigger.setAttribute('aria-expanded', 'true');
      try {
        dialog.showModal();
      } catch (error) {
        if (record.trigger && record.trigger.setAttribute) record.trigger.setAttribute('aria-expanded', 'false');
        record.trigger = null;
        return false;
      }
      if (root.toast && typeof root.toast._attachToDialog === 'function') root.toast._attachToDialog(dialog);
      var initial = focusTarget(dialog);
      if (initial && typeof initial.focus === 'function') initial.focus({ preventScroll: true });
      return true;
    }

    function closeDialog(dialog, returnValue) {
      if (!dialog || !dialog.open) return false;
      var record = registerDialog(dialog);
      if (record.busy && dialog.getAttribute('data-cancel-while-busy') !== 'true') return false;
      dialog.close(returnValue || 'cancel');
      return true;
    }

    function bindPopovers() {
      scope.querySelectorAll('[popover][data-ib-popover]').forEach(function (panel) {
        var trigger = Array.prototype.find.call(scope.querySelectorAll('[popovertarget]'), function (candidate) {
          return candidate.getAttribute('popovertarget') === panel.id;
        });
        if (!trigger) return;
        if (!trigger.hasAttribute('aria-controls') && !trigger.hasAttribute('popovertarget')) {
          trigger.setAttribute('aria-controls', panel.id);
        }
        trigger.setAttribute('aria-expanded', panel.matches(':popover-open') ? 'true' : 'false');
        trigger.setAttribute('aria-haspopup', 'true');
        var anchorName = '--ib-overlay-anchor-' + (++anchorSequence);
        trigger.style.setProperty('anchor-name', anchorName);
        panel.style.setProperty('position-anchor', anchorName);
        function syncExpanded() {
          trigger.setAttribute('aria-expanded', panel.matches(':popover-open') ? 'true' : 'false');
        }
        panel.addEventListener('beforetoggle', function (event) {
          trigger.setAttribute('aria-expanded', event.newState === 'open' ? 'true' : 'false');
        });
        panel.addEventListener('toggle', syncExpanded);
      });
    }

    function onClick(event) {
      var openTrigger = closestElement(event.target, '[data-ib-dialog-open]');
      if (openTrigger) {
        event.preventDefault();
        var dialog = findDialog(openTrigger.getAttribute('data-ib-dialog-open'));
        if (dialog) openDialog(dialog, openTrigger);
        return;
      }
      var cancelTrigger = closestElement(event.target, '[data-ib-dialog-cancel]');
      if (cancelTrigger) {
        var owner = closestElement(cancelTrigger, 'dialog[data-ib-dialog]');
        if (owner) {
          event.preventDefault();
          closeDialog(owner, 'cancel');
        }
      }
    }

    scope.querySelectorAll('dialog[data-ib-dialog]').forEach(registerDialog);
    bindPopovers();
    scope.addEventListener('click', onClick);

    var api = {
      openDialog: openDialog,
      closeDialog: closeDialog,
      isBusy: function (dialog) {
        var record = dialogRecords.get(dialog);
        return !!(record && record.busy);
      },
      bindPopovers: bindPopovers
    };
    installations.set(scope, api);
    return api;
  }

  root.IBOverlayLifecycle = { install: install };
})(window);
