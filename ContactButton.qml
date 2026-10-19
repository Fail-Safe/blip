import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Commons as Commons

// Contact actions share the panel typography and wrap at the available width.
QQC.Button {
  id: root
  property color foreground: Commons.Color.foreground
  property color accent: "#0a84ff"
  property string fontFamily: Style.font.family
  property real fontSize: Style.font.bodySmall
  padding: Style.space(8)
  horizontalPadding: Style.space(10)
  implicitWidth: actionLabel.implicitWidth + leftPadding + rightPadding
  implicitHeight: actionLabel.implicitHeight + topPadding + bottomPadding
  contentItem: Text {
    id: actionLabel
    text: root.text
    textFormat: Text.PlainText
    font.family: root.fontFamily
    font.pixelSize: root.fontSize
    wrapMode: Text.WordWrap
    horizontalAlignment: Text.AlignHCenter
    verticalAlignment: Text.AlignVCenter
    color: root.enabled ? root.foreground : Qt.darker(root.foreground, 1.6)
  }
  background: Rectangle {
    radius: Style.cornerRadius
    color: root.hovered || root.down ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.12) : "transparent"
    border.width: 1
    border.color: root.activeFocus ? root.accent : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.3)
  }
}
