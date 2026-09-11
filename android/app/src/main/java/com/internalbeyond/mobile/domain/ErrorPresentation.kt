package com.internalbeyond.mobile.domain

/** What the user can do about a failure. Drives which button the UI shows. */
enum class ErrorAction {
    NONE,

    /** Offer "再试一次" on the same request (same requestId!). */
    RETRY,

    /** Offer "再试一次" but the caller should expect to wait (rate limit / busy). */
    RETRY_LATER,

    /** The credential is gone: send the user back to pairing. */
    RE_PAIR,

    /** Needs action on the DESKTOP (publish the character). */
    DESKTOP_ACTION,

    /** Needs action in the app's Settings (disconnect / re-pair). */
    OPEN_SETTINGS,
}

/**
 * A failure as the user should see it.
 *
 * Phase 34 requires these to be DISTINGUISHABLE. A single "出错了" is not an acceptable
 * rendering of any of them, so every branch below produces its own (title, explanation,
 * action) triple — and `ErrorMappingTest` asserts that no two distinct protocol codes
 * collapse to the same text.
 *
 * M1-C.1 added [technical], and it is the mechanism behind the brief's rule that a
 * normal screen never shows protocol vocabulary. The split is:
 *
 *  · [title] and [detail] are Chinese, written for a person, and free of any word the
 *    product uses internally — no "Home Node", no code, no address.
 *  · [technical] is the protocol's own account of what happened: the code the server
 *    returned and whatever it said. The UI renders it only inside a collapsed
 *    "详细信息" disclosure.
 *
 * That is strictly better than the old shape, which put `error.detail` — server text
 * like "The Home Node sent an empty body (HTTP 502)" — straight into the sentence a
 * user reads. The information is not lost; it is moved to where someone who needs it
 * will look for it.
 */
data class ErrorPresentation(
    val title: String,
    val detail: String? = null,
    val action: ErrorAction = ErrorAction.NONE,
    /** Protocol code plus raw server text. Shown only under 详细信息. */
    val technical: String? = null,
)

object ErrorPresenter {

    fun present(error: ProtocolError): ErrorPresentation = when (error) {
        is ProtocolError.Transport -> when (error.kind) {
            TransportKind.OFFLINE -> ErrorPresentation(
                title = "暂时连不上电脑",
                detail = "这台手机和电脑不在同一个网络里，或者这边的网络断了。",
                action = ErrorAction.RETRY,
                technical = technical(error.code, error.detail),
            )
            TransportKind.UNREACHABLE -> ErrorPresentation(
                title = "电脑没有回应",
                detail = "地址能到达，但电脑上的 InternalBeyond 没有应答。确认它正在电脑上运行。",
                action = ErrorAction.RETRY,
                technical = technical(error.code, error.detail),
            )
            TransportKind.TIMEOUT -> ErrorPresentation(
                title = "电脑回应得太慢",
                detail = "等了一段时间还是没收到回应。稍后再试一次。",
                action = ErrorAction.RETRY,
                technical = technical(error.code, error.detail),
            )
            TransportKind.INTERRUPTED -> ErrorPresentation(
                title = "和电脑的连接中断了",
                detail = "连接中途断开。重新连上以后会接着走。",
                action = ErrorAction.RETRY,
                technical = technical(error.code, error.detail),
            )
            TransportKind.CANCELLED -> ErrorPresentation(
                title = "已经取消",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail),
            )
        }

        is ProtocolError.Response -> ErrorPresentation(
            title = "电脑回了一份看不懂的答复",
            detail = "它说的不是这台手机能理解的内容。两边可能不是同一个版本。",
            action = ErrorAction.RETRY,
            technical = technical(error.code, error.detail, error.httpStatus),
        )

        is ProtocolError.Local -> ErrorPresentation(
            title = "这一步没能完成",
            detail = error.detail,
            action = ErrorAction.NONE,
            technical = technical(error.code, null),
        )

        is ProtocolError.Server -> when (error.code) {
            ProtocolError.AUTH_REQUIRED -> ErrorPresentation(
                title = "这台手机还没有连上电脑",
                detail = "重新连接一次这台手机。",
                action = ErrorAction.RE_PAIR,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.AUTH_INVALID -> ErrorPresentation(
                title = "电脑不再认得这台手机",
                detail = "电脑没有接受这台手机的身份。重新连接一次，换一份新的。",
                action = ErrorAction.RE_PAIR,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.DEVICE_REVOKED -> ErrorPresentation(
                title = "这台手机已经在电脑上被移除了",
                detail = "电脑上把它移除了，原来的身份不再有效。重新连接一次就能恢复。",
                action = ErrorAction.RE_PAIR,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.PAIRING_INVALID -> ErrorPresentation(
                title = "这段配对信息不对",
                detail = "在电脑上重新复制一次，完整地粘贴过来。",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.PAIRING_EXPIRED -> ErrorPresentation(
                title = "这段配对信息过期了",
                detail = "配对信息只有几分钟有效。在电脑上重新生成一段。",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.PAIRING_USED -> ErrorPresentation(
                title = "这段配对信息已经用过了",
                detail = "每一段配对信息只能用一次。在电脑上重新生成一段。",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.PAIRING_NOT_FOUND -> ErrorPresentation(
                title = "电脑不认识这段配对信息",
                detail = "它可能是另一台电脑生成的。",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.BAD_VERSION -> ErrorPresentation(
                title = "手机和电脑的版本对不上",
                detail = "电脑端说的是第 ${error.detail ?: "?"} 版，这台手机说的是第 1 版。" +
                    "哪一边旧就更新哪一边。",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.BAD_REQUEST -> ErrorPresentation(
                title = "电脑拒绝了这次请求",
                detail = "它没有说明是哪一项不对。",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.UNKNOWN_VERB -> ErrorPresentation(
                title = "这台手机问了电脑不认识的东西",
                detail = "两边不是同一个版本。更新比较旧的那一边。",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.NOT_FOUND -> ErrorPresentation(
                title = "电脑上没有这一项",
                detail = "它可能已经被删掉了。",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.BUSY -> ErrorPresentation(
                title = "上一句还在写",
                detail = "一段对话一次只能生成一条回复。等它写完再发。",
                action = ErrorAction.RETRY_LATER,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.CONFLICT -> if (error.detail?.contains(ProtocolError.NO_RUNNABLE_CONFIG) == true) {
                ErrorPresentation(
                    title = "这个角色暂时还不能回复",
                    detail = "在电脑上打开一次 InternalBeyond，它会把角色同步过来。在那之前，" +
                        "这个角色无法生成回复。",
                    action = ErrorAction.DESKTOP_ACTION,
                    technical = technical(error.code, error.detail, error.httpStatus),
                )
            } else {
                ErrorPresentation(
                    title = "电脑拒绝了这次请求",
                    detail = "两边对这件事的看法不一致。",
                    action = ErrorAction.NONE,
                    technical = technical(error.code, error.detail, error.httpStatus),
                )
            }

            ProtocolError.RATE_LIMITED -> ErrorPresentation(
                title = "请求太频繁了",
                detail = error.retryAfterMs
                    ?.let { "电脑让这台手机等 ${(it / 1000).coerceAtLeast(1)} 秒再试。" }
                    ?: "电脑让这台手机放慢一点。",
                action = ErrorAction.RETRY_LATER,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.TOO_LARGE -> ErrorPresentation(
                title = "这条内容太大了，发不出去",
                detail = "电脑不接受超过 24 MiB 的内容。",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.LOOPBACK_ONLY -> ErrorPresentation(
                title = "电脑还没有开放给这台手机",
                detail = "电脑上的 InternalBeyond 正在运行，但它暂时只接受本机的连接，" +
                    "所以同一网络里的手机还连不上。这是电脑那边的设置，手机端改不了。",
                action = ErrorAction.DESKTOP_ACTION,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.UNSUPPORTED -> ErrorPresentation(
                title = "电脑现在没法生成回复",
                detail = "它那边的生成通道不可用。打开电脑上的诊断看一下。",
                action = ErrorAction.DESKTOP_ACTION,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.PROVIDER_ERROR -> ErrorPresentation(
                title = "角色的模型出错了",
                detail = "电脑那边调用模型时出错了。稍后再试一次。",
                action = ErrorAction.RETRY,
                technical = technical(error.code, error.detail ?: error.message, error.httpStatus),
            )

            ProtocolError.TIMEOUT -> ErrorPresentation(
                title = "角色想了太久",
                detail = "模型没有在限定时间内写完。稍后再试一次。",
                action = ErrorAction.RETRY,
                technical = technical(error.code, error.detail ?: error.message, error.httpStatus),
            )

            ProtocolError.ABORT -> ErrorPresentation(
                title = "这次回复被停下来了",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.REPLAY_GAP -> ErrorPresentation(
                title = "漏掉了一小段",
                detail = "正在从电脑重新读取这段对话，把中间补上。",
                action = ErrorAction.NONE,
                technical = technical(error.code, error.detail, error.httpStatus),
            )

            ProtocolError.INTERNAL -> ErrorPresentation(
                title = "电脑那边内部出错了",
                detail = "稍后再试一次。",
                action = ErrorAction.RETRY,
                technical = technical(error.code, error.detail ?: error.message, error.httpStatus),
            )

            else -> ErrorPresentation(
                title = "电脑拒绝了这次请求",
                detail = null,
                action = if (error.retryable) ErrorAction.RETRY else ErrorAction.NONE,
                technical = technical(error.code, error.message, error.httpStatus),
            )
        }
    }

    /** `CODE · what the server said · HTTP n`. Built once so no branch invents a format. */
    private fun technical(code: String, detail: String?, httpStatus: Int = 0): String {
        val parts = mutableListOf(code)
        detail?.takeIf { it.isNotBlank() }?.let { parts += it }
        if (httpStatus != 0) parts += "HTTP $httpStatus"
        return parts.joinToString(" · ")
    }
}
