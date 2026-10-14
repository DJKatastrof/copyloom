const command = /^(?:Get|Set|New|Remove|Invoke|Import|Export|Write|Read|Connect|Disconnect|Test|Start|Stop|ForEach|Where|Select|Sort|Measure|Add|Clear|Copy|Move|Join|Split|ConvertFrom|ConvertTo|Out|Format|Enable|Disable|Register|Unregister|Update|Install|Uninstall)-[a-z][a-z0-9]*(?:\s|$)/i;

export function isPowerShell(content: string): boolean {
  return content.split(/\r?\n/).some(line => {
    const text = line.trim();
    return /^#requires\s/i.test(text) || /^param\s*\(/i.test(text)
      || /^\$[a-z_]\w*(?:\.\w+)*\s*=/im.test(text)
      || /^\$[a-z_]\w*\s*\|/i.test(text)
      || /^\[(?:string|bool|int|switch|hashtable|datetime|pscustomobject|psobject)(?:\[\])?\]\s*\$/i.test(text)
      || /^\[(?:pscustomobject|hashtable)\]\s*@\{/i.test(text)
      || command.test(text);
  });
}

export const LANGUAGE_LABELS = {
  sql: 'SQL', powershell: 'PowerShell', typescript: 'TypeScript', javascript: 'JavaScript',
  python: 'Python', bash: 'Bash', csharp: 'C#', java: 'Java', rust: 'Rust', go: 'Go',
  xml: 'HTML / XML', css: 'CSS', json: 'JSON', yaml: 'YAML', php: 'PHP',
} as const;
export type CodeLanguage = keyof typeof LANGUAGE_LABELS;

// Inspect a bounded sample, without loading syntax grammars on the startup path.
// Specific syntax is required; a word such as "SELECT" in a note is insufficient.
export function detectCodeLanguage(content: string): CodeLanguage | undefined {
  const sample = content.slice(0, 16000).trim();
  if (!sample) return undefined;
  if (/^#!.*\b(?:bash|sh|zsh)\b/.test(sample)) return 'bash';
  if (/^<\?php\b/.test(sample)) return 'php';
  if (/^[{\[]/.test(sample) && sample.length < 16000) {
    try {
      const value: unknown = JSON.parse(sample);
      if (value !== null && typeof value === 'object') return 'json';
    } catch { /* A partial object may belong to another language. */ }
  }
  const text = sample.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '').replace(/^\s*(?:\/\/|--|#(?!requires\b|!)).*$/gmi, '').trim();
  const select = /^\s*SELECT\s+(?:DISTINCT\s+)?([\s\S]+?)\bFROM\s+[\w["`]/im.exec(text);
  const sqlProjection = select?.[1].trim();
  if ((sqlProjection && (/^[\w.\[\]"`]+$/.test(sqlProjection) || /[*(),@+]|\sAS\s/i.test(sqlProjection)))
    || /^\s*(?:INSERT\s+INTO|DELETE\s+FROM|CREATE\s+(?:TABLE|PROCEDURE|VIEW)|ALTER\s+TABLE|DROP\s+TABLE)\s+[\w["`]/im.test(text)
    || /^\s*UPDATE\s+[\w.\[\]]+\s+SET\s+\w+\s*=/im.test(text)
    || /^\s*DECLARE\s+@\w+\s+\w+/im.test(text)
    || /^\s*SELECT\s+(?:\d+|@@\w+|COUNT\s*\()/im.test(text)) return 'sql';
  if (isPowerShell(text)) return 'powershell';
  if (/^\s*(?:from\s+[\w.]+\s+import\s+|(?:async\s+)?def\s+\w+\s*\([^)]*\)\s*(?:->[^:]+)?:|class\s+\w+(?:\([^)]*\))?\s*:)/m.test(text)) return 'python';
  if (/^\s*(?:using\s+System(?:\.[\w.]+)?\s*;|namespace\s+[\w.]+\s*[;{]|(?:public|private|internal)\s+(?:sealed\s+)?record\s+\w+)/m.test(text)
    && !/^\s*(?:package\s+[\w.]+;|import\s+java\.)/m.test(text)) return 'csharp';
  if (/^\s*(?:package\s+[\w.]+\s*;|import\s+(?:java|javax|org)\.[\w.*]+\s*;)/m.test(text)
    || /\bpublic\s+static\s+void\s+main\s*\(/.test(text)) return 'java';
  if (/^\s*(?:(?:pub\s+)?(?:async\s+)?fn\s+\w+\s*\(|use\s+\w+::|impl(?:<[^>]+>)?\s+\w+)/m.test(text)) return 'rust';
  if (/^\s*(?:package\s+\w+\s*$|func\s+(?:\([^)]*\)\s*)?\w+\s*\()/m.test(text)) return 'go';
  if (/^\s*(?:export\s+)?(?:interface\s+\w+\s*[<{]|type\s+\w+(?:<[^>]+>)?\s*=)/m.test(text)
    || /\b(?:const|let)\s+\w+\s*:\s*[\w[<{]/.test(text)
    || /\([^)]*\b\w+\s*:\s*(?:string|number|boolean|unknown)\b[^)]*\)/.test(text)) return 'typescript';
  if (/^\s*(?:(?:export\s+)?(?:const|let|var)\s+\w+\s*=|(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|import\s+.+\s+from\s+['"])/m.test(text)
    || /\bconsole\.log\s*\(/.test(text) || /\([^)]*\)\s*=>/.test(text)) return 'javascript';
  if (/<(?:!doctype\s+html|\?xml|html|head|body|div|span|section|script)\b/i.test(text)
    || /<([a-z][\w:-]*)[^>]*>[\s\S]*<\/\1>/i.test(text)) return 'xml';
  if (/(?:^|})\s*[.#@]?[\w.#:\s>+,[\]="'-]+\{\s*[\w-]+\s*:\s*[^{};]+[;}]/m.test(text)) return 'css';
  if (/^\s*(?:if\s+\[|(?:for\s+\w+\s+in\s+.+;\s*do)|(?:export\s+)?\w+=['"])/m.test(text)
    || /^\s*(?:sudo\s+)?(?:echo|printf|grep|sed|awk|chmod|curl)\s+(?:[-$'"/]|.+\|)/m.test(text)) return 'bash';
  const yamlLines = text.split('\n').filter(line => /^\s*[\w.-]+:\s+(?:\S.*)?$/.test(line));
  if (yamlLines.length >= 2 && !/[{};]/.test(text) && /^(?:---\s*$|\s{2,}\S|\s*-\s+\S)|:\s*(?:true|false|null|\d+)\s*$/m.test(text) && /^\s*[\w.-]+:/m.test(text)) return 'yaml';
  return undefined;
}

// Shorten only long introductory comments in the preview, never in clipboard data.
export function codePreview(content: string): string {
  const sample = content.slice(0, 16000);
  const block = /^\s*(?:\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|<#[\s\S]*?#>)/.exec(sample);
  if (block && block[0].split('\n').length >= 5 && sample.slice(block[0].length).trim()) {
    const marker = block[0].trimStart().startsWith('<!--') ? '<!-- … -->'
      : block[0].trimStart().startsWith('<#') ? '<# … #>' : '/* … */';
    return (marker + '\n' + content.slice(block[0].length).trimStart()).slice(0, 5000);
  }
  return content.slice(0, 5000);
}
