package expo.modules.ras_code.nativecontrols

import android.content.Context
import android.view.KeyEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class RasCodeKeyboardCommandsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RasCodeKeyboardCommands")

    View(RasCodeKeyboardCommandsView::class) {
      Prop("enabledCommands") { view: RasCodeKeyboardCommandsView, commands: List<String> ->
        view.enabledCommands = commands.toSet()
      }
      Events("onCommand")
    }
  }
}

class RasCodeKeyboardCommandsView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private val onCommand by EventDispatcher()
  var enabledCommands = emptySet<String>()

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val copiesThreadReference =
      event.action == KeyEvent.ACTION_DOWN &&
        event.repeatCount == 0 &&
        event.keyCode == KeyEvent.KEYCODE_C &&
        event.isCtrlPressed &&
        event.isShiftPressed &&
        !event.isAltPressed &&
        enabledCommands.contains("copyThreadReference")
    if (copiesThreadReference) {
      onCommand(mapOf("command" to "copyThreadReference"))
      return true
    }
    return super.dispatchKeyEvent(event)
  }
}
