import { useEffect, useRef } from "react";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, placeholder as editorPlaceholder } from "@codemirror/view";
import type { LanguageCompletion, LanguageDiagnostic } from "./kernel/protocol";
import { compileSafeJavaScript } from "./notebook/javascript";

type Props = {
  label: string;
  language: "biolang" | "javascript";
  value: string;
  onChange: (value: string) => void;
  onRun: (advance: boolean) => void;
  diagnostics?: (source: string) => Promise<LanguageDiagnostic[]>;
  completions?: (prefix: string) => Promise<LanguageCompletion[]>;
  readOnly?: boolean;
  placeholder?: string;
  knownNames?: string[];
};

function jsDiagnostics(source: string, knownNames: string[]): Diagnostic[] {
  const result = compileSafeJavaScript(source, knownNames);
  return result.ok ? [] : result.issues.map(item => ({
    from: Math.min(item.start, source.length),
    to: Math.min(Math.max(item.end, item.start + 1), source.length),
    severity: "error",
    message: item.message,
    source: "BioLang JS",
  }));
}

export function CodeEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    if (!host.current) return;
    const complete = async (context: CompletionContext): Promise<CompletionResult | null> => {
      const before = context.matchBefore(/[A-Za-z_$][\w$]*$/);
      if (!before && !context.explicit) return null;
      const prefix = before?.text ?? "";
      const values = await callbacks.current.completions?.(prefix) ?? [];
      const currentNames = Array.from(
        context.state.doc.toString().matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g),
        match => match[1],
      );
      const knownNames = [...(callbacks.current.knownNames ?? []), ...currentNames]
        .filter(name => !prefix || name.startsWith(prefix));
      const options = values.map(item => ({
        label: item.label, apply: item.insertText, detail: item.detail,
        type: item.kind === "function" ? "function" : "keyword",
      }));
      const labels = new Set(options.map(option => option.label));
      for (const name of knownNames) {
        if (!labels.has(name)) {
          options.push({ label: name, apply: name, detail: "notebook variable", type: "variable" });
          labels.add(name);
        }
      }
      return {
        from: before?.from ?? context.pos,
        options,
      };
    };
    const liveLint = linter(async current => {
      const source = current.state.doc.toString();
      if (!source.trim()) return [];
      if (callbacks.current.language === "javascript") return jsDiagnostics(source, callbacks.current.knownNames ?? []);
      const items = await callbacks.current.diagnostics?.(source) ?? [];
      return items.map(item => ({
        from: Math.min(item.start, source.length),
        to: Math.min(Math.max(item.end, item.start + 1), source.length),
        severity: item.severity === "information" ? "info" : item.severity,
        message: item.message,
        source: "BioLang",
      }));
    }, { delay: 260 });
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(), history(), lintGutter(), liveLint,
          autocompletion({ override: [complete], activateOnTyping: true }),
          keymap.of([
            { key: "Mod-Enter", run: () => { callbacks.current.onRun(false); return true; } },
            { key: "Shift-Enter", run: () => { callbacks.current.onRun(true); return true; } },
            { key: "Tab", run: editor => { editor.dispatch(editor.state.replaceSelection("  ")); return true; } },
            ...defaultKeymap, ...historyKeymap,
          ]),
          language.current.of(props.language === "javascript" ? javascript({ jsx: false, typescript: false }) : []),
          editable.current.of(EditorView.editable.of(!props.readOnly)),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": props.label, spellcheck: "false" }),
          props.placeholder ? editorPlaceholder(props.placeholder) : [],
          EditorView.updateListener.of(update => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    return () => { view.current?.destroy(); view.current = null; };
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current) return;
    const existing = current.state.doc.toString();
    if (existing !== props.value) current.dispatch({ changes: { from: 0, to: existing.length, insert: props.value } });
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        language.current.reconfigure(props.language === "javascript" ? javascript({ jsx: false, typescript: false }) : []),
        editable.current.reconfigure(EditorView.editable.of(!props.readOnly)),
      ],
    });
  }, [props.language, props.readOnly]);

  useEffect(() => {
    view.current?.contentDOM.setAttribute("aria-label", props.label);
  }, [props.label]);

  return <div ref={host} className="code-editor codemirror-editor" data-language={props.language} data-readonly={props.readOnly ? "true" : "false"} />;
}
