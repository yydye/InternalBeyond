package com.internalbeyond.mobile.platform

import kotlinx.coroutines.Job
import java.util.concurrent.ConcurrentHashMap

/**
 * Every live turn stream, so that losing the session can actually stop them.
 *
 * Phase 24 requires `DEVICE_REVOKED` to "stop all active streams" immediately, and
 * Phase 23 requires the same when the user disconnects. Without a registry, a
 * stream would keep reading frames until it happened to notice; with one, the
 * cancel is a single call and the socket is closed by the cancellation handler in
 * [com.internalbeyond.mobile.data.api.HomeNodeClient].
 */
class StreamRegistry {

    private val jobs = ConcurrentHashMap<String, Job>()

    fun register(key: String, job: Job) {
        jobs.remove(key)?.cancel()
        jobs[key] = job
    }

    fun unregister(key: String) {
        jobs.remove(key)
    }

    fun cancel(key: String) {
        jobs.remove(key)?.cancel()
    }

    fun cancelAll() {
        for (key in jobs.keys.toList()) {
            jobs.remove(key)?.cancel()
        }
    }

    /** Visible for tests and for the connection indicator. */
    fun activeCount(): Int = jobs.count { !it.value.isCompleted }
}
