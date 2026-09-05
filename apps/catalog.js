/* apps/catalog.json 的 JS 壳——file:// 直接双击打开时 fetch 读不到 json，底座退回用 <script> 读这一份；两份内容必须一致 */
window.IB_APP_CATALOG={
  "sdk": 2,
  "apps": [
    {
      "id": "coread",
      "name": "共读间",
      "version": "1.0.0",
      "file": "inline",
      "builtin": true,
      "hidden": true,
      "desc": "常驻：一篇日志＝一本书，选一位 TA 一起读；聊天落在「共读 · 书名」话题频道，TA 只读到你此刻这一页。",
      "icon": "<path d=\"M12 6.0c-1.8-1.5-4.2-2.2-7-2.2v14c2.8 0 5.2.7 7 2.2 1.8-1.5 4.2-2.2 7-2.2v-14c-2.8 0-5.2.7-7 2.2z\"/><path d=\"M12 6.0v14\"/>"
    },
    {
      "id": "cinema",
      "name": "观影室",
      "version": "1.0.0",
      "file": "ib-app-cinema.js",
      "desc": "选一段本机视频、配 .srt/.vtt 字幕，和 TA 一起看：通栏播放器 / 留影 / 看画面 / 弹幕 / 全屏；视频与字幕不入库。",
      "icon": "<rect x=\"3.5\" y=\"6\" width=\"17\" height=\"12\" rx=\"2.5\"/><path d=\"M3.5 9.5h17M7.5 6v12M16.5 6v12\"/><path d=\"M10.8 11v4l3.4-2z\"/>"
    }
  ]
};
