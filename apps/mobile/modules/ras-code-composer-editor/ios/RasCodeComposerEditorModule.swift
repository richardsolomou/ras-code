import ExpoModulesCore

public class RasCodeComposerEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RasCodeComposerEditor")

    View(RasCodeComposerEditorView.self) {
      Prop("controlledDocumentJson") { (view: RasCodeComposerEditorView, documentJson: String) in
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { (view: RasCodeComposerEditorView, themeJson: String) in
        view.setThemeJson(themeJson)
      }
      Prop("placeholder") { (view: RasCodeComposerEditorView, placeholder: String) in
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { (view: RasCodeComposerEditorView, fontFamily: String) in
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { (view: RasCodeComposerEditorView, fontSize: Double) in
        view.setFontSize(CGFloat(fontSize))
      }
      Prop("lineHeight") { (view: RasCodeComposerEditorView, lineHeight: Double) in
        view.setLineHeight(CGFloat(lineHeight))
      }
      Prop("contentInsetVertical") { (view: RasCodeComposerEditorView, contentInsetVertical: Double) in
        view.setContentInsetVertical(CGFloat(contentInsetVertical))
      }
      Prop("editable") { (view: RasCodeComposerEditorView, editable: Bool) in
        view.setEditable(editable)
      }
      Prop("readOnly") { (view: RasCodeComposerEditorView, readOnly: Bool) in
        view.setReadOnly(readOnly)
      }
      Prop("scrollEnabled") { (view: RasCodeComposerEditorView, scrollEnabled: Bool) in
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { (view: RasCodeComposerEditorView, autoFocus: Bool) in
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { (view: RasCodeComposerEditorView, autoCorrect: Bool) in
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { (view: RasCodeComposerEditorView, spellCheck: Bool) in
        view.setSpellCheck(spellCheck)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerSubmit",
        "onComposerPasteImages",
        "onComposerContentSizeChange"
      )

      AsyncFunction("focus") { (view: RasCodeComposerEditorView) in
        view.focusEditor()
      }
      AsyncFunction("blur") { (view: RasCodeComposerEditorView) in
        view.blurEditor()
      }
      AsyncFunction("setSelection") { (view: RasCodeComposerEditorView, start: Int, end: Int) in
        view.setSelection(start: start, end: end)
      }
    }
  }
}
