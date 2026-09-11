package com.internalbeyond.mobile

import com.internalbeyond.mobile.data.api.ApiResult
import com.internalbeyond.mobile.data.api.DeltaKind
import com.internalbeyond.mobile.data.api.HomeNodeClient
import com.internalbeyond.mobile.data.api.HomeNodeEndpoint
import com.internalbeyond.mobile.data.api.PairingParse
import com.internalbeyond.mobile.data.api.PairingPayloadParser
import com.internalbeyond.mobile.data.api.StreamEvent
import com.internalbeyond.mobile.data.cache.CacheSchema
import com.internalbeyond.mobile.data.repository.PairingResult
import com.internalbeyond.mobile.domain.model.ConnectionState
import com.internalbeyond.mobile.platform.IbLog
import com.internalbeyond.mobile.support.TestRig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runners.MethodSorters
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Integration · the REAL Home Node (`services/home-node-service.js`), Phase 36.
 *
 * This is M1-C's acceptance evidence. It spawns the actual Node service with a temp
 * data directory and a random port, points a real OpenAI-compatible SSE mock provider
 * at it, publishes a character catalog through the desktop admin surface, and then
 * drives the SAME production classes the app uses — [HomeNodeClient],
 * `SessionRepository`, `ConversationSession`, `SyncEngine`, `LocalCache` — through the
 * whole journey:
 *
 * ```
 * pair → character.list → chat.history → chat.send → streaming deltas
 *      → disconnect mid-generation → resume → sync.changes
 *      → retry the same requestId → presence → revoke → DEVICE_REVOKED
 * ```
 *
 * The client is not a stand-in: it is the code that ships in the APK. What this file
 * does NOT cover is the Android platform layer (Keystore, SQLite, Compose); the
 * Keystore's sealing logic, the SQL and the state machines are covered on the JVM by
 * the other test classes, and the APK build covers the rest.
 *
 * Requirement: Node.js on PATH (this repository is a Node application). If it is
 * missing, the test FAILS loudly rather than skipping — a silently skipped acceptance
 * test is worse than no test at all.
 */
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class HomeNodeIntegrationTest {

    @Test
    fun a01_the_service_is_the_canonical_chat_authority() {
        val health = adminGet("/health")
        assertEquals(200, health.status)
        val body = JSONObject(health.body)
        assertTrue(body.optBoolean("ok"))
        assertEquals("internal-beyond-home-node", body.optString("service"))
    }

    @Test
    fun a02_the_desktop_publishes_a_catalog_without_leaking_credentials() {
        val publish = adminPost("/characters/publish", JSONObject().put("characters", catalogJson()))
        assertEquals(publish.body, 200, publish.status)
        val payload = JSONObject(publish.body).getJSONObject("payload")
        assertEquals(3, payload.optInt("count"))
        assertEquals("every character must have a runnable spec", 3, payload.optInt("withSpec"))
        assertFalse("the publish response must not echo an apiKey", publish.body.contains("sk-SECRET"))
    }

    @Test
    fun a03_pairing_issues_a_credential_and_the_session_verifies_it() = runBlocking {
        val session = adminPost(
            "/pairing/session",
            JSONObject().put("deviceName", "Kotlin Test").put("deviceType", "android"),
        )
        assertEquals(200, session.status)
        val payloadJson = JSONObject(session.body).getJSONObject("payload")

        val parsed = PairingPayloadParser.parse(payloadJson.toString())
        assertTrue("payload did not parse: $parsed", parsed is PairingParse.Ok)
        val payload = (parsed as PairingParse.Ok).payload
        assertTrue("the pairing secret must be high entropy", payload.secret.length >= 32)
        assertTrue("pairing must carry a TTL", (payload.ttlMs ?: 0) > 0)
        assertEquals("a loopback bind must say so", false, payload.lanReachable)
        assertNull(
            "a loopback-only node must not hand out an address that cannot work",
            payload.endpoint,
        )

        val repository = rig.sessionRepository()
        // A brand-new device: no session, no credential (Phase 9).
        assertEquals(ConnectionState.Unpaired, repository.state.value)

        // The Node is bound to loopback, so its payload honestly reports
        // lanReachable=false with no host. A client on the same machine therefore
        // types the address — which is exactly what the pairing screen's override
        // field is for, so this is the real path, not a shortcut.
        val result = repository.pair(payloadJson.toString(), "127.0.0.1:$nodePort", "Kotlin Test")
        assertTrue("pairing failed: $result", result is PairingResult.Success)

        val state = repository.state.value
        assertTrue("expected Connected, got $state", state is ConnectionState.Connected)
        val node = (state as ConnectionState.Connected).node
        assertTrue("deviceId must be a dev_ identity", node.deviceId.startsWith("dev_"))
        assertTrue("the node fingerprint must round-trip", node.nodeFingerprint.isNotEmpty())
        assertEquals(1, node.protocol)
        pairedDeviceId = node.deviceId
    }

    @Test
    fun a03b_a_restarted_app_reconnects_with_the_stored_credential() = runBlocking {
        val restarted = rig.restartedSessionRepository()

        // Nothing in memory: the state comes purely from what is on disk (the sealed
        // credential plus the non-secret session record), with no network involved.
        val booted = restarted.boot()
        assertTrue("expected Connected after a restart, got $booted", booted is ConnectionState.Connected)
        assertEquals(
            "the same device must come back",
            pairedDeviceId,
            (booted as ConnectionState.Connected).node.deviceId,
        )
        assertEquals(nodePort, booted.node.endpoint.port)

        // ...and the Home Node still accepts that credential.
        assertNull(restarted.verify())
        assertTrue(restarted.state.value is ConnectionState.Connected)
    }

    @Test
    fun a04_character_list_exposes_display_identity_and_nothing_secret() = runBlocking {
        // Through the repository, so this also proves the cache is filled from the node.
        val error = rig.characters.refresh()
        assertNull("character.list failed: ${error?.code} ${error?.message}", error)

        val state = rig.characters.state.value
        assertEquals(3, state.characters.size)
        assertFalse("a fresh answer is not from the cache", state.fromCache)

        val first = state.characters.first { it.id == CHARACTER_ID }
        assertEquals("小满", first.name)
        assertEquals("同桌", first.relationship)
        assertEquals("xiaoman", first.handle)
        assertEquals("喜欢下雨天", first.bio)
        assertTrue(first.capabilities.vision)
        assertTrue(first.capabilities.imageGen)
        assertTrue(first.capabilities.stream)

        // The mobile DTO is the whole story: no field exists that could carry a
        // provider credential, so nothing here can leak one.
        val serialized = com.internalbeyond.mobile.data.api.DtoCodec.characterToJson(first).toString()
        assertFalse(serialized.contains("sk-"))
        assertFalse(serialized.contains("HIDDEN-SYSTEM-PROMPT"))
        assertFalse(serialized.contains("127.0.0.1"))
    }

    @Test
    fun a05_a_send_streams_and_the_canonical_message_is_read_back() = runBlocking {
        val session = rig.session()
        val error = session.sendAndAwait("你好呀")
        assertNull("send failed: ${error?.code} ${error?.message}", error)

        val attempt = rig.cache.attemptsFor(CHARACTER_ID).single()
        assertEquals("the streamed content must have been consumed", "你好", attempt.partialText)
        assertTrue("reasoning frames must not be discarded", attempt.reasoningText.isNotEmpty())
        lastRequestId = attempt.requestId
        lastUserMessageId = attempt.userMessageId ?: ""
        lastAssistantMessageId = attempt.assistantMessageId ?: ""
        assertTrue(lastUserMessageId.isNotEmpty())
        assertTrue(lastAssistantMessageId.isNotEmpty())

        assertNull("history must still be readable after a send", session.refreshNewest())
        val messages = rig.cache.messages(CONVERSATION_ID, 10)
        assertEquals(2, messages.size)
        assertEquals("user", messages[0].role)
        assertEquals("你好呀", messages[0].content)
        assertEquals("assistant", messages[1].role)
        assertEquals("你好", messages[1].content)
        assertEquals("mock-model", messages[1].metadata["model_id"])
    }

    @Test
    fun a05b_history_paginates_with_the_m1a_keyset_anchor() = runBlocking {
        // Two messages exist in this conversation by now, so a page size of one
        // exercises the real anchors rather than a single full page.
        val newest = rig.client.chatHistory(CHARACTER_ID, limit = 1)
        assertTrue(newest is ApiResult.Ok)
        val first = (newest as ApiResult.Ok).value
        assertEquals(1, first.count)
        assertNotNull("a page must carry its continuation anchor", first.olderAnchor)
        assertTrue("there is an older message, and the node says so", first.hasOlder)

        val older = rig.client.chatHistory(CHARACTER_ID, limit = 1, cursor = first.olderAnchor)
        assertTrue(older is ApiResult.Ok)
        val second = (older as ApiResult.Ok).value
        assertEquals(1, second.count)
        assertTrue(
            "the second page must be a DIFFERENT, older message",
            second.messages.single().id != first.messages.single().id,
        )
        assertTrue(
            "pages must move backwards in time",
            second.messages.single().timestamp <= first.messages.single().timestamp,
        )
        assertFalse("the oldest message has nothing before it", second.hasOlder)
        assertEquals(
            "both pages belong to the same conversation",
            first.conversationId,
            second.conversationId,
        )

        // Reading history is not a write: the store is unchanged.
        assertEquals(2, historyCount(CHARACTER_ID))
    }

    @Test
    fun a06_retrying_the_same_requestId_does_not_generate_again() {
        val callsBefore = providerCallCount()
        val historyBefore = historyCount(CHARACTER_ID)

        val retry = mobilePost(
            "/chat/send",
            JSONObject()
                .put("v", 1)
                .put("requestId", lastRequestId)
                .put("payload", JSONObject().put("characterId", CHARACTER_ID).put("content", "你好呀")),
        )
        assertEquals(200, retry.status)
        val payload = JSONObject(retry.body).getJSONObject("payload")
        assertTrue("a repeated requestId must be reported as a duplicate", payload.optBoolean("duplicateRequest"))
        assertEquals("the same user message must be reused", lastUserMessageId, payload.optString("userMessageId"))
        assertEquals(
            "the same assistant message must be reused",
            lastAssistantMessageId,
            payload.getJSONObject("result").optString("assistantMessageId"),
        )

        Thread.sleep(400)
        assertEquals("the model must not be called a second time", callsBefore, providerCallCount())
        assertEquals("no second message may be stored", historyBefore, historyCount(CHARACTER_ID))
    }

    @Test
    fun a07_disconnect_mid_generation_is_not_a_failure_and_resumes() = runBlocking {
        var turnId: String? = null
        var lastSequence = 0
        var contentDeltasSeen = 0
        val requestId = "req_kotlin_slow_0001"

        // Read the slow character's stream, then walk away after two content deltas.
        rig.client.sendStream(requestId, SLOW_CHARACTER_ID, "慢慢说")
            .takeWhile { event ->
                if (event is StreamEvent.Delta && event.kind == DeltaKind.CONTENT) {
                    contentDeltasSeen++
                    contentDeltasSeen <= 2
                } else {
                    true
                }
            }
            .collect { event ->
                when (event) {
                    is StreamEvent.Start -> turnId = event.started.status.turnId
                    is StreamEvent.Delta -> lastSequence = maxOf(lastSequence, event.sequence)
                    else -> Unit
                }
            }

        assertNotNull("chat.start must arrive before the first delta", turnId)
        assertTrue("we must have disconnected mid-generation", contentDeltasSeen >= 2)

        // The turn keeps running on the Home Node while nobody is listening.
        Thread.sleep(1500)

        val done = withContext(Dispatchers.IO) {
            rig.client.openTurnStream(turnId!!, lastSequence)
                .filterIsInstance<StreamEvent.Done>()
                .first()
        }
        assertEquals(
            "generation continued while the client was away",
            "ABCDE",
            done.done.message?.content ?: "",
        )
        assertTrue((done.done.revision ?: 0L) >= 2L)

        val status = rig.client.turnsGet(turnId!!)
        assertTrue(status is ApiResult.Ok)
        assertEquals("done", (status as ApiResult.Ok).value.status)

        // The same status is reachable by requestId alone — which is what the app uses
        // when it never learned the turnId (process death before chat.start).
        val byRequest = rig.client.turnsGet(requestId)
        assertTrue(byRequest is ApiResult.Ok)
        assertEquals(turnId, (byRequest as ApiResult.Ok).value.turnId)
    }

    @Test
    fun a08_sync_walks_the_change_log_from_a_cursor() = runBlocking {
        val fromZero = rig.client.syncChanges(0)
        assertTrue(fromZero is ApiResult.Ok)
        val page = (fromZero as ApiResult.Ok).value
        assertTrue("every message written so far must be replayable", page.upserts.size >= 4)
        assertTrue(page.revision >= page.cursor)
        assertTrue(page.upserts.all { it.id.isNotEmpty() && it.conversationId.isNotEmpty() })

        val drained = rig.sync.run(rig.endpointForDisplay().key)
        assertTrue(drained is ApiResult.Ok)
        val outcome = (drained as ApiResult.Ok).value
        assertEquals("the cache cursor must end at the node revision", page.revision, outcome.cursor)
        assertTrue(rig.cache.messages(CONVERSATION_ID, 50).size >= 2)

        val empty = rig.client.syncChanges(outcome.cursor)
        assertTrue(empty is ApiResult.Ok)
        val emptyPage = (empty as ApiResult.Ok).value
        assertTrue(emptyPage.upserts.isEmpty())
        assertTrue(emptyPage.deletes.isEmpty())
    }

    @Test
    fun a09_presence_carries_only_appForeground() = runBlocking {
        val report = rig.client.presenceReport(true)
        assertTrue(report is ApiResult.Ok)
        assertTrue((report as ApiResult.Ok).value > 0L)

        val presence = rig.client.presence()
        assertTrue(presence is ApiResult.Ok)
        val entries = (presence as ApiResult.Ok).value
        assertTrue("the reporting device must appear", entries.any { it.deviceId == pairedDeviceId })
        val mine = entries.first { it.deviceId == pairedDeviceId }
        assertTrue("appForeground must be persisted, not merely echoed", mine.appForeground)
        assertTrue(mine.lastSeenAt > 0L)
    }

    @Test
    fun a10_offline_startup_still_serves_the_cache() = runBlocking {
        // A client pointed at a dead address is the "phone on the wrong network" case.
        val deadClient = HomeNodeClient(
            endpointProvider = { HomeNodeEndpoint("http", "127.0.0.1", deadPort) },
            tokenProvider = { "ibd1_" + "x".repeat(40) },
        )
        val failure = deadClient.characterList()
        assertTrue("an unreachable node must produce a transport error", failure is ApiResult.Err)
        assertTrue("...which is retryable", (failure as ApiResult.Err).error.retryable)

        // Meanwhile the cache still carries the UI: the character list is served from
        // disk, and the history is still readable, with no node involved.
        val cached = rig.characters.loadCached()
        assertTrue("the cached catalog must survive an offline start", cached.characters.isNotEmpty())
        assertTrue(cached.fromCache)
        assertTrue(rig.cache.messages(CONVERSATION_ID, 10).isNotEmpty())
    }

    @Test
    fun a11_no_credential_or_message_body_reached_the_logs() {
        val logText = logLines.joinToString("\n")
        assertTrue("the log capture must not be empty, or this proves nothing", logText.isNotEmpty())
        assertFalse("device token leaked", logText.contains(rig.holder.token!!))
        assertFalse("api key leaked", logText.contains("sk-SECRET"))
        assertFalse("message body leaked", logText.contains("你好呀"))
        assertFalse("message body leaked", logText.contains("ABCDE"))
        assertFalse("hidden prompt leaked", logText.contains("HIDDEN-SYSTEM-PROMPT"))

        // The Node service's own stdout must be equally clean.
        val nodeOutput = nodeLog.toString()
        assertFalse(nodeOutput.contains(rig.holder.token!!))
        assertFalse(nodeOutput.contains("sk-SECRET-should-never-leak"))
        assertFalse(nodeOutput.contains("你好呀"))
    }

    @Test
    fun a12_revoking_the_device_takes_effect_on_the_very_next_request() {
        val revoke = mobilePost("/device/revoke", JSONObject().put("v", 1).put("payload", JSONObject()))
        assertEquals(200, revoke.status)

        val after = mobileGet("/character/list")
        assertEquals(403, after.status)
        assertEquals("DEVICE_REVOKED", JSONObject(after.body).getJSONObject("error").optString("code"))

        // The app must then discard the credential and return to pairing (Phase 24).
        runBlocking { rig.sessionRepository().verify() }
        val state = rig.sessionRepository().state.value
        assertTrue("expected Revoked, got $state", state is ConnectionState.Revoked)
    }

    // ── harness ──────────────────────────────────────────────────────────────

    companion object {
        private const val CHARACTER_ID = "friend_test_a"
        private const val SLOW_CHARACTER_ID = "friend_test_slow"
        private const val CONVERSATION_ID = "dm:friend_test_a"
        private const val ADMIN_TOKEN = "kotlin-integration-admin-token"
        private const val SLOW_MODEL = "slow-model"

        private lateinit var repoRoot: Path
        private lateinit var dataDir: Path
        private lateinit var rig: TestRig
        private lateinit var nodeLog: StringBuilder
        private var node: Process? = null
        private var provider: MockWebServer? = null
        private var nodePort = 0
        private var deadPort = 0
        private var lastRequestId = ""
        private var lastUserMessageId = ""
        private var lastAssistantMessageId = ""
        private var pairedDeviceId = ""
        private val providerCalls = AtomicInteger(0)
        private val logLines = java.util.Collections.synchronizedList(mutableListOf<String>())

        private val http = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()

        @BeforeClass
        @JvmStatic
        fun startEverything() {
            IbLog.enabled = true
            IbLog.sink = IbLog.recordingSink(logLines)

            repoRoot = findRepoRoot()
            dataDir = Files.createTempDirectory("ib-kotlin-home-node-")
            nodePort = freePort()
            deadPort = freePort()

            provider = startMockProvider()
            startNodeService()

            val dbPath = Files.createTempFile("ib-integration-", ".db").toString()
            rig = TestRig(dbPath, realBaseUrl = "http://127.0.0.1:$nodePort")
            CacheSchema.create(rig.db)
        }

        @AfterClass
        @JvmStatic
        fun stopEverything() {
            runCatching { node?.destroy() }
            runCatching { node?.waitFor(5, TimeUnit.SECONDS) }
            runCatching { node?.destroyForcibly() }
            runCatching { provider?.shutdown() }
            runCatching { rig.close() }
            runCatching { dataDir.toFile().deleteRecursively() }
        }

        private fun findRepoRoot(): Path {
            var dir: Path? = Paths.get(System.getProperty("user.dir")).toAbsolutePath()
            while (dir != null) {
                if (Files.exists(dir.resolve("services").resolve("home-node-service.js"))) return dir
                dir = dir.parent
            }
            throw IllegalStateException(
                "Could not find services/home-node-service.js above ${System.getProperty("user.dir")}. " +
                    "This integration test must run from inside the InternalBeyond repository.",
            )
        }

        private fun freePort(): Int = ServerSocket(0).use { it.localPort }

        /**
         * An OpenAI-compatible SSE provider.
         *
         * The fast model answers immediately; [SLOW_MODEL] is throttled so that a
         * generation is genuinely still in flight when the client walks away —
         * which is the situation Phase 19 is about.
         */
        private fun startMockProvider(): MockWebServer {
            val server = MockWebServer()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    providerCalls.incrementAndGet()
                    val bodyText = request.body.readUtf8()
                    val slow = bodyText.contains(SLOW_MODEL)
                    val response = MockResponse()
                        .setResponseCode(200)
                        .setHeader("Content-Type", "text/event-stream; charset=utf-8")
                        .setBody(sseBody(slow))
                    return if (slow) response.throttleBody(40, 100, TimeUnit.MILLISECONDS) else response
                }
            }
            server.start()
            return server
        }

        private fun sseBody(slow: Boolean): String {
            val out = StringBuilder()
            fun frame(payload: JSONObject) {
                out.append("data: ").append(payload).append("\n\n")
            }
            frame(
                JSONObject().put(
                    "choices",
                    JSONArray().put(JSONObject().put("delta", JSONObject().put("reasoning_content", "想"))),
                ),
            )
            val letters = if (slow) listOf("A", "B", "C", "D", "E") else listOf("你", "好")
            for (letter in letters) {
                frame(
                    JSONObject().put(
                        "choices",
                        JSONArray().put(JSONObject().put("delta", JSONObject().put("content", letter))),
                    ),
                )
            }
            frame(
                JSONObject().put(
                    "choices",
                    JSONArray().put(JSONObject().put("delta", JSONObject()).put("finish_reason", "stop")),
                ),
            )
            out.append("data: [DONE]\n\n")
            return out.toString()
        }

        private fun providerCallCount(): Int = providerCalls.get()

        private fun startNodeService() {
            val executable = resolveNodeExecutable()
            val process = ProcessBuilder(executable, "services/home-node-service.js")
                .directory(repoRoot.toFile())
                .apply {
                    environment()["IB_HOME_NODE_PORT"] = nodePort.toString()
                    environment()["IB_HOME_NODE_HOST"] = "127.0.0.1"
                    environment()["IB_HOME_NODE_DATA_DIR"] = dataDir.toString()
                    environment()["IB_HOME_NODE_TOKEN"] = ADMIN_TOKEN
                }
                .start()

            val log = StringBuilder()
            nodeLog = log
            for (stream in listOf(process.inputStream, process.errorStream)) {
                Thread {
                    runCatching {
                        stream.bufferedReader(StandardCharsets.UTF_8).forEachLine { line ->
                            synchronized(log) { log.append(line).append('\n') }
                        }
                    }
                }.apply { isDaemon = true }.start()
            }

            val deadline = System.currentTimeMillis() + 25_000
            while (System.currentTimeMillis() < deadline) {
                val health = runCatching { adminGet("/health") }.getOrNull()
                if (health != null && health.status == 200) {
                    node = process
                    return
                }
                Thread.sleep(200)
            }
            throw IllegalStateException(
                "the Home Node did not become healthy: ${log.toString().takeLast(1500)}",
            )
        }

        private fun resolveNodeExecutable(): String {
            System.getenv("IB_NODE")?.takeIf { it.isNotBlank() }?.let { return it }
            val ok = runCatching {
                ProcessBuilder("node", "--version").redirectErrorStream(true).start()
                    .let { it.waitFor(15, TimeUnit.SECONDS) && it.exitValue() == 0 }
            }.getOrDefault(false)
            if (!ok) {
                throw IllegalStateException(
                    "Node.js was not found. This integration test drives the real Home Node and " +
                        "needs `node` on PATH (or IB_NODE set to its full path).",
                )
            }
            return "node"
        }

        private fun catalogJson(): JSONArray {
            val endpoint = "http://127.0.0.1:${provider!!.port}/v1/chat/completions"
            fun entry(id: String, nickname: String, model: String) = JSONObject()
                .put("id", id)
                .put("nickname", nickname)
                .put("avatar", "data:image/png;base64,AAAA")
                .put("relationship", if (id == CHARACTER_ID) "同桌" else "")
                .put("handle", if (id == CHARACTER_ID) "xiaoman" else "")
                .put("signature", "今天也要开心")
                .put("bio", "喜欢下雨天")
                .put("model", model)
                .put("provider", "custom")
                .put("endpoint", endpoint)
                .put("apiKey", "sk-SECRET-should-never-leak")
                .put("imageGenApiKey", "sk-IMAGEGEN-should-never-leak")
                .put("systemPrompt", "HIDDEN-SYSTEM-PROMPT")
                .put("temperature", 0.7)
                .put("vision", true)
                .put("streaming", true)
                .put("webSearch", false)
                .put("imageGen", true)

            return JSONArray()
                .put(entry(CHARACTER_ID, "小满", "mock-model"))
                .put(entry("friend_test_b", "阿遥", "mock-model"))
                .put(entry(SLOW_CHARACTER_ID, "慢慢", SLOW_MODEL))
        }

        // ── raw HTTP: as the desktop (admin) and as a plain mobile client ─────

        data class HttpResult(val status: Int, val body: String)

        private fun call(url: String, method: String, body: JSONObject?, headers: Map<String, String>): HttpResult {
            val builder = Request.Builder().url(url)
            for ((key, value) in headers) builder.header(key, value)
            if (body != null) {
                builder.method(method, body.toString().toRequestBody("application/json".toMediaType()))
            } else {
                builder.method(method, null)
            }
            http.newCall(builder.build()).execute().use { response ->
                return HttpResult(response.code, response.body?.string() ?: "")
            }
        }

        private fun adminGet(path: String) =
            call("http://127.0.0.1:$nodePort$path", "GET", null, mapOf("X-IB-Home-Token" to ADMIN_TOKEN))

        private fun adminPost(path: String, body: JSONObject) =
            call("http://127.0.0.1:$nodePort$path", "POST", body, mapOf("X-IB-Home-Token" to ADMIN_TOKEN))

        private fun mobileGet(path: String) = call(
            "http://127.0.0.1:$nodePort/mobile/v1$path",
            "GET",
            null,
            mapOf("Authorization" to "Bearer ${rig.holder.token}"),
        )

        private fun mobilePost(path: String, body: JSONObject) = call(
            "http://127.0.0.1:$nodePort/mobile/v1$path",
            "POST",
            body,
            mapOf("Authorization" to "Bearer ${rig.holder.token}"),
        )

        private fun historyCount(characterId: String): Int {
            val result = mobileGet("/chat/history?characterId=$characterId&limit=50")
            return JSONObject(result.body).getJSONObject("payload").optInt("count")
        }
    }
}
