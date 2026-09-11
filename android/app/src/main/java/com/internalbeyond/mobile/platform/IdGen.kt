package com.internalbeyond.mobile.platform

import java.util.UUID

/**
 * Stable ids generated once and then persisted.
 *
 * The only genuinely important one is the **requestId**: it is the Home Node's
 * idempotency key, so it must be created before the request is sent and reused
 * unchanged by every retry (Phase 15/16/20). It is a UUID rather than a counter
 * because a counter that resets on reinstall would collide with a requestId the
 * Home Node has already recorded.
 */
object IdGen {
    fun requestId(prefix: String = "req"): String =
        prefix + "_" + UUID.randomUUID().toString().replace("-", "")
}
