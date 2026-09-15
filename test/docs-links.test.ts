import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('Markdown checks files, Chinese/duplicate anchors, references and skips fenced examples/external URLs', () => {
  const checker=resolve('scripts/check-markdown-links.mjs');
  assert(existsSync(checker),'缺少全项目 Markdown 链接检查器');
  const root=mkdtempSync(resolve('work/docs-links-'));
  try {
    mkdirSync(join(root,'docs'));
    assert.equal(spawnSync('git',['init','--quiet',root]).status,0);
    writeFileSync(join(root,'.gitignore'),'codex-session-*.md\n');
    writeFileSync(join(root,'codex-session-private.md'),'[ignored](missing-secret.md)\n');
    writeFileSync(join(root,'docs/target.md'),'# 中文标题\n\n## Hello `code`!\n\n## Hello `code`!\n\n## A &copy; B\n\n## `&amp;`\n\nSetext\n------\n\n<a id="custom"></a>\n');
    writeFileSync(join(root,'docs/with space.md'),'# 空格\n');
    const valid='# 首页\n\n[中文](docs/target.md#中文标题)\n[重复](docs/target.md#hello-code-1)\n[literal](docs/target.md#amp)\n[entity](docs/target.md#a--b)\n[setext](docs/target.md#setext)\n[html](docs/target.md#custom)\n[空格](<docs/with space.md#空格>)\n[自引](#首页)\n[ref][target]\n\n[target]: docs/target.md#hello-code\n\n[remote](https://example.invalid/nope)\n`[inline](missing.md)`\n\n```md\n[example](missing.md)\n```\n\n~~~md\n[example](missing2.md)\n~~~\n';
    writeFileSync(join(root,'README.md'),valid);
    let result=spawnSync(process.execPath,[checker,root],{encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);
    for(const bad of ['![bad](missing.png)','[bad](missing.md)','[bad](docs/target.md#missing)','[bad](#missing)','[ref][bad]\n\n[bad]: docs/target.md#missing']) {
      writeFileSync(join(root,'README.md'),valid+'\n'+bad+'\n');
      result=spawnSync(process.execPath,[checker,root],{encoding:'utf8'});
      assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,/README.md/);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});
