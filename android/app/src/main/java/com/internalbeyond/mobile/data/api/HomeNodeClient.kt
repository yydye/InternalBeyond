package com.internalbeyond.mobile.data.api

import com.internalbeyond.mobile.domain.ProtocolError
import com.internalbeyond.mobile.domain.TransportKind
import com.internalbeyond.mobile.domain.model.Character
import com.internalbeyond.mobile.domain.model.DeviceProfile
import com.internalbeyond.mobile.domain.model.HistoryPage
import com.internalbeyond.mobile.domain.model.NodeHandshake
import com.internalbeyond.mobile.domain.model.PresenceEntry
import com.internalbeyond.mobile.domain.model.SyncPage
import com.internalbeyond.mobile.domain.model.TurnStatus
import com.internalbeyond.mobile.platform.IbLog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

data class PairingOutcome(
    val device: DeviceProfile,
    val token: String,
    val tokenType: String,
    val handshake: NodeHandshake,
)

data class CharacterCatalog(
    val characters: List<Character>,
    val catalogUpdatedAt: Long?,
)

data class DeviceSelf(
    val device: DeviceProfile,
    val protocol: Int,
    val serverVersion: String,
    val nodeFingerprint: String,
)

data class TokenRotation(
    val device: DeviceProfile,
    val token: String,
    val tokenType: String,
)

/**
 * The Home Node's mobile API, v1.
 *
 * This is the ONLY place in the app that speaks HTTP. No UI class, ViewModel or
 * repository builds a URL or a JSON envelope (Phase 4) — which is also what makes
 * the whole protocol surface testable against a real Home Node from a plain JVM
 * test (see `HomeNodeClientIntegrationTest`).
 *
 * Every response passes through [Envelope], so the protocol version is validated
 * on the way IN as well as on the way out, and every failure arrives as a
 * [ProtocolError] with the server's code intact.
 */
class HomeNodeClient(
    private val endpointProvider: () -> HomeNodeEndpoint?,
    private val tokenProvider: () -> String?,
    baseClient: OkHttpClient = defaultClient(),
) {

    private val jsonClient: OkHttpClient = baseClient
    private val streamClient: OkHttpClient = baseClient.newBuilder()
        // A turn stream is idle between deltas by design (heartbeat every 15s),
        // so a read deadline would kill healthy streams. The JSON client keeps
        // its deadline; only streams opt out.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    fun endpoint(): HomeNodeEndpoint? = endpointProvider()

    // ── pairing (the only unauthenticated verb) ──────────────────────────────

    /**
     * Exchange a pairing payload for a device credential.
     *
     * [endpoint] is passed in rather than read from the payload: the payload may carry
     * no address at all (a loopback-only Home Node reports none), and the caller may
     * have resolved one from the pairing screen's address override. At pairing time
     * there is nothing stored yet, so this is the only call that takes its own address.
     */
    suspend fun pairingComplete(
        payload: PairingPayload,
        deviceName: String,
        deviceType: String,
        requestId: String,
        endpoint: HomeNodeEndpoint,
    ): ApiResult<PairingOutcome> {
        val body = JSONObject()
            .put("v", Envelope.PROTOCOL_VERSION)
            .put("type", "pairing.complete")
            .put("requestId", requestId)
            .put(
                "payload",
                JSONObject()
                    .put("pairingId", payload.pairingId)
                    .put("secret", payload.secret)
                    .put("deviceName", deviceName)
                    .put("deviceType", deviceType),
            )
        return call(
            endpoint = endpoint,
            method = "POST",
            path = payload.pairPath,
            body = body,
            authed = false,
        ).map { payloadJson ->
            PairingOutcome(
                device = DtoCodec.deviceProfile(payloadJson.objOrNull("device") ?: JSONObject()),
                token = payloadJson.strOrNull("token") ?: "",
                tokenType = payloadJson.strOrNull("tokenType") ?: "Bearer",
                handshake = DtoCodec.handshake(payloadJson.objOrNull("profile") ?: JSONObject()),
            )
        }
    }

    // ── identity ─────────────────────────────────────────────────────────────

    suspend fun handshake(): ApiResult<NodeHandshake> =
        call("GET", "/mobile/v1/handshake").map { DtoCodec.handshake(it) }

    suspend fun deviceSelf(): ApiResult<DeviceSelf> =
        call("GET", "/mobile/v1/device/self").map {
            DeviceSelf(
                device = DtoCodec.deviceProfile(it.objOrNull("device") ?: JSONObject()),
                protocol = it.intOrNull("protocol") ?: 0,
                serverVersion = it.strOrNull("serverVersion") ?: "",
                nodeFingerprint = it.strOrNull("fingerprint") ?: "",
            )
        }

    suspend fun deviceRename(name: String): ApiResult<DeviceProfile> {
        val body = JSONObject()
            .put("v", Envelope.PROTOCOL_VERSION)
            .put("type", "device.rename")
            .put("payload", JSONObject().put("name", name))
        return call("POST", "/mobile/v1/device/rename", body = body)
            .map { DtoCodec.deviceProfile(it.objOrNull("device") ?: JSONObject()) }
    }

    suspend fun deviceRevoke(): ApiResult<DeviceProfile> {
        val body = JSONObject()
            .put("v", Envelope.PROTOCOL_VERSION)
            .put("type", "device.revoke")
            .put("payload", JSONObject())
        return call("POST", "/mobile/v1/device/revoke", body = body)
            .map { DtoCodec.deviceProfile(it.objOrNull("device") ?: JSONObject()) }
    }

    suspend fun deviceTokenRotate(): ApiResult<TokenRotation> {
        val body = JSONObject()
            .put("v", Envelope.PROTOCOL_VERSION)
            .put("type", "device.token.rotate")
            .put("payload", JSONObject())
        return call("POST", "/mobile/v1/device/token/rotate", body = body).map {
            TokenRotation(
                device = DtoCodec.deviceProfile(it.objOrNull("device") ?: JSONObject()),
                token = it.strOrNull("token") ?: "",
                tokenType = it.strOrNull("tokenType") ?: "Bearer",
            )
        }
    }

    // ── characters ───────────────────────────────────────────────────────────

    suspend fun characterList(): ApiResult<CharacterCatalog> =
        call("GET", "/mobile/v1/character/list").map {
            CharacterCatalog(
                characters = it.arrOrNull("characters")?.objects()?.map(DtoCodec::character) ?: emptyList(),
                catalogUpdatedAt = it.longOrNull("catalogUpdatedAt"),
            )
        }

    suspend fun characterGet(id: String): ApiResult<Character> =
        call("GET", "/mobile/v1/character/${encodePathSegment(id)}").map {
            DtoCodec.character(it.objOrNull("character") ?: JSONObject())
        }

    // ── chat ─────────────────────────────────────────────────────────────────

    /**
     * `chat.history` — M1-A's keyset pagination, used verbatim.
     * [cursor] is the `oldest` anchor from the previous page ("load older").
     */
    suspend fun chatHistory(
        characterId: String,
        limit: Int = 50,
        cursor: String? = null,
        threadId: String? = null,
    ): ApiResult<HistoryPage> {
        val query = ArrayList<Pair<String, String>>(4)
        query.add("characterId" to characterId)
        query.add("limit" to limit.toString())
        if (!cursor.isNullOrBlank()) query.add("cursor" to cursor)
        if (!threadId.isNullOrBlank()) query.add("threadId" to threadId)
        return call("GET", "/mobile/v1/chat/history", query = query).map(DtoCodec::historyPage)
    }

    /** `sync.changes` — the canonical cursor is the Home Node revision itself. */
    suspend fun syncChanges(cursor: Long, limit: Int? = null): ApiResult<SyncPage> {
        val query = ArrayList<Pair<String, String>>(2)
        query.add("cursor" to cursor.toString())
        if (limit != null) query.add("limit" to limit.toString())
        return call("GET", "/mobile/v1/sync/changes", query = query).map(DtoCodec::syncPage)
    }

    /** `turns.get` accepts either a turnId or the originating requestId. */
    suspend fun turnsGet(turnIdOrRequestId: String): ApiResult<TurnStatus> =
        call("GET", "/mobile/v1/turns/${encodePathSegment(turnIdOrRequestId)}").map(DtoCodec::turnStatus)

    suspend fun presenceReport(appForeground: Boolean): ApiResult<Long> {
        val body = JSONObject()
            .put("v", Envelope.PROTOCOL_VERSION)
            .put("type", "presence.report")
            .put("payload", JSONObject().put("appForeground", appForeground))
        return call("POST", "/mobile/v1/presence/report", body = body)
            .map { it.longOrNull("lastSeenAt") ?: 0L }
    }

    suspend fun presence(): ApiResult<List<PresenceEntry>> = call("GET", "/mobile/v1/presence").map {
        it.arrOrNull("devices")?.objects()?.map(DtoCodec::presence) ?: emptyList()
    }

    // ── streaming ────────────────────────────────────────────────────────────

    /**
     * Send a message and consume the turn's stream **in the same request**
     * (`Accept: text/event-stream`), which saves a round trip and — more
     * importantly — means the turnId arrives on `chat.start` instead of having to
     * be discovered afterwards.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    fun sendStream(
        requestId: String,
        characterId: String,
        content: String,
        historyLimit: Int = 20,
        threadId: String? = null,
    ): Flow<StreamEvent> {
        val payload = JSONObject()
            .put("characterId", characterId)
            .put("content", content)
            .put("historyLimit", historyLimit)
        if (!threadId.isNullOrBlank()) payload.put("threadId", threadId)
        val body = JSONObject()
            .put("v", Envelope.PROTOCOL_VERSION)
            .put("type", "chat.send")
            .put("requestId", requestId)
            .put("payload", payload)
        val request = buildRequest("POST", "/mobile/v1/chat/send", emptyList(), body, authed = true, acceptSse = true)
        return openStream(request, "chat.send")
    }

    /** Reconnect to a turn (or look it up by requestId) from [after]. */
    @OptIn(ExperimentalCoroutinesApi::class)
    fun openTurnStream(turnIdOrRequestId: String, after: Int): Flow<StreamEvent> {
        val query = if (after > 0) listOf("after" to after.toString()) else emptyList()
        val request = buildRequest(
            "GET",
            "/mobile/v1/chat/stream/${encodePathSegment(turnIdOrRequestId)}",
            query,
            body = null,
            authed = true,
            acceptSse = true,
        )
        return openStream(request, "chat.stream")
    }

    // ── request building ─────────────────────────────────────────────────────

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private fun buildRequest(
        method: String,
        path: String,
        query: List<Pair<String, String>>,
        body: JSONObject?,
        authed: Boolean,
        acceptSse: Boolean = false,
    ): Request? {
        val endpoint = endpointProvider() ?: return null
        return buildRequestFor(endpoint, method, path, query, body, authed, acceptSse)
    }

    private fun buildRequestFor(
        endpoint: HomeNodeEndpoint,
        method: String,
        path: String,
        query: List<Pair<String, String>>,
        body: JSONObject?,
        authed: Boolean,
        acceptSse: Boolean,
    ): Request? {
        val base = endpoint.path(path).toHttpUrlOrNull() ?: return null
        val builder = base.newBuilder()
        for ((key, value) in query) builder.addQueryParameter(key, value)
        val requestBuilder = Request.Builder().url(builder.build())
        if (acceptSse) {
            requestBuilder.header("Accept", "text/event-stream")
        } else {
            requestBuilder.header("Accept", "application/json")
        }
        if (authed) {
            val token = tokenProvider() ?: return null
            requestBuilder.header("Authorization", "Bearer $token")
        }
        val requestBody = body?.toString()?.toRequestBody(jsonMediaType)
        requestBuilder.method(method, requestBody)
        return requestBuilder.build()
    }

    // ── JSON calls ───────────────────────────────────────────────────────────

    private suspend fun call(
        method: String,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: JSONObject? = null,
        authed: Boolean = true,
        endpoint: HomeNodeEndpoint? = endpointProvider(),
    ): ApiResult<JSONObject> {
        val target = endpoint ?: return ApiResult.Err(
            ProtocolError.Local("This app is not connected to a Home Node."),
        )
        if (authed && tokenProvider() == null) {
            return ApiResult.Err(
                ProtocolError.Server(
                    code = ProtocolError.AUTH_REQUIRED,
                    message = "This device has no credential.",
                    retryable = false,
                ),
            )
        }
        val request = buildRequestFor(target, method, path, query, body, authed, acceptSse = false)
            ?: return ApiResult.Err(ProtocolError.Local("The Home Node address is not usable: ${target.display}"))

        IbLog.debug("http.request", IbLog.FIELD_ENDPOINT to target.display, "path" to path, "method" to method)
        val startedAt = System.nanoTime()
        return withContext(Dispatchers.IO) {
            try {
                jsonClient.newCall(request).execute().use { response ->
                    val retryAfterMs = response.header("Retry-After")?.trim()?.toLongOrNull()?.times(1000)
                    val text = response.body?.string() ?: ""
                    val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000
                    IbLog.debug(
                        "http.response",
                        IbLog.FIELD_ENDPOINT to target.display,
                        "path" to path,
                        IbLog.FIELD_STATUS to response.code,
                        IbLog.FIELD_LATENCY_MS to elapsedMs,
                    )
                    if (text.isBlank()) {
                        if (response.isSuccessful) {
                            ApiResult.Ok(JSONObject())
                        } else {
                            ApiResult.Err(
                                Envelope.bareError(response.code, "The Home Node sent an empty body."),
                            )
                        }
                    } else {
                        Envelope.payload(text, response.code, retryAfterMs)
                    }
                }
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                val transport = transportError(error)
                IbLog.warn(
                    "http.failed",
                    IbLog.FIELD_ENDPOINT to target.display,
                    "path" to path,
                    IbLog.FIELD_CODE to transport.code,
                )
                ApiResult.Err(transport)
            }
        }
    }

    // ── SSE ──────────────────────────────────────────────────────────────────

    @OptIn(ExperimentalCoroutinesApi::class)
    private fun openStream(request: Request?, label: String): Flow<StreamEvent> = callbackFlow {
        if (request == null) {
            send(StreamEvent.Failure(noCredentialOrAddress(), 0))
            close()
            return@callbackFlow
        }
        val call = streamClient.newCall(request)
        val parser = SseParser()
        val startedAt = System.nanoTime()
        IbLog.debug("stream.open", "label" to label, "url" to (request.url.encodedPath))

        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                emitBlocking(StreamEvent.StreamProblem(transportError(e), resync = false))
                close()
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { res ->
                    val contentType = res.header("Content-Type") ?: ""
                    if (res.code != 200 || !contentType.contains("text/event-stream")) {
                        // The server answers a failed send with a JSON envelope even
                        // when the request asked for a stream. Surface it as the
                        // turn's terminal failure so the caller has one code path.
                        val text = res.body?.string() ?: ""
                        val retryAfterMs = res.header("Retry-After")?.trim()?.toLongOrNull()?.times(1000)
                        val error = when (val parsed = Envelope.payload(text, res.code, retryAfterMs)) {
                            is ApiResult.Err -> parsed.error
                            is ApiResult.Ok -> ProtocolError.Response(
                                "The Home Node answered HTTP ${res.code} with " +
                                    "Content-Type \"$contentType\" where a stream was expected.",
                                res.code,
                            )
                        }
                        emitBlocking(StreamEvent.Failure(error, 0))
                        close()
                        return
                    }
                    val source = res.body?.source()
                    if (source == null) {
                        emitBlocking(
                            StreamEvent.StreamProblem(
                                ProtocolError.Response("The stream had no body.", res.code),
                                resync = false,
                            ),
                        )
                        close()
                        return
                    }
                    val buffer = Buffer()
                    try {
                        while (true) {
                            val read = source.read(buffer, 8192)
                            if (read == -1L) break
                            val chunk = buffer.readUtf8()
                            if (chunk.isEmpty()) continue
                            for (frame in parser.feed(chunk)) {
                                StreamEventCodec.decode(frame)?.let { emitBlocking(it) }
                            }
                        }
                        for (frame in parser.flush()) {
                            StreamEventCodec.decode(frame)?.let { emitBlocking(it) }
                        }
                    } catch (error: IOException) {
                        if (!call.isCanceled()) {
                            emitBlocking(StreamEvent.StreamProblem(transportError(error), resync = false))
                        }
                    } finally {
                        IbLog.debug(
                            "stream.closed",
                            "label" to label,
                            IbLog.FIELD_LATENCY_MS to (System.nanoTime() - startedAt) / 1_000_000,
                        )
                        close()
                    }
                }
            }
        })

        // Cancelling the collector must cancel the CALL, not merely stop reading:
        // the read is blocked on a socket, so only closing it unblocks the thread.
        awaitClose { call.cancel() }
    }

    /**
     * Backpressure-aware emission from OkHttp's callback thread.
     * `trySendBlocking` waits for the collector instead of dropping frames — a
     * dropped frame would look exactly like a lost frame to the sequence tracker.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    private fun ProducerScope<StreamEvent>.emitBlocking(event: StreamEvent) {
        try {
            trySendBlocking(event)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        } catch (_: Exception) {
            // Channel closed (collector gone) — nothing to deliver to.
        }
    }

    private fun noCredentialOrAddress(): ProtocolError =
        if (endpointProvider() == null) {
            ProtocolError.Local("This app is not connected to a Home Node.")
        } else {
            ProtocolError.Server(
                code = ProtocolError.AUTH_REQUIRED,
                message = "This device has no credential.",
                retryable = false,
            )
        }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            // No overall call deadline: a slow provider turn is legitimately slow,
            // and a deadline here would abort healthy long generations.
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(true)
            .build()

        fun transportError(error: Throwable): ProtocolError {
            val kind = TransportKind.of(error.javaClass.simpleName, error.message ?: "")
            val detail = buildString {
                append(error.javaClass.simpleName)
                val message = error.message
                if (!message.isNullOrBlank()) {
                    append(": ")
                    append(message.take(160))
                }
            }
            return ProtocolError.Transport(kind, detail)
        }

        internal fun encodePathSegment(raw: String): String =
            java.net.URLEncoder.encode(raw, "UTF-8").replace("+", "%20")
    }
}
