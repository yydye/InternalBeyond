# Companion Active Runtime Contract

**Status: Canonical**
**Scope: Browser ↔ Active service protocol (schedule sync, execution, queue, import/ack)**

> Current-state contract between the browser and the background Active service
> (`services/active-message-service.js`). Sources: `services/active-message-service.js`,
> `active/http.js`, `active/scheduler.js`, `active/plan-domain.js`, and `tests/test_active_http.js` /
> `tests/test_active_plans.js`. Autonomy mechanism (frequency/retry/dedup) is in `AUTONOMY.md`; this
> contract fixes the **protocol and ownership**.

---

## 1. Schedule Ownership

- The **browser owns plans and settings** (`active_message_plans`, `active_message_settings`).
- Only schedules whose `background_enabled` switch is on are synced to the service.
- The service executes synchronized plans; it does not invent schedules.

---

## 2. Execution

```
schedule → plan-domain → character model → validation → dedup / DND → queue
```

- `active/plan-domain.js` owns sanitize, run/message ids, `isInDnd` / `nextDndFree`, and the
  send/reschedule/cancel decision shape.
- `active/scheduler.js` owns the tick, evaluation, and persistence of queue state.
- The character model is called via `active/model-client.js`.

---

## 3. Queue

- The service may **durably queue** generated results (persisted before OS notification).
- Queue entries carry an `acknowledged` flag and are not canonical chat rows.

> queue ≠ canonical chat storage

---

## 4. Import / Acknowledge

```
service result → browser import → browser persistence/delivery → acknowledge
```

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | service health |
| `/proactive/traces`, `/proactive/debug` | GET | observability (no decisions) |
| `/tasks` | GET | task list |
| `/plans` | GET | plan list |
| `/moments` | GET | moments state |
| `/events` | GET | **unacknowledged** events for a user (`user_id`, `limit`) |
| `/events/:id/ack` | POST | acknowledge one event (marks history acked, removes from queue) |
| `/history` | GET / DELETE | history list / clear |
| `/reconcile` | POST | browser declares owned `task_ids` / `plan_ids` / `moment_ids`; service prunes non-declared per user and **arms** the user |
| `/bg-ai` | GET / POST | background-AI toggle |
| `/credentials` | POST | credential provisioning (not Companion-owned) |
| `/economy/propose-purchase` | POST | **Economy** surface, not Companion |

Ownership rules observed in the runtime:

- `/events` returns only the requesting user's unacknowledged events.
- `/events/:id/ack` rejects an event belonging to another user (403).
- `/reconcile` only prunes a set when that set is present in the request (declared ownership);
  **arming is last and process-local** — a failed reconcile never enables scheduling.

---

## 5. Crash / Recovery

The scheduler performs **crash-leftover recovery** and history trimming (`active/scheduler.js` header).
Queue state is persisted so a restart resumes the queue rather than dropping it. No additional
recovery guarantee is claimed here.

---

## 6. Boundary

- The service is an **executor + queue**, not chat storage authority and not message-lifecycle authority.
- The browser remains the authority for plans, chat storage, and delivery.
- Companion has no provider authority; it calls the character model (`active/model-client.js`).

---

## 7. Non-goals

This contract does not define proactive frequency policy, DND windows, dedup thresholds, or delivery
timing (see `AUTONOMY.md` and the proactive interaction contract).

---

## 8. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_active_http.js` | service HTTP surface (events/reconcile/ack behavior) |
| `tests/test_active_plans.js` | plan sync / execution ownership |
| `tests/test_runtime_convergence_proactive.js` | browser↔service convergence (no double-send) |

---

## 9. Historical Origin

`services/active-message-service.js`, `active/*`; mechanism context in `docs/AUTONOMY.md`.
