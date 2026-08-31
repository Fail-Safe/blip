import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Blip panel — threads, then an iMessage-style conversation with a compose box.
//
//   list         → every thread, newest first, unread marked
//   conversation → bubbles: mine blue on the right, theirs grey on the left,
//                  grouped by sender with one timestamp per run, day dividers,
//                  compose box pinned at the bottom. Esc goes back.
//
// Reads its thread list from the host widget so there is exactly one poller.
// Bubble decoration (grouping, day labels, times) is computed in thread.ts,
// where it is unit-tested; this file only renders.
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

  // iMessage's own palette. Fixed on purpose — the bubbles are the whole
  // point of looking like iMessage, so they do not follow the Omarchy theme.
  readonly property color mineFill: "#0a84ff"
  readonly property color mineText: "#ffffff"
  readonly property color theirsFill: Qt.rgba(foreground.r, foreground.g, foreground.b, 0.14)
  readonly property color theirsText: foreground

  readonly property string home: Quickshell.env("HOME")
  readonly property string threadScript:
    decodeURIComponent(Qt.resolvedUrl("thread.ts").toString().replace(/^file:\/\//, ""))

  readonly property var threads: hostWidget ? hostWidget.threads : []
  readonly property bool online: hostWidget ? hostWidget.online : false
  readonly property int unread: hostWidget ? hostWidget.unread : 0

  // ---- view state
  property var active: null          // selected thread object, null = list view
  property var bubbles: []           // decorated messages for `active` (see thread.ts)
  property bool loading: false
  property string note: ""           // transient status line (send result, errors)
  property int cursor: -1            // keyboard row selection in list view
  property bool pinToBottom: false   // scroll to the newest bubble once layout settles
  property bool bubbleFocused: false // a bubble's TextEdit has focus (text selection in progress)

  readonly property bool inThread: active !== null
  readonly property bool activeIsGroup: inThread && /^[0-9a-f]{32}$/i.test(String(active.chat || ""))

  /**
   * DMs send --to the chat id (a phone/email). Groups send --chat-id with the
   * full AppleScript GUID ("any;+;<id>") that `imsg groups` supplies; a group
   * whose GUID is not cached yet stays read-only rather than guess. Never the
   * handle: a group's handle is whichever member spoke last, and sending to it
   * would DM that one person while the panel shows the group.
   */
  function isSendable(t) {
    if (!t) return false
    var c = String(t.chat || "")
    if (/^[0-9a-f]{32}$/i.test(c)) return /^[A-Za-z]+;[+-];[0-9a-f]{32}$/i.test(String(t.guid || ""))
    return /^\+?[0-9]{5,}$/.test(c) || c.indexOf("@") > 0
  }

  function open() {
    active = null
    bubbles = []
    note = ""
    cursor = -1
    // Deep fetch for a real thread list. Does NOT clear dots: like iMessage,
    // a thread stays marked until that conversation is opened.
    if (hostWidget) hostWidget.refresh(true, false)
    controller.show()
    Qt.callLater(function() { flick.contentY = 0 })
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
    bubbles = []
    note = ""
    pinToBottom = false
    Qt.callLater(function() { flick.contentY = 0; keyCatcher.forceActiveFocus() })
  }

  function openThread(t) {
    if (!t) return
    active = t
    bubbles = []
    note = ""
    loading = true
    threadProc.command = ["bun", root.threadScript, String(t.chat), "80"]
    threadProc.running = true
    if (hostWidget) hostWidget.markThreadRead(String(t.chat))
    Qt.callLater(function() { composeField.forceActiveFocus() })
  }

  function send() {
    var text = composeField.text
    if (!root.inThread || text.trim() === "") return
    if (!isSendable(root.active)) {
      note = "Read-only — group id unknown — send from your phone"
      return
    }
    note = "sending…"
    // "--" so a message that starts with "-" is text, not a flag (argparse honours it).
    sendProc.command = [
      root.home + "/bin/imsg-send",
      "--to", String(root.active.chat),
      "--yes", "--", text
    ]
    sendProc.running = true
  }

  Process { id: copyProc }
  function copyText(t) {
    if (t === "") return
    // stdin, not argv: message text can be long and can start with "-".
    copyProc.command = ["sh", "-c", "wl-copy"]
    copyProc.stdinEnabled = true
    copyProc.running = true
    copyProc.write(t)
    copyProc.stdinEnabled = false
    note = "copied"
    noteTimer.restart()
  }
  Timer { id: noteTimer; interval: 1500; onTriggered: if (root.note === "copied") root.note = "" }

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
          var d = JSON.parse(text.trim())
          if (d.ok === true) {
            root.bubbles = Array.isArray(d.bubbles) ? d.bubbles : []
            root.pinToBottom = true
          } else {
            root.bubbles = []
            root.note = String(d.error || "could not load this thread")
          }
        } catch (e) {
          root.bubbles = []
          root.note = "could not load this thread"
        }
      }
    }
    onExited: function(code, status) {
      root.loading = false
      if (code !== 0) root.note = "thread loader failed (exit " + code + ")"
    }
  }

  Process {
    id: sendProc
    onExited: function(code, status) {
      if (code === 0) {
        root.note = ""
        composeField.text = ""
        // Give Messages.app a beat to write the row, then reload the thread.
        reloadTimer.restart()
      } else if (code === 69) {
        root.note = "not sent — fnix unreachable"
      } else {
        root.note = "send failed (exit " + code + ")"
      }
      composeField.forceActiveFocus()
    }
  }
  Timer {
    id: reloadTimer
    interval: 1500
    onTriggered: if (root.inThread) {
      threadProc.command = ["bun", root.threadScript, String(root.active.chat), "80"]
      threadProc.running = true
    }
  }

  // ------------------------------------------------------------ panel
  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: root.inThread ? composeField : keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(440))
    contentHeight: panel.fittedContentHeight(root.inThread ? Style.space(640) : content.implicitHeight, Style.space(640))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // PanelKeyCatcher runs BEFORE any focused descendant (Keys.BeforeItem).
      // Without this it swallows every letter typed into the compose box.
      // Any focused editor — the compose box or a bubble being selected —
      // must receive its own keys (Ctrl+C, arrows, Esc).
      blocked: composeField.activeFocus || root.bubbleFocused
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

      ColumnLayout {
        anchors.fill: parent
        spacing: Style.space(8)

        // ---------------------------------------------------------- header
        PanelHero {
          Layout.fillWidth: true
          title: root.inThread ? String(root.active.name || root.active.chat) : "Blip"
          meta: root.inThread
            ? (root.activeIsGroup
                ? (root.isSendable(root.active) ? "group" : "group · read-only (id unknown)")
                : String(root.active.handle))
            : (!root.online
                ? "fnix unreachable — bridge offline"
                : (root.unread > 0 ? root.unread + " unread" : "all caught up"))
          detail: root.inThread
            ? (root.loading ? "loading…" : "Esc = back")
            : "iMessage via fnix"
          foreground: root.foreground
          fontFamily: root.fontFamily
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.foreground }

        // ---------------------------------------------------- scroll body
        Flickable {
          id: flick
          Layout.fillWidth: true
          Layout.fillHeight: true
          contentWidth: width
          contentHeight: content.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
          // Layout height lands a frame or two after `bubbles` changes; a
          // one-shot callLater under-scrolled. Follow the height instead.
          onContentHeightChanged: if (root.pinToBottom && root.inThread) {
            contentY = Math.max(0, contentHeight - height)
            if (!root.loading) root.pinToBottom = false
          }

          ColumnLayout {
            id: content
            width: parent.width
            spacing: root.inThread ? Style.space(2) : Style.space(6)

            // ------------------------------------------------- OFFLINE
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

            // ---------------------------------------------- LIST VIEW
            RowLayout {
              Layout.fillWidth: true
              visible: root.online && !root.inThread
              PanelSectionHeader {
                Layout.fillWidth: true
                text: "MESSAGES"
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
                implicitHeight: rowRow.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: rowHover.hovered || root.cursor === index
                  ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                  : "transparent"

                HoverHandler { id: rowHover }
                TapHandler { onTapped: root.openThread(modelData) }

                RowLayout {
                  id: rowRow
                  anchors.fill: parent
                  anchors.margins: Style.space(6)
                  spacing: Style.space(8)

                  // the iMessage blue dot — present only while the thread has
                  // unread inbound; the slot stays so names line up.
                  Rectangle {
                    width: Style.space(9); height: width; radius: width / 2
                    color: root.mineFill
                    opacity: modelData.unread > 0 ? 1 : 0
                  }

                  // avatar circle with initials — the iMessage sidebar look
                  Rectangle {
                    width: Style.space(30); height: width; radius: width / 2
                    color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.18)
                    Text {
                      anchors.centerIn: parent
                      text: {
                        var n = String(modelData.name || "")
                        if (/^[+0-9]/.test(n) || n === "") return "#"
                        var parts = n.trim().split(/\s+/)
                        return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
                      }
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: true
                    }
                  }

                  ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Style.space(1)
                    RowLayout {
                      Layout.fillWidth: true
                      spacing: Style.space(6)
                      Text {
                        Layout.fillWidth: true
                        text: String(modelData.name || modelData.chat)
                        textFormat: Text.PlainText
                        elide: Text.ElideRight
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                        font.bold: modelData.unread > 0
                      }
                      Text {
                        text: root.fmtTime(modelData.last_ts)
                        textFormat: Text.PlainText
                        color: modelData.unread > 0 ? root.mineFill : root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                      }
                    }
                    Text {
                      Layout.fillWidth: true
                      text: (modelData.last_from_me ? "You: " : "") + String(modelData.last_text || "")
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
            }

            // ------------------------------------------- CONVERSATION
            Text {
              Layout.fillWidth: true
              visible: root.inThread && root.loading
              text: "loading…"
              horizontalAlignment: Text.AlignHCenter
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Repeater {
              model: root.inThread ? root.bubbles : []
              delegate: ColumnLayout {
                id: bubbleRow
                required property var modelData
                readonly property bool mine: modelData.from_me === true

                Layout.fillWidth: true
                spacing: Style.space(2)

                // day divider — "Today", "Yesterday", "Aug 28"
                Text {
                  Layout.fillWidth: true
                  visible: String(modelData.day || "") !== ""
                  text: String(modelData.day || "")
                  horizontalAlignment: Text.AlignHCenter
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                  topPadding: Style.space(10)
                  bottomPadding: Style.space(4)
                }

                // in a group, iMessage names the sender above each run of theirs
                Text {
                  Layout.alignment: Qt.AlignLeft
                  Layout.leftMargin: Style.space(10)
                  Layout.topMargin: Style.space(6)
                  visible: root.activeIsGroup && !bubbleRow.mine && modelData.groupStart === true
                  text: String(modelData.name || "")
                  textFormat: Text.PlainText
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                // the bubble itself. Width comes from the laid-out text
                // (contentWidth), never the unwrapped implicitWidth — a long
                // line would otherwise overshoot the cap and break alignment.
                Rectangle {
                  id: bubble
                  readonly property real maxInner: Math.round(content.width * 0.78) - Style.space(22)
                  Layout.alignment: bubbleRow.mine ? Qt.AlignRight : Qt.AlignLeft
                  Layout.topMargin: modelData.groupStart ? Style.space(6) : 0
                  Layout.preferredWidth: Math.ceil(bubbleText.contentWidth) + Style.space(22)
                  Layout.preferredHeight: Math.ceil(bubbleText.contentHeight) + Style.space(14)
                  radius: Style.space(16)
                  color: bubbleRow.mine ? root.mineFill : root.theirsFill

                  // iMessage squares off the corner nearest the sender on the
                  // last bubble of a run — the "tail" without drawing a tail.
                  Rectangle {
                    visible: modelData.groupEnd === true
                    width: Style.space(16); height: Style.space(16)
                    color: bubble.color
                    anchors.bottom: parent.bottom
                    anchors.right: bubbleRow.mine ? parent.right : undefined
                    anchors.left: bubbleRow.mine ? undefined : parent.left
                  }                  // TextEdit, not Text: read-only but selectable, so a message
                  // can be highlighted and Ctrl+C'd like any other text.
                  TextEdit {
                    id: bubbleText
                    x: Style.space(11); y: Style.space(7)
                    width: bubble.maxInner
                    text: String(modelData.text || "")
                    textFormat: TextEdit.PlainText
                    wrapMode: TextEdit.Wrap
                    readOnly: true
                    selectByMouse: true
                    persistentSelection: false
                    color: bubbleRow.mine ? root.mineText : root.theirsText
                    selectionColor: bubbleRow.mine ? "#ffffff" : root.mineFill
                    selectedTextColor: bubbleRow.mine ? root.mineFill : "#ffffff"
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    // Focus goes to the bubble while selecting; the key catcher
                    // is blocked for any focused editor (see below).
                    onActiveFocusChanged: root.bubbleFocused = activeFocus
                    Keys.onEscapePressed: { deselect(); composeField.forceActiveFocus() }
                  }

                  // right-click = copy the whole message
                  TapHandler {
                    acceptedButtons: Qt.RightButton
                    onTapped: root.copyText(String(modelData.text || ""))
                  }
                }

                // timestamp under the last bubble of a run
                Text {
                  Layout.alignment: bubbleRow.mine ? Qt.AlignRight : Qt.AlignLeft
                  Layout.rightMargin: bubbleRow.mine ? Style.space(6) : 0
                  Layout.leftMargin: bubbleRow.mine ? 0 : Style.space(6)
                  visible: String(modelData.time || "") !== ""
                  text: String(modelData.time || "")
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  bottomPadding: Style.space(4)
                }
              }
            }

            Text {
              Layout.fillWidth: true
              visible: root.inThread && !root.loading && root.bubbles.length === 0
              text: "No messages loaded for this thread."
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        // ------------------------------------------------------ COMPOSE
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
            placeholderText: root.isSendable(root.active) ? "iMessage" : "Read-only — group id unknown"
            foreground: root.foreground
            accent: root.mineFill
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            onAccepted: root.send()
            Keys.onEscapePressed: root.back()
          }

          // send button — the blue arrow circle
          Rectangle {
            width: Style.space(28); height: width; radius: width / 2
            color: composeField.text.trim() === "" ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.15) : root.mineFill
            Text {
              anchors.centerIn: parent
              text: "↑"
              color: composeField.text.trim() === "" ? root.dim : "#ffffff"
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }
            TapHandler { onTapped: root.send() }
          }
        }

        Text {
          Layout.fillWidth: true
          visible: root.note !== ""
          text: root.note
          textFormat: Text.PlainText
          color: root.note === "sending…" ? root.dim : root.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }
}
