import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// blip — iMessage in the bar.
//
// iMessage is macOS-only: chat.db and the AppleScript send path both live on
// fnix. vic is a thin client over a multiplexed SSH socket (~47ms warm). This
// widget owns the single poller; the panel reads its state rather than running
// its own collector.
//
// Badge counts EVERY unread. Toasts fire only for allowlisted handles
// (~/.config/blip/allowlist.json) — chat.db is 15k Truist alerts and a steady
// drip of 2FA codes, and none of that deserves to interrupt Fred.
//
// Left-click = panel · middle-click = refresh · right-click = mark all read.
BarWidget {
  id: root
  moduleName: "nixfred.blip"

  readonly property string home: Quickshell.env("HOME")
  readonly property string collectorPath:
    decodeURIComponent(Qt.resolvedUrl("collector.ts").toString().replace(/^file:\/\//, ""))

  // ---- collector state
  property var threads: []           // [{chat,name,handle,service,last_ts,last_text,last_from_me,count,unread}]
  property int unread: 0
  property bool online: false        // fnix reachable
  property bool healthy: false       // last collector run parsed cleanly
  property string lastError: ""
  property string lastRun: ""

  readonly property bool hasUnread: unread > 0

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function show(chat) {
    if (!panelLoader.item) return
    panelLoader.item.open()
    // `qs ipc call` rejects a leading "+" as a flag, so accept the bare digits too.
    var want = String(chat)
    var t = null
    for (var i = 0; i < threads.length; i++) {
      var c = String(threads[i].chat)
      if (c === want || c === "+" + want) { t = threads[i]; break }
    }
    if (!t && /^[0-9]+$/.test(want)) want = "+" + want
    // Unknown to the current window: still open it, with the id as the name.
    panelLoader.item.openThread(t || { chat: want, handle: want, name: want })
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.anchorItem = button
    target.hostWidget = root
  }
  onBarChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // ------------------------------------------------------------ collector
  // `deep` widens the fetch window for the panel; `markRead` clears the badge.
  property bool pendingDeep: false
  property bool pendingMarkRead: false

  function refresh(deep, markRead) {
    if (collector.running) return
    pendingDeep = deep === true
    pendingMarkRead = markRead === true
    var args = ["bun", collectorPath]
    if (pendingDeep) args.push("--deep")
    if (pendingMarkRead) args.push("--mark-read")
    collector.command = args
    collector.running = true
  }
  function markAllRead() { refresh(false, true) }

  Process {
    id: collector
    command: ["bun", root.collectorPath]
    stdout: StdioCollector {
      onStreamFinished: {
        // A garbled run keeps the last good thread list rather than flashing
        // the bar empty — same discipline as larry.status's session collector.
        try {
          var d = JSON.parse(text.trim())
          root.online = d.online === true
          root.lastError = String(d.error || "")
          root.lastRun = String(d.ts || "")
          if (d.ok === true) {
            root.threads = Array.isArray(d.threads) ? d.threads : []
            root.unread = Number(d.unread) || 0
            root.healthy = true
            if (Array.isArray(d.toast)) root.fireToasts(d.toast)
          } else {
            root.healthy = false
            if (!root.online) root.unread = 0     // offline: no honest count to show
          }
        } catch (e) {
          root.healthy = false
          root.lastError = "collector produced unparseable output"
        }
      }
    }
    onExited: function(code, status) { if (code !== 0) root.healthy = false }
  }

  Timer {
    interval: 6000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh(false, false)
  }

  // ------------------------------------------------------------ toasts
  // One notify-send per allowlisted inbound message. The collector has already
  // applied the allowlist and the dedupe ring, so anything arriving here is
  // meant to interrupt. Reuses the no-focus-steal notification behaviour.
  Process { id: notifyProc }
  property var toastQueue: []

  function fireToasts(list) {
    if (!list || list.length === 0) return
    var q = toastQueue.slice()
    for (var i = 0; i < list.length; i++) q.push(list[i])
    toastQueue = q
    drainToasts()
  }
  function drainToasts() {
    if (notifyProc.running || toastQueue.length === 0) return
    var q = toastQueue.slice()
    var t = q.shift()
    toastQueue = q
    var body = String(t.text || "")
    if (body.length > 220) body = body.substring(0, 217) + "…"
    notifyProc.command = [
      "notify-send",
      "--app-name=Blip",
      "--icon=mail-message-new",
      "--expire-time=8000",
      String(t.name || t.chat || "iMessage"),
      body
    ]
    notifyProc.running = true
  }
  Connections {
    target: notifyProc
    function onExited(code, status) { Qt.callLater(root.drainToasts) }
  }

  // ------------------------------------------------------------ IPC
  IpcHandler {
    target: root.moduleName
    function status(): string {
      return "online=" + root.online + " unread=" + root.unread
        + " threads=" + root.threads.length + " healthy=" + root.healthy
        + (root.lastError !== "" ? " error=" + root.lastError : "")
    }
    function threads(): string { return JSON.stringify(root.threads) }
    function refresh(): void { root.refresh(false, false) }
    function read(): void { root.markAllRead() }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function goto(chat: string): void { root.show(chat) }
  }

  // ------------------------------------------------------------ bar button
  function tooltip() {
    var parts = []
    if (!root.online) parts.push("fnix unreachable — iMessage bridge offline")
    else if (root.unread === 0) parts.push("No unread messages")
    else parts.push(root.unread + " unread message" + (root.unread === 1 ? "" : "s"))

    if (root.online && root.unread > 0) {
      var hot = root.threads.filter(function(t){ return t.unread > 0 }).slice(0, 4)
      for (var i = 0; i < hot.length; i++)
        parts.push("  " + hot[i].name + " (" + hot[i].unread + ")")
    }
    if (root.online && !root.healthy && root.lastError !== "") parts.push("⚠ " + root.lastError)
    return parts.join("\n") + "\nleft: threads · middle: refresh · right: mark all read"
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""
    hasVisualContent: true
    labelVisible: false
    keepSpace: true
    fixedWidth: content.implicitWidth + Style.spaceReal(horizontalMargin) * 2
    dimmed: !root.online
    active: root.hasUnread
    useActiveColor: false
    tooltipText: root.tooltip()
    onPressed: function(code) {
      if (code === Qt.MiddleButton) root.refresh(false, false)
      else if (code === Qt.RightButton) root.markAllRead()
      else root.toggle()
    }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.spaceReal(4)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        // Nerd Font: filled speech bubble when unread, outline when quiet,
        // slashed when the bridge is down.
        text: !root.online ? "󰻞" : (root.hasUnread ? "󰭹" : "󰭻")
        textFormat: Text.PlainText
        color: root.hasUnread ? root.blipAccent : button.foreground
        font.family: button.fontFamily
        font.pixelSize: Style.font.body
        renderType: Text.NativeRendering
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.online && root.unread > 0
        text: root.unread > 99 ? "99+" : root.unread
        textFormat: Text.PlainText
        color: root.blipAccent
        font.family: button.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: true
        renderType: Text.NativeRendering
      }
    }
  }

  // Fixed cyan rather than the theme accent: several Omarchy themes use red for
  // accents, and red must stay reserved for genuine alerts (see larry.status).
  readonly property color blipAccent: "#5fd7ff"
}
