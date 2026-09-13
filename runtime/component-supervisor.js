'use strict';

/*
 * Internal Beyond · component supervisor (P11-3C)
 *
 * ONE bounded crash-recovery policy for the components the runner manages.
 *
 * ── Why this file exists, and what it refuses to be ───────────────────────
 *
 * P11-3B made the registry the single source of truth for WHICH components
 * exist, what port they own, whether a port answer is really theirs, and
 * whether they are allowed to be restarted (`restartable`). It deliberately
 * contained no recovery behaviour: a stopped component was reported stopped and
 * that was the whole story.
 *
 * This file adds exactly one thing: what the runner DOES about a component that
 * died. It is the recovery counterpart to the registry, and it is built so that
 * the two cannot drift:
 *
 *   · It never lists components. The component list is the registry's, and the
 *     runner calls `note*` with a plain component id. A second list here would
 *     be the fifth drift the registry was created to kill.
 *   · It never declares eligibility. `restartable` on the registry is the only
 *     authorization; this module refuses to recover anything the caller did not
 *     present as restartable (see `concerns()` / `eligible()`).
 *   · It is dependency-free. No filesystem, no process, no HTTP, no clock it did
 *     not receive, and no `require` of any sibling module. Every decision is a
 *     pure function of (policy, state, event, now). That is what makes the
 *     bounded-ness of the policy testable without spawning a single process.
 *   · It owns no process. It does not spawn, kill, probe or retry anything; it
 *     decides, and the runner acts. A policy engine that could also start
 *     processes would need a real machine to test, which is precisely how
 *     "temporary" unbounded retry loops get shipped.
 *
 * ── The one rule this file exists to enforce ──────────────────────────────
 *
 *   NO UNBOUNDED RECOVERY. Ever, by any path.
 *
 * Every route back into `recovering` passes through `authorizeAttempt()`, which
 * consults the sliding-window budget and the lockout. There is no public method
 * that sets a state directly, and no public method that clears a failed state:
 * a lockout ends only when a probe proves the component healthy again. The
 * attempt budget is clamped to a FINITE number in the constructor, so a caller
 * cannot ask for infinite retries even by accident.
 *
 * ── Redaction ─────────────────────────────────────────────────────────────
 *
 * Every string that enters this module is a component id, a display name, or a
 * message that the caller already produced from a local probe outcome. Nothing
 * here reads a credential, and `sanitize()` additionally caps length and strips
 * anything credential-shaped before a reason can reach a health view, a log or
 * the diagnostics page.
 */

/* ── State vocabulary ──────────────────────────────────────────────────────
 *
 * These strings are a contract: tests, the health view and the diagnostics page
 * key off them. They are disjoint from registry STATE by design — the registry
 * describes "what a probe observed", this describes "what the runner is doing
 * about it", and a component can legitimately be registry-healthy while the
 * supervisor is `recovering` (the process is up but its port never answered).
 */
const RECOVERY_STATE = {
  HEALTHY: 'healthy',
  STARTING: 'starting',
  STOPPED: 'stopped',
  RECOVERING: 'recovering',
  FAILED: 'failed'
};
const STATES = Object.values(RECOVERY_STATE);

/* The closed set of events the state machine accepts. An unknown event is a
   defect in the caller, not something to silently absorb. */
const EVENT = {
  START: 'start',
  HEALTH_FAIL: 'health_fail',
  PROCESS_EXIT: 'process_exit',
  RESTART_SUCCESS: 'restart_success',
  RESTART_FAILED: 'restart_failed',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  /* Emitted by the runner, never by an operator: an intent to stop (graceful
     shutdown, control-plane restart, operator stop) is not a crash, and must
     not be recovered. Kept in this vocabulary so "not recovered" is an explicit
     state-machine decision rather than an `if` the caller might one day drop. */
  STOP: 'stop',
  STOP_FAILED: 'stop_failed'
};
const EVENTS = Object.values(EVENT);

/* Why a component is being considered for recovery. Recorded so a health view
   can distinguish "died on its own" from "was alive and stopped answering". */
const TRIGGER = {
  START: 'start',
  PROCESS_EXIT: 'process-exit',
  SPAWN_FAILED: 'spawn-failed',
  HEALTH_FAIL: 'health-fail'
};

/* ── Policy ────────────────────────────────────────────────────────────────
 *
 * Bounded by construction. Four independent limits, each closing a different
 * way an "automatic restart" becomes a fork bomb or a hot loop:
 *
 *   maxAttempts      how many restarts are allowed inside the window. Finite,
 *                    and the constructor refuses a non-finite value.
 *   windowMs         the sliding window those attempts are counted over, so a
 *                    component cannot accumulate unlimited restarts by running
 *                    for a long time — only by failing repeatedly.
 *   backoffMs/capMs  exponential spacing, so a persistent failure does not spin
 *                    at full CPU. Delay = base * 2^(failures-1), capped.
 *   lockout          after the budget is exhausted the component is `failed` and
 *                    NEVER retried automatically again in this process. Only
 *                    real evidence of health ends a lockout.
 *
 * Health-driven recovery additionally needs `healthFailStreak` consecutive
 * failed probes: one slow probe must not restart a working service.
 */
const DEFAULT_POLICY = Object.freeze({
  maxAttempts: 5,
  windowMs: 10 * 60 * 1000,
  baseBackoffMs: 1000,
  maxBackoffMs: 60 * 1000,
  healthFailStreak: 2
});

/* The finite clamp. A caller may lower the budget; nobody may raise it to
   unbounded, and `Infinity`/`NaN`/negative/absent all resolve to the default
   rather than to "no limit". */
const HARD_MAX_ATTEMPTS = 10;
const HARD_MAX_WINDOW_MS = 60 * 60 * 1000;

function positiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return max !== undefined && n > max ? max : n;
}

function normalizePolicy(given) {
  const p = given || {};
  const maxAttempts = positiveInt(p.maxAttempts, DEFAULT_POLICY.maxAttempts, HARD_MAX_ATTEMPTS);
  const windowMs = positiveInt(p.windowMs, DEFAULT_POLICY.windowMs, HARD_MAX_WINDOW_MS);
  /* The backoff interval, but never 0 for a retry loop: a zero backoff is a
     busy loop wearing a policy's clothes. */
  const base = positiveInt(p.baseBackoffMs, DEFAULT_POLICY.baseBackoffMs);
  const cap = positiveInt(p.maxBackoffMs, DEFAULT_POLICY.maxBackoffMs);
  return Object.freeze({
    maxAttempts: maxAttempts === 0 ? 0 : maxAttempts,
    windowMs: windowMs,
    baseBackoffMs: base > 0 ? base : DEFAULT_POLICY.baseBackoffMs,
    maxBackoffMs: cap > 0 ? cap : DEFAULT_POLICY.maxBackoffMs,
    healthFailStreak: Math.max(1, positiveInt(p.healthFailStreak, DEFAULT_POLICY.healthFailStreak))
  });
}

/* ── Redaction ─────────────────────────────────────────────────────────────
 *
 * The supervisor's reasons are built from probe outcomes, which are already
 * local and already redacted by the runner. This is the second pass the P5
 * diagnostics contract requires: nothing that looks like a credential may ride
 * a reason string into a health view or a log. */
function sanitize(text, max) {
  let out = String(text == null ? '' : text);
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, '****');
  out = out.replace(/\b(AIza[A-Za-z0-9_-]{15,})\b/g, '****');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._-]{6,}\b/gi, (m, p1) => p1 + '****');
  out = out.replace(/(\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|authorization|x-ib-token)\b\s*[:=]\s*)(['"]?)[^\s,'";]{4,}/gi,
    (m, p1, p2) => p1 + (p2 || '') + '***' + (p2 || ''));
  return out.slice(0, max || 200);
}

/* ── Per-component record ──────────────────────────────────────────────────
 *
 * Internal shape. Everything a health view is allowed to see goes through
 * `describe()`, which is an allowlist — a new field added here does not leak
 * into the API by accident.
 */
function newRecord(componentId, label, at) {
  return {
    componentId: componentId,
    label: label || componentId,
    state: RECOVERY_STATE.STOPPED,
    lastEvent: null,
    lastEventAt: at,
    stateSince: at,
    /* Attempt bookkeeping (the budget's evidence). */
    attemptTimes: [],
    /* Consecutive failures since the last PROVEN recovery. Drives the backoff, so
       only real failures increment it — never a failed attempt's own bookkeeping. */
    consecutiveFailures: 0,
    restartCount: 0,
    lastRestartAt: null,
    lastFailureReason: '',
    lastFailureAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    lastTrigger: null,
    nextAttemptAt: null,
    backoffMs: 0,
    healthFailStreak: 0,
    lockedOutAt: null,
    failedReason: ''
  };
}

/* ── Supervisor ──────────────────────────────────────────────────────────── */

class Supervisor {
  /**
   * @param {object} [opts]
   * @param {object} [opts.policy]     bounded policy overrides (see DEFAULT_POLICY)
   * @param {function} [opts.now]      clock injection, for deterministic tests
   */
  constructor(opts) {
    const o = opts || {};
    this.policy = normalizePolicy(o.policy);
    this._now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    this._records = new Map();
    this._history = [];
  }

  /* Register a component. Registration is NOT eligibility: the caller still has
     to present `restartable:true` on every event that could cause a restart,
     so a component cannot be recovered by being registered. */
  register(componentId, label) {
    const id = String(componentId || '');
    if (!id) throw new Error('supervisor.register requires a component id');
    if (!this._records.has(id)) {
      this._records.set(id, newRecord(id, label, this._now()));
    }
    return this._records.get(id);
  }

  has(componentId) { return this._records.has(String(componentId)); }

  policySnapshot() {
    return {
      maxAttempts: this.policy.maxAttempts,
      windowMs: this.policy.windowMs,
      baseBackoffMs: this.policy.baseBackoffMs,
      maxBackoffMs: this.policy.maxBackoffMs,
      healthFailStreak: this.policy.healthFailStreak,
      bounded: true
    };
  }

  /* ── Eligibility ───────────────────────────────────────────────────────
   *
   * `component` is whatever the caller has: the registry's component object, a
   * runner service spec, or a plain descriptor. Only the two facts that decide
   * recovery are consulted, and BOTH must hold. An unrecognised or missing
   * `restartable` is false — silence is never permission. */
  static eligible(component) {
    const c = component || {};
    return c.restartable === true && c.managedByRunner === true;
  }

  /* ── Budget ────────────────────────────────────────────────────────────
   *
   * The attempt budget is a sliding window over real attempt timestamps. The
   * window is what makes this bounded: a component that restarts successfully
   * and later crashes again is judged on recent history, not on a lifetime
   * counter that would eventually lock out a healthy product. */
  attemptsInWindow(componentId, at) {
    const rec = this._records.get(String(componentId));
    if (!rec) return 0;
    const t = at === undefined ? this._now() : at;
    return rec.attemptTimes.filter(ts => t - ts < this.policy.windowMs).length;
  }

  remainingBudget(componentId, at) {
    return Math.max(0, this.policy.maxAttempts - this.attemptsInWindow(componentId, at));
  }

  /* THE single gate. Every transition into a retry passes through here, which is
     what makes "no unbounded restart" a property of the code rather than a
     property of the callers' discipline. */
  authorizeAttempt(componentId, at) {
    const rec = this._records.get(String(componentId));
    if (!rec) return { allowed: false, reason: 'unregistered-component' };
    const t = at === undefined ? this._now() : at;
    if (rec.lockedOutAt !== null) {
      return { allowed: false, reason: 'locked-out', lockedOutAt: rec.lockedOutAt };
    }
    const used = this.attemptsInWindow(componentId, t);
    if (used >= this.policy.maxAttempts) {
      return { allowed: false, reason: 'budget-exhausted', used: used, max: this.policy.maxAttempts, windowMs: this.policy.windowMs };
    }
    return { allowed: true, remaining: this.policy.maxAttempts - used };
  }

  /* Backoff for the NEXT retry: exponential in consecutive failures, capped.
     Exponential in (failures - 1), so the FIRST retry after a failure uses the
     base delay and each further consecutive failure doubles it. A zero delay is
     unreachable: base is the minimum, and normalizePolicy refuses a 0 base. */
  backoffFor(componentId, at) {
    const rec = this._records.get(String(componentId));
    if (!rec) return this.policy.baseBackoffMs;
    const step = Math.max(0, rec.consecutiveFailures - 1);
    const raw = this.policy.baseBackoffMs * Math.pow(2, step);
    const capped = Math.min(raw, this.policy.maxBackoffMs);
    /* NaN can only appear if a caller mutated the frozen policy through a proxy;
       the cap check keeps the retry bounded even then. */
    return Number.isFinite(capped) ? capped : this.policy.maxBackoffMs;
  }

  /* ── Event intake ──────────────────────────────────────────────────────
   *
   * The ONLY way a state changes. Returns a decision object telling the runner
   * what to do; the supervisor itself never spawns, kills or probes anything.
   *
   * decision = {
   *   state, event, action: 'none'|'retry'|'recovered'|'failed',
   *   inMs (when action === 'retry'), reason
   * }
   */
  handle(componentId, event, payload) {
    const id = String(componentId || '');
    const rec = this._records.get(id);
    if (!rec) return { state: null, event: event, action: 'none', reason: 'unregistered-component' };
    if (EVENTS.indexOf(event) < 0) {
      throw new Error('supervisor.handle: unknown event ' + String(event));
    }
    const p = payload || {};
    const at = Number.isFinite(Number(p.at)) && Number(p.at) > 0 ? Number(p.at) : this._now();
    /* Eligibility is required for any event that could lead to a process being
       started. A non-restartable component still gets an honest state (stopped /
       failed) — it just never gets an attempt. */
    const restartable = p.restartable === true;
    const wasState = rec.state;

    rec.lastEvent = event;
    rec.lastEventAt = at;

    const setState = (next) => {
      if (next !== rec.state) {
        rec.state = next;
        rec.stateSince = at;
      }
    };

    if (event === EVENT.START) {
      rec.healthFailStreak = 0;
      rec.lastTrigger = p.trigger || TRIGGER.START;
      setState(RECOVERY_STATE.STARTING);
      return { state: rec.state, event: event, action: 'none', reason: 'started', previous: wasState };
    }

    /* Evidence of health. This is the ONE thing that ends a lockout — a failed
       component that comes back on its own (or through an operator's explicit
       restart) is genuinely healthy, and refusing to believe it would leave the
       product permanently red after a transient failure. */
    if (event === EVENT.RESTART_SUCCESS) {
      rec.healthFailStreak = 0;
      rec.consecutiveFailures = 0;
      rec.nextAttemptAt = null;
      rec.backoffMs = 0;
      rec.lockedOutAt = null;
      rec.failedReason = '';
      rec.restartCount += 1;
      rec.lastRestartAt = at;
      rec.lastTrigger = p.trigger || rec.lastTrigger;
      setState(RECOVERY_STATE.HEALTHY);
      return { state: rec.state, event: event, action: 'recovered', reason: 'healthy', previous: wasState };
    }

    if (event === EVENT.STOP) {
      rec.healthFailStreak = 0;
      rec.nextAttemptAt = null;
      rec.backoffMs = 0;
      setState(RECOVERY_STATE.STOPPED);
      return { state: rec.state, event: event, action: 'none', reason: 'stopped-intentionally', previous: wasState };
    }

    if (event === EVENT.STOP_FAILED) {
      rec.lastFailureReason = sanitize(p.reason || 'stop failed without a reason', 200);
      rec.lastFailureAt = at;
      setState(RECOVERY_STATE.FAILED);
      return { state: rec.state, event: event, action: 'none', reason: 'stop-failed', previous: wasState };
    }

    if (event === EVENT.BUDGET_EXHAUSTED) {
      return this._lockOut(rec, at, sanitize(p.reason || 'restart budget exhausted', 200), wasState, event);
    }

    /* A restart attempt that did not succeed. It does NOT add to
       consecutiveFailures: the failure that CAUSED the attempt already did, and
       counting it twice would double the backoff on the very first retry (the
       first retry would already jump to base*2). The backoff therefore measures
       consecutive failures since the last proven recovery, which is what makes
       attempt #1 use the base delay. */
    if (event === EVENT.RESTART_FAILED) {
      rec.lastFailureReason = sanitize(p.reason || 'restart attempt failed', 200);
      rec.lastFailureAt = at;
      rec.failedReason = rec.lastFailureReason;
      const authorization = restartable ? this.authorizeAttempt(id, at) : { allowed: false, reason: 'not-restartable' };
      if (!authorization.allowed) {
        return this._lockOut(rec, at,
          authorization.reason === 'not-restartable'
            ? (rec.label + ' is not restartable; no recovery attempted')
            : ('restart budget exhausted for ' + rec.label + ' (' + authorization.reason + ')'),
          wasState, authorization.reason === 'not-restartable' ? EVENT.RESTART_FAILED : EVENT.BUDGET_EXHAUSTED);
      }
      const delay = this.backoffFor(id, at);
      rec.backoffMs = delay;
      rec.nextAttemptAt = at + delay;
      rec.lastTrigger = p.trigger || rec.lastTrigger;
      setState(RECOVERY_STATE.RECOVERING);
      return {
        state: rec.state, event: event, action: 'retry', inMs: delay,
        remaining: authorization.remaining, reason: rec.lastFailureReason, previous: wasState
      };
    }

    /* The two liveness signals. They share one body because they differ only in
       what they record and how they word the reason — and sharing it is what
       stops "crash recovery" and "health recovery" from acquiring different
       budgets by accident. */
    if (event === EVENT.PROCESS_EXIT || event === EVENT.HEALTH_FAIL) {
      const isExit = event === EVENT.PROCESS_EXIT;
      if (isExit) {
        rec.lastExitCode = p.code === undefined || p.code === null ? null : Number(p.code);
        rec.lastExitSignal = p.signal ? String(p.signal).slice(0, 24) : null;
      } else {
        rec.healthFailStreak += 1;
      }
      /* A single failed probe is not a failure — a service under load, or one
         that is still warming up, answers late. Requiring a streak is why a slow
         probe cannot restart a working component. */
      if (!isExit && rec.healthFailStreak < this.policy.healthFailStreak) {
        setState(wasState === RECOVERY_STATE.STARTING ? RECOVERY_STATE.STARTING : wasState);
        return {
          state: rec.state, event: event, action: 'none',
          reason: 'health-fail-streak ' + rec.healthFailStreak + '/' + this.policy.healthFailStreak,
          streak: rec.healthFailStreak, previous: wasState
        };
      }
      if (isExit) rec.healthFailStreak = 0;
      rec.consecutiveFailures += 1;
      rec.lastTrigger = isExit
        ? (p.spawnFailed ? TRIGGER.SPAWN_FAILED : TRIGGER.PROCESS_EXIT)
        : TRIGGER.HEALTH_FAIL;
      rec.lastFailureReason = sanitize(isExit
        ? (p.spawnFailed
          ? (rec.label + ' failed to start: ' + (p.reason || 'spawn failed'))
          : (rec.label + ' exited unexpectedly (code=' + (rec.lastExitCode === null ? 'n/a' : rec.lastExitCode) +
            ', signal=' + (rec.lastExitSignal || 'n/a') + ')'))
        : (p.reason || (rec.label + ' stopped answering its health endpoint')), 200);
      rec.lastFailureAt = at;
      rec.failedReason = rec.lastFailureReason;

      if (!restartable) {
        return this._lockOut(rec, at, rec.label + ' is not restartable; no recovery attempted', wasState, event);
      }
      const authorization = this.authorizeAttempt(id, at);
      if (!authorization.allowed) {
        return this._lockOut(rec, at,
          rec.lastFailureReason + ' — restart budget exhausted (' + authorization.reason + ')',
          wasState, EVENT.BUDGET_EXHAUSTED);
      }
      /* The first crash retries immediately (the process is already gone and the
         port is free); later ones are spaced by the backoff. */
      const delay = rec.consecutiveFailures > 1 ? this.backoffFor(id, at) : 0;
      rec.backoffMs = delay;
      rec.nextAttemptAt = delay > 0 ? at + delay : at;
      setState(RECOVERY_STATE.RECOVERING);
      return {
        state: rec.state, event: event, action: 'retry', inMs: delay,
        remaining: authorization.remaining, reason: rec.lastFailureReason, previous: wasState
      };
    }

    /* Unreachable: EVENTS is exhaustive and every value is handled above. Kept
       as a throw rather than a silent no-op so a future event cannot be added
       without deciding what it does. */
    throw new Error('supervisor.handle: unhandled event ' + String(event));
  }

  /* Exhaustion and ineligibility converge here. Both mean "this process will not
     try again by itself", and both set the lockout, so there is no code path
     that reports `failed` while still holding a retry timer. */
  _lockOut(rec, at, reason, wasState, event) {
    rec.lockedOutAt = at;
    rec.nextAttemptAt = null;
    rec.backoffMs = 0;
    rec.failedReason = sanitize(reason, 200);
    rec.lastFailureReason = rec.failedReason;
    rec.lastFailureAt = at;
    if (rec.state !== RECOVERY_STATE.FAILED) {
      rec.state = RECOVERY_STATE.FAILED;
      rec.stateSince = at;
    }
    this._history.push({ at: at, componentId: rec.componentId, event: 'lockout', reason: rec.failedReason });
    return { state: rec.state, event: event || EVENT.BUDGET_EXHAUSTED, action: 'failed', reason: rec.failedReason, previous: wasState };
  }

  /* Called by the runner AFTER it has consumed the decision and actually
     consumed budget (i.e. right before it spawns). Kept separate from `handle`
     so a decision alone cannot burn budget: only real attempts count. */
  noteAttempt(componentId, at) {
    const rec = this._records.get(String(componentId));
    if (!rec) return 0;
    const t = at === undefined ? this._now() : at;
    rec.attemptTimes.push(t);
    /* Bound the stored evidence at the window: the budget is a window, so older
       timestamps can never authorize anything and are dropped. */
    rec.attemptTimes = rec.attemptTimes.filter(ts => t - ts < this.policy.windowMs);
    return this.remainingBudget(componentId, t);
  }

  /* Called by the runner when its own probe proves the component healthy. This
     is the operator-free way out of a lockout, and it deliberately requires
     real health evidence. */
  noteHealthy(componentId, at) {
    const rec = this._records.get(String(componentId));
    if (!rec) return null;
    const t = at === undefined ? this._now() : at;
    const wasLocked = rec.lockedOutAt !== null;
    rec.healthFailStreak = 0;
    rec.consecutiveFailures = 0;
    rec.nextAttemptAt = null;
    rec.backoffMs = 0;
    rec.lockedOutAt = null;
    rec.failedReason = '';
    if (rec.state !== RECOVERY_STATE.HEALTHY) {
      rec.state = RECOVERY_STATE.HEALTHY;
      rec.stateSince = t;
      rec.lastEvent = 'probe_ok';
      rec.lastEventAt = t;
    }
    if (wasLocked) this._history.push({ at: t, componentId: rec.componentId, event: 'lockout-cleared', reason: 'probe proved healthy' });
    return rec.state;
  }

  /* An operator-driven restart cycle (the control plane, or the runner's own
     startup path) re-arms the component but does NOT wipe its budget: a manual
     restart that keeps failing must still hit the same wall. Only proven health
     resets. */
  noteOperatorRestart(componentId, at) {
    const rec = this._records.get(String(componentId));
    if (!rec) return null;
    const t = at === undefined ? this._now() : at;
    rec.nextAttemptAt = null;
    rec.backoffMs = 0;
    rec.state = RECOVERY_STATE.STARTING;
    rec.stateSince = t;
    rec.lastEvent = 'operator_restart';
    rec.lastEventAt = t;
    return rec.state;
  }

  stateOf(componentId) {
    const rec = this._records.get(String(componentId));
    return rec ? rec.state : null;
  }

  snapshot() {
    const out = {};
    for (const rec of this._records.values()) out[rec.componentId] = this.describe(rec.componentId);
    return out;
  }

  /* ── Observability ─────────────────────────────────────────────────────
   *
   * Allowlisted view of one component's recovery state. Exactly the four fields
   * the phase contract requires, plus the bounded-policy evidence needed to
   * explain them (attempts used, when the next retry is, why it locked out).
   * `attemptTimes` (absolute timestamps) stays internal. */
  describe(componentId) {
    const rec = this._records.get(String(componentId));
    if (!rec) return null;
    const at = this._now();
    const view = {
      schema: 'internalbeyond.component-recovery',
      version: 1,
      componentId: rec.componentId,
      recoveryState: rec.state,
      restartCount: rec.restartCount,
      lastRestartAt: rec.lastRestartAt,
      lastFailureReason: rec.lastFailureReason || null,
      attemptsInWindow: this.attemptsInWindow(rec.componentId, at),
      maxAttempts: this.policy.maxAttempts,
      nextAttemptAt: rec.nextAttemptAt,
      backoffMs: rec.backoffMs,
      lockedOut: rec.lockedOutAt !== null,
      consecutiveFailures: rec.consecutiveFailures,
      stateSince: rec.stateSince,
      lastEvent: rec.lastEvent
    };
    /* Exit evidence only exists once a process actually ended. A null `exitCode`
       is a real value (spawn refused before a process existed) and must not be
       confused with "no exit observed", so it is only reported after an exit. */
    if (rec.lastEvent === EVENT.PROCESS_EXIT || rec.lastExitCode !== null || rec.lastExitSignal !== null) {
      view.lastExitCode = rec.lastExitCode;
      view.lastExitSignal = rec.lastExitSignal;
    }
    if (rec.lastFailureAt !== null) view.lastFailureAt = rec.lastFailureAt;
    if (rec.lastTrigger) view.lastTrigger = rec.lastTrigger;
    if (rec.state === RECOVERY_STATE.FAILED && rec.failedReason) view.failedReason = rec.failedReason;
    return view;
  }

  /* Merge a recovery view into a component report produced by the registry.
     Written here (not in the registry) so the registry stays a pure static model
     with no knowledge of recovery, and so every key this adds is allowlisted in
     one place. The four contract fields are ALWAYS present — a consumer must
     never have to guess whether "no restarts yet" means 0 or absent.
     A component the supervisor has no record for reports `recoveryState: null`
     and not `stopped`: this supervisor does not manage it, so it has no answer,
     and "unmanaged" must not be dressed up as "known to be down". */
  decorate(report) {
    const r = report || {};
    const view = this.describe(r.id);
    r.recoveryState = view ? view.recoveryState : null;
    r.restartCount = view ? view.restartCount : null;
    r.lastRestartAt = view ? view.lastRestartAt : null;
    r.lastFailureReason = view ? view.lastFailureReason : null;
    if (view) {
      r.recoveryAttempts = view.attemptsInWindow;
      r.recoveryMaxAttempts = view.maxAttempts;
      r.recoveryNextAttemptAt = view.nextAttemptAt;
      r.recoveryLockedOut = view.lockedOut;
      r.recoveryLastEvent = view.lastEvent;
      if (view.failedReason) r.recoveryFailedReason = view.failedReason;
      if (view.lastTrigger) r.recoveryTrigger = view.lastTrigger;
    }
    return r;
  }

  /* Recent lockout/clear history: what actually happened, in order, for a
     diagnostics view that must not have to reconstruct it from counters. */
  history() { return this._history.slice(-50); }
}

module.exports = {
  SCHEMA: 'internalbeyond.component-supervisor',
  VERSION: 1,
  RECOVERY_STATE: RECOVERY_STATE,
  STATES: STATES,
  EVENT: EVENT,
  EVENTS: EVENTS,
  TRIGGER: TRIGGER,
  DEFAULT_POLICY: DEFAULT_POLICY,
  HARD_MAX_ATTEMPTS: HARD_MAX_ATTEMPTS,
  normalizePolicy: normalizePolicy,
  sanitize: sanitize,
  Supervisor: Supervisor
};
