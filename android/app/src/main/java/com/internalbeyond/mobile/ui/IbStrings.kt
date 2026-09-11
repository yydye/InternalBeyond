package com.internalbeyond.mobile.ui

/**
 * Everything the app says to the person holding the phone.
 *
 * One file, one voice, one audit surface. The reason it is not scattered across the
 * four screens is requirement 9 of M1-C.1: a user must never meet the architecture.
 * "Home Node", "payload", "endpoint", "protocol v1", "JSON", "F12" are words this
 * product uses *internally*; on a phone they are replaced by 电脑 and 配对信息. Keeping
 * the copy in one place is what makes that checkable — `IbCopyAuditTest` walks every
 * value in this object and fails on a single leaked term.
 *
 * The split is structural, not a convention:
 *
 *  · Every value directly on [IbStrings] is **user-facing** and must be free of
 *    developer vocabulary.
 *  · [IbStrings.Dev] is the one place where that vocabulary is allowed, because it is
 *    only ever rendered inside a collapsed "开发者信息" / "开发帮助" disclosure.
 *
 * Voice: plain verbs, sentence case, no exclamation, no apology. A failure says what
 * happened and what to do; it does not perform concern. Emptiness is an invitation.
 */
object IbStrings {

    // ── Brand ────────────────────────────────────────────────────────────────
    // The name only. A tagline constant used to live here and nothing rendered it —
    // dead copy is how a catalogue starts drifting from the screens it describes.
    val brand = "InternalBeyond"

    // ── Pairing · first screen ───────────────────────────────────────────────
    val pairTitle = "连接到你的 InternalBeyond"
    val pairSubtitle = "与电脑上的角色、记忆和聊天保持在同一个世界"
    val pairScanQr = "扫描二维码"
    val pairScanQrSoon = "即将加入"
    val pairManual = "手动连接"
    val pairAdvanced = "高级设置"

    // ── Pairing · live status ────────────────────────────────────────────────
    val statusNotConnected = "尚未连接"
    val statusConnected = "已连接"
    val statusUnreachable = "暂时联系不上电脑"
    val statusChecking = "正在检查配对信息"
    val statusExchanging = "正在配对"
    val statusVerifying = "正在确认身份"

    // ── Pairing · manual sheet ───────────────────────────────────────────────
    val manualTitle = "手动连接"
    val manualIntro = "先在电脑上打开 InternalBeyond，生成一段配对信息，再把它粘贴到这里。"
    val manualPasteLabel = "配对信息"
    val manualPastePlaceholder = "粘贴从电脑上复制过来的内容"
    val manualDeviceNameLabel = "设备名称"
    val manualDeviceNameHint = "这台手机显示在电脑上的名字"
    val manualConnect = "连接"
    val manualCancel = "取消"

    // ── Pairing · advanced sheet ─────────────────────────────────────────────
    val advancedTitle = "高级设置"
    val advancedAddressLabel = "电脑地址"
    val advancedAddressHint = "只有手机连不上配对信息里的地址时才需要填写"
    val advancedAddressPlaceholder = "192.168.10.7:23118"
    val advancedNothingYet = "还没有连接过电脑。"
    val advancedDone = "完成"

    // ── Pairing · success ────────────────────────────────────────────────────
    val pairedTitle = "已经连上了"
    val pairedGoOn = "开始使用"
    val pairedRemember = "这台手机记住了它，下次打开会直接回到角色。"

    // ── Characters ───────────────────────────────────────────────────────────
    val charactersTitle = "角色"
    val charactersFromCache = "以下是你上次从电脑收到的列表"
    val charactersEmptyPublished = "电脑上还没有角色"
    val charactersEmptyPublishedDetail = "在电脑上的 InternalBeyond 里建好角色，它们会出现在这里。"
    val charactersEmptyUnreachable = "暂时读不到角色"
    val charactersEmptyUnreachableDetail = "还没能连上电脑，这台手机上也还没有缓存。"
    val characterArchived = "已归档"
    val characterVision = "视觉"
    val charactersRefresh = "刷新"
    val charactersSettings = "设置"

    // ── Chat ─────────────────────────────────────────────────────────────────
    val chatBack = "返回"
    val chatReconnecting = "正在重新连接…"
    val chatReconnectingNote = "回复还在电脑上继续生成"
    val chatResumeNow = "立即继续"
    val chatSending = "发送中…"
    val chatSendFailed = "发送失败"
    val chatSendAgain = "重新发送"
    val chatReasoningShow = "思考过程"
    val chatLoadOlder = "读取更早的消息"
    val chatEmptyTitle = "还没有说过话"
    val chatComposerPlaceholder = "说点什么…"
    val chatSend = "发送"
    val chatWithdrawn = "（已撤回）"
    val chatTruncated = "内容过长，只显示了一部分"

    fun chatEmptyDetail(name: String) = "对 $name 说点什么吧。"

    fun chatMessageCount(count: Int) = "$count 条消息"

    fun chatImageMark(mime: String) = "图片 ${mime.removePrefix("image/")}"

    fun chatFileMark(name: String) = "文件 $name"

    fun chatVoiceMark(seconds: Double?) =
        if (seconds == null) "语音" else "语音 ${seconds.toInt()} 秒"

    fun chatVoiceTranscript() = "语音转写已保存"

    // ── Settings ─────────────────────────────────────────────────────────────
    val settingsTitle = "设置"
    val settingsThisDevice = "当前设备"
    val settingsRename = "改名"
    val settingsRenameTitle = "给这台手机改个名字"
    val settingsRenameLabel = "名称"
    val settingsSave = "保存"
    val settingsCancel = "取消"
    val settingsThisComputer = "已连接的电脑"
    val settingsNotPairedDetail = "连接之后，这台手机就能看到电脑上的角色和聊天。"
    val settingsDisconnect = "断开连接"
    val settingsDisconnectTitle = "要断开这台手机吗？"
    val settingsDisconnectBody = "断开以后，电脑会停止接受这台手机的凭据。电脑上的聊天记录不受影响。"
    val settingsDisconnectAlsoCache = "同时删除这台手机上缓存的聊天记录"
    val settingsDisconnectConfirm = "断开"
    val settingsAbout = "关于 InternalBeyond"
    val settingsAboutBody = "手机端 1.0.0"
    val settingsAboutDetail = "电脑上的 InternalBeyond 保存着你的角色、记忆和聊天；这台手机只是它的一扇窗。"

    val settingsDisconnectedRemote = "这台手机已经断开，电脑上也一并移除了。"
    val settingsDisconnectedUnconfirmed =
        "这台手机已经断开，但没能通知到电脑。如果电脑上还显示着这台手机，请在那里手动移除。"
    val settingsCacheCleared = "这台手机上的缓存已删除。电脑上的记录不受影响。"
    val settingsRenamed = "名字已经改好了。"
    val settingsRenameFailed = "改名没有成功，稍后再试一次。"
    val settingsSynced = "已经是最新的。"
    val settingsSyncFailed = "同步没有完成"

    // ── Errors · shared ──────────────────────────────────────────────────────
    val errorDetailToggle = "详细信息"
    val errorTryAgain = "再试一次"
    val errorRepair = "重新连接"
    val errorOpenSettings = "打开设置"

    // ── Accessibility ────────────────────────────────────────────────────────
    val cdAvatarOf = "头像"
    val cdBridgeMark = "手机与电脑之间的连接"

    fun cdOpenCharacter(name: String) = "打开与 $name 的对话"

    // ── Developer-facing copy ────────────────────────────────────────────────
    /**
     * The only strings allowed to name the architecture.
     *
     * They are rendered exclusively inside a collapsed disclosure whose label is
     * itself user-facing ([devInfoTitle] / [devHelpTitle]), so the normal screen never
     * shows them; someone who opens the disclosure has asked for the real names.
     */
    object Dev {
        val devInfoTitle = "开发者信息"
        val devHelpTitle = "开发帮助"
        val nodeLabel = "Home Node"
        val address = "地址"
        val transport = "传输"
        val deviceId = "设备标识"
        val fingerprint = "节点指纹"
        val serverVersion = "电脑端版本"
        val protocolVersion = "协议版本"
        val appVersion = "手机端版本"
        val errorCode = "错误代码"
        val cacheTitle = "本机缓存"
        val cacheCharacters = "角色"
        val cacheMessages = "消息"
        val cacheConversations = "会话"
        val cachePendingSends = "未完成的发送"
        val cacheDrafts = "草稿"
        val syncNow = "立即同步"
        val clearCache = "删除本机缓存"
        val copy = "复制"

        /** The desktop-side command. Verbatim, and never shown outside [devHelpTitle]. */
        val pairingCommand =
            "JSON.stringify((await IB.homeNode.pairing.create({deviceName:'Android'})).payload)"

        val pairingHelpBody =
            "这个版本的电脑端还没有生成配对信息的按钮。如果你会用浏览器的开发者工具：" +
                "在电脑上打开 InternalBeyond，按 F12，把下面这行命令粘贴进控制台，回车，" +
                "再把打印出来的整段内容复制到这里。"

        val loopbackHelp =
            "电脑上的 Home Node 目前只监听本机（127.0.0.1），手机无法访问。" +
                "需要在电脑上以 IB_HOME_NODE_HOST=0.0.0.0 启动，或者在这里手动填写电脑地址。"
    }
}
