"use strict";
const {
  Plugin, PluginSettingTab, ItemView, TextFileView, MarkdownView, MarkdownRenderer, MarkdownRenderChild, Component, debounce, moment,
  Menu, Modal, Setting, Notice, Keymap, Scope, TFile, TFolder, setIcon, getIconIds, normalizePath,
} = require("obsidian");

const VIEW_TYPE = "kanplete-board";
const NEW_BOARD = "---\nkanban: true\n---\n\n## To do\n\n## Doing\n\n## Done\n";
const DEFAULT_SETTINGS = {
  columnWidth: 280, autoDone: true, defaultLayout: "columns", collapsed: {}, layouts: {}, donePiles: {},
  staleDays: 21, journalLog: false, lastCapture: null,
};
const DUE_RE = /(^|\s)@(\d{4}-\d{2}-\d{2})(?=\s|$)/;
const MAX_HISTORY = 100;

// =====================================================================
// markdown <-> board
// =====================================================================

function parseBoard(text) {
  let fm = "";
  let body = text;
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  if (m) { fm = m[0]; body = text.slice(m[0].length); }

  const preamble = [];
  const columns = [];
  let col = null;
  let card = null;

  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) { col = { title: h[1].trim(), notes: [], cards: [] }; columns.push(col); card = null; continue; }
    if (!col) { preamble.push(line); continue; }
    const c = line.match(/^[-*+]\s+(?:\[([^\]])\]\s*)?(.*)$/);
    if (c) {
      card = { checked: c[1] === undefined ? null : c[1] !== " ", text: c[2], extra: [] };
      col.cards.push(card);
      continue;
    }
    if (card && /^\s+\S/.test(line)) { card.extra.push(line); continue; }
    if (line.trim()) { card = null; col.notes.push(line); }
  }
  // the archive is a hidden section, kept apart from the real columns
  const ai = columns.findIndex(isArchiveCol);
  const archive = ai >= 0 ? columns.splice(ai, 1)[0] : null;
  return { fm, preamble: preamble.join("\n").trim(), columns, archive };
}

function serializeBoard(b) {
  let out = b.fm;
  if (out && !out.endsWith("\n")) out += "\n";
  if (b.preamble) out += "\n" + b.preamble + "\n";
  const all = b.archive && b.archive.cards.length ? [...b.columns, b.archive] : b.columns;
  for (const col of all) {
    out += `\n## ${col.title}\n`;
    if (col.notes.length || col.cards.length) out += "\n";
    for (const n of col.notes) out += n + "\n";
    if (col.notes.length && col.cards.length) out += "\n";
    for (const c of col.cards) {
      const box = c.checked === null ? "" : c.checked ? "[x] " : "[ ] ";
      out += `- ${box}${c.text}\n`;
      for (const e of c.extra) out += e + "\n";
    }
  }
  return out;
}

function dedent(lines) {
  const ind = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
  const min = ind.length ? Math.min(...ind) : 0;
  return lines.map((l) => l.slice(min));
}

function cardSource(card) {
  return [card.text, ...dedent(card.extra)].join("\n");
}

function setCardSource(card, src) {
  const lines = src.split(/\r?\n/).filter((l) => l.trim());
  card.text = (lines.shift() || "").trim();
  card.extra = lines.map((l) => "    " + l);
}

// ----- due dates: "@2026-11-20" anywhere in the first line of a card -----

function getDue(card) {
  const m = card.text.match(DUE_RE);
  return m ? m[2] : null;
}

function stripDue(s) {
  return s.replace(DUE_RE, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

function setDue(card, iso) {
  card.text = stripDue(card.text);
  if (iso) card.text = `${card.text} @${iso}`.trim();
}

function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dueInfo(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const due = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((due - today) / 86400000);
  let label;
  if (diff === 0) label = "Today";
  else if (diff === 1) label = "Tomorrow";
  else if (diff === -1) label = "Yesterday";
  else {
    const opts = { month: "short", day: "numeric" };
    if (due.getFullYear() !== today.getFullYear()) opts.year = "numeric";
    label = due.toLocaleDateString(undefined, opts);
  }
  return { label, diff, state: diff < 0 ? "overdue" : diff <= 1 ? "soon" : "later" };
}

function isDoneColumn(col) {
  return /^(done|complete|completed|finished)$/i.test(colName(col));
}

// ----- column icons: "## Doing [icon:: hammer]" -----

// icons used when a column hasn't been given one (matched on its name)
const DEFAULT_COL_ICONS = {
  "to do": "circle", "todo": "circle", "to-do": "circle", "tasks": "circle",
  "backlog": "inbox", "inbox": "inbox",
  "next": "circle-arrow-right", "up next": "circle-arrow-right",
  "doing": "loader", "in progress": "loader", "wip": "loader", "active": "loader", "working": "loader",
  "blocked": "circle-pause", "waiting": "circle-pause", "on hold": "circle-pause",
  "review": "eye", "testing": "eye",
  "ideas": "lightbulb",
  "later": "clock", "someday": "clock",
  "done": "circle-check", "complete": "circle-check", "completed": "circle-check", "finished": "circle-check",
};
const PILE_ICON = "circle-check";

function colName(col) {
  return stripFields(col.title);
}

// the done pile always shows the check; "[icon:: none]" hides a default
function colIcon(col, isPile) {
  if (isPile) return PILE_ICON;
  const set = getField(col.title, "icon");
  if (set) return set.toLowerCase() === "none" ? null : set;
  return DEFAULT_COL_ICONS[colName(col).toLowerCase()] || null;
}

function setColField(col, key, value) {
  col.title = withField(col.title, key, value);
}

function setColIcon(col, icon) {
  if (!icon && DEFAULT_COL_ICONS[colName(col).toLowerCase()]) icon = "none";
  col.title = withField(col.title, "icon", icon);
}

// ----- card metadata: [color:: x] [icon:: y] fields, #tags, subtasks -----

const CARD_COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray"];
const FIELDS_RE = /[ \t]*\[(color|icon|archive|archived|from|id|blockedby|updated)::[^\]]*\]/gi;
const TAG_RE = /(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const SUBTASK_RE = /^[-*+]\s+\[([^\]])\]\s*(.*)$/;

function fieldRe(key, flags = "i") {
  return new RegExp(`[ \\t]*\\[${key}::\\s*([^\\]]*?)\\s*\\]`, flags);
}

function getField(text, key) {
  const m = text.match(fieldRe(key));
  return m && m[1] ? m[1] : null;
}

// Set "[key:: value]" in a line of text: updated where it already sits (so the
// markdown doesn't reshuffle), appended if new, removed when value is empty.
function withField(text, key, value) {
  const re = fieldRe(key);
  if (value && re.test(text)) {
    let first = true;
    return text.replace(fieldRe(key, "gi"), (m) => {
      if (!first) return "";
      first = false;
      return m.replace(/\[[^\]]*\]/, `[${key}:: ${value}]`);
    }).trim();
  }
  text = text.replace(fieldRe(key, "gi"), "").trim();
  return value ? `${text} [${key}:: ${value}]` : text;
}

function setField(card, key, value) {
  card.text = withField(card.text, key, value);
}

function stripFields(text) {
  return text.replace(FIELDS_RE, "").trim();
}

function getTags(text) {
  const tags = [];
  for (const m of stripFields(text).matchAll(TAG_RE)) if (!tags.includes(m[2])) tags.push(m[2]);
  return tags;
}

function stripMeta(text) {
  return stripDue(stripFields(text)).replace(TAG_RE, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

function cardMeta(card) {
  const desc = [];
  const subtasks = [];
  const comments = [];
  dedent(card.extra).forEach((line, index) => {
    const m = line.match(SUBTASK_RE);
    if (m) { subtasks.push({ index, checked: m[1] !== " ", text: m[2] }); return; }
    const c = line.match(COMMENT_RE);
    if (c) { comments.push({ index, stamp: c[1] || null, text: c[2] }); return; }
    desc.push(line);
  });
  return {
    title: stripMeta(card.text),
    due: getDue(card),
    color: getField(card.text, "color"),
    icon: getField(card.text, "icon"),
    tags: getTags(card.text),
    desc,
    subtasks,
    comments,
    id: getField(card.text, "id"),
    blockedBy: (getField(card.text, "blockedby") || "").split(/[,\s]+/).filter(Boolean),
    updated: getField(card.text, "updated"),
  };
}

function searchText(card) {
  return [stripFields(card.text), ...dedent(card.extra)].join(" ").toLowerCase();
}

function toggleSubtask(card, index, checked) {
  card.extra[index] = card.extra[index].replace(/^(\s*[-*+]\s+)\[[^\]]\]/, `$1[${checked ? "x" : " "}]`);
}

function addSubtask(card, text) {
  card.extra.push(`    - [ ] ${text.replace(/\s*\n\s*/g, " ")}`);
}

function colorValue(c) {
  const name = c.toLowerCase();
  if (name === "gray" || name === "grey") return "var(--text-faint)";
  if (CARD_COLORS.includes(name)) return `var(--color-${name})`;
  if (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c)) return c.startsWith("#") ? c : `#${c}`;
  return c;
}

// ----- done pile lookup shared by the board and the due panel -----

// chosen: undefined = use a column named "Done", "" = no pile, otherwise a column name
function pileIndexOf(board, chosen) {
  if (!board) return -1;
  if (chosen === "") return -1;
  if (chosen) {
    const i = board.columns.findIndex((c) => colName(c) === chosen);
    if (i >= 0) return i;
  }
  return board.columns.findIndex(isDoneColumn);
}

// ----- archive: a hidden "## Archive [archive:: true]" section at the end of the board -----

const ARCHIVE_TITLE = "Archive [archive:: true]";

function isArchiveCol(col) {
  return /\[archive::\s*true\s*\]/i.test(col.title);
}

// ----- comments: "    > 2026-11-16 14:02 | text" lines under a card -----

const COMMENT_RE = /^>\s?(?:(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)\s*\|\s?)?(.*)$/;

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${isoDate(0)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function addComment(card, text) {
  const clean = text.replace(/\s*\r?\n\s*/g, " ").trim();
  if (clean) card.extra.push(`    > ${nowStamp()} | ${clean}`);
}

function formatStamp(stamp) {
  if (!stamp) return "";
  const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/);
  if (!m) return stamp;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  if (m[4]) { opts.hour = "numeric"; opts.minute = "2-digit"; }
  return d.toLocaleString(undefined, opts);
}


// ----- card ids, blockers, staleness -----

function newCardId(board) {
  const used = new Set();
  for (const col of [...board.columns, ...(board.archive ? [board.archive] : [])]) {
    for (const c of col.cards) { const id = getField(c.text, "id"); if (id) used.add(id); }
  }
  let id;
  do { id = Math.random().toString(36).slice(2, 8); } while (!id || used.has(id));
  return id;
}

function ensureCardId(board, card) {
  let id = getField(card.text, "id");
  if (!id) { id = newCardId(board); setField(card, "id", id); }
  return id;
}

// where a card with this id lives: { card, ci } (ci = -1 for the archive), or null
function findCardById(board, id) {
  if (!id) return null;
  for (let ci = 0; ci < board.columns.length; ci++) {
    const card = board.columns[ci].cards.find((c) => getField(c.text, "id") === id);
    if (card) return { card, ci };
  }
  const a = board.archive && board.archive.cards.find((c) => getField(c.text, "id") === id);
  return a ? { card: a, ci: -1 } : null;
}

function cardIsDone(card, ci, pile) {
  return !!card.checked || (pile >= 0 && ci === pile);
}

// unfinished cards this card is waiting on (archived or deleted blockers don't count)
function openBlockers(board, card, pile) {
  const out = [];
  for (const id of cardMeta(card).blockedBy) {
    const hit = findCardById(board, id);
    if (hit && hit.ci >= 0 && !cardIsDone(hit.card, hit.ci, pile)) out.push(hit.card);
  }
  return out;
}

// how a card should look: overdue / blocked / stale
function cardState(board, card, ci, pile, opts = {}) {
  const meta = cardMeta(card);
  const done = cardIsDone(card, ci, pile);
  const st = { overdue: false, blockers: [], stale: 0 };
  if (done) return st;
  st.overdue = !!meta.due && dueInfo(meta.due).state === "overdue";
  st.blockers = openBlockers(board, card, pile);
  const days = opts.staleDays || 0;
  if (days > 0) {
    let since = null;
    if (meta.updated) {
      const [y, m, d] = meta.updated.split("-").map(Number);
      since = new Date(y, m - 1, d).getTime();
    } else if (opts.fallbackMs) since = opts.fallbackMs;
    if (since) {
      const age = Math.floor((Date.now() - since) / 86400000);
      if (age >= days) st.stale = age;
    }
  }
  return st;
}

function blockedLabel(blockers) {
  const first = stripMeta(blockers[0].text);
  return blockers.length > 1 ? `Blocked by ${first} +${blockers.length - 1}` : `Blocked by ${first}`;
}

// ----- what changed between two versions of a board -----

function changeKey(card, colTitle) {
  return [colTitle, card.checked, withField(card.text, "updated", null), ...card.extra].join("\u0000");
}

function diffBoards(oldB, newB, oldPile, newPile) {
  const seen = new Map();
  const bump = (map, k, n) => map.set(k, (map.get(k) || 0) + n);
  oldB.columns.forEach((col) => col.cards.forEach((c) => bump(seen, changeKey(c, colName(col)), 1)));
  const touched = [];
  newB.columns.forEach((col) => col.cards.forEach((c) => {
    const k = changeKey(c, colName(col));
    if (seen.get(k) > 0) bump(seen, k, -1);
    else touched.push(c);
  }));

  const tally = (b, pile) => {
    const done = new Map();
    const open = new Map();
    b.columns.forEach((col, ci) => col.cards.forEach((c) => {
      const t = stripMeta(c.text);
      if (t) bump(cardIsDone(c, ci, pile) ? done : open, t, 1);
    }));
    return { done, open };
  };
  const o = tally(oldB, oldPile);
  const n = tally(newB, newPile);
  const done = [];
  const undone = [];
  for (const [t, cnt] of n.done) for (let i = 0; i < cnt - (o.done.get(t) || 0); i++) done.push(t);
  for (const [t, cnt] of n.open) {
    const k = Math.min(cnt - (o.open.get(t) || 0), o.done.get(t) || 0);
    for (let i = 0; i < k; i++) undone.push(t);
  }
  return { touched, done, undone };
}

// ----- "Done today" section of a daily note -----

const DONE_HEADING = "## Done today";

function updateDoneLog(data, add, remove) {
  const lines = data.split("\n");
  const findSection = () => {
    const h = lines.findIndex((l) => l.trim().toLowerCase() === DONE_HEADING.toLowerCase());
    if (h < 0) return null;
    let end = lines.length;
    for (let i = h + 1; i < lines.length; i++) if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
    return { h, end };
  };
  let sec = findSection();
  if (sec) {
    for (const r of remove) {
      const i = lines.findIndex((l, idx) => idx > sec.h && idx < sec.end && l === r);
      if (i >= 0) { lines.splice(i, 1); sec.end--; }
    }
    // nothing left under the heading: drop it
    if (!lines.slice(sec.h + 1, sec.end).some((l) => l.trim())) {
      lines.splice(sec.h, sec.end - sec.h);
      while (lines.length && !lines[lines.length - 1].trim() && sec.h >= lines.length) lines.pop();
      sec = null;
    }
  }
  const fresh = add.filter((a, i) => add.indexOf(a) === i && !(sec && lines.slice(sec.h + 1, sec.end).includes(a)));
  if (fresh.length) {
    if (sec) {
      let at = sec.end;
      while (at > sec.h + 1 && !lines[at - 1].trim()) at--;
      lines.splice(at, 0, ...fresh);
    } else {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      if (lines.length) lines.push("");
      lines.push(DONE_HEADING, "", ...fresh);
    }
  }
  let out = lines.join("\n");
  if (out && !out.endsWith("\n")) out += "\n";
  return out;
}

// ----- smart title: "Leg day tomorrow #gym" -> title + due + tags -----

const MONTH_FULL = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAY_FULL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_SHORT = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };

function isoOf(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function trailingDate(text, now) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const plus = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
  const PRE = "(?:(?:on|by|due)\\s+)?";
  const tries = [
    [new RegExp(`(?:^|\\s)${PRE}(today|tonight|tomorrow|tmrw|tmr)$`, "i"), (m) => plus(/^to(day|night)$/i.test(m[1]) ? 0 : 1)],
    [new RegExp(`(?:^|\\s)${PRE}(?:this\\s+|next\\s+)?(${DAY_FULL.join("|")})$`, "i"), (m) => {
      const want = DAY_FULL.indexOf(m[1].toLowerCase());
      return plus(((want - base.getDay() + 7) % 7) || 7);
    }],
    [new RegExp(`(?:^|\\s)(?:on|by|due|this|next)\\s+(${Object.keys(DAY_SHORT).join("|")})\\.?$`, "i"), (m) => {
      const want = DAY_SHORT[m[1].toLowerCase()];
      return plus(((want - base.getDay() + 7) % 7) || 7);
    }],
    [/(?:^|\s)next\s+week$/i, () => plus(7)],
    [/(?:^|\s)next\s+month$/i, () => { const d = new Date(base); d.setMonth(d.getMonth() + 1); return d; }],
    [/(?:^|\s)in\s+(a|an|one|\d{1,3})\s+(day|days|week|weeks|month|months)$/i, (m) => {
      const n = /^(a|an|one)$/i.test(m[1]) ? 1 : Number(m[1]);
      if (/^day/i.test(m[2])) return plus(n);
      if (/^week/i.test(m[2])) return plus(n * 7);
      const d = new Date(base); d.setMonth(d.getMonth() + n); return d;
    }],
    [new RegExp(`(?:^|\\s)${PRE}([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?$`, "i"), (m) => monthDay(m[1], m[2], base)],
    [new RegExp(`(?:^|\\s)${PRE}(\\d{1,2})(?:st|nd|rd|th)?\\s+([a-z]{3,9})$`, "i"), (m) => monthDay(m[2], m[1], base)],
    [new RegExp(`(?:^|\\s)${PRE}(\\d{4}-\\d{2}-\\d{2})$`, "i"), (m) => {
      const [y, mo, d] = m[1].split("-").map(Number);
      const dt = new Date(y, mo - 1, d);
      return dt.getMonth() === mo - 1 ? dt : null;
    }],
  ];
  for (const [re, fn] of tries) {
    const m = text.match(re);
    if (!m) continue;
    const d = fn(m);
    if (!d) continue;
    const rest = text.slice(0, m.index).trim();
    if (!rest) return null; // the whole title is a date: leave it alone
    return { iso: isoOf(d), phrase: m[0].trim(), rest };
  }
  return null;
}

function monthDay(name, day, base) {
  const n = name.toLowerCase();
  const mi = n.length >= 3 ? MONTH_FULL.findIndex((f) => f.startsWith(n)) : -1;
  if (mi < 0) return null;
  const d = Number(day);
  let dt = new Date(base.getFullYear(), mi, d);
  if (dt.getMonth() !== mi) return null;
  if (dt < base) dt = new Date(base.getFullYear() + 1, mi, d);
  return dt;
}

function parseQuick(input, now = new Date()) {
  const tags = [];
  let text = input.replace(TAG_RE, (m, pre, tag) => { if (!tags.includes(tag)) tags.push(tag); return pre; });
  text = text.replace(/[ \t]{2,}/g, " ").trim();
  let due = null;
  let phrase = null;
  const at = text.match(DUE_RE);
  if (at) {
    due = at[2];
    phrase = at[0].trim();
    text = text.replace(DUE_RE, "$1").replace(/[ \t]{2,}/g, " ").trim();
  } else {
    const r = trailingDate(text, now);
    if (r) { due = r.iso; phrase = r.phrase; text = r.rest; }
  }
  return { title: text, tags, due, phrase };
}

function shortDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const opts = { weekday: "short", month: "short", day: "numeric" };
  if (y !== new Date().getFullYear()) opts.year = "numeric";
  return dt.toLocaleDateString(undefined, opts);
}

// move a card to the top of the done pile (shared by the board, embeds and quick add)
function sendToPileIn(board, pile, card) {
  const cols = board.columns;
  if (pile < 0) return;
  const ci = cols.findIndex((c) => c.cards.includes(card));
  if (ci < 0 || ci === pile) return;
  cols[ci].cards.splice(cols[ci].cards.indexOf(card), 1);
  cols[pile].cards.unshift(card);
}

// chips under a card: blocked, due date, subtask progress, tags
function renderChips(main, card, meta, st, h = {}) {
  if (!(meta.due || meta.subtasks.length || meta.tags.length || st.blockers.length)) return;
  const chips = main.createDiv("mdk-chips");
  if (st.blockers.length) {
    const chip = chips.createDiv({ cls: "mdk-chip mdk-blocked", attr: { "aria-label": `Waiting on: ${st.blockers.map((b) => stripMeta(b.text)).join(", ")}` } });
    setIcon(chip.createSpan("mdk-chip-icon"), "lock");
    chip.createSpan({ text: blockedLabel(st.blockers) });
  }
  if (meta.due) {
    const info = dueInfo(meta.due);
    const chip = chips.createDiv({ cls: `mdk-chip mdk-due is-${card.checked ? "done" : info.state}`, attr: { "aria-label": meta.due } });
    setIcon(chip.createSpan("mdk-chip-icon"), "calendar");
    chip.createSpan({ text: info.label });
    if (h.onDue) chip.onclick = (e) => { e.stopPropagation(); h.onDue(); };
  }
  if (meta.subtasks.length) {
    const done = meta.subtasks.filter((s) => s.checked).length;
    const chip = chips.createDiv({ cls: "mdk-chip mdk-progress", attr: { "aria-label": "Subtasks" } });
    chip.toggleClass("is-complete", done === meta.subtasks.length);
    setIcon(chip.createSpan("mdk-chip-icon"), "list-checks");
    chip.createSpan({ text: `${done}/${meta.subtasks.length}` });
  }
  meta.tags.forEach((t) => {
    const chip = chips.createDiv({ cls: "mdk-chip mdk-tag", text: `#${t}`, attr: h.onTag ? { "aria-label": `Show only #${t}` } : {} });
    if (h.onTag) chip.onclick = (e) => { e.stopPropagation(); h.onTag(t); };
  });
}

// =====================================================================
// modals
// =====================================================================

class ConfirmModal extends Modal {
  constructor(app, message, confirmText, onYes) {
    super(app);
    this.message = message;
    this.confirmText = confirmText;
    this.onYes = onYes;
  }
  onOpen() {
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.confirmText).setWarning().onClick(() => { this.close(); this.onYes(); }));
  }
  onClose() { this.contentEl.empty(); }
}

class DueModal extends Modal {
  constructor(app, current, onPick) {
    super(app);
    this.current = current;
    this.onPick = onPick;
  }
  onOpen() {
    this.titleEl.setText("Due date");
    const input = this.contentEl.createEl("input", { type: "date", cls: "mdk-date-input" });
    input.value = this.current || isoDate(0);
    const pick = (v) => { this.close(); this.onPick(v); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pick(input.value || null); } });

    const quick = this.contentEl.createDiv("mdk-date-quick");
    [["Today", 0], ["Tomorrow", 1], ["In a week", 7]].forEach(([label, off]) => {
      quick.createEl("button", { text: label }).onclick = () => pick(isoDate(off));
    });

    const s = new Setting(this.contentEl);
    if (this.current) s.addButton((b) => b.setButtonText("Remove").onClick(() => pick(null)));
    s.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    s.addButton((b) => b.setButtonText("Save").setCta().onClick(() => pick(input.value || null)));
    window.setTimeout(() => input.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}

// Icon + color picker: color swatches, a search box, and a grid of icons on one page.
const PICKER_LIMIT = 300;

class IconColorModal extends Modal {
  constructor(app, { title, icon, color }, onPick) {
    super(app);
    this.heading = title;
    this.icon = icon || null;
    this.color = color || null;
    this.onPick = onPick;
  }

  onOpen() {
    this.modalEl.addClass("mdk-picker-modal");
    this.titleEl.setText(this.heading);
    const c = this.contentEl;

    // colors
    c.createDiv({ cls: "mdk-picker-label", text: "Color" });
    this.colorsEl = c.createDiv("mdk-picker-colors");
    this.renderColors();

    // icon search + grid
    c.createDiv({ cls: "mdk-picker-label", text: "Icon" });
    this.searchEl = c.createEl("input", { type: "search", cls: "mdk-picker-search", attr: { placeholder: "Search icons, e.g. dumbbell, book, cart" } });
    this.gridEl = c.createDiv("mdk-picker-grid");
    this.noteEl = c.createDiv("mdk-picker-note");
    this.allIcons = Array.from(new Set(getIconIds().map((id) => id.replace(/^lucide-/, "")))).sort();
    this.applyTint();
    this.renderGrid();

    this.searchEl.addEventListener("input", () => this.renderGrid());
    this.searchEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (this.searchEl.value.trim() && this.matches.length) this.icon = this.matches[0];
        this.save();
      }
    });

    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.save()));
    window.setTimeout(() => this.searchEl.focus(), 0);
  }

  renderColors() {
    const el = this.colorsEl;
    el.empty();
    [null, ...CARD_COLORS].forEach((col) => {
      const b = el.createEl("button", { cls: "mdk-picker-color", attr: { "aria-label": col || "none" } });
      if (col) b.setCssProps({ "--mdk-swatch": colorValue(col) });
      else b.addClass("is-none");
      b.toggleClass("is-active", this.color === col);
      b.onclick = () => { this.color = col; this.renderColors(); this.applyTint(); };
    });
  }

  applyTint() {
    this.gridEl.setCssProps({ "--mdk-picker-tint": this.color ? colorValue(this.color) : "var(--text-normal)" });
  }

  renderGrid() {
    const q = this.searchEl.value.trim().toLowerCase();
    let list = q ? this.allIcons.filter((id) => id.includes(q)) : this.allIcons;
    // keep the current icon visible at the front when browsing
    if (!q && this.icon && list.includes(this.icon)) list = [this.icon, ...list.filter((id) => id !== this.icon)];
    this.matches = list;

    const grid = this.gridEl;
    grid.empty();
    if (!q) this.iconCell(null);
    list.slice(0, PICKER_LIMIT).forEach((id) => this.iconCell(id));
    this.noteEl.setText(
      !list.length ? "No icons match." :
      list.length > PICKER_LIMIT ? `Showing ${PICKER_LIMIT} of ${list.length}. Type to narrow it down.` : "",
    );
  }

  iconCell(id) {
    const b = this.gridEl.createEl("button", { cls: "mdk-picker-icon", attr: { "aria-label": id || "No icon" } });
    if (id) setIcon(b, id);
    else b.addClass("is-none");
    b.toggleClass("is-active", this.icon === id);
    b.onclick = () => {
      this.icon = id;
      this.gridEl.querySelectorAll(".mdk-picker-icon.is-active").forEach((n) => n.removeClass("is-active"));
      b.addClass("is-active");
    };
    b.ondblclick = () => { this.icon = id; this.save(); };
  }

  save() {
    this.close();
    this.onPick({ icon: this.icon, color: this.color });
  }

  onClose() { this.contentEl.empty(); }
}

// Card editor: every part of a card as a form, so the markdown never shows.
class CardEditModal extends Modal {
  constructor(app, view, card, opts = {}) {
    super(app);
    this.view = view;
    this.card = card;
    this.focusTarget = opts.focus || "title";
    this.isNew = !!opts.isNew;
    this.target = { ci: opts.ci, top: !!opts.top, pos: opts.pos || 0 }; // where a new card goes
    this.capture = opts.capture || null; // quick add: { boards } - lets you pick board and column
    this.plugin = view.plugin;
    const m = cardMeta(card);
    this.origTitle = this.isNew ? "" : m.title; // smart title reading only kicks in when the title changes
    this.keepId = m.id;
    this.keepUpdated = m.updated;
    this.wasDone = !!card.checked;
    this.state = {
      title: m.title,
      desc: m.desc.filter((l) => l.trim()).join("\n"),
      subtasks: m.subtasks.map((s) => ({ checked: s.checked, text: s.text })),
      tags: m.tags.slice(),
      due: m.due,
      icon: m.icon,
      color: m.color,
      done: !!card.checked,
      blockers: m.blockedBy.map((id) => ({ id, card: null })),
    };
    // comments aren't edited here (they have their own popup) but must survive a save
    this.commentLines = m.comments.map((cm) => card.extra[cm.index].replace(/^\s*/, "    "));
  }

  applyTemplate(t) {
    const s = this.state;
    s.title = t.title || "";
    s.subtasks = (t.subtasks || []).map((text) => ({ checked: false, text }));
    s.tags = (t.tags || []).slice();
    s.icon = t.icon || null;
    s.color = t.color || null;
    this.titleInput.value = s.title;
    this.descInput.value = t.desc || "";
    this.renderSubtasks();
    this.renderTags();
    this.renderLook();
    this.titleInput.focus();
    this.titleInput.select();
  }

  saveAsTemplate() {
    const s = this.state;
    const tpl = {
      title: this.titleInput.value.trim(),
      desc: this.descInput.value.trim(),
      subtasks: s.subtasks.map((x) => x.text.trim()).filter(Boolean),
      tags: s.tags.slice(),
      icon: s.icon,
      color: s.color,
    };
    new NameModal(this.app, "Save as template", tpl.title, (name) => {
      const list = this.view.plugin.settings.templates;
      const i = list.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
      if (i >= 0) list[i] = { name, ...tpl };
      else list.push({ name, ...tpl });
      this.view.plugin.saveSettings();
      new Notice(`Template "${name}" saved`);
    }).open();
  }

  onOpen() {
    this.modalEl.addClass("mdk-edit-modal");
    this.titleEl.setText(this.capture ? "Quick add card" : this.isNew ? "New card" : "Edit card");
    this.plugin.lastEditor = this;
    const c = this.contentEl;
    const field = (label) => {
      const f = c.createDiv("mdk-field");
      f.createDiv({ cls: "mdk-picker-label", text: label });
      return f;
    };

    // quick add: choose where the card goes
    if (this.capture) {
      const row = c.createDiv("mdk-edit-row");
      const bf = row.createDiv("mdk-field");
      bf.createDiv({ cls: "mdk-picker-label", text: "Board" });
      this.boardSel = bf.createEl("select", { cls: "dropdown mdk-edit-select mdk-capture-board" });
      this.capture.boards.forEach((b, i) => this.boardSel.createEl("option", { text: b.basename, attr: { value: String(i) } }));
      this.boardSel.value = String(Math.max(0, this.capture.boards.findIndex((b) => b.path === this.view.file.path)));
      const cf = row.createDiv("mdk-field");
      cf.createDiv({ cls: "mdk-picker-label", text: "Column" });
      this.colSel = cf.createEl("select", { cls: "dropdown mdk-edit-select mdk-capture-col" });
      this.fillCaptureColumns();
      this.boardSel.onchange = async () => {
        const file = this.capture.boards[Number(this.boardSel.value)];
        this.view = await this.plugin.boardTarget(file);
        this.target.ci = 0;
        this.state.blockers = [];
        this.fillCaptureColumns();
        this.renderBlockers();
      };
      this.colSel.onchange = () => { this.target.ci = Number(this.colSel.value); };
    }

    // templates (new cards only)
    const templates = this.view.plugin.settings.templates || [];
    if (this.isNew && templates.length) {
      const sel = field("Template").createEl("select", { cls: "dropdown mdk-edit-select" });
      sel.createEl("option", { text: "None", attr: { value: "" } });
      templates.forEach((t, i) => sel.createEl("option", { text: t.name, attr: { value: String(i) } }));
      sel.onchange = () => { if (sel.value !== "") this.applyTemplate(templates[Number(sel.value)]); };
      this.templateSelect = sel;
    }

    // title: Enter jumps to the subtask box, same as on the board
    const titleField = field("Title");
    this.titleInput = titleField.createEl("input", { type: "text", cls: "mdk-edit-input", attr: { placeholder: "Card title (try: Leg day tomorrow #gym)" } });
    this.titleInput.value = this.state.title;
    this.hintEl = titleField.createDiv("mdk-edit-hint");
    this.titleInput.addEventListener("input", () => this.updateHint());
    this.updateHint();
    this.titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); this.subAdd.focus(); }
    });

    // description
    this.descInput = field("Description").createEl("textarea", { cls: "mdk-edit-input mdk-edit-desc", attr: { rows: "3", placeholder: "Notes (optional)" } });
    this.descInput.value = this.state.desc;

    // subtasks
    const sf = field("Subtasks");
    this.subList = sf.createDiv("mdk-edit-subtasks");
    this.subAdd = sf.createEl("input", { type: "text", cls: "mdk-edit-input mdk-edit-subadd", attr: { placeholder: "Add a subtask and press Enter" } });
    this.subAdd.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const v = this.subAdd.value.trim();
      if (!v) return;
      this.state.subtasks.push({ checked: false, text: v });
      this.subAdd.value = "";
      this.renderSubtasks();
    });
    this.renderSubtasks();

    // tags
    this.tagWrap = field("Tags").createDiv("mdk-edit-tags");
    this.renderTags();

    // cards this one waits on
    this.blockWrap = field("Blocked by").createDiv("mdk-edit-blockers");
    this.renderBlockers();

    // due date, done, icon & color
    const row = c.createDiv("mdk-edit-row");
    const dueF = row.createDiv("mdk-field");
    dueF.createDiv({ cls: "mdk-picker-label", text: "Due date" });
    const dueRow = dueF.createDiv("mdk-edit-inline");
    this.dueInput = dueRow.createEl("input", { type: "date", cls: "mdk-edit-input" });
    this.dueInput.value = this.state.due || "";
    const clearDue = dueRow.createEl("button", { cls: "mdk-edit-small", text: "Clear" });
    clearDue.onclick = () => { this.dueInput.value = ""; };

    const doneF = row.createDiv("mdk-field");
    doneF.createDiv({ cls: "mdk-picker-label", text: "Status" });
    const doneLabel = doneF.createEl("label", { cls: "mdk-edit-inline mdk-edit-done" });
    this.doneInput = doneLabel.createEl("input", { type: "checkbox" });
    this.doneInput.checked = this.state.done;
    doneLabel.createSpan({ text: "Done" });

    const lookF = row.createDiv("mdk-field");
    lookF.createDiv({ cls: "mdk-picker-label", text: "Icon & color" });
    this.lookBtn = lookF.createEl("button", { cls: "mdk-edit-look" });
    this.renderLook();
    this.lookBtn.onclick = () => {
      new IconColorModal(this.app, { title: "Card icon & color", icon: this.state.icon, color: this.state.color }, (pick) => {
        this.state.icon = pick.icon;
        this.state.color = pick.color;
        this.renderLook();
      }).open();
    };

    // footer
    const foot = c.createDiv("mdk-edit-foot");
    if (!this.isNew) {
      const del = foot.createEl("button", { cls: "mod-warning", text: "Delete card" });
      del.onclick = () => this.deleteCard();
    }
    foot.createEl("button", { text: "Save as template" }).onclick = () => this.saveAsTemplate();
    foot.createDiv("mdk-spacer");
    foot.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    if (this.isNew) {
      const again = foot.createEl("button", { text: "Add & new", attr: { "aria-label": "Add this card and start another" } });
      again.onclick = () => this.save(true);
    }
    const save = foot.createEl("button", { cls: "mod-cta", text: this.isNew ? "Add card" : "Save" });
    save.onclick = () => this.save();

    if (this.scope) this.scope.register(["Mod"], "Enter", () => { this.save(); return false; });
    window.setTimeout(() => (this.focusTarget === "subtasks" ? this.subAdd : this.titleInput).focus(), 0);
  }

  renderSubtasks() {
    const list = this.subList;
    list.empty();
    const subs = this.state.subtasks;
    subs.forEach((s, i) => {
      const row = list.createDiv("mdk-edit-subtask");
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = s.checked;
      cb.onchange = () => { s.checked = cb.checked; };
      const inp = row.createEl("input", { type: "text", cls: "mdk-edit-input" });
      inp.value = s.text;
      inp.oninput = () => { s.text = inp.value; };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); this.subAdd.focus(); }
      });
      const btn = (icon, label, fn, enabled = true) => {
        const b = row.createDiv({ cls: "clickable-icon mdk-icon", attr: { "aria-label": label } });
        setIcon(b, icon);
        b.toggleClass("is-disabled", !enabled);
        if (enabled) b.onclick = fn;
      };
      btn("arrow-up", "Move up", () => { [subs[i - 1], subs[i]] = [subs[i], subs[i - 1]]; this.renderSubtasks(); }, i > 0);
      btn("arrow-down", "Move down", () => { [subs[i + 1], subs[i]] = [subs[i], subs[i + 1]]; this.renderSubtasks(); }, i < subs.length - 1);
      btn("x", "Remove subtask", () => { subs.splice(i, 1); this.renderSubtasks(); });
    });
    if (!subs.length) list.createDiv({ cls: "mdk-edit-empty", text: "No subtasks yet." });
  }

  renderTags() {
    const wrap = this.tagWrap;
    // removing the focused tag box fires blur; don't let that re-render mid-render
    this.redrawingTags = true;
    try { wrap.empty(); } finally { this.redrawingTags = false; }
    this.state.tags.forEach((t, i) => {
      const chip = wrap.createDiv({ cls: "mdk-chip mdk-tag mdk-edit-tag", text: `#${t}` });
      const x = chip.createSpan({ cls: "mdk-edit-tag-x", attr: { "aria-label": `Remove #${t}` } });
      setIcon(x, "x");
      x.onclick = () => { this.state.tags.splice(i, 1); this.renderTags(); this.tagInput.focus(); };
    });
    this.tagInput = wrap.createEl("input", { type: "text", cls: "mdk-edit-tag-input", attr: { placeholder: this.state.tags.length ? "Add tag" : "Add a tag and press Enter" } });
    const add = () => {
      const t = this.tagInput.value.trim().replace(/^#+/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_/-]/gu, "");
      if (t && !this.state.tags.includes(t)) this.state.tags.push(t);
      this.renderTags();
      this.tagInput.focus();
    };
    this.tagInput.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === ",") && !e.isComposing) {
        e.preventDefault();
        if (this.tagInput.value.trim()) add();
      } else if (e.key === "Backspace" && !this.tagInput.value && this.state.tags.length) {
        this.state.tags.pop();
        this.renderTags();
        this.tagInput.focus();
      }
    });
    const input = this.tagInput;
    input.addEventListener("blur", () => {
      if (this.redrawingTags || input !== this.tagInput) return;
      if (input.value.trim()) add();
    });
  }

  fillCaptureColumns() {
    const sel = this.colSel;
    sel.empty();
    this.view.board.columns.forEach((col, ci) => sel.createEl("option", { text: colName(col), attr: { value: String(ci) } }));
    const n = this.view.board.columns.length;
    this.target.ci = Math.min(Math.max(0, this.target.ci || 0), Math.max(0, n - 1));
    sel.value = String(this.target.ci);
  }

  // live preview of what the title will turn into
  updateHint() {
    const el = this.hintEl;
    const v = this.titleInput.value.trim();
    el.empty();
    if (!v || v === this.origTitle) return;
    const q = parseQuick(v);
    const bits = [];
    if (q.due) bits.push(`due ${shortDate(q.due)}`);
    q.tags.forEach((t) => bits.push(`#${t}`));
    if (!bits.length || !q.title) return;
    el.setText(`Will set ${bits.join(", ")}`);
  }

  renderBlockers() {
    const wrap = this.blockWrap;
    if (!wrap) return;
    wrap.empty();
    const board = this.view.board;
    const pile = this.view.pileIndex();
    const s = this.state;
    const chosen = (c) => s.blockers.some((b) => b.card === c || (b.id && getField(c.text, "id") === b.id));
    s.blockers.forEach((b, i) => {
      const hit = b.card ? { card: b.card } : findCardById(board, b.id);
      const chip = wrap.createDiv({ cls: "mdk-chip mdk-blocked mdk-edit-tag", text: hit ? stripMeta(hit.card.text) : "(removed card)" });
      const x = chip.createSpan({ cls: "mdk-edit-tag-x", attr: { "aria-label": "Remove" } });
      setIcon(x, "x");
      x.onclick = () => { s.blockers.splice(i, 1); this.renderBlockers(); };
    });
    const sel = wrap.createEl("select", { cls: "dropdown mdk-edit-block-add" });
    sel.createEl("option", { text: s.blockers.length ? "Add another..." : "Pick a card this waits on...", attr: { value: "" } });
    let any = false;
    board.columns.forEach((col, ci) => col.cards.forEach((c, ki) => {
      if (c === this.card || cardIsDone(c, ci, pile) || chosen(c)) return;
      any = true;
      sel.createEl("option", { text: `${stripMeta(c.text)} (${colName(col)})`, attr: { value: `${ci}:${ki}` } });
    }));
    if (!any) { sel.empty(); sel.createEl("option", { text: "No other open cards", attr: { value: "" } }); sel.disabled = true; }
    sel.onchange = () => {
      if (!sel.value) return;
      const [ci, ki] = sel.value.split(":").map(Number);
      const c = board.columns[ci].cards[ki];
      s.blockers.push({ id: getField(c.text, "id"), card: c });
      this.renderBlockers();
    };
  }

  renderLook() {
    const b = this.lookBtn;
    b.empty();
    const prev = b.createSpan("mdk-edit-look-icon");
    if (this.state.icon) setIcon(prev, this.state.icon);
    else prev.addClass("is-none");
    if (this.state.color) prev.setCssStyles({ color: colorValue(this.state.color) });
    else prev.setCssStyles({ color: "" });
    b.createSpan({ text: this.state.icon || this.state.color ? "Change" : "Choose" });
  }

  save(another = false) {
    let title = this.titleInput.value.trim().replace(/\s*\n\s*/g, " ");
    if (!title) { new Notice("A card needs a title."); this.titleInput.focus(); return; }
    let quickDue = null;
    if (title !== this.origTitle) {
      const q = parseQuick(title);
      if (q.title) {
        title = q.title;
        q.tags.forEach((t) => { if (!this.state.tags.includes(t)) this.state.tags.push(t); });
        quickDue = q.due;
      }
    }
    // a tag typed into the tag box but not yet added still counts
    if (this.tagInput && this.tagInput.value.trim()) {
      const t = this.tagInput.value.trim().replace(/^#+/, "").replace(/\s+/g, "-");
      if (t && !this.state.tags.includes(t)) this.state.tags.push(t);
    }
    const s = this.state;
    const due = quickDue || this.dueInput.value || null;
    const card = this.card;
    const board = this.view.board;
    const blockIds = s.blockers.map((b) => b.id || (b.card ? ensureCardId(board, b.card) : null)).filter(Boolean);

    let text = title;
    for (const t of s.tags) text += ` #${t}`;
    if (due) text += ` @${due}`;
    if (s.color) text += ` [color:: ${s.color}]`;
    if (s.icon) text += ` [icon:: ${s.icon}]`;
    if (this.keepId) text += ` [id:: ${this.keepId}]`;
    if (blockIds.length) text += ` [blockedby:: ${blockIds.join(", ")}]`;
    if (this.keepUpdated) text += ` [updated:: ${this.keepUpdated}]`;
    card.text = text;

    const desc = this.descInput.value.split(/\r?\n/).filter((l) => l.trim()).map((l) => `    ${l}`);
    const subs = s.subtasks.filter((x) => x.text.trim()).map((x) => `    - [${x.checked ? "x" : " "}] ${x.text.trim()}`);
    card.extra = [...desc, ...subs, ...this.commentLines];

    const done = this.doneInput.checked;
    card.checked = done ? true : card.checked === null && !this.wasDone ? null : false;

    this.close();
    const view = this.view;
    const t = this.target;
    if (this.isNew) {
      const col = view.board.columns[t.ci] || view.board.columns[0];
      if (!col) return;
      if (t.top) col.cards.splice(Math.min(t.pos, col.cards.length), 0, card);
      else col.cards.push(card);
    }
    if (done && !this.wasDone) view.sendToPile(card);
    view.commit();
    if (this.isNew && !t.top) view.scrollColumnToEnd(t.ci);
    if (this.capture) {
      const col = view.board.columns[t.ci];
      this.plugin.settings.lastCapture = { path: view.file.path, column: col ? colName(col) : null };
      this.plugin.saveSettings();
      new Notice(`Added to ${view.file.basename}${col ? ` / ${colName(col)}` : ""}`);
      if (another) this.plugin.quickAdd({ file: view.file, ci: t.ci, text: "" });
      return;
    }
    if (another) view.openNewCard(t.ci, t.top, t.pos + 1); // keep top-added cards in typed order
  }

  deleteCard() {
    for (const col of this.view.board.columns) {
      const i = col.cards.indexOf(this.card);
      if (i >= 0) { col.cards.splice(i, 1); break; }
    }
    this.close();
    this.view.commit();
  }

  onClose() { this.contentEl.empty(); }
}

// Small "type a name" window (used for template names).
class NameModal extends Modal {
  constructor(app, heading, value, onSubmit) {
    super(app);
    this.heading = heading;
    this.value = value || "";
    this.onSubmit = onSubmit;
  }
  onOpen() {
    this.titleEl.setText(this.heading);
    const input = this.contentEl.createEl("input", { type: "text", cls: "mdk-edit-input" });
    input.value = this.value;
    const submit = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      this.close();
      this.onSubmit(v);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
    const foot = this.contentEl.createDiv("mdk-edit-foot");
    foot.createDiv("mdk-spacer");
    foot.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    foot.createEl("button", { cls: "mod-cta", text: "Save" }).onclick = submit;
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  onClose() { this.contentEl.empty(); }
}

// Comments live only in this popup; the card just shows a count.
class CommentsModal extends Modal {
  constructor(app, view, card) {
    super(app);
    this.view = view;
    this.card = card;
  }
  onOpen() {
    this.modalEl.addClass("mdk-comments-modal");
    this.titleEl.setText("Comments");
    const c = this.contentEl;
    c.createDiv({ cls: "mdk-comments-card", text: stripMeta(this.card.text) });
    this.listEl = c.createDiv("mdk-comment-list");
    this.input = c.createEl("textarea", {
      cls: "mdk-edit-input mdk-comment-input",
      attr: { rows: "2", placeholder: "Write a comment (Enter to post, Shift+Enter for a new line)" },
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.post(); }
    });
    const foot = c.createDiv("mdk-edit-foot");
    foot.createDiv("mdk-spacer");
    foot.createEl("button", { text: "Close" }).onclick = () => this.close();
    foot.createEl("button", { cls: "mod-cta", text: "Post" }).onclick = () => this.post();
    this.renderList();
    window.setTimeout(() => this.input.focus(), 0);
  }
  renderList() {
    const list = this.listEl;
    list.empty();
    const comments = cardMeta(this.card).comments;
    if (!comments.length) {
      list.createDiv({ cls: "mdk-edit-empty", text: "No comments yet." });
      return;
    }
    comments.forEach((cm) => {
      const item = list.createDiv("mdk-comment");
      const head = item.createDiv("mdk-comment-head");
      head.createSpan({ cls: "mdk-comment-time", text: formatStamp(cm.stamp) || "Comment" });
      const del = head.createDiv({ cls: "clickable-icon mdk-icon mdk-comment-del", attr: { "aria-label": "Delete comment" } });
      setIcon(del, "trash-2");
      del.onclick = () => {
        this.card.extra.splice(cm.index, 1);
        this.view.commit();
        this.renderList();
      };
      item.createDiv({ cls: "mdk-comment-text", text: cm.text });
    });
    list.scrollTop = list.scrollHeight;
  }
  post() {
    const v = this.input.value.trim();
    if (!v) return;
    addComment(this.card, v);
    this.input.value = "";
    this.view.commit();
    this.renderList();
    this.input.focus();
  }
  onClose() { this.contentEl.empty(); }
}

// Archived cards: search, restore to where they came from, or delete.
class ArchiveModal extends Modal {
  constructor(app, view) {
    super(app);
    this.view = view;
  }
  onOpen() {
    this.modalEl.addClass("mdk-archive-modal");
    const c = this.contentEl;
    this.search = c.createEl("input", { type: "search", cls: "mdk-edit-input", attr: { placeholder: "Search the archive..." } });
    this.search.addEventListener("input", () => this.render());
    this.listEl = c.createDiv("mdk-archive-list");
    const foot = c.createDiv("mdk-edit-foot");
    this.emptyBtn = foot.createEl("button", { cls: "mod-warning", text: "Empty archive" });
    this.emptyBtn.onclick = () => { this.view.emptyArchive(); this.render(); };
    foot.createDiv("mdk-spacer");
    foot.createEl("button", { text: "Close" }).onclick = () => this.close();
    this.render();
    window.setTimeout(() => this.search.focus(), 0);
  }
  render() {
    const archive = this.view.board && this.view.board.archive;
    const cards = archive ? archive.cards : [];
    this.titleEl.setText(`Archive (${cards.length})`);
    this.emptyBtn.toggleClass("is-hidden", !cards.length);
    const q = this.search.value.trim().toLowerCase();
    const shown = cards.filter((card) => !q || searchText(card).includes(q));
    const list = this.listEl;
    list.empty();
    if (!shown.length) {
      list.createDiv({ cls: "mdk-edit-empty", text: cards.length ? "Nothing matches." : "Nothing archived yet." });
      return;
    }
    shown.forEach((card) => {
      const meta = cardMeta(card);
      const row = list.createDiv("mdk-archive-item");
      const ic = row.createSpan("mdk-archive-icon");
      if (meta.icon) setIcon(ic, meta.icon);
      if (meta.color) ic.setCssStyles({ color: colorValue(meta.color) });
      const main = row.createDiv("mdk-archive-main");
      main.createDiv({ cls: "mdk-archive-title", text: meta.title || "(untitled)" });
      const from = getField(card.text, "from");
      const when = getField(card.text, "archived");
      main.createDiv({ cls: "mdk-archive-sub", text: [from && `from ${from}`, when && `archived ${formatStamp(when)}`].filter(Boolean).join(", ") });
      const restore = row.createDiv({ cls: "clickable-icon mdk-icon", attr: { "aria-label": "Restore" } });
      setIcon(restore, "rotate-ccw");
      restore.onclick = () => { this.view.restoreCard(card); this.render(); };
      const del = row.createDiv({ cls: "clickable-icon mdk-icon", attr: { "aria-label": "Delete for good" } });
      setIcon(del, "trash-2");
      del.onclick = () => { this.view.deleteArchived(card); this.render(); };
    });
  }
  onClose() { this.contentEl.empty(); }
}

// Sidebar panel: overdue / today / next 7 days, across every board.
const DUE_VIEW = "kanplete-due";

class DueView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() { return DUE_VIEW; }
  getDisplayText() { return "Due cards"; }
  getIcon() { return "calendar-clock"; }

  async onOpen() {
    this.contentEl.addClass("mdk-due-view");
    const refresh = debounce(() => this.refresh(), 500, true);
    this.registerEvent(this.app.vault.on("modify", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(this.app.metadataCache.on("changed", refresh));
    // move cards between Today / Overdue when the date changes
    let day = isoDate(0);
    const tick = () => { if (isoDate(0) !== day) { day = isoDate(0); this.refresh(); } };
    this.registerInterval(window.setInterval(tick, 60 * 1000));
    this.registerDomEvent(window, "focus", tick);
    await this.refresh();
  }

  async refresh() {
    const groups = await this.plugin.collectDue();
    const el = this.contentEl;
    el.empty();
    const head = el.createDiv("mdk-due-head");
    head.createDiv({ cls: "mdk-due-heading", text: "Due cards" });
    const r = head.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Refresh" } });
    setIcon(r, "refresh-cw");
    r.onclick = () => this.refresh();

    const sections = [
      ["Overdue", groups.overdue, "overdue"],
      ["Today", groups.today, "soon"],
      ["Next 7 days", groups.upcoming, "later"],
    ];
    if (!sections.some(([, items]) => items.length)) {
      el.createDiv({ cls: "mdk-due-empty", text: "Nothing due in the next week." });
      return;
    }
    for (const [label, items, state] of sections) {
      if (!items.length) continue;
      const sec = el.createDiv(`mdk-due-section is-${state}`);
      const h = sec.createDiv("mdk-due-section-head");
      h.createSpan({ text: label });
      h.createSpan({ cls: "mdk-count", text: String(items.length) });
      items.forEach((item) => this.renderItem(sec, item));
    }
  }

  renderItem(sec, item) {
    const meta = cardMeta(item.card);
    const row = sec.createDiv("mdk-due-item");
    const done = row.createDiv({ cls: "clickable-icon mdk-icon mdk-done-btn", attr: { "aria-label": "Mark done" } });
    setIcon(done, "check");
    done.onclick = async (e) => {
      e.stopPropagation();
      await this.plugin.markDueDone(item);
      await this.refresh();
    };
    const main = row.createDiv("mdk-due-main");
    const t = main.createDiv("mdk-due-title");
    if (meta.icon) {
      const ic = t.createSpan("mdk-card-icon");
      setIcon(ic, meta.icon);
      if (meta.color) ic.setCssStyles({ color: colorValue(meta.color) });
    }
    t.createSpan({ text: meta.title || "(untitled)" });
    main.createDiv({ cls: "mdk-due-sub", text: `${item.file.basename} / ${item.column}` });
    const info = dueInfo(item.due);
    const chip = row.createDiv({ cls: `mdk-chip mdk-due is-${info.state}` });
    chip.createSpan({ text: info.label });
    row.onclick = () => this.plugin.openBoard(item.file);
  }
}

// =====================================================================
// board view
// =====================================================================

class KanbanView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.board = null;
    this.undoStack = [];
    this.redoStack = [];
    this.filter = "";
    this.subtaskFor = null; // card object with an open "add subtask" box
    this.drag = null;      // { kind: "card", ci, ki, height } | { kind: "col", ci }
    this.placeholder = null;
    this.dropCol = null;
    this.dropColIdx = null;
    this.renderComp = null;
    this.domReady = false;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file ? this.file.basename : "Kanban"; }
  getIcon() { return "kanban"; }
  canAcceptExtension(ext) { return ext === "md"; }

  async onOpen() {
    this.ensureDom();
    // redraw when the date changes so overdue cards turn red without a reload
    this.renderedDay = isoDate(0);
    this.registerInterval(window.setInterval(() => this.checkDay(), 60 * 1000));
    this.registerDomEvent(window, "focus", () => this.checkDay());
    this.addAction("file-text", "Open as markdown", () => this.plugin.openAsMarkdown(this.leaf));

    this.scope = new Scope(this.app.scope);
    const undoKey = (redo) => () => {
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return true; // let text fields undo text
      redo ? this.redo() : this.undo();
      return false;
    };
    this.scope.register(["Mod"], "z", undoKey(false));
    this.scope.register(["Mod", "Shift"], "z", undoKey(true));
    this.scope.register(["Mod"], "y", undoKey(true));
  }

  async onClose() {
    if (this.renderComp) this.renderComp.unload();
  }

  ensureDom() {
    if (this.domReady) return;
    this.domReady = true;
    const root = this.contentEl;
    root.empty();
    root.addClass("mdk-root");
    this.toolbarEl = root.createDiv("mdk-toolbar");
    this.boardEl = root.createDiv("mdk-board");
    this.buildToolbar();

    // Listeners live on the persistent board element so re-renders never stack them.
    this.registerDomEvent(this.boardEl, "click", (e) => {
      const a = e.target.closest && e.target.closest("a.internal-link");
      if (!a || !this.file) return;
      e.preventDefault();
      this.app.workspace.openLinkText(a.getAttr("data-href") || a.getAttr("href"), this.file.path, Keymap.isModEvent(e));
    });
    this.registerDomEvent(this.boardEl, "dragover", (e) => this.onDragOver(e));
    this.registerDomEvent(this.boardEl, "drop", (e) => this.onDrop(e));
    this.registerDomEvent(this.boardEl, "dragleave", (e) => {
      if (!this.boardEl.contains(e.relatedTarget)) this.clearColMarkers();
    });
  }

  // ----- TextFileView plumbing -----

  getViewData() { return this.data; }

  setViewData(data, clear) {
    if (clear) {
      this.undoStack = [];
      this.redoStack = [];
      this.subtaskFor = null;
    }
    this.data = data;
    this.board = parseBoard(data);
    this.render();
  }

  clear() {
    this.board = null;
    this.subtaskFor = null;
    if (this.boardEl) this.boardEl.empty();
  }

  // Every edit mutates this.board and then calls commit(); this.data still holds the
  // previous markdown at that point, which is exactly what undo needs.
  commit() {
    if (this.data !== undefined) this.plugin.onBoardChange(this.file, parseBoard(this.data), this.board);
    this.undoStack.push(this.data);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.data = serializeBoard(this.board);
    this.requestSave();
    this.render();
  }

  undo() {
    if (!this.undoStack.length) { new Notice("Nothing to undo"); return; }
    this.redoStack.push(this.data);
    this.restore(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) { new Notice("Nothing to redo"); return; }
    this.undoStack.push(this.data);
    this.restore(this.redoStack.pop());
  }

  restore(data) {
    const before = this.board;
    this.data = data;
    this.board = parseBoard(data);
    this.plugin.onBoardChange(this.file, before, this.board, { stamp: false });
    this.subtaskFor = null;
    this.requestSave();
    this.render();
  }

  // ----- toolbar -----

  buildToolbar() {
    const tb = this.toolbarEl;
    this.boardTitleEl = tb.createDiv({ cls: "mdk-board-title", attr: { "aria-label": "Double-click to rename" } });
    this.boardTitleEl.ondblclick = () => this.renameBoard();
    const search = tb.createEl("input", { type: "search", cls: "mdk-search", attr: { placeholder: "Filter cards or #tags..." } });
    this.searchEl = search;
    search.addEventListener("input", () => { this.filter = search.value.trim().toLowerCase(); this.applyFilter(); });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { search.value = ""; this.filter = ""; this.applyFilter(); search.blur(); }
    });
    this.statEl = tb.createSpan("mdk-stat");
    tb.createDiv("mdk-spacer");
    const btn = (icon, label, fn) => {
      const el = tb.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
      setIcon(el, icon);
      el.onclick = fn;
      return el;
    };
    btn("undo-2", "Undo (Ctrl+Z)", () => this.undo());
    btn("redo-2", "Redo (Ctrl+Shift+Z)", () => this.redo());
    btn("plus", "Add column", () => this.startAddColumn());
    this.archiveBtn = btn("archive", "Archive", () => new ArchiveModal(this.app, this).open());
    tb.createDiv("mdk-toolbar-sep");
    this.layoutBtn = btn("rows-3", "Switch to rows", () => this.toggleLayout());
    this.focusBtn = btn("maximize-2", "Focus: hide sidebars", () => this.plugin.toggleFocus());
  }

  isRows() {
    return this.plugin.getLayout(this.file) === "rows";
  }

  toggleLayout() {
    this.plugin.setLayout(this.file, this.isRows() ? "columns" : "rows");
    this.render();
  }

  updateToolbarState() {
    if (this.boardTitleEl && !this.renamingBoard) this.boardTitleEl.setText(this.file ? this.file.basename : "");
    if (this.archiveBtn) {
      const n = this.board && this.board.archive ? this.board.archive.cards.length : 0;
      this.archiveBtn.setAttr("aria-label", n ? `Archive (${n})` : "Archive");
    }
    if (this.layoutBtn) {
      const rows = this.isRows();
      setIcon(this.layoutBtn, rows ? "columns-3" : "rows-3");
      this.layoutBtn.setAttr("aria-label", rows ? "Switch to columns" : "Switch to rows");
    }
    if (this.focusBtn) {
      const on = this.plugin.isFocused();
      setIcon(this.focusBtn, on ? "minimize-2" : "maximize-2");
      this.focusBtn.setAttr("aria-label", on ? "Exit focus: show sidebars" : "Focus: hide sidebars");
      this.focusBtn.toggleClass("is-active", on);
    }
  }

  updateStats() {
    if (!this.statEl || !this.board) return;
    let total = 0;
    let done = 0;
    for (const c of this.board.columns) for (const k of c.cards) { total++; if (k.checked) done++; }
    this.statEl.setText(total ? `${total} card${total === 1 ? "" : "s"}, ${done} done` : "");
  }

  applyFilter() {
    if (!this.boardEl) return;
    const f = this.filter;
    this.boardEl.toggleClass("is-filtering", !!f);
    this.boardEl.querySelectorAll(".mdk-card").forEach((el) => {
      el.toggleClass("is-hidden", !!f && !el.dataset.search.includes(f));
    });
  }

  // ----- rendering -----

  render() {
    this.renderedDay = isoDate(0);
    this.ensureDom();
    const boardEl = this.boardEl;

    // keep each column's scroll position across re-renders
    const scrolls = Array.from(boardEl.querySelectorAll(".mdk-cards")).map((l) => [l.scrollTop, l.scrollLeft]);

    // Removing a focused input fires "blur" synchronously; flag it so that blur
    // doesn't start a second render in the middle of this one.
    this.clearing = true;
    try { boardEl.empty(); } finally { this.clearing = false; }
    this.placeholder = null;
    if (this.renderComp) this.renderComp.unload();
    this.renderComp = new Component();
    this.renderComp.load();
    const w = this.plugin.settings.columnWidth;
    boardEl.setCssProps({ "--mdk-col-width": `${w}px` });
    boardEl.setCssProps({ "--mdk-card-width": `${w - 24}px` });
    boardEl.toggleClass("is-rows", this.isRows());
    this.updateToolbarState();
    if (!this.board) return;

    this.board.columns.forEach((col, ci) => this.renderColumn(col, ci));

    this.addColEl = boardEl.createDiv("mdk-add-col");
    this.addColEl.createEl("button", { cls: "mdk-ghost-btn", text: this.isRows() ? "+ Add row" : "+ Add column" }).onclick = () => this.startAddColumn();

    boardEl.querySelectorAll(".mdk-cards").forEach((l, i) => {
      if (!scrolls[i]) return;
      l.scrollTop = scrolls[i][0];
      l.scrollLeft = scrolls[i][1];
    });
    this.applyFilter();
    this.updateStats();
  }

  renderColumn(col, ci) {
    const name = colName(col);
    const collapsed = this.plugin.isCollapsed(this.file, name);
    const colEl = this.boardEl.createDiv("mdk-col");
    colEl.dataset.ci = String(ci);
    colEl.toggleClass("is-collapsed", collapsed);
    const isPile = ci === this.pileIndex();
    colEl.toggleClass("is-done-col", isPile);

    // header
    const head = colEl.createDiv("mdk-col-head");
    head.draggable = true;
    const chev = head.createDiv({ cls: "clickable-icon mdk-icon", attr: { "aria-label": collapsed ? "Expand" : "Collapse" } });
    setIcon(chev, collapsed ? "chevron-right" : "chevron-down");
    chev.onclick = () => this.toggleCollapsed(col);

    const icon = colIcon(col, isPile);
    if (icon) {
      const ic = head.createSpan({ cls: "mdk-col-icon", attr: { "aria-label": isPile ? "Done pile" : icon } });
      ic.toggleClass("mdk-pile-icon", isPile);
      const tint = !isPile && getField(col.title, "color");
      if (tint) ic.setCssStyles({ color: colorValue(tint) });
      setIcon(ic, icon);
    }
    const title = head.createDiv({ cls: "mdk-col-title", text: name });
    head.createSpan({ cls: "mdk-count", text: String(col.cards.length) });

    const rename = () => {
      head.draggable = false;
      title.empty();
      this.openEditor(title, {
        value: name,
        multiline: false,
        onSubmit: (v) => {
          v = stripFields(v) || name;
          if (v !== name) {
            this.plugin.renameCollapsed(this.file, name, v);
            this.plugin.renamePile(this.file, name, v);
          }
          const fields = (col.title.match(FIELDS_RE) || []).map((f) => f.trim());
          col.title = [v, ...fields].join(" "); // keep the column's icon and color
          this.commit();
        },
        onCancel: () => this.render(),
      });
    };
    title.ondblclick = rename;

    if (!collapsed) {
      const add = head.createDiv({ cls: "clickable-icon mdk-icon mdk-head-hover", attr: { "aria-label": "Add card to top" } });
      setIcon(add, "plus");
      add.onclick = () => this.openNewCard(ci, true);
    }
    const more = head.createDiv({ cls: "clickable-icon mdk-icon mdk-head-hover", attr: { "aria-label": "Column options" } });
    setIcon(more, "more-horizontal");
    more.onclick = (e) => this.columnMenu(col, ci, rename).showAtMouseEvent(e);
    head.addEventListener("contextmenu", (e) => { e.preventDefault(); this.columnMenu(col, ci, rename).showAtMouseEvent(e); });

    head.addEventListener("dragstart", (e) => {
      if (!head.draggable) { e.preventDefault(); return; }
      this.drag = { kind: "col", ci };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", col.title);
      window.setTimeout(() => colEl.addClass("is-dragging"), 0);
    });
    head.addEventListener("dragend", () => this.endDrag());

    if (collapsed) {
      colEl.onclick = (e) => { if (e.target === colEl) this.toggleCollapsed(col); };
      return;
    }

    // cards
    const list = colEl.createDiv("mdk-cards");
    col.cards.forEach((card, ki) => this.renderCard(list, card, ci, ki));
    if (!col.cards.length) list.createDiv({ cls: "mdk-empty", text: "No cards" });

    // "add card" sits right after the last card and scrolls with them
    const foot = list.createDiv("mdk-col-foot");
    foot.createEl("button", { cls: "mdk-ghost-btn", text: "+ Add card" }).onclick = () => this.openNewCard(ci, false);
  }

  // new card in the same editor window used for editing
  openNewCard(ci, top, pos = 0) {
    const card = { checked: false, text: "", extra: [] };
    const modal = new CardEditModal(this.app, this, card, { isNew: true, ci, top, pos });
    this.lastEditor = modal;
    modal.open();
  }

  scrollColumnToEnd(ci) {
    const list = this.boardEl.querySelector(`.mdk-col[data-ci="${ci}"] .mdk-cards`);
    if (list) { list.scrollTop = list.scrollHeight; list.scrollLeft = list.scrollWidth; }
  }

  renderCard(list, card, ci, ki) {
    const meta = cardMeta(card);
    const path = this.file ? this.file.path : "";
    const el = list.createDiv("mdk-card");
    el.draggable = true;
    el.dataset.search = searchText(card);
    el.toggleClass("is-checked", !!card.checked);
    // overdue: red; waiting on another card: greyed; untouched for weeks: faded
    const st = this.plugin.cardStateFor(this, card, ci, this.pileIndex());
    el.toggleClass("is-overdue", st.overdue);
    el.toggleClass("is-blocked", st.blockers.length > 0);
    el.toggleClass("is-stale", !!st.stale && !st.blockers.length);
    if (st.blockers.length) el.setAttr("aria-label", blockedLabel(st.blockers));
    else if (st.overdue) el.setAttr("aria-label", "Overdue");
    else if (st.stale) el.setAttr("aria-label", `Untouched for ${st.stale} days`);
    if (meta.color) {
      el.addClass("has-color");
      el.setCssProps({ "--mdk-card-color": colorValue(meta.color) });
    }

    const main = el.createDiv("mdk-card-main");

    // title (+ icon) and description
    const body = main.createDiv("mdk-card-body");
    const titleRow = body.createDiv("mdk-card-title-row");
    if (meta.icon) setIcon(titleRow.createSpan("mdk-card-icon"), meta.icon);
    const title = titleRow.createDiv("mdk-card-title markdown-rendered");
    MarkdownRenderer.render(this.app, meta.title, title, path, this.renderComp);
    if (meta.desc.some((l) => l.trim())) {
      const desc = body.createDiv("mdk-card-desc markdown-rendered");
      MarkdownRenderer.render(this.app, meta.desc.join("\n"), desc, path, this.renderComp);
    }

    // subtask checklist
    const addingSubtask = this.subtaskFor === card;
    if (meta.subtasks.length || addingSubtask) {
      const st = main.createDiv("mdk-subtasks");
      meta.subtasks.forEach((s) => {
        const row = st.createDiv("mdk-subtask");
        row.toggleClass("is-checked", s.checked);
        const scb = row.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox" });
        scb.checked = s.checked;
        scb.onclick = (e) => { e.stopPropagation(); toggleSubtask(card, s.index, scb.checked); this.commit(); };
        const txt = row.createDiv("mdk-subtask-text markdown-rendered");
        MarkdownRenderer.render(this.app, s.text, txt, path, this.renderComp);
      });
      if (addingSubtask) {
        el.draggable = false;
        this.openEditor(st.createDiv("mdk-subtask-new"), {
          multiline: false,
          placeholder: "Add subtask (Enter to add, Esc to finish)",
          onSubmit: (v, viaEnter) => {
            addSubtask(card, v);
            if (!viaEnter) this.subtaskFor = null;
            this.commit();
          },
          onCancel: () => { this.subtaskFor = null; this.render(); },
        });
      }
    }

    // chips: blocked, due date, subtask progress, tags
    renderChips(main, card, meta, st, { onDue: () => this.pickDue(card), onTag: (t) => this.setFilter(`#${t}`) });

    // comments: small icon, always in the bottom-right corner
    const n = meta.comments.length;
    const cm = el.createDiv({
      cls: `mdk-comments${n ? " has-comments" : ""}`,
      attr: { "aria-label": n ? `${n} comment${n === 1 ? "" : "s"}` : "Add a comment" },
    });
    setIcon(cm.createSpan("mdk-comments-icon"), "message-square");
    if (n) cm.createSpan({ cls: "mdk-comments-count", text: String(n) });
    cm.onclick = (e) => { e.stopPropagation(); this.openComments(card); };
    cm.ondblclick = (e) => e.stopPropagation();

    const edit = (focus) => this.openCardEditor(card, focus);

    const actions = el.createDiv("mdk-card-actions");
    if (!card.checked) {
      const pile = this.pileIndex();
      const doneBtn = actions.createDiv({
        cls: "clickable-icon mdk-icon mdk-done-btn",
        attr: { "aria-label": pile >= 0 && pile !== ci ? `Done (move to ${colName(this.board.columns[pile])})` : "Mark done" },
      });
      setIcon(doneBtn, "check");
      doneBtn.onclick = (e) => { e.stopPropagation(); this.markDone(ci, ki); };
    }
    const editBtn = actions.createDiv({ cls: "clickable-icon mdk-icon", attr: { "aria-label": "Edit" } });
    setIcon(editBtn, "pencil");
    editBtn.onclick = (e) => { e.stopPropagation(); edit(); };
    const moreBtn = actions.createDiv({ cls: "clickable-icon mdk-icon", attr: { "aria-label": "More" } });
    setIcon(moreBtn, "more-horizontal");
    moreBtn.onclick = (e) => { e.stopPropagation(); this.cardMenu(card, ci, ki, edit).showAtMouseEvent(e); };

    el.addEventListener("dblclick", (e) => {
      if (e.target.closest("a, input, .mdk-chip, .mdk-card-actions")) return;
      edit();
    });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); this.cardMenu(card, ci, ki, edit).showAtMouseEvent(e); });

    el.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      if (this.filter || !el.draggable) { e.preventDefault(); return; }
      this.drag = { kind: "card", ci, ki, height: el.offsetHeight, width: el.offsetWidth };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", cardSource(card));
      window.setTimeout(() => {
        if (!this.drag) return;
        el.addClass("is-dragging");
        el.parentElement.insertBefore(this.getPlaceholder(), el);
      }, 0);
    });
    el.addEventListener("dragend", () => this.endDrag());
  }

  // ----- menus -----

  columnMenu(col, ci, rename) {
    const cols = this.board.columns;
    const collapsed = this.plugin.isCollapsed(this.file, colName(col));
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Rename").setIcon("pencil").onClick(rename));
    if (ci !== this.pileIndex()) {
      menu.addItem((i) => i.setTitle("Icon & color...").setIcon("palette").onClick(() => this.pickColumnLook(col)));
    }
    menu.addItem((i) => i.setTitle(collapsed ? "Expand" : "Collapse").setIcon(collapsed ? "chevron-right" : "chevron-down")
      .onClick(() => this.toggleCollapsed(col)));
    if (!collapsed) {
      menu.addItem((i) => i.setTitle("Add card to top").setIcon("plus").onClick(() => {
        this.openNewCard(ci, true);
      }));
    }

    menu.addSeparator();
    if (ci === this.pileIndex()) {
      menu.addItem((i) => i.setTitle("Stop using as done pile").setIcon("circle-off").onClick(() => {
        this.plugin.setPile(this.file, ""); this.render();
      }));
    } else {
      menu.addItem((i) => i.setTitle("Set as done pile").setIcon("circle-check").onClick(() => {
        this.plugin.setPile(this.file, colName(col)); this.render();
      }));
    }

    const open = col.cards.filter((c) => c.checked === false);
    const done = col.cards.filter((c) => c.checked);
    if (open.length || done.length) menu.addSeparator();
    if (open.length) {
      menu.addItem((i) => i.setTitle("Mark all done").setIcon("check-check").onClick(() => {
        open.forEach((c) => { c.checked = true; }); this.commit();
      }));
    }
    if (done.length) {
      menu.addItem((i) => i.setTitle(`Archive ${done.length} done card${done.length === 1 ? "" : "s"}`).setIcon("archive")
        .onClick(() => this.archiveDone(ci)));
      menu.addItem((i) => i.setTitle(`Delete ${done.length} done card${done.length === 1 ? "" : "s"}`).setIcon("eraser")
        .onClick(() => { col.cards = col.cards.filter((c) => !c.checked); this.commit(); }));
    }

    menu.addSeparator();
    if (ci > 0) menu.addItem((i) => i.setTitle("Move left").setIcon("arrow-left").onClick(() => {
      [cols[ci - 1], cols[ci]] = [cols[ci], cols[ci - 1]]; this.commit();
    }));
    if (ci < cols.length - 1) menu.addItem((i) => i.setTitle("Move right").setIcon("arrow-right").onClick(() => {
      [cols[ci + 1], cols[ci]] = [cols[ci], cols[ci + 1]]; this.commit();
    }));
    menu.addItem((i) => i.setTitle("Delete column").setIcon("trash").setWarning(true).onClick(() => {
      const del = () => { cols.splice(ci, 1); this.commit(); };
      if (col.cards.length) {
        new ConfirmModal(this.app, `Delete "${colName(col)}" and its ${col.cards.length} card${col.cards.length === 1 ? "" : "s"}? You can undo with Ctrl+Z.`, "Delete", del).open();
      } else del();
    }));
    return menu;
  }

  cardMenu(card, ci, ki, edit) {
    const cols = this.board.columns;
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Edit card...").setIcon("pencil").onClick(() => edit()));
    menu.addItem((i) => i.setTitle("Edit subtasks...").setIcon("list-checks").onClick(() => edit("subtasks")));
    menu.addItem((i) => i.setTitle("Comments...").setIcon("message-square").onClick(() => this.openComments(card)));
    const pile = this.pileIndex();
    if (card.checked) {
      menu.addItem((i) => i.setTitle("Mark not done").setIcon("rotate-ccw").onClick(() => { card.checked = false; this.commit(); }));
    } else {
      const label = pile >= 0 && pile !== ci ? `Mark done (move to ${colName(cols[pile])})` : "Mark done";
      menu.addItem((i) => i.setTitle(label).setIcon("check").onClick(() => this.markDone(ci, ki)));
    }
    menu.addItem((i) => i.setTitle(getDue(card) ? "Change due date" : "Set due date").setIcon("calendar")
      .onClick(() => this.pickDue(card)));
    if (getDue(card)) {
      menu.addItem((i) => i.setTitle("Remove due date").setIcon("calendar-x").onClick(() => { setDue(card, null); this.commit(); }));
    }
    menu.addItem((i) => i.setTitle("Icon & color...").setIcon("palette").onClick(() => this.pickCardLook(card)));
    menu.addItem((i) => i.setTitle("Add subtask").setIcon("list-plus").onClick(() => { this.subtaskFor = card; this.render(); }));

    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Create note from card").setIcon("file-plus").onClick(() => this.noteFromCard(card)));
    menu.addItem((i) => i.setTitle("Duplicate").setIcon("copy").onClick(() => {
      const copy = { checked: card.checked, text: withField(card.text, "id", null), extra: card.extra.slice() };
      cols[ci].cards.splice(ki + 1, 0, copy);
      this.commit();
    }));
    if (ki > 0) menu.addItem((i) => i.setTitle("Move to top").setIcon("arrow-up-to-line").onClick(() => this.moveCard(ci, ki, ci, 0)));
    if (ki < cols[ci].cards.length - 1) {
      menu.addItem((i) => i.setTitle("Move to bottom").setIcon("arrow-down-to-line")
        .onClick(() => this.moveCard(ci, ki, ci, cols[ci].cards.length - 1)));
    }

    const others = cols.map((c, i) => [c, i]).filter(([, i]) => i !== ci);
    if (others.length) {
      menu.addSeparator();
      others.forEach(([c, i]) => menu.addItem((it) => it.setTitle(`Move to ${colName(c)}`).setIcon("arrow-right")
        .onClick(() => this.moveCard(ci, ki, i, c.cards.length))));
    }

    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Archive").setIcon("archive").onClick(() => this.archiveCard(ci, ki)));
    menu.addItem((i) => i.setTitle("Delete").setIcon("trash").setWarning(true).onClick(() => {
      cols[ci].cards.splice(ki, 1); this.commit();
    }));
    return menu;
  }

  // ----- card actions -----

  pickCardLook(card) {
    const icon = getField(card.text, "icon");
    const color = getField(card.text, "color");
    new IconColorModal(this.app, { title: "Card icon & color", icon, color }, (pick) => {
      if (pick.icon !== icon) setField(card, "icon", pick.icon);
      if (pick.color !== color) setField(card, "color", pick.color);
      this.commit();
    }).open();
  }

  pickColumnLook(col) {
    const icon = colIcon(col, false);
    const color = getField(col.title, "color");
    new IconColorModal(this.app, { title: `"${colName(col)}" icon & color`, icon, color }, (pick) => {
      if (pick.icon !== icon) setColIcon(col, pick.icon);
      if (pick.color !== color) setColField(col, "color", pick.color);
      this.commit();
    }).open();
  }

  setFilter(text) {
    if (this.searchEl) this.searchEl.value = text;
    this.filter = text.trim().toLowerCase();
    this.applyFilter();
  }

  pickDue(card) {
    new DueModal(this.app, getDue(card), (iso) => { setDue(card, iso); this.commit(); }).open();
  }

  async noteFromCard(card) {
    const name = stripMeta(card.text)
      .replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, "$1")
      .replace(/[\\/:*?"<>|#^[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    if (!name) { new Notice("This card has no text to name a note with."); return; }

    const parent = this.file && this.file.parent ? this.file.parent.path : "";
    const path = normalizePath(parent && parent !== "/" ? `${parent}/${name}.md` : `${name}.md`);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      const extra = dedent(card.extra).join("\n");
      file = await this.app.vault.create(path, extra ? extra + "\n" : "");
      card.extra = [];
    }
    const due = getDue(card);
    const color = getField(card.text, "color");
    const icon = getField(card.text, "icon");
    card.text = [`[[${file.basename}]]`, ...getTags(card.text).map((t) => `#${t}`)].join(" ");
    if (due) setDue(card, due);
    if (color) setField(card, "color", color);
    if (icon) setField(card, "icon", icon);
    this.commit();
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  moveCard(fromCol, fromIdx, toCol, toIdx) {
    const cols = this.board.columns;
    const [card] = cols[fromCol].cards.splice(fromIdx, 1);
    if (!card) return;
    toIdx = Math.max(0, Math.min(toIdx, cols[toCol].cards.length));
    if (fromCol === toCol && fromIdx === toIdx) {
      cols[fromCol].cards.splice(fromIdx, 0, card);
      this.render();
      return;
    }
    const pile = this.pileIndex();
    if (fromCol !== toCol && this.plugin.settings.autoDone) {
      if (toCol === pile) card.checked = true;
      else if (fromCol === pile && card.checked !== null) card.checked = false;
    }
    cols[toCol].cards.splice(toIdx, 0, card);
    this.commit();
  }

  checkDay() {
    if (!this.board || isoDate(0) === this.renderedDay) return;
    if (this.drag) return; // mid-drag; try again next tick
    const a = document.activeElement;
    if (a && this.boardEl && this.boardEl.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return; // typing on the board
    this.render();
  }

  // index of this board's done pile column, or -1
  pileIndex() {
    return pileIndexOf(this.board, this.plugin.getPile(this.file));
  }

  // ----- archive -----

  archiveCards(cards, fromName) {
    if (!this.board.archive) this.board.archive = { title: ARCHIVE_TITLE, notes: [], cards: [] };
    const today = isoDate(0);
    cards.forEach((c) => { setField(c, "from", fromName); setField(c, "archived", today); });
    this.board.archive.cards.unshift(...cards);
  }

  archiveCard(ci, ki) {
    const col = this.board.columns[ci];
    const [card] = col.cards.splice(ki, 1);
    if (!card) return;
    this.archiveCards([card], colName(col));
    this.commit();
    new Notice("Card archived");
  }

  archiveDone(ci) {
    const col = this.board.columns[ci];
    const done = col.cards.filter((c) => c.checked);
    if (!done.length) return;
    col.cards = col.cards.filter((c) => !c.checked);
    this.archiveCards(done, colName(col));
    this.commit();
    new Notice(`Archived ${done.length} card${done.length === 1 ? "" : "s"}`);
  }

  restoreCard(card) {
    const a = this.board.archive;
    const i = a ? a.cards.indexOf(card) : -1;
    if (i < 0) return;
    a.cards.splice(i, 1);
    const from = getField(card.text, "from");
    setField(card, "from", null);
    setField(card, "archived", null);
    const cols = this.board.columns;
    if (!cols.length) cols.push({ title: "To do", notes: [], cards: [] });
    const target = cols.find((c) => colName(c) === from) || cols[0];
    target.cards.unshift(card);
    this.commit();
  }

  deleteArchived(card) {
    const a = this.board.archive;
    const i = a ? a.cards.indexOf(card) : -1;
    if (i < 0) return;
    a.cards.splice(i, 1);
    this.commit();
  }

  emptyArchive() {
    if (!this.board.archive || !this.board.archive.cards.length) return;
    const n = this.board.archive.cards.length;
    this.board.archive.cards = [];
    this.commit();
    new Notice(`Deleted ${n} archived card${n === 1 ? "" : "s"}. Ctrl+Z to undo.`);
  }

  openComments(card) {
    const modal = new CommentsModal(this.app, this, card);
    this.lastComments = modal;
    modal.open();
  }

  // ----- board title = file name -----

  renameBoard() {
    if (!this.file) return;
    const file = this.file;
    const el = this.boardTitleEl;
    this.renamingBoard = true;
    el.empty();
    const done = () => { this.renamingBoard = false; this.updateToolbarState(); };
    this.openEditor(el, {
      value: file.basename,
      multiline: false,
      onSubmit: async (v) => {
        const name = v.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
        if (name && name !== file.basename) {
          const parent = file.parent && file.parent.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
          try {
            await this.app.fileManager.renameFile(file, normalizePath(`${parent}${name}.md`));
          } catch (e) {
            new Notice(`Couldn't rename: ${e.message}`);
          }
        }
        done();
      },
      onCancel: done,
    });
  }

  async onRename(file) {
    if (super.onRename) await super.onRename(file);
    this.updateToolbarState();
  }

  openCardEditor(card, focus) {
    const modal = new CardEditModal(this.app, this, card, { focus });
    this.lastEditor = modal;
    modal.open();
  }

  // move a card to the top of the done pile (if there is one and it isn't already there)
  sendToPile(card) {
    const cols = this.board.columns;
    const pile = this.pileIndex();
    if (pile < 0) return;
    const ci = cols.findIndex((c) => c.cards.includes(card));
    if (ci < 0 || ci === pile) return;
    cols[ci].cards.splice(cols[ci].cards.indexOf(card), 1);
    cols[pile].cards.unshift(card);
  }

  // check the card and, if there's a pile elsewhere, send it to the top of the pile
  markDone(ci, ki) {
    const cols = this.board.columns;
    const pile = this.pileIndex();
    const card = cols[ci].cards[ki];
    if (!card) return;
    card.checked = true;
    if (pile >= 0 && pile !== ci) {
      cols[ci].cards.splice(ki, 1);
      cols[pile].cards.unshift(card);
    }
    this.commit();
  }

  toggleCollapsed(col) {
    const name = colName(col);
    this.plugin.setCollapsed(this.file, name, !this.plugin.isCollapsed(this.file, name));
    this.render();
  }

  startAddColumn() {
    if (!this.addColEl) return;
    const host = this.addColEl;
    host.empty();
    host.addClass("is-editing");
    this.openEditor(host, {
      multiline: false,
      placeholder: "Column name",
      onSubmit: (v) => { this.board.columns.push({ title: v, notes: [], cards: [] }); this.commit(); },
      onCancel: () => this.render(),
    });
    this.boardEl.scrollLeft = this.boardEl.scrollWidth;
  }

  // ----- drag and drop -----

  getPlaceholder() {
    if (!this.placeholder) {
      this.placeholder = createDiv("mdk-placeholder");
      this.placeholder.setCssStyles({ height: `${(this.drag && this.drag.height) || 40}px` });
      if (this.isRows() && this.drag && this.drag.width) this.placeholder.setCssStyles({ width: `${this.drag.width}px` });
    }
    return this.placeholder;
  }

  placeholderIndex() {
    let i = 0;
    for (let n = this.placeholder.previousElementSibling; n; n = n.previousElementSibling) {
      if (n.hasClass("mdk-card") && !n.hasClass("is-dragging")) i++;
    }
    return i;
  }

  columnAt(e) {
    const hit = e.target.closest && e.target.closest(".mdk-col");
    if (hit) return hit;
    // between columns (or rows): use the nearest one along the board's axis
    const rows = this.isRows();
    let best = null;
    let bestDist = Infinity;
    this.boardEl.querySelectorAll(".mdk-col").forEach((c) => {
      const r = c.getBoundingClientRect();
      const [lo, hi, v] = rows ? [r.top, r.bottom, e.clientY] : [r.left, r.right, e.clientX];
      const d = v < lo ? lo - v : v > hi ? v - hi : 0;
      if (d < bestDist) { bestDist = d; best = c; }
    });
    return best;
  }

  onDragOver(e) {
    if (!this.drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    this.clearColMarkers();
    const rows = this.isRows();
    // is the pointer before the middle of this element, along the axis that matters?
    const before = (el, alongRow) => {
      const r = el.getBoundingClientRect();
      return alongRow ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    };

    if (this.drag.kind === "card") {
      const colEl = this.columnAt(e);
      if (!colEl) return;
      this.dropCol = Number(colEl.dataset.ci);
      if (colEl.hasClass("is-collapsed")) {
        if (this.placeholder) this.placeholder.detach();
        colEl.addClass("is-drop-target");
        return;
      }
      const list = colEl.querySelector(".mdk-cards");
      const ph = this.getPlaceholder();
      const cards = Array.from(list.children).filter((n) => n.hasClass("mdk-card") && !n.hasClass("is-dragging"));
      const target = cards.find((c) => before(c, rows));
      const anchor = target || list.querySelector(":scope > .mdk-col-foot");
      if (anchor) { if (ph.nextElementSibling !== anchor || ph.parentElement !== list) list.insertBefore(ph, anchor); }
      else if (ph.parentElement !== list || ph.nextElementSibling) list.appendChild(ph);
      colEl.addClass("is-drop-target");
    } else {
      const cols = Array.from(this.boardEl.querySelectorAll(".mdk-col"));
      let idx = cols.findIndex((c) => before(c, !rows));
      if (idx === -1) idx = cols.length;
      this.dropColIdx = idx;
      if (idx < cols.length) cols[idx].addClass("mdk-col-drop-before");
      else if (cols.length) cols[cols.length - 1].addClass("mdk-col-drop-after");
    }
  }

  onDrop(e) {
    if (!this.drag) return;
    e.preventDefault();
    const d = this.drag;
    const dropCol = this.dropCol;
    const dropColIdx = this.dropColIdx;
    const ph = this.placeholder;
    const phCol = ph && ph.isConnected ? ph.closest(".mdk-col") : null;
    const phIdx = phCol ? this.placeholderIndex() : null;
    this.drag = null;

    if (d.kind === "card") {
      if (dropCol === null) { this.render(); return; }
      const target = this.board.columns[dropCol];
      const idx = phCol && Number(phCol.dataset.ci) === dropCol
        ? phIdx
        : target.cards.length - (d.ci === dropCol ? 1 : 0);
      this.moveCard(d.ci, d.ki, dropCol, idx);
    } else {
      if (dropColIdx === null) { this.render(); return; }
      let to = dropColIdx;
      if (d.ci < to) to--;
      if (to === d.ci) { this.render(); return; }
      const [col] = this.board.columns.splice(d.ci, 1);
      this.board.columns.splice(to, 0, col);
      this.commit();
    }
  }

  endDrag() {
    this.drag = null;
    this.dropCol = null;
    this.dropColIdx = null;
    if (this.placeholder) this.placeholder.detach();
    this.placeholder = null;
    this.clearColMarkers();
    if (this.boardEl) this.boardEl.querySelectorAll(".is-dragging").forEach((n) => n.removeClass("is-dragging"));
  }

  clearColMarkers() {
    if (!this.boardEl) return;
    this.boardEl.querySelectorAll(".mdk-col-drop-before, .mdk-col-drop-after, .is-drop-target")
      .forEach((n) => n.removeClass("mdk-col-drop-before", "mdk-col-drop-after", "is-drop-target"));
  }

  // ----- inline editor -----

  openEditor(host, { value = "", placeholder = "", multiline = true, onSubmit, onCancel }) {
    const input = host.createEl(multiline ? "textarea" : "input", { cls: "mdk-input", attr: { placeholder, rows: "1" } });
    input.value = value;
    const autosize = () => {
      if (!multiline) return;
      input.setCssStyles({ height: "auto" });
      input.setCssStyles({ height: `${input.scrollHeight}px` });
    };
    input.addEventListener("input", autosize);

    let done = false;
    const finish = (save, viaEnter) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v) onSubmit(v, viaEnter);
      else onCancel(viaEnter ? "enter" : save ? "blur" : "escape");
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish(true, true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false, false); }
    });
    input.addEventListener("blur", () => {
      if (this.clearing) { done = true; return; } // board is being redrawn; this box is going away
      finish(true, false);
    });
    window.setTimeout(() => {
      autosize();
      input.focus();
      if (value) input.select();
      input.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, 0);
    return input;
  }
}

// =====================================================================
// settings
// =====================================================================

// A board that isn't open in a tab: edits go straight to the file.
// Offers the same calls the card window, comments popup and embeds use on a KanbanView.
class FileBoard {
  constructor(plugin, file, data) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.file = file;
    this.snapshot = data;
    this.board = parseBoard(data);
  }
  pileIndex() { return pileIndexOf(this.board, this.plugin.getPile(this.file)); }
  render() {}
  scrollColumnToEnd() {}
  openNewCard(ci, top, pos = 0) {
    const card = { checked: false, text: "", extra: [] };
    new CardEditModal(this.app, this, card, { isNew: true, ci, top, pos }).open();
  }
  openCardEditor(card, focus) { new CardEditModal(this.app, this, card, { focus }).open(); }
  async commit() {
    this.plugin.onBoardChange(this.file, parseBoard(this.snapshot), this.board);
    const out = serializeBoard(this.board);
    let ok = true;
    await this.app.vault.process(this.file, (data) => {
      if (data !== this.snapshot) { ok = false; return data; }
      return out;
    });
    if (ok) this.snapshot = out;
    else new Notice(`${this.file.basename} changed somewhere else, so that edit wasn't saved. Try again.`);
    return ok;
  }
}
FileBoard.prototype.sendToPile = KanbanView.prototype.sendToPile;
FileBoard.prototype.markDone = KanbanView.prototype.markDone;
FileBoard.prototype.moveCard = KanbanView.prototype.moveCard;

// A live column (or whole board) shown inside a note.
//   ```kanplete
//   board: Gym plan
//   column: Doing
//   ```
const EMBED_LANG = "kanplete";

function parseEmbedSource(src) {
  const o = {};
  src.split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*(board|column)\s*:\s*(.*?)\s*$/i);
    if (m) o[m[1].toLowerCase()] = m[2].replace(/^\[\[|\]\]$/g, "");
  });
  return o;
}

class BoardEmbed extends MarkdownRenderChild {
  constructor(plugin, el, src, sourcePath) {
    super(el);
    this.plugin = plugin;
    this.app = plugin.app;
    this.opts = parseEmbedSource(src);
    this.sourcePath = sourcePath;
    this.drag = null;
  }
  onload() {
    this.registerEvent(this.app.vault.on("modify", (f) => { if (this.file && f.path === this.file.path) this.refresh(); }));
    this.registerInterval(window.setInterval(() => { if (this.day !== isoDate(0)) this.refresh(); }, 60 * 1000));
    this.refresh();
  }
  async refresh() {
    if (this.drag) return;
    const name = this.opts.board || "";
    this.file = name ? this.app.metadataCache.getFirstLinkpathDest(name, this.sourcePath) : null;
    if (!this.file || !this.plugin.isBoard(this.file)) {
      this.target = null;
      this.renderMessage(name ? `Board "${name}" wasn't found.` : "Pick a board: add a line like \"board: Gym plan\".");
      return;
    }
    this.target = await this.plugin.boardTarget(this.file);
    this.render();
  }
  renderMessage(text) {
    const el = this.containerEl;
    el.empty();
    el.createDiv({ cls: "mdk-embed mdk-embed-msg", text });
  }
  // after an edit: redraw from the edited board right away; the file event refreshes later
  after() { this.render(); }
  render() {
    const t = this.target;
    if (!t || !t.board) return;
    this.day = isoDate(0);
    const board = t.board;
    const pile = t.pileIndex();
    const el = this.containerEl;
    el.empty();
    const root = el.createDiv("mdk-embed");
    // in editing mode a click on a rendered block opens its source; keep clicks on cards and buttons for us
    const ours = (e) => e.target.closest && e.target.closest(".mdk-card, button, a, input, select, .clickable-icon");
    root.addEventListener("mousedown", (e) => { if (ours(e)) e.stopPropagation(); });
    root.addEventListener("click", (e) => { if (ours(e)) e.stopPropagation(); });
    const head = root.createDiv("mdk-embed-head");
    setIcon(head.createSpan("mdk-embed-icon"), "kanban");
    const link = head.createEl("a", { cls: "mdk-embed-board", text: this.file.basename, attr: { "aria-label": "Open board" } });
    link.onclick = (e) => { e.preventDefault(); this.plugin.openBoard(this.file); };

    let shown = board.columns.map((c, ci) => ci);
    if (this.opts.column) {
      const ci = board.columns.findIndex((c) => colName(c).toLowerCase() === this.opts.column.toLowerCase());
      if (ci < 0) {
        root.createDiv({ cls: "mdk-embed-msg", text: `Column "${this.opts.column}" isn't on this board.` });
        return;
      }
      shown = [ci];
      head.createSpan({ cls: "mdk-embed-sep", text: "/" });
      head.createSpan({ cls: "mdk-embed-col-name", text: colName(board.columns[ci]) });
      head.createSpan({ cls: "mdk-count", text: String(board.columns[ci].cards.length) });
    }
    const wrap = root.createDiv(`mdk-embed-cols${shown.length > 1 ? " is-multi" : ""}`);
    shown.forEach((ci) => this.renderColumn(wrap, ci, shown.length > 1, pile));
  }
  renderColumn(wrap, ci, showHead, pile) {
    const t = this.target;
    const col = t.board.columns[ci];
    const colEl = wrap.createDiv("mdk-embed-col");
    if (showHead) {
      const h = colEl.createDiv("mdk-embed-col-head");
      const ic = colIcon(col, ci === pile);
      if (ic) setIcon(h.createSpan("mdk-col-icon"), ic);
      h.createSpan({ text: colName(col) });
      h.createSpan({ cls: "mdk-count", text: String(col.cards.length) });
    }
    const list = colEl.createDiv("mdk-embed-cards");
    list.dataset.ci = String(ci);
    col.cards.forEach((card, ki) => this.renderCard(list, card, ci, ki, pile));
    if (!col.cards.length) list.createDiv({ cls: "mdk-empty", text: "No cards" });
    const add = colEl.createEl("button", { cls: "mdk-ghost-btn", text: "+ Add card" });
    add.onclick = () => t.openNewCard(ci, false);

    list.addEventListener("dragover", (e) => {
      if (!this.drag) return;
      e.preventDefault();
      this.markDrop(list, e.clientY);
    });
    list.addEventListener("dragleave", (e) => { if (!list.contains(e.relatedTarget)) this.clearDrop(); });
    list.addEventListener("drop", (e) => {
      if (!this.drag) return;
      e.preventDefault();
      const idx = this.dropIndex(list, e.clientY);
      const { ci: fc, ki: fk } = this.drag;
      this.drag = null;
      this.clearDrop();
      const to = fc === ci && idx > fk ? idx - 1 : idx;
      this.after(t.moveCard(fc, fk, ci, to));
    });
  }
  dropIndex(list, y) {
    const cards = Array.from(list.querySelectorAll(":scope > .mdk-card"));
    const i = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return i < 0 ? cards.length : i;
  }
  markDrop(list, y) {
    this.clearDrop();
    const cards = Array.from(list.querySelectorAll(":scope > .mdk-card"));
    const i = this.dropIndex(list, y);
    if (i < cards.length) cards[i].addClass("mdk-drop-before");
    else list.addClass("mdk-drop-end");
  }
  clearDrop() {
    this.containerEl.querySelectorAll(".mdk-drop-before").forEach((x) => x.removeClass("mdk-drop-before"));
    this.containerEl.querySelectorAll(".mdk-drop-end").forEach((x) => x.removeClass("mdk-drop-end"));
  }
  renderCard(list, card, ci, ki, pile) {
    const t = this.target;
    const meta = cardMeta(card);
    const st = this.plugin.cardStateFor(t, card, ci, pile);
    const el = list.createDiv("mdk-card mdk-embed-card");
    el.draggable = true;
    el.toggleClass("is-checked", !!card.checked);
    el.toggleClass("is-overdue", st.overdue);
    el.toggleClass("is-blocked", st.blockers.length > 0);
    el.toggleClass("is-stale", !!st.stale);
    if (st.stale) el.setAttr("aria-label", `Untouched for ${st.stale} days`);
    if (meta.color) { el.addClass("has-color"); el.setCssProps({ "--mdk-card-color": colorValue(meta.color) }); }

    const main = el.createDiv("mdk-card-main");
    const body = main.createDiv("mdk-card-body");
    const titleRow = body.createDiv("mdk-card-title-row");
    if (meta.icon) setIcon(titleRow.createSpan("mdk-card-icon"), meta.icon);
    const title = titleRow.createDiv("mdk-card-title markdown-rendered");
    MarkdownRenderer.render(this.app, meta.title, title, this.file.path, this);

    if (meta.subtasks.length) {
      const sl = main.createDiv("mdk-subtasks");
      meta.subtasks.forEach((s) => {
        const row = sl.createDiv("mdk-subtask");
        row.toggleClass("is-checked", s.checked);
        const cb = row.createEl("input", { type: "checkbox", cls: "task-list-item-checkbox" });
        cb.checked = s.checked;
        cb.onclick = (e) => { e.stopPropagation(); toggleSubtask(card, s.index, cb.checked); this.after(t.commit()); };
        row.createDiv({ cls: "mdk-subtask-text", text: s.text });
      });
    }
    renderChips(main, card, meta, st);

    const n = meta.comments.length;
    const cm = el.createDiv({ cls: `mdk-comments${n ? " has-comments" : ""}`, attr: { "aria-label": n ? `${n} comment${n === 1 ? "" : "s"}` : "Add a comment" } });
    setIcon(cm.createSpan("mdk-comments-icon"), "message-square");
    if (n) cm.createSpan({ cls: "mdk-comments-count", text: String(n) });
    cm.onclick = (e) => { e.stopPropagation(); new CommentsModal(this.app, t, card).open(); };

    const actions = el.createDiv("mdk-card-actions");
    if (!cardIsDone(card, ci, pile)) {
      const d = actions.createDiv({ cls: "clickable-icon mdk-icon mdk-done-btn", attr: { "aria-label": "Mark done" } });
      setIcon(d, "check");
      d.onclick = (e) => { e.stopPropagation(); this.after(t.markDone(ci, ki)); };
    }
    const ed = actions.createDiv({ cls: "clickable-icon mdk-icon", attr: { "aria-label": "Edit" } });
    setIcon(ed, "pencil");
    ed.onclick = (e) => { e.stopPropagation(); t.openCardEditor(card); };
    el.addEventListener("dblclick", (e) => {
      if (e.target.closest("a, input, .mdk-chip, .mdk-card-actions, .mdk-comments")) return;
      t.openCardEditor(card);
    });

    el.addEventListener("dragstart", (e) => {
      this.drag = { ci, ki };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", meta.title);
      window.setTimeout(() => el.addClass("is-dragging"), 0);
    });
    el.addEventListener("dragend", () => {
      el.removeClass("is-dragging");
      this.clearDrop();
      if (this.drag) { this.drag = null; this.refresh(); }
    });
  }
}

// Pick a board (and optionally a column) - used to insert a live column into a note.
class BoardPickModal extends Modal {
  constructor(plugin, boards, onPick) {
    super(plugin.app);
    this.plugin = plugin;
    this.boards = boards;
    this.onPick = onPick;
  }
  onOpen() {
    this.titleEl.setText("Insert board column");
    const c = this.contentEl;
    const field = (label) => { const f = c.createDiv("mdk-field"); f.createDiv({ cls: "mdk-picker-label", text: label }); return f; };
    this.boardSel = field("Board").createEl("select", { cls: "dropdown mdk-edit-select" });
    this.boards.forEach((b, i) => this.boardSel.createEl("option", { text: b.basename, attr: { value: String(i) } }));
    this.colSel = field("Column").createEl("select", { cls: "dropdown mdk-edit-select" });
    this.boardSel.onchange = () => this.fillColumns();
    const foot = c.createDiv("mdk-edit-foot");
    foot.createDiv("mdk-spacer");
    foot.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    foot.createEl("button", { cls: "mod-cta", text: "Insert" }).onclick = () => {
      const file = this.boards[Number(this.boardSel.value)];
      this.close();
      this.onPick(file, this.colSel.value || null);
    };
    this.fillColumns();
  }
  async fillColumns() {
    const file = this.boards[Number(this.boardSel.value)];
    const board = parseBoard(await this.app.vault.cachedRead(file));
    const sel = this.colSel;
    sel.empty();
    board.columns.forEach((col) => sel.createEl("option", { text: colName(col), attr: { value: colName(col) } }));
    sel.createEl("option", { text: "Whole board", attr: { value: "" } });
  }
  onClose() { this.contentEl.empty(); }
}

class KanbanSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl;
    el.empty();
    new Setting(el)
      .setName("Column width")
      .setDesc("Width of each column in pixels.")
      .addSlider((s) => s.setLimits(200, 480, 10).setValue(this.plugin.settings.columnWidth).setDynamicTooltip()
        .onChange(async (v) => { this.plugin.settings.columnWidth = v; await this.plugin.saveSettings(); this.plugin.refreshViews(); }));
    new Setting(el)
      .setName("Default layout")
      .setDesc("How new boards open. Each board remembers its own layout once you switch it from the toolbar.")
      .addDropdown((d) => d.addOption("columns", "Columns").addOption("rows", "Rows")
        .setValue(this.plugin.settings.defaultLayout)
        .onChange(async (v) => { this.plugin.settings.defaultLayout = v; await this.plugin.saveSettings(); this.plugin.refreshViews(); }));
    new Setting(el)
      .setName("Auto-complete in done pile")
      .setDesc('Cards moved into the done pile get marked done, and unmarked when moved back out. Pick the pile from a column\'s menu; otherwise a column called "Done" is used.')
      .addToggle((t) => t.setValue(this.plugin.settings.autoDone)
        .onChange(async (v) => { this.plugin.settings.autoDone = v; await this.plugin.saveSettings(); }));
    new Setting(el)
      .setName("Fade untouched cards")
      .setDesc("Cards nobody has edited or moved for this long fade out, so forgotten work stands out.")
      .addDropdown((d) => {
        [["0", "Never"], ["7", "After 1 week"], ["14", "After 2 weeks"], ["21", "After 3 weeks"], ["30", "After a month"], ["60", "After 2 months"]]
          .forEach(([v, l]) => d.addOption(v, l));
        d.setValue(String(this.plugin.settings.staleDays || 0)).onChange(async (v) => {
          this.plugin.settings.staleDays = Number(v);
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
      });
    new Setting(el)
      .setName("Log finished cards in your daily note")
      .setDesc('Each card you finish is added under "Done today" in today\'s daily note, with a link to its board. Unticking a card removes its line. Uses the folder and date format from the Daily notes core plugin.')
      .addToggle((t) => t.setValue(!!this.plugin.settings.journalLog)
        .onChange(async (v) => { this.plugin.settings.journalLog = v; await this.plugin.saveSettings(); }));

    new Setting(el).setName("Card templates").setHeading();
    const ts = this.plugin.settings.templates;
    if (!ts.length) {
      el.createEl("p", { cls: "setting-item-description", text: 'No templates yet. In the card window, use "Save as template".' });
    }
    ts.forEach((t, i) => {
      const bits = [];
      if (t.subtasks && t.subtasks.length) bits.push(`${t.subtasks.length} subtask${t.subtasks.length === 1 ? "" : "s"}`);
      if (t.tags && t.tags.length) bits.push(t.tags.map((x) => `#${x}`).join(" "));
      new Setting(el)
        .setName(t.name)
        .setDesc(bits.join(", ") || "Empty template")
        .addExtraButton((b) => b.setIcon("pencil").setTooltip("Rename").onClick(() => {
          new NameModal(this.app, "Rename template", t.name, async (name) => {
            t.name = name;
            await this.plugin.saveSettings();
            this.display();
          }).open();
        }))
        .addExtraButton((b) => b.setIcon("trash").setTooltip("Delete").onClick(async () => {
          ts.splice(i, 1);
          await this.plugin.saveSettings();
          this.display();
        }));
    });
  }
}

// =====================================================================
// plugin
// =====================================================================

module.exports = class KanpletePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.collapsed = this.settings.collapsed || {};
    this.settings.layouts = this.settings.layouts || {};
    this.settings.donePiles = this.settings.donePiles || {};
    if (!Array.isArray(this.settings.templates)) this.settings.templates = []; // none ship with the plugin
    this.focusPrev = null; // sidebar state saved when focus mode is on
    this.markdownMode = new Set(); // board files the user flipped to raw markdown this session

    this.registerView(VIEW_TYPE, (leaf) => new KanbanView(leaf, this));
    this.registerView(DUE_VIEW, (leaf) => new DueView(leaf, this));
    this.addRibbonIcon("calendar-clock", "Due cards", () => this.activateDueView());
    this.addCommand({ id: "show-due", name: "Show due cards", callback: () => this.activateDueView() });
    this.addSettingTab(new KanbanSettingTab(this.app, this));
    this.addRibbonIcon("kanban", "New kanban board", () => this.newBoard());

    this.addCommand({ id: "new-board", name: "New board", callback: () => this.newBoard() });
    this.addCommand({ id: "quick-add", name: "Quick add card", callback: () => this.quickAdd() });
    this.addCommand({ id: "insert-column", name: "Insert board column into note", editorCallback: (editor, view) => this.insertEmbed(editor, view) });
    this.registerMarkdownCodeBlockProcessor(EMBED_LANG, (src, el, ctx) => ctx.addChild(new BoardEmbed(this, el, src, ctx.sourcePath)));
    this.addCommand({
      id: "toggle-layout",
      name: "Switch layout (columns / rows)",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(KanbanView);
        if (!view) return false;
        if (!checking) view.toggleLayout();
        return true;
      },
    });
    this.addCommand({ id: "toggle-focus", name: "Focus mode (hide sidebars)", callback: () => this.toggleFocus() });
    this.addCommand({
      id: "toggle-view",
      name: "Toggle board / markdown",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const view = leaf && leaf.view;
        if (!view || !view.file || view.file.extension !== "md") return false;
        const type = view.getViewType();
        if (type !== VIEW_TYPE && type !== "markdown") return false;
        if (!checking) {
          if (type === VIEW_TYPE) this.openAsMarkdown(leaf);
          else this.openAsBoard(leaf, view.file);
        }
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      menu.addItem((i) => i.setTitle("Open as kanban board").setIcon("kanban")
        .onClick(() => this.openAsBoard(this.app.workspace.getLeaf(false), file)));
    }));

    this.registerEvent(this.app.workspace.on("file-open", () => {
      const v = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (v) this.maybeSwitch(v.leaf);
    }));

    // forget "show as markdown" once no tab has that file open as markdown anymore
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      if (!this.markdownMode.size) return;
      const open = new Set();
      this.app.workspace.getLeavesOfType("markdown").forEach((l) => { if (l.view.file) open.add(l.view.file.path); });
      for (const p of this.markdownMode) if (!open.has(p)) this.markdownMode.delete(p);
    }));

    // keep collapsed-column memory attached to renamed boards
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      let changed = false;
      for (const key of ["collapsed", "layouts", "donePiles"]) {
        const store = this.settings[key];
        if (store[oldPath] !== undefined) {
          store[file.path] = store[oldPath];
          delete store[oldPath];
          changed = true;
        }
      }
      if (changed) this.saveSettings();
      this.updateEmbedsOnRename(file, oldPath);
    }));

    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves((leaf) => this.maybeSwitch(leaf));
    });
  }

  async saveSettings() { await this.saveData(this.settings); }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((l) => l.view.render && l.view.render());
  }

  getLayout(file) {
    return (file && this.settings.layouts[file.path]) || this.settings.defaultLayout || "columns";
  }

  setLayout(file, layout) {
    if (!file) return;
    if (layout === this.settings.defaultLayout) delete this.settings.layouts[file.path];
    else this.settings.layouts[file.path] = layout;
    this.saveSettings();
  }

  isFocused() {
    return !!this.focusPrev;
  }

  toggleFocus() {
    const ws = this.app.workspace;
    const left = ws.leftSplit;
    const right = ws.rightSplit;
    if (this.focusPrev) {
      if (left && !this.focusPrev.left) left.expand();
      if (right && !this.focusPrev.right) right.expand();
      this.focusPrev = null;
    } else {
      this.focusPrev = { left: left ? left.collapsed : true, right: right ? right.collapsed : true };
      if (left) left.collapse();
      if (right) right.collapse();
    }
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((l) => l.view.updateToolbarState && l.view.updateToolbarState());
  }

  isCollapsed(file, title) {
    return !!file && (this.settings.collapsed[file.path] || []).includes(title);
  }

  setCollapsed(file, title, value) {
    if (!file) return;
    const list = new Set(this.settings.collapsed[file.path] || []);
    value ? list.add(title) : list.delete(title);
    if (list.size) this.settings.collapsed[file.path] = Array.from(list);
    else delete this.settings.collapsed[file.path];
    this.saveSettings();
  }

  // done pile per board: undefined = use a column named "Done", "" = none, otherwise a column title
  getPile(file) {
    return file ? this.settings.donePiles[file.path] : undefined;
  }

  setPile(file, title) {
    if (!file) return;
    this.settings.donePiles[file.path] = title;
    this.saveSettings();
  }

  renamePile(file, oldTitle, newTitle) {
    if (file && this.settings.donePiles[file.path] === oldTitle) this.setPile(file, newTitle);
  }

  renameCollapsed(file, oldTitle, newTitle) {
    if (this.isCollapsed(file, oldTitle)) {
      this.setCollapsed(file, oldTitle, false);
      this.setCollapsed(file, newTitle, true);
    }
  }

  // the open board view for a file if there is one (so undo works), otherwise edit the file directly
  async boardTarget(file) {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => l.view.file && l.view.file.path === file.path && l.view.board);
    if (leaf) return leaf.view;
    return new FileBoard(this, file, await this.app.vault.read(file));
  }

  cardStateFor(t, card, ci, pile) {
    const stat = t.file && t.file.stat;
    return cardState(t.board, card, ci, pile, { staleDays: this.settings.staleDays, fallbackMs: stat ? stat.ctime : null });
  }

  // every edit to a board passes through here: stamp touched cards, log finished ones
  onBoardChange(file, oldB, newB, opts = {}) {
    if (!file || !oldB || !newB) return;
    const chosen = this.getPile(file);
    const newPile = pileIndexOf(newB, chosen);
    let oldPile = pileIndexOf(oldB, chosen);
    if (oldPile < 0 && oldB.columns.length === newB.columns.length) oldPile = newPile; // the pile column was just renamed
    const ch = diffBoards(oldB, newB, oldPile, newPile);
    if (opts.stamp !== false && this.settings.staleDays > 0) {
      const today = isoDate(0);
      ch.touched.forEach((c) => { if (getField(c.text, "updated") !== today) setField(c, "updated", today); });
    }
    if (this.settings.journalLog && (ch.done.length || ch.undone.length)) {
      this.logQueue = (this.logQueue || Promise.resolve())
        .then(() => this.logDone(file, ch.done, ch.undone))
        .catch((e) => console.error("Kanplete: daily note log failed", e));
    }
  }

  dailyNotePath() {
    let folder = "";
    let format = "YYYY-MM-DD";
    try {
      const dn = this.app.internalPlugins && this.app.internalPlugins.getPluginById && this.app.internalPlugins.getPluginById("daily-notes");
      const o = dn && dn.instance && dn.instance.options;
      if (o) { folder = (o.folder || "").replace(/^\/+|\/+$/g, ""); format = o.format || format; }
    } catch (e) { /* fall back to defaults */ }
    const name = typeof moment === "function" ? moment().format(format) : isoDate(0);
    return normalizePath(`${folder ? `${folder}/` : ""}${name}.md`);
  }

  async logDone(boardFile, done, undone) {
    const path = this.dailyNotePath();
    if (path === boardFile.path) return;
    const vault = this.app.vault;
    let f = vault.getAbstractFileByPath(path);
    if (f && this.isBoard(f)) return; // never write into a board
    const mc = this.app.metadataCache;
    const link = mc.fileToLinktext ? mc.fileToLinktext(boardFile, path, true) : boardFile.basename;
    const line = (t) => `- ${t} ([[${link}]])`;
    if (!f) {
      if (!done.length) return;
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
      f = await vault.create(path, "");
    }
    await vault.process(f, (data) => updateDoneLog(data, done.map(line), undone.map(line)));
  }

  boardFiles() {
    return this.app.vault.getMarkdownFiles().filter((f) => this.isBoard(f)).sort((a, b) => a.basename.localeCompare(b.basename));
  }

  // the New card window from anywhere, with a board / column picker
  async quickAdd(pref = {}) {
    const boards = this.boardFiles();
    if (!boards.length) { new Notice('No boards yet. Make one with "New board" first.'); return; }
    let title = "";
    let desc = [];
    if (pref.text === undefined) {
      const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
      const sel = mv && mv.editor ? mv.editor.getSelection() : "";
      if (sel && sel.trim()) {
        const ls = sel.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+)?/, "").trim()).filter(Boolean);
        title = ls.shift() || "";
        desc = ls;
      }
    }
    const active = this.app.workspace.getActiveViewOfType(KanbanView);
    const last = this.settings.lastCapture;
    const file = pref.file
      || (active && active.file && boards.find((b) => b.path === active.file.path))
      || (last && boards.find((b) => b.path === last.path))
      || boards[0];
    const target = await this.boardTarget(file);
    if (!target.board.columns.length) { new Notice(`${file.basename} has no columns yet.`); return; }
    let ci = pref.ci;
    if (ci === undefined) {
      ci = last && last.path === file.path ? target.board.columns.findIndex((c) => colName(c) === last.column) : 0;
      if (ci < 0) ci = 0;
    }
    const card = { checked: false, text: title, extra: desc.map((l) => `    ${l}`) };
    new CardEditModal(this.app, target, card, { isNew: true, ci, capture: { boards } }).open();
  }

  insertEmbed(editor, view) {
    const boards = this.boardFiles();
    if (!boards.length) { new Notice('No boards yet. Make one with "New board" first.'); return; }
    new BoardPickModal(this, boards, (file, column) => {
      const from = view && view.file ? view.file.path : "";
      const mc = this.app.metadataCache;
      const link = mc.fileToLinktext ? mc.fileToLinktext(file, from, true) : file.basename;
      const cur = editor.getCursor();
      const lead = cur && cur.ch > 0 ? "\n" : "";
      editor.replaceSelection(`${lead}\`\`\`${EMBED_LANG}\nboard: ${link}${column ? `\ncolumn: ${column}` : ""}\n\`\`\`\n`);
    }).open();
  }

  // code blocks point at boards by name; follow renames
  async updateEmbedsOnRename(file, oldPath) {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const oldName = oldPath.replace(/\.md$/i, "");
    const oldBase = oldName.split("/").pop();
    const vault = this.app.vault;
    const mc = this.app.metadataCache;
    for (const f of vault.getMarkdownFiles()) {
      const data = await vault.cachedRead(f);
      if (!data.includes("```" + EMBED_LANG)) continue;
      await vault.process(f, (d) => {
        let inBlock = false;
        return d.split("\n").map((l) => {
          const t = l.trim();
          if (!inBlock && t === "```" + EMBED_LANG) { inBlock = true; return l; }
          if (inBlock && t.startsWith("```")) { inBlock = false; return l; }
          if (!inBlock) return l;
          const m = l.match(/^(\s*board\s*:\s*)(.*?)\s*$/i);
          if (!m) return l;
          const name = m[2].replace(/^\[\[|\]\]$/g, "");
          if (name !== oldName && name !== oldBase) return l;
          return m[1] + (mc.fileToLinktext ? mc.fileToLinktext(file, f.path, true) : file.basename);
        }).join("\n");
      });
    }
  }

  async activateDueView() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(DUE_VIEW)[0];
    if (!leaf) {
      leaf = ws.getRightLeaf(false);
      await leaf.setViewState({ type: DUE_VIEW, active: true });
    }
    ws.revealLeaf(leaf);
  }

  // every unfinished card with a due date up to a week out, from every board
  async collectDue() {
    const groups = { overdue: [], today: [], upcoming: [] };
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.isBoard(file)) continue;
      const board = parseBoard(await this.app.vault.cachedRead(file));
      board.columns.forEach((col, ci) => col.cards.forEach((card, ki) => {
        const due = getDue(card);
        if (!due || card.checked) return;
        const { diff } = dueInfo(due);
        const item = { file, ci, ki, card, due, diff, column: colName(col) };
        if (diff < 0) groups.overdue.push(item);
        else if (diff === 0) groups.today.push(item);
        else if (diff <= 7) groups.upcoming.push(item);
      }));
    }
    for (const g of Object.values(groups)) g.sort((a, b) => a.diff - b.diff || a.file.basename.localeCompare(b.file.basename));
    return groups;
  }

  // tick a card from the due panel: edits the board file, sends it to that board's pile
  async markDueDone(item) {
    let ok = false;
    await this.app.vault.process(item.file, (data) => {
      const b = parseBoard(data);
      const before = parseBoard(data);
      const col = b.columns[item.ci];
      const c = col && col.cards[item.ki];
      if (!c || c.text !== item.card.text) return data;
      c.checked = true;
      const pile = pileIndexOf(b, this.getPile(item.file));
      if (pile >= 0 && pile !== item.ci) {
        col.cards.splice(item.ki, 1);
        b.columns[pile].cards.unshift(c);
      }
      ok = true;
      this.onBoardChange(item.file, before, b);
      return serializeBoard(b);
    });
    if (!ok) new Notice("That card changed since the list was made. Refreshing.");
  }

  async openBoard(file) {
    const open = this.app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => l.view.file && l.view.file.path === file.path);
    if (open) { this.app.workspace.revealLeaf(open); return; }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  isBoard(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return !!fm && (fm.kanban === true || fm.kanban === "true");
  }

  async maybeSwitch(leaf) {
    const view = leaf.view;
    if (!view || view.getViewType() !== "markdown" || !view.file) return;
    if (this.markdownMode.has(view.file.path) || !this.isBoard(view.file)) return;
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: view.file.path }, active: true });
  }

  async openAsMarkdown(leaf) {
    const file = leaf.view.file;
    if (!file) return;
    this.markdownMode.add(file.path);
    if (leaf.view.save) await leaf.view.save();
    await leaf.setViewState({ type: "markdown", state: { file: file.path }, active: true });
  }

  async openAsBoard(leaf, file) {
    this.markdownMode.delete(file.path);
    if (!this.isBoard(file)) {
      await this.app.fileManager.processFrontMatter(file, (fm) => { fm.kanban = true; });
    }
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
  }

  async newBoard() {
    const active = this.app.workspace.getActiveFile();
    const folder = active && active.parent instanceof TFolder ? active.parent.path : "";
    const base = folder && folder !== "/" ? `${folder}/` : "";
    let name = "Untitled board";
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(normalizePath(`${base}${name}.md`))) name = `Untitled board ${++n}`;
    const file = await this.app.vault.create(normalizePath(`${base}${name}.md`), NEW_BOARD);
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
  }

  onunload() {
    if (this.focusPrev) this.toggleFocus(); // give the sidebars back
  }
};

// exported for tests only
module.exports.parseBoard = parseBoard;
module.exports.serializeBoard = serializeBoard;
module.exports.getDue = getDue;
module.exports.setDue = setDue;
module.exports.cardMeta = cardMeta;
module.exports.setField = setField;
module.exports.addComment = addComment;
module.exports.parseQuick = parseQuick;
module.exports.diffBoards = diffBoards;
module.exports.updateDoneLog = updateDoneLog;
