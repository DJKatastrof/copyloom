import { memo, useMemo, type ReactNode } from 'react';
import powershell from 'highlight.js/lib/languages/powershell';
import { codePreview, type CodeLanguage } from '../domain/code';
import { createLowlight } from 'lowlight';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import csharp from 'highlight.js/lib/languages/csharp';
import java from 'highlight.js/lib/languages/java';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import php from 'highlight.js/lib/languages/php';
import type { Element, RootContent } from 'hast';

const highlighter = createLowlight({ typescript, javascript, json, css, sql, python, bash, powershell, csharp, java, rust, go, xml, yaml, php });

function renderToken(node: RootContent, key: number): ReactNode {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return null;
  const element = node as Element;
  const classNames = element.properties.className;
  return <span key={key} className={Array.isArray(classNames) ? classNames.join(' ') : undefined}>{element.children.map(renderToken)}</span>;
}

// A card shows about fifteen lines, the preview pane the whole clip; both stay bounded. The clipboard content is never changed.
const CARD_CODE = 1200, FULL_CODE = 40000;
function CodePreview({ content, language, full = false }: { content: string; language?: CodeLanguage; full?: boolean }) {
  const preview = full ? content.slice(0, FULL_CODE) : codePreview(content).slice(0, CARD_CODE);
  const tree = useMemo(() => language ? highlighter.highlight(language, preview) : undefined, [preview, language]);
  return <pre className="code-preview"><code data-language={language}>{tree ? tree.children.map(renderToken) : preview}</code></pre>;
}

export default memo(CodePreview);
