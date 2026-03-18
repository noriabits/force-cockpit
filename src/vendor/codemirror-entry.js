import { EditorView, lineNumbers, keymap, placeholder, drawSelection, highlightSpecialChars } from '@codemirror/view';
import { EditorState, Compartment, Transaction } from '@codemirror/state';
import { defaultKeymap, indentWithTab, history, historyKeymap, undo, redo, indentMore, indentLess } from '@codemirror/commands';
import {
  syntaxHighlighting,
  HighlightStyle,
  StreamLanguage,
} from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { java } from '@codemirror/lang-java';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { tags } from '@lezer/highlight';

window.CodeMirrorBundle = {
  EditorView,
  EditorState,
  Compartment,
  Transaction,
  lineNumbers,
  keymap,
  placeholder,
  drawSelection,
  highlightSpecialChars,
  defaultKeymap,
  indentWithTab,
  history,
  historyKeymap,
  undo,
  redo,
  indentMore,
  indentLess,
  syntaxHighlighting,
  HighlightStyle,
  StreamLanguage,
  javascript,
  java,
  shell,
  tags,
};
