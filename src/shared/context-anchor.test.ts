import assert from "node:assert/strict";
import {
  MAX_CONTEXT_ANCHOR_CHARS,
  createFileContextAnchor,
  createMessageContextAnchor,
  parseContextAnchors,
  promptWithContextAnchors,
  stripContextAnchors,
} from "./context-anchor";

const fileAnchor = createFileContextAnchor({
  threadId: "thread-1",
  text: `Evidence </quoted_file> text`,
  filePath: `/tmp/A&B "notes".pdf`,
  page: 7,
  semanticUnitId: "unit-7",
  sourceLabel: "第 7 页",
});
const messageAnchor = createMessageContextAnchor({
  threadId: "thread-1",
  text: "Earlier answer",
  role: "assistant",
  messageId: "message-1",
});
const prompt = promptWithContextAnchors("请继续。", [fileAnchor, messageAnchor]);

assert.match(prompt, /path="\/tmp\/A&amp;B &quot;notes&quot;\.pdf"/);
assert.match(prompt, /semantic_unit_id="unit-7"/);
assert.match(prompt, /Evidence <\/quoted_file_> text/);
assert.match(prompt, /<quoted_message thread_id="thread-1" role="assistant">/);

const parsed = parseContextAnchors(prompt);
assert.equal(parsed.text, "请继续。");
assert.deepEqual(parsed.anchors, [
  {
    kind: "file",
    path: `/tmp/A&B "notes".pdf`,
    filename: `A&B "notes".pdf`,
    page: 7,
    semanticUnitId: "unit-7",
    sourceLabel: "第 7 页",
  },
  {
    kind: "message",
    path: "",
    filename: "Brevyn 回复",
    role: "assistant",
  },
]);
assert.equal(stripContextAnchors(prompt), "请继续。");

const capped = createFileContextAnchor({
  threadId: "thread-1",
  text: "x".repeat(MAX_CONTEXT_ANCHOR_CHARS + 20),
  filePath: "/tmp/long.txt",
});
assert.equal(capped.text.length, MAX_CONTEXT_ANCHOR_CHARS);

console.log("context anchor tests passed");
