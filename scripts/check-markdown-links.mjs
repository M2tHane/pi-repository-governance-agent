// 检查根目录、docs/ 和长期设计决策中的本地 Markdown 链接。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { marked } from 'marked';
import GithubSlugger from 'github-slugger';
import { decodeHTML } from 'entities';

const root = resolve(process.argv[2] ?? '.');
let files = [];
function collect(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(path);
  }
}
let gitRoot;
try { gitRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
if (gitRoot === root) {
  const paths = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {encoding:'utf8'}).split('\0');
  files = [...new Set(paths)].filter(path => /\.md$/i.test(path) && (!path.includes('/') || path.startsWith('docs/') || path.startsWith('.agents/decisions/'))).map(path => join(root,path)).filter(existsSync);
} else {
  files = readdirSync(root).filter(name => /\.md$/i.test(name)).map(name => join(root,name));
  collect(join(root, 'docs'));
  collect(join(root, '.agents/decisions'));
}
const parsed = new Map();
const errors = [];
function plain(tokens) {
  return tokens.map(token => token.type === 'html' ? '' : token.tokens ? plain(token.tokens) : token.type === 'codespan' ? token.text : decodeHTML(token.text ?? '')).join('');
}
function parse(path) {
  if (parsed.has(path)) return parsed.get(path);
  const tokens = marked.lexer(readFileSync(path, 'utf8'));
  const headings = new Set(), links = [], slugger = new GithubSlugger();
  marked.walkTokens(tokens, token => {
    if (token.type === 'heading') headings.add(slugger.slug(plain(token.tokens)));
    if (token.type === 'link' || token.type === 'image') links.push(token.href);
    if (token.type === 'html') {
      const html = token.text.replace(/<!--[\s\S]*?-->/g, '');
      for (const match of html.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) headings.add(decodeHTML(match[1]));
    }
  });
  const value = { headings, links }; parsed.set(path, value); return value;
}
let linkCount = 0;
for (const file of files.sort()) {
  for (const href of parse(file).links) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
    linkCount++;
    try {
      const [destination, ...fragments] = href.split('#');
      const pathText = decodeURIComponent(destination.split('?')[0]);
      const target = pathText ? resolve(pathText.startsWith('/') ? root : dirname(file), pathText.replace(/^\//, '')) : file;
      if (!existsSync(target)) throw new Error('目标文件不存在');
      if (fragments.length && /\.md$/i.test(extname(target)) && statSync(target).isFile()) {
        const anchor = decodeURIComponent(fragments.join('#'));
        if (anchor && !parse(target).headings.has(anchor)) throw new Error(`标题锚点不存在：${anchor}`);
      }
    } catch (error) { errors.push(`${relative(root, file)} -> ${href}: ${error.message}`); }
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`ok: ${files.length} Markdown files, ${linkCount} local links and anchors verified`);
