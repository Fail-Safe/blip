import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Blip panel — threads, history, compose.
//
// Two views in one column (a bar panel is too narrow for a real two-pane):
//   list         → every thread, newest first, unread marked
//   conversation → one thread's history + a compose box, Esc goes back
//
// Reads its thread list from the host widget so there is exactly one poller.
Panel {
  id: root
  moduleName: "nixfred.blip"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.45)
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color cyan: "#5fd7ff"
  readonly property color okColor: "#7fbf7f"

  readonly property string home: Quickshell.env("HOME")

  readonly property var threads: hostWidget ? hostWidget.threads : []
  readonly property bool online: hostWidget ? hostWidget.online : false
  readonly property int unread: hostWidget ? hostWidget.unread : 0

  // ---- view state
  property var active: null          // selected thread object, null = list view
  property var messages: []          // [{ts,from_me,name,text}] for `active`
  property bool loading: false
  property string note: ""           // transient status line (send result, errors)
  property int cursor: -1            // keyboard row selection in list view

  readonly property bool inThread: active !== null

  /**
   * Group chats carry an opaque chat_identifier (32 hex, chat.style=43), but
   * AppleScript needs the full GUID ("any;+;<id>") which `imsg --json` does not
   * expose. Rather than risk delivering a message to the wrong thread, v0.1
   * sends to DMs only and marks groups read-only.
   */
  function isSendable(t) {
    if (!t) return false
    var h = String(t.handle || "")
    return /^\+?[0-9]{5,}$/.test(h) || h.indexOf("@") > 0
  }

  function open() {
    active = null
    messages = []
    note = ""
    cursor = -1
    // Deep fetch for a real thread list, and clear the badge — opening the
    // panel is exactly the moment Fred has "seen" his messages.
    if (hostWidget) hostWidget.refresh(true, true)
    controller.show()
  }
  function close() { controller.hide() }
  function toggle() { opened ? close() : open() }

  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function")
      return bar.switchPanelFrom(barIdentity, direction)
    return false
  }

  function back() {
    active = null
    messages = []
    note = ""
  }

  function openThread(t) {
    if (!t) return
    active = t
    messages = []
    note = ""
    loading = true
    threadProc.command = [root.home + "/bin/imsg", "--json", "thread", String(t.chat), "60"]
    threadProc.running = true
  }

  function send() {
    var text = composeField.text
    if (!root.inThread || text.trim() === "") return
    if (!isSendable(root.active)) {
      note = "Group threads are read-only in v0.1 — send from your phone"
      return
    }
    note = "sending…"
    sendProc.command = [
      root.home + "/bin/imsg-send",
      "--to", String(root.active.handle),
      "--yes", text
    ]
    sendProc.running = true
  }

  function fmtTime(ts) {
    var s = String(ts || "")
    if (s.length < 16) return s
    var today = Qt.formatDateTime(new Date(), "yyyy-MM-dd")
    return s.substring(0, 10) === today ? s.substring(11, 16) : s.substring(5, 16)
  }

  // ------------------------------------------------------------ processes
  Process {
    id: threadProc
    stdout: StdioCollector {
      onStreamFinished: {
        root.loading = false
        try {
          var v = JSON.parse(text.trim())
          root.messages = Array.isArray(v) ? v : []
        } catch (e) {
          root.messages = []
          root.note = "could not load this thread"
        }
      }
    }
    onExited: function(code, status) {
      root.loading = false
      // 69 = the imsg shim's documented "fnix unreachable" code.
      if (code === 69) root.note = "fnix unreachable — bridge offline"
      else if (code !== 0) root.note = "imsg failed (exit " + code + ")"
    }
  }

  Process {
    id: sendProc
    onExited: function(code, status) {
      if (code === 0) {
        root.note = "sent"
        composeField.text = ""
        // Give Messages.app a beat to write the row, then reload the thread.
        reloadTimer.restart()
      } else if (code === 69) {
        root.note = "not sent — fnix unreachable"
      } else {
        root.note = "send failed (exit " + code + ")"
      }
    }
  }
  Timer {
    id: reloadTimer
    interval: 1500
    onTriggered: if (root.inThread) root.openThread(root.active)
  }

  // ------------------------------------------------------------ panel
  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: root.inThread ? composeField : keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    contentHeight: panel.fittedContentHeight(content.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.inThread ? root.back() : root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) {
        if (root.inThread || root.threads.length === 0 || dy === 0) return
        root.cursor = (root.cursor + dy + root.threads.length) % root.threads.length
      }
      onActivateRequested: if (!root.inThread && root.cursor >= 0) root.openThread(root.threads[root.cursor])
      onReturnRequested:   if (!root.inThread && root.cursor >= 0) root.openThread(root.threads[root.cursor])
      onTextKey: function(text) {
        if (root.inThread) return
        if (text === "r" || text === "R") { if (root.hostWidget) root.hostWidget.refresh(true, false) }
        else if (text >= "1" && text <= "9") {
          var i = Number(text) - 1
          if (i < root.threads.length) root.openThread(root.threads[i])
        }
      }

      Flickable {
        anchors.fill: parent
        contentWidth: width
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        ColumnLayout {
          id: content
          width: parent.width
          spacing: Style.space(10)

          // ---------------------------------------------------------- hero
          PanelHero {
            Layout.fillWidth: true
            title: root.inThread ? String(root.active.name || root.active.chat) : "Blip"
            meta: root.inThread
              ? (root.isSendable(root.active) ? String(root.active.handle) : "group · read-only")
              : (!root.online
                  ? "fnix unreachable — bridge offline"
                  : (root.unread > 0 ? root.unread + " unread" : "all caught up"))
            detail: root.inThread
              ? (root.loading ? "loading…" : root.messages.length + " recent messages")
              : "iMessage via fnix"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }

          // ---------------------------------------------------- OFFLINE
          Text {
            Layout.fillWidth: true
            visible: !root.online
            text: "fnix is not reachable, so there is no iMessage bridge right now. "
                + "chat.db and the AppleScript send path both live on fnix — vic can only ever be a client. "
                + "Wake fnix (or check Tailscale) and Blip reconnects on its own."
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          // ------------------------------------------------- LIST VIEW
          RowLayout {
            Layout.fillWidth: true
            visible: root.online && !root.inThread
            PanelSectionHeader {
              Layout.fillWidth: true
              text: "THREADS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }
            Text {
              text: root.threads.length === 0 ? "" : "click, 1–9, or j/k+Enter"
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Text {
            Layout.fillWidth: true
            visible: root.online && !root.inThread && root.threads.length === 0
            text: "No threads in the current window yet — press r to refresh."
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Repeater {
            model: root.online && !root.inThread ? root.threads : []
            delegate: Rectangle {
              required property var modelData
              required property int index

              Layout.fillWidth: true
              implicitHeight: rowCol.implicitHeight + Style.space(10)
              radius: Style.cornerRadius
              color: rowHover.hovered || root.cursor === index
                ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                : "transparent"

              HoverHandler { id: rowHover }
              TapHandler { onTapped: root.openThread(modelData) }

              ColumnLayout {
                id: rowCol
                anchors.fill: parent
                anchors.margins: Style.space(5)
                spacing: Style.space(2)

                RowLayout {
                  Layout.fillWidth: true
                  spacing: Style.space(6)

                  Text {
                    visible: modelData.unread > 0
                    text: "●"
                    color: root.cyan
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                  Text {
                    Layout.fillWidth: true
                    text: String(modelData.name || modelData.chat)
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    color: modelData.unread > 0 ? root.foreground : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    font.bold: modelData.unread > 0
                  }
                  Text {
                    text: modelData.unread > 0 ? String(modelData.unread) : ""
                    color: root.cyan
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                  }
                  Text {
                    text: root.fmtTime(modelData.last_ts)
                    textFormat: Text.PlainText
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }

                Text {
                  Layout.fillWidth: true
                  text: (modelData.last_from_me ? "you: " : "") + String(modelData.last_text || "")
                  textFormat: Text.PlainText
                  elide: Text.ElideRight
                  maximumLineCount: 1
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }
          }

          // ---------------------------------------- CONVERSATION VIEW
          Repeater {
            model: root.inThread ? root.messages : []
            delegate: ColumnLayout {
              required property var modelData

              Layout.fillWidth: true
              spacing: 0

              Text {
                Layout.fillWidth: true
                text: (modelData.from_me ? "you" : String(modelData.name || root.active.name || "them"))
                    + " · " + root.fmtTime(modelData.ts)
                textFormat: Text.PlainText
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                Layout.fillWidth: true
                text: String(modelData.text || "")
                textFormat: Text.PlainText
                wrapMode: Text.WordWrap
                color: modelData.from_me ? root.dim : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                bottomPadding: Style.space(5)
              }
            }
          }

          Text {
            Layout.fillWidth: true
            visible: root.inThread && !root.loading && root.messages.length === 0
            text: "No messages loaded for this thread."
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          // ---------------------------------------------------- COMPOSE
          PanelSeparator {
            Layout.fillWidth: true
            visible: root.inThread
            foreground: root.foreground
          }

          RowLayout {
            Layout.fillWidth: true
            visible: root.inThread
            spacing: Style.space(6)

            TextField {
              id: composeField
              Layout.fillWidth: true
              enabled: root.online && root.isSendable(root.active)
              placeholderText: root.isSendable(root.active)
                ? "Message… (Enter to send, Esc back)"
                : "Group threads are read-only in v0.1"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              background: Rectangle {
                radius: Style.cornerRadius
                color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.07)
              }
              onAccepted: root.send()
              Keys.onEscapePressed: root.back()
            }

            Text {
              text: "󰊐"
              color: composeField.text.trim() === "" ? root.dim : root.cyan
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              TapHandler { onTapped: root.send() }
            }
          }

          Text {
            Layout.fillWidth: true
            visible: root.note !== ""
            text: root.note
            textFormat: Text.PlainText
            color: root.note === "sent" ? root.okColor
                 : (root.note === "sending…" ? root.dim : root.urgent)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Text {
            Layout.fillWidth: true
            visible: root.inThread
            text: "Esc = back to threads"
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}
