/**
 * Verify tree: lifecycle/class/filename/INDEX. Links: check-markdown-links.mjs.
 * Run: node scripts/verify-agent-note-tree.ts
 */
import { walkAgentNoteTree } from "./agent-note-tree.ts";

// 链接统一由 Markdown 解析器检查，避免正则把代码示例当成真实链接。
const { notes, errors } = walkAgentNoteTree();

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

console.log(`ok: ${notes.length} note(s) tree verified`);
