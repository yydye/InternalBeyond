package com.internalbeyond.mobile.app

import android.app.Application
import android.util.Log
import com.internalbeyond.mobile.BuildConfig
import com.internalbeyond.mobile.platform.IbLog
import kotlinx.coroutines.launch

/**
 * Process-level wiring.
 *
 * Two jobs, both about things that must exist before any screen:
 *
 * 1. **Install the log sink.** Debug builds log a bounded set of named fields;
 *    release builds install nothing at all. [IbLog] redacts anything credential-
 *    shaped before it reaches the sink, so a careless call site cannot leak a token
 *    into logcat even in a debug build (Phase 35).
 * 2. **Track foreground/background** through activity lifecycle callbacks rather
 *    than a ProcessLifecycleOwner dependency: the app needs exactly one bit, and
 *    nothing more than that bit is ever reported to the Home Node (Phase 22).
 */
class IbApplication : Application(), Application.ActivityLifecycleCallbacks {

    lateinit var graph: AppGraph
        private set

    private var startedActivities = 0
    private var lastForeground: Boolean? = null

    override fun onCreate() {
        super.onCreate()
        installLogging()
        graph = AppGraph(this)
        graph.boot()
        registerActivityLifecycleCallbacks(this)
        resumePendingTurns()
    }

    /**
     * Phase 21: pick up sends that were in flight when the process died, without
     * waiting for the user to open the conversation. Nothing is marked failed —
     * each attempt is probed and either resumed or resynced.
     */
    private fun resumePendingTurns() {
        if (graph.session.state.value !is com.internalbeyond.mobile.domain.model.ConnectionState.Connected) return
        graph.appScope.launch {
            for (session in graph.chat.sessionsWithOpenAttempts()) {
                session.resumeOpenAttemptsNow()
            }
        }
    }

    private fun installLogging() {
        IbLog.enabled = BuildConfig.DEBUG
        if (!BuildConfig.DEBUG) return
        IbLog.sink = IbLog.Sink { level, event, fields ->
            val line = buildString {
                append(event)
                if (fields.isNotEmpty()) {
                    append(' ')
                    append(fields.entries.joinToString(" ") { "${it.key}=${it.value}" })
                }
            }
            Log.println(level.toPriority(), LOG_TAG, line)
        }
    }

    private fun IbLog.Level.toPriority(): Int = when (this) {
        IbLog.Level.DEBUG -> Log.DEBUG
        IbLog.Level.INFO -> Log.INFO
        IbLog.Level.WARN -> Log.WARN
        IbLog.Level.ERROR -> Log.ERROR
    }

    override fun onActivityStarted(activity: android.app.Activity) {
        startedActivities++
        reportForeground(true)
    }

    override fun onActivityStopped(activity: android.app.Activity) {
        startedActivities = (startedActivities - 1).coerceAtLeast(0)
        if (startedActivities == 0) reportForeground(false)
    }

    private fun reportForeground(foreground: Boolean) {
        if (lastForeground == foreground) return
        lastForeground = foreground
        graph.session.reportPresence(foreground)
        // Coming back to the foreground is a good moment to retry a deferred recovery
        // and to drain any changes that happened while the phone was idle.
        if (foreground && graph.session.state.value is com.internalbeyond.mobile.domain.model.ConnectionState.Connected) {
            graph.appScope.launch {
                graph.sync.run(graph.nodeKey())
                for (session in graph.chat.sessionsWithOpenAttempts()) {
                    session.resumeOpenAttemptsNow()
                }
            }
        }
    }

    override fun onActivityCreated(activity: android.app.Activity, savedInstanceState: android.os.Bundle?) = Unit
    override fun onActivityResumed(activity: android.app.Activity) = Unit
    override fun onActivityPaused(activity: android.app.Activity) = Unit
    override fun onActivitySaveInstanceState(activity: android.app.Activity, outState: android.os.Bundle) = Unit
    override fun onActivityDestroyed(activity: android.app.Activity) = Unit

    private companion object {
        const val LOG_TAG = "InternalBeyond"
    }
}
