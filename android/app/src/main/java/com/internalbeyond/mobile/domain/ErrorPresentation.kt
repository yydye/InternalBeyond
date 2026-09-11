package com.internalbeyond.mobile.domain

/** What the user can do about a failure. Drives which button the UI shows. */
enum class ErrorAction {
    NONE,

    /** Offer "Try again" on the same request (same requestId!). */
    RETRY,

    /** Offer "Try again" but the caller should expect to wait (rate limit / busy). */
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
 * Phase 34 requires these to be DISTINGUISHABLE. A single "Something went wrong"
 * is not an acceptable rendering of any of them, so every branch below produces
 * its own (title, explanation, action) triple — and `ErrorPresentationTest`
 * asserts that no two distinct protocol codes collapse to the same text.
 */
data class ErrorPresentation(
    val title: String,
    val detail: String? = null,
    val action: ErrorAction = ErrorAction.NONE,
)

object ErrorPresenter {

    fun present(error: ProtocolError): ErrorPresentation = when (error) {
        is ProtocolError.Transport -> when (error.kind) {
            TransportKind.OFFLINE -> ErrorPresentation(
                title = "Home Node not reachable",
                detail = "No network route to ${error.detail}. Check that the phone and the " +
                    "desktop are on the same network.",
                action = ErrorAction.RETRY,
            )
            TransportKind.UNREACHABLE -> ErrorPresentation(
                title = "Home Node is not answering",
                detail = "The address answered nothing. Check that InternalBeyond is running " +
                    "on the desktop (${error.detail}).",
                action = ErrorAction.RETRY,
            )
            TransportKind.TIMEOUT -> ErrorPresentation(
                title = "Home Node did not answer in time",
                detail = error.detail,
                action = ErrorAction.RETRY,
            )
            TransportKind.INTERRUPTED -> ErrorPresentation(
                title = "Connection to the Home Node was interrupted",
                detail = error.detail,
                action = ErrorAction.RETRY,
            )
            TransportKind.CANCELLED -> ErrorPresentation(
                title = "Cancelled",
                detail = error.detail,
                action = ErrorAction.NONE,
            )
        }

        is ProtocolError.Response -> ErrorPresentation(
            title = "Unexpected answer from the Home Node",
            detail = error.detail,
            action = ErrorAction.RETRY,
        )

        is ProtocolError.Local -> ErrorPresentation(
            title = "Cannot do that yet",
            detail = error.detail,
            action = ErrorAction.NONE,
        )

        is ProtocolError.Server -> when (error.code) {
            ProtocolError.AUTH_REQUIRED -> ErrorPresentation(
                title = "This app is not signed in to the Home Node",
                detail = "Pair this device again.",
                action = ErrorAction.RE_PAIR,
            )

            ProtocolError.AUTH_INVALID -> ErrorPresentation(
                title = "This device is no longer recognised",
                detail = "The Home Node did not accept this device's credential. " +
                    "Pair again to get a new one.",
                action = ErrorAction.RE_PAIR,
            )

            ProtocolError.DEVICE_REVOKED -> ErrorPresentation(
                title = "This device was disconnected from the Home Node",
                detail = "It was revoked on the desktop, so its credential no longer works. " +
                    "Pair again to reconnect.",
                action = ErrorAction.RE_PAIR,
            )

            ProtocolError.PAIRING_INVALID -> ErrorPresentation(
                title = "That pairing payload is not valid",
                detail = "Copy it again from the desktop — the payload must be pasted exactly.",
                action = ErrorAction.NONE,
            )

            ProtocolError.PAIRING_EXPIRED -> ErrorPresentation(
                title = "That pairing payload has expired",
                detail = "Pairing payloads are valid for a few minutes. Create a new one on " +
                    "the desktop.",
                action = ErrorAction.NONE,
            )

            ProtocolError.PAIRING_USED -> ErrorPresentation(
                title = "That pairing payload was already used",
                detail = "Each payload works exactly once. Create a new one on the desktop.",
                action = ErrorAction.NONE,
            )

            ProtocolError.PAIRING_NOT_FOUND -> ErrorPresentation(
                title = "The desktop does not know that pairing payload",
                detail = "It may have been created by a different Home Node.",
                action = ErrorAction.NONE,
            )

            ProtocolError.BAD_VERSION -> ErrorPresentation(
                title = "This app and the Home Node disagree on the protocol version",
                detail = "The Home Node speaks protocol v1" +
                    (error.detail?.let { " and rejected ours ($it)" } ?: "") +
                    ". Update whichever side is older.",
                action = ErrorAction.NONE,
            )

            ProtocolError.BAD_REQUEST -> ErrorPresentation(
                title = "The Home Node rejected the request",
                detail = error.detail,
                action = ErrorAction.NONE,
            )

            ProtocolError.UNKNOWN_VERB -> ErrorPresentation(
                title = "This version of the app asked for something the Home Node does not offer",
                detail = "The desktop build is from a different protocol revision.",
                action = ErrorAction.NONE,
            )

            ProtocolError.NOT_FOUND -> ErrorPresentation(
                title = "Not found on the Home Node",
                detail = error.detail,
                action = ErrorAction.NONE,
            )

            ProtocolError.BUSY -> ErrorPresentation(
                title = "A reply is still being written",
                detail = "A conversation can only generate one reply at a time. Wait for it to " +
                    "finish, then send again.",
                action = ErrorAction.RETRY_LATER,
            )

            ProtocolError.CONFLICT -> if (error.detail?.contains(ProtocolError.NO_RUNNABLE_CONFIG) == true) {
                ErrorPresentation(
                    title = "This character is not available on the Home Node yet",
                    detail = "Open InternalBeyond on the desktop once — it publishes the " +
                        "character list to the Home Node. Until then, this character cannot " +
                        "generate replies.",
                    action = ErrorAction.DESKTOP_ACTION,
                )
            } else {
                ErrorPresentation(
                    title = "The Home Node refused the request",
                    detail = error.detail,
                    action = ErrorAction.NONE,
                )
            }

            ProtocolError.RATE_LIMITED -> ErrorPresentation(
                title = "Too many requests",
                detail = error.retryAfterMs
                    ?.let { "The Home Node asked this device to wait ${(it / 1000).coerceAtLeast(1)}s." }
                    ?: "The Home Node asked this device to slow down.",
                action = ErrorAction.RETRY_LATER,
            )

            ProtocolError.TOO_LARGE -> ErrorPresentation(
                title = "That message is too large to send",
                detail = "The Home Node refuses request bodies over 24 MiB.",
                action = ErrorAction.NONE,
            )

            ProtocolError.UNSUPPORTED -> ErrorPresentation(
                title = "The Home Node cannot generate replies right now",
                detail = "Its execution path is unavailable. Check the desktop's diagnostics.",
                action = ErrorAction.DESKTOP_ACTION,
            )

            ProtocolError.PROVIDER_ERROR -> ErrorPresentation(
                title = "The character's model provider failed",
                detail = error.detail ?: error.message,
                action = ErrorAction.RETRY,
            )

            ProtocolError.TIMEOUT -> ErrorPresentation(
                title = "The character took too long to answer",
                detail = error.detail ?: "The provider did not finish in time.",
                action = ErrorAction.RETRY,
            )

            ProtocolError.ABORT -> ErrorPresentation(
                title = "The reply was stopped",
                detail = error.detail,
                action = ErrorAction.NONE,
            )

            ProtocolError.REPLAY_GAP -> ErrorPresentation(
                title = "Part of the live reply was missed",
                detail = "Re-reading the conversation from the Home Node to fill the gap.",
                action = ErrorAction.NONE,
            )

            ProtocolError.INTERNAL -> ErrorPresentation(
                title = "The Home Node hit an internal error",
                detail = error.detail ?: error.message,
                action = ErrorAction.RETRY,
            )

            else -> ErrorPresentation(
                title = "The Home Node refused the request",
                detail = "${error.code}: ${error.message}",
                action = if (error.retryable) ErrorAction.RETRY else ErrorAction.NONE,
            )
        }
    }
}
