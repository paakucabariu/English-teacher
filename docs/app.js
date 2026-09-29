import Anthropic from "./vendor/anthropic-sdk.mjs";
import { STAGES, TOPICS } from "./lessons.js";

/* ================= configuration ================= */
const MODELS = { "claude-opus-5": "Opus 5 — самый сильный", "claude-sonnet-5": "Sonnet 5 — дешевле и быстрее" };
const BETAS = ["server-side-fallback-2026-07-01"];

/* ================= storage ================= */
const K = "coach:";
const store = {
  get(k, d) { try { const v = localStorage.getItem(K + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(K + k, JSON.stringify(v)); } catch { toast("Не удалось сохранить: память браузера заполнена или отключена"); } }
};
const db = {
  keys: { claude: "", ...store.get("keys", {}) },
  settings: { silence: 2500, rate: 0.95, voice: "", handsFree: false, model: "claude-opus-5", ...store.get("settings", {}) },
  profile: { level: "", strengths: [], weaknesses: [], errors: [], phrases: [], unclear: {}, ...store.get("profile", {}) },
  sessions: store.get("sessions", []),
  next: store.get("next", null)
};
const save = k => store.set(k, db[k]);
if (!MODELS[db.settings.model]) db.settings.model = "claude-opus-5";

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
function fill(node, ...kids) { node.replaceChildren(...kids.flat().filter(k => k != null && k !== false)); }
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) { if (k == null || k === false) continue; e.append(k.nodeType ? k : document.createTextNode(k)); }
  return e;
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 4500); }
const words = s => (s.trim().match(/[A-Za-zА-Яа-яЁё0-9']+/g) || []).length;
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, "0")}`;
const dayKey = d => new Date(d).toISOString().slice(0, 10);
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9' ]/g, "").trim();
function show(screen) { for (const s of ["setup", "home", "lesson", "report", "drill"]) $("#" + s).hidden = s !== screen; window.scrollTo(0, 0); }
let client = null;
function makeClient() { client = db.keys.claude ? new Anthropic({ apiKey: db.keys.claude, dangerouslyAllowBrowser: true }) : null; }
function apiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "Ключ Claude не подошёл. Проверьте его в настройках.";
  if (e instanceof Anthropic.PermissionDeniedError) return "У ключа Claude нет доступа к модели. Проверьте аккаунт в консоли Anthropic.";
  if (e instanceof Anthropic.RateLimitError) return "Слишком много запросов или закончился баланс Claude. Подождите минуту или пополните баланс.";
  if (e instanceof Anthropic.APIConnectionError) return "Нет связи с Claude. Проверьте интернет.";
  if (e instanceof Anthropic.APIError) return `Ошибка Claude (${e.status}). Попробуйте ещё раз.`;
  return "Что-то пошло не так. Попробуйте ещё раз.";
}
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}
document.addEventListener("visibilitychange", () => {
  if (!L || L.finished) return;
  if (document.visibilityState === "visible") { keepAwake(true); return; }
  // the app went to the background: iOS takes the microphone away, so stop cleanly and keep the lesson
  if (input.active) { stopInput(); L.state = "idle"; L.error = "Запись остановилась, пока приложение было свёрнуто. Нажмите на микрофон и повторите ответ."; }
  if (tts.speaking) { stopSpeaking(); if (L.state === "speaking") L.state = "idle"; }
  saveProgress(); lessonUI();
});
window.addEventListener("pagehide", () => { if (L && !L.finished) saveProgress(); });

/* ================= speech output ================= */
const canSpeak = "speechSynthesis" in window;
function voices() { return canSpeak ? speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang)) : []; }
function pickVoice() {
  const vs = voices();
  return vs.find(v => v.name === db.settings.voice) ||
    vs.find(v => /en[-_]US/i.test(v.lang) && /premium|enhanced|natural|siri|google|samantha|ava|aria|jenny/i.test(v.name)) ||
    vs.find(v => /en[-_]US/i.test(v.lang)) || vs[0] || null;
}
const tts = { q: [], speaking: false, onIdle: null, rateMul: 1 };
function speakQueue(text) { if (!text.trim()) return; tts.q.push(text.trim()); pump(); }
function pump() {
  if (tts.speaking) return;
  if (!tts.q.length) { const f = tts.onIdle; tts.onIdle = null; if (f) f(); return; }
  if (!canSpeak) { tts.q = []; pump(); return; }
  const u = new SpeechSynthesisUtterance(tts.q.shift());
  const v = pickVoice(); if (v) u.voice = v;
  u.lang = v ? v.lang : "en-US"; u.rate = db.settings.rate * tts.rateMul;
  tts.speaking = true; setLive();
  u.onend = u.onerror = () => { tts.speaking = false; setLive(); pump(); };
  speechSynthesis.speak(u);
}
function stopSpeaking() { tts.q = []; tts.onIdle = null; if (canSpeak) speechSynthesis.cancel(); tts.speaking = false; setLive(); }
function whenSpoken(f) { if (!tts.speaking && !tts.q.length) f(); else tts.onIdle = f; }
function setLive() { $("#lamp").classList.toggle("live", tts.speaking || input.active); }

/* ================= speech input (browser speech recognition) ================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
// Android Chrome repeats results in continuous mode, so there each phrase is its own recognition session.
const CONTINUOUS = !/Android/i.test(navigator.userAgent);
const input = { active: false, started: false, rec: null, base: "", fin: "", interim: "", lastChange: 0, firstAt: 0, timer: null, watchdog: null, opts: {}, restarts: 0 };
// Only a browser without speech recognition is "blocked". Microphone errors are never permanent:
// iOS reports not-allowed / audio-capture transiently (e.g. when it cuts a session short), and the next tap usually works.
const micBlocked = !SR;
const canListen = () => !micBlocked;
let micFailures = 0;
function inputText() { return [input.base, input.fin, input.interim].join(" ").replace(/\s+/g, " ").trim(); }
/* The recording stopped by itself. Keep what was said instead of losing it. */
function interrupted(msg) {
  if (!input.active) return;
  if (inputText()) { finishInput(); return; }
  micFailures++;
  const fail = input.opts.onFail;
  stopInput();
  fail && fail(micFailures >= 3
    ? msg + " Если повторяется: Настройки iPhone → Safari → Микрофон → «Разрешить», затем закройте и откройте приложение."
    : msg);
}
/* opts: onUpdate(text), onDone(text, ms), onStart() once the microphone is really on, onFail(msg), auto: send after a pause */
function startInput(opts) {
  if (micBlocked) return false;
  stopInput();
  if (canSpeak && (tts.speaking || speechSynthesis.speaking)) stopSpeaking(); // iOS cannot record while it is speaking
  Object.assign(input, { active: true, started: false, base: "", fin: "", interim: "", lastChange: Date.now(), firstAt: 0, opts, restarts: 0 });
  const run = () => {
    if (!input.active) return;
    let rec;
    try { rec = new SR(); } catch { interrupted("Распознавание речи не запустилось. Нажмите на микрофон ещё раз."); return; }
    rec.lang = "en-US"; rec.continuous = CONTINUOUS; rec.interimResults = true; rec.maxAlternatives = 1;
    const started = () => { if (!input.started && input.active) { input.started = true; micFailures = 0; clearTimeout(input.watchdog); input.opts.onStart && input.opts.onStart(); } };
    rec.onstart = started; rec.onaudiostart = started;
    rec.onresult = ev => {
      if (rec !== input.rec) return;
      let fin = "", inter = "";
      for (let i = 0; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) fin += r[0].transcript + " "; else inter += r[0].transcript; }
      input.fin = fin.trim(); input.interim = inter;
      if (!input.firstAt) input.firstAt = Date.now();
      input.lastChange = Date.now(); input.opts.onUpdate && input.opts.onUpdate(inputText());
    };
    rec.onerror = ev => {
      if (rec !== input.rec) return;
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed")
        interrupted(input.restarts ? "Запись прервалась." : "Нет доступа к микрофону. Нажмите на микрофон ещё раз и, если телефон спросит, разрешите доступ.");
      else if (ev.error === "audio-capture")
        interrupted("Микрофон занят (звонок или другое приложение). Нажмите на микрофон ещё раз.");
      // no-speech, aborted, network: the session ends and onend decides what to do
    };
    rec.onend = () => {
      if (rec !== input.rec) return;
      input.base = [input.base, input.fin].join(" ").trim(); input.fin = ""; input.interim = "";
      if (!input.active) return;
      // the browser ended the session on its own (a pause, a time limit): start a new one, at most a few times
      if (input.restarts >= 5) { interrupted("Запись остановилась. Нажмите на микрофон ещё раз."); return; }
      input.restarts++;
      setTimeout(run, 80);
    };
    input.rec = rec;
    try { rec.start(); }
    catch { interrupted("Микрофон не включился. Нажмите на него ещё раз."); }
  };
  run();
  if (!input.active) return false;
  // if the browser never reports that recording started, say so instead of pretending to listen
  clearTimeout(input.watchdog);
  input.watchdog = setTimeout(() => { if (input.active && !input.started) interrupted("Микрофон не включился. Нажмите на кнопку ещё раз."); }, 3000);
  clearInterval(input.timer);
  input.timer = setInterval(() => { if (input.active && input.opts.auto && inputText() && Date.now() - input.lastChange > db.settings.silence) finishInput(); }, 200);
  setLive();
  return true;
}
function finishInput() {
  if (!input.active) return;
  const text = inputText(), ms = input.firstAt ? Date.now() - input.firstAt : 0, done = input.opts.onDone;
  stopInput(); done && done(text, ms);
}
function stopInput() {
  input.active = false; clearInterval(input.timer); clearTimeout(input.watchdog);
  const rec = input.rec; input.rec = null;
  try { rec && rec.abort(); } catch {}
  setLive();
}

/* Words the recognizer fails to catch when the learner reads a known phrase: a rough signal of unclear pronunciation. */
function wordDiff(target, heard) {
  const t = target.split(/\s+/).filter(Boolean), tn = t.map(norm), h = heard.split(/\s+/).map(norm).filter(Boolean);
  const dp = Array.from({ length: t.length + 1 }, () => new Array(h.length + 1).fill(0));
  for (let i = t.length - 1; i >= 0; i--) for (let j = h.length - 1; j >= 0; j--)
    dp[i][j] = tn[i] && tn[i] === h[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ok = new Array(t.length).fill(false);
  for (let i = 0, j = 0; i < t.length && j < h.length;) {
    if (tn[i] && tn[i] === h[j]) { ok[i] = true; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return t.map((w, i) => ({ w, ok: ok[i] || !tn[i] }));
}
function recordUnclear(diff) {
  const U = db.profile.unclear ||= {};
  for (const { w, ok } of diff) {
    const k = norm(w); if (k.length < 2) continue;
    const x = U[k] ||= { w: w.replace(/[^A-Za-z']/g, ""), t: 0, miss: 0 };
    x.t++; if (!ok) x.miss++;
  }
  save("profile");
}
function unclearWords(max = 8) {
  return Object.values(db.profile.unclear || {}).filter(x => x.miss >= 2 && x.miss / x.t >= 0.4)
    .sort((a, b) => b.miss / b.t - a.miss / a.t || b.miss - a.miss).slice(0, max);
}

/* ================= lesson plan ================= */
function topicIndex() { return db.next && Number.isInteger(db.next.topic) ? db.next.topic : db.sessions.length % TOPICS.length; }
function buildPlan(topicIdx) {
  const tp = TOPICS[topicIdx];
  const nextPhrases = db.next && Array.isArray(db.next.phrases) && db.next.phrases.length ? db.next.phrases.slice(0, 3).map(p => [p.en, p.ru]) : null;
  const openErrors = db.profile.errors.filter(e => e.status !== "fixed").sort((a, b) => b.count - a.count).slice(0, 3);
  return {
    n: db.sessions.length + 1, topic: topicIdx, title: tp.t, ru: tp.ru, talk: tp.talk, role: tp.role,
    phrases: nextPhrases || tp.phrases,
    focus: db.next && db.next.focus || "",
    drill: [...new Set([...(db.next && db.next.drill || []), ...openErrors.map(e => `${e.wrong} → ${e.right}`)])].slice(0, 4),
    lastPhrases: (db.sessions.at(-1) && db.sessions.at(-1).phrases || []).map(p => p[0]).slice(0, 3),
    unclear: unclearWords(5).map(x => x.w)
  };
}

/* ================= lesson runtime ================= */
let L = null;
function systemPrompt() {
  const p = L.plan, st = STAGES[L.stage], elapsed = (Date.now() - L.stageStart) / 1000, prof = db.profile;
  const stageLines = STAGES.map((s, i) => `${i + 1}. ${s.name} (${Math.round(s.sec / 60)} min): ${s.goal}`).join("\n");
  const notes = L.notes.slice(-8).map(n => `- "${n.said}" → "${n.better}"`).join("\n") || "- (none yet)";
  let now = `CURRENT STAGE: ${L.stage + 1}. ${st.name}. Time in this stage: ${Math.round(elapsed)}s of ${st.sec}s.`;
  if (L.justStarted && L.stage === 0 && L.turns === 0) now += "\nThe lesson is starting now: say hi, say in one short sentence that you will ask questions and they just answer naturally, then ask one easy warm-up question.";
  else if (L.justStarted) now += "\nThis stage has JUST started: react to the learner's last message in one short sentence, then open this stage with a clear one-sentence transition.";
  if (L.ending) now += "\nThis is your LAST reply of the lesson: react briefly, tell the learner in one sentence what they did well today, and say their report is coming. Do not ask a question.";
  return `You are Alex, a warm, witty native English speaker and an experienced speaking coach. You are leading a live VOICE lesson with a Russian-speaking adult learner who works in IT. They understand about 95% of spoken English but struggle to put their thoughts into words. The goal is fluency and getting ideas across, not perfect grammar.

HOW YOU SPEAK
- Your spoken part is read aloud by text-to-speech: plain conversational sentences only. No lists, no markdown, no emojis, no stage names.
- Usually 1-3 short sentences, then ONE question. Leave the learner most of the talking time.
- This is a dialogue, not a speaking exam: ask short, concrete, easy-to-answer questions one at a time, react to what the learner said, and build the next question on it. Never ask the learner to "talk about" a topic at length or give a speech.
- If the learner seems stuck or answers "I don't know", make it easier: offer two options ("Is it more A or B?") or ask a simpler question.
- The learner's messages come from speech recognition and may contain recognition errors. Guess the intended meaning when it is clear. If a message is garbled or makes no sense, say you didn't quite catch it and ask them to say it again. Never treat a garbled message as a request to stop.
- Never end, pause or wrap up the lesson on your own and never ask whether the learner wants to stop: the app controls the lesson and its stages.
- Messages in square brackets are signals from the app, not from the learner.
- You only get the recognized text, not the learner's voice, so do not judge pronunciation. If a word was clearly misrecognized, you may say how it is pronounced and ask the learner to repeat it slowly (stages 2 and 5 only).

LESSON ${p.n}: "${p.title}". Topic for discussion: ${p.talk}.
Target phrases: ${p.phrases.map(x => x[0]).join(" | ")}.
${p.lastPhrases.length ? `Phrases from the last lesson to recycle in the warm-up: ${p.lastPhrases.join(" | ")}.` : ""}
Role-play situation: ${p.role}
${p.focus ? `Coach's focus for today (from the last analysis): ${p.focus}` : ""}
${p.drill.length ? `Known weak spots to watch for: ${p.drill.join("; ")}` : ""}
${p.unclear.length ? `Words speech recognition often fails to catch from this learner (possible pronunciation issue): ${p.unclear.join(", ")}.` : ""}
Learner profile: ${prof.level ? "level " + prof.level + "; " : ""}${(prof.weaknesses || []).slice(0, 4).join("; ") || "no history yet"}.

STAGES (the app moves between them)
${stageLines}

${now}

MISTAKES LOGGED SO FAR TODAY
${notes}

OUTPUT FORMAT
First the spoken text. Then on a new line write @@META and then one line of JSON:
{"notes":[{"said":"the learner's exact phrase","better":"how a native speaker would say it","why":"up to 8 words in Russian"}],"done":false,"hint":"a short English phrase the learner could start their answer with","ru":"Russian translation of your spoken text"}
"notes": only real problems in the learner's LAST message that make it unclear or clearly unnatural (skip small grammar slips and likely recognition errors); [] if none.
"done": true only when the current stage's goal is complete.`;
}

function startLesson(topicIdx) {
  if (!client) { setupUI(); return; }
  if (canSpeak) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } // unlocks speech on iOS
  L = { plan: buildPlan(topicIdx), stage: 0, stageStart: Date.now(), startedAt: Date.now(), messages: [], notes: [],
        transcript: [], turns: 0, justStarted: true, stageDone: false, ending: false, finished: false,
        speakMs: 0, words: 0, answers: 0, longest: 0, state: "intro", last: { text: "", ru: "", hint: "" }, showRu: false, showHint: false,
        draft: "", recStart: 0, ctl: null, confirmEnd: 0, tick: null, error: "" };
  L.messages.push({ role: "user", content: "[The learner has joined. Start the lesson.]" });
  show("lesson"); lessonUI();
}
function beginLesson() {
  if (!L || L.state !== "intro") return;
  if (canSpeak) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); }
  keepAwake(true);
  L.stageStart = L.startedAt = Date.now();
  startTick();
  aiTurn();
}
function startTick() {
  clearInterval(L.tick);
  L.tick = setInterval(() => { if (L && !L.finished) { stageBar(); if (L.state === "listening") statusUI(); } }, 1000);
}

/* ---- the lesson in progress is saved after every exchange, so closing the app loses nothing ---- */
function saveProgress() {
  if (!L || L.finished || L.state === "intro") return;
  const now = Date.now();
  store.set("current", {
    v: 1, savedAt: new Date().toISOString(), plan: L.plan, stage: L.stage,
    stageElapsed: Math.round((now - L.stageStart) / 1000), totalElapsed: Math.round((now - L.startedAt) / 1000),
    messages: L.messages, notes: L.notes, transcript: L.transcript, turns: L.turns, stageDone: L.stageDone,
    speakMs: L.speakMs, words: L.words, answers: L.answers, longest: L.longest, last: L.last
  });
}
function savedLesson() {
  const c = store.get("current", null);
  return c && c.v === 1 && c.plan && Array.isArray(c.messages) ? c : null;
}
function discardProgress() { try { localStorage.removeItem(K + "current"); } catch {} }
function resumeLesson(thenFinish) {
  const c = savedLesson(); if (!c || !client) return;
  if (canSpeak) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); }
  const now = Date.now();
  L = { plan: c.plan, stage: c.stage, stageStart: now - c.stageElapsed * 1000, startedAt: now - c.totalElapsed * 1000,
        messages: c.messages, notes: c.notes || [], transcript: c.transcript || [], turns: c.turns || 0, justStarted: false, stageDone: !!c.stageDone,
        ending: false, finished: false, speakMs: c.speakMs || 0, words: c.words || 0, answers: c.answers || 0, longest: c.longest || 0,
        state: "idle", last: c.last || { text: "", ru: "", hint: "" }, showRu: false, showHint: false,
        draft: "", recStart: 0, ctl: null, confirmEnd: 0, tick: null, error: "" };
  if (thenFinish) { finishLesson(); return; }
  keepAwake(true);
  show("lesson"); startTick();
  // the last answer was sent but the reply never arrived: ask again
  if (L.messages.at(-1) && L.messages.at(-1).role === "user") { lessonUI(); aiTurn(); return; }
  L.error = "Урок продолжается с того же места. Нажмите на микрофон и ответьте на последний вопрос Алекса.";
  lessonUI();
}
function maybeAdvance() {
  const st = STAGES[L.stage], elapsed = (Date.now() - L.stageStart) / 1000;
  L.justStarted = false;
  if (L.stage < STAGES.length - 1 && (L.stageDone || elapsed >= st.sec)) { L.stage++; L.stageStart = Date.now(); L.justStarted = true; L.stageDone = false; }
  else if (L.stage === STAGES.length - 1 && (L.stageDone || elapsed >= st.sec)) L.ending = true;
}
function userSays(text, ms) {
  text = (text || "").trim();
  if (!L || L.finished) return;
  if (!text) { listen(); return; }
  L.answers++; const w = words(text); L.words += w; L.longest = Math.max(L.longest, w); L.speakMs += ms || 0;
  L.transcript.push({ who: "me", text });
  L.messages.push({ role: "user", content: text });
  L.turns++;
  maybeAdvance();
  saveProgress();
  aiTurn();
}
async function aiTurn() {
  L.state = "thinking"; L.showRu = false; L.showHint = false; L.error = ""; lessonUI();
  let buf = "", spokenUpTo = 0;
  const metaIdx = () => buf.indexOf("@@META");
  const spokenPart = () => { const i = metaIdx(); return (i >= 0 ? buf.slice(0, i) : buf).replace(/@+[A-Z]*\s*$/, ""); };
  const flush = final => {
    const rest = spokenPart().slice(spokenUpTo);
    const re = /[^.!?]+[.!?]+["')\]]*(\s+|$)/g; let m, last = 0;
    while ((m = re.exec(rest))) { if (!final && m.index + m[0].length === rest.length && !/\s$/.test(m[0])) break; speakQueue(m[0]); last = m.index + m[0].length; }
    if (final && rest.slice(last).trim()) { speakQueue(rest.slice(last)); last = rest.length; }
    spokenUpTo += last;
  };
  const ctl = L.ctl = new AbortController();
  try {
    const stream = client.beta.messages.stream({
      model: db.settings.model, max_tokens: 4000, betas: BETAS, fallbacks: "default",
      output_config: { effort: "low" },
      system: systemPrompt(), messages: L.messages
    }, { signal: ctl.signal });
    stream.on("text", delta => {
      if (!L || ctl.signal.aborted) return;
      buf += delta; L.state = "speaking"; L.last.text = spokenPart().trim(); lessonUI(); flush(false);
    });
    const msg = await stream.finalMessage();
    if (!L || ctl.signal.aborted) return;
    if (msg.stop_reason === "refusal") { stopSpeaking(); buf = "Let's talk about something else. Tell me, what are you working on this week?"; spokenUpTo = 0; }
    flush(true);
    const spoken = spokenPart().trim();
    let meta = {};
    const i = metaIdx();
    if (i >= 0) { const raw = buf.slice(i + 6); try { meta = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { meta = {}; } }
    L.last = { text: spoken, ru: String(meta.ru || ""), hint: String(meta.hint || "") };
    for (const n of Array.isArray(meta.notes) ? meta.notes : []) {
      if (n && n.said && n.better && !L.notes.some(x => norm(x.said) === norm(n.said))) L.notes.push({ said: String(n.said), better: String(n.better), why: String(n.why || ""), stage: STAGES[L.stage].id });
    }
    if (meta.done === true) L.stageDone = true;
    L.messages.push({ role: "assistant", content: spoken || "Sorry, could you say that again?" });
    L.transcript.push({ who: "ai", text: spoken });
    saveProgress();
    L.state = "speaking"; lessonUI();
    whenSpoken(() => {
      if (!L || L.finished) return;
      if (L.ending) { finishLesson(); return; }
      if (db.settings.handsFree && canListen()) listen(); else { L.state = "idle"; lessonUI(); }
    });
  } catch (e) {
    if (ctl.signal.aborted || !L) return;
    stopSpeaking();
    L.state = "error"; L.error = apiError(e); lessonUI();
  } finally { if (L && L.ctl === ctl) L.ctl = null; }
}
function listen() {
  if (!L || L.finished) return;
  stopSpeaking();
  L.draft = ""; L.error = "";
  const ok = startInput({
    auto: db.settings.handsFree,
    onStart: () => { if (!L) return; L.state = "listening"; L.recStart = Date.now(); lessonUI(); },
    onUpdate: t => { if (!L) return; L.draft = t; draftUI(); },
    onDone: (t, ms) => {
      if (!L || L.finished) return;
      if (!t.trim()) { L.state = "idle"; L.error = "Я ничего не расслышал. Нажмите на микрофон и скажите ещё раз, чуть громче."; lessonUI(); return; }
      userSays(t, ms);
    },
    onFail: msg => { if (!L || L.finished) return; L.state = "idle"; L.error = msg; lessonUI(); }
  });
  L.state = ok ? "starting" : "idle";
  if (!ok) L.error = micBlocked ? "Микрофон недоступен: ответьте текстом ниже." : "Микрофон не включился. Нажмите ещё раз.";
  lessonUI();
}
function skipStage() {
  if (!L || L.state === "thinking" || L.state === "intro") return;
  stopInput(); stopSpeaking();
  L.stageDone = true;
  L.messages.push({ role: "user", content: "[The learner asked to move on to the next stage.]" });
  maybeAdvance(); aiTurn();
}
function endLesson() {
  if (!L) return;
  if (Date.now() - L.confirmEnd > 4000) { L.confirmEnd = Date.now(); toast("Нажмите «Закончить» ещё раз, чтобы завершить урок и получить разбор"); return; }
  finishLesson();
}
async function finishLesson() {
  if (!L || L.finished) return;
  L.finished = true; clearInterval(L.tick);
  stopInput(); stopSpeaking(); if (L.ctl) L.ctl.abort(); keepAwake(false);
  discardProgress();
  if (!L.answers) { L = null; toast("Урок закрыт: вы ещё ничего не ответили, сохранять нечего."); homeUI(); return; }
  const s = {
    id: Date.now().toString(36), date: new Date().toISOString(), n: L.plan.n, topic: L.plan.topic, title: L.plan.title, model: db.settings.model,
    durationSec: Math.round((Date.now() - L.startedAt) / 1000), speakSec: Math.round(L.speakMs / 1000),
    words: L.words, answers: L.answers, longest: L.longest, avgWords: L.answers ? Math.round(L.words / L.answers * 10) / 10 : 0,
    stagesReached: L.stage + 1, phrases: L.plan.phrases, notes: L.notes, transcript: L.transcript.slice(-80),
    report: null
  };
  db.sessions.push(s); save("sessions");
  L = null;
  if (s.answers < 3) { reportView(s, "Урок слишком короткий для разбора: меньше трёх ответов. Статистика сохранена."); return; }
  reportView(s, null, true);
  await makeReport(s);
}

/* ================= report ================= */
const REPORT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["summary", "wins", "mistakes", "scores", "level", "strengths", "weaknesses", "patterns", "phrasesUsed", "next"],
  properties: {
    summary: { type: "string" },
    wins: { type: "array", items: { type: "string" } },
    mistakes: { type: "array", items: { type: "object", additionalProperties: false, required: ["said", "better", "why"],
      properties: { said: { type: "string" }, better: { type: "string" }, why: { type: "string" } } } },
    scores: { type: "object", additionalProperties: false, required: ["fluency", "clarity", "vocabulary", "confidence"],
      properties: { fluency: { type: "integer" }, clarity: { type: "integer" }, vocabulary: { type: "integer" }, confidence: { type: "integer" } } },
    level: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    patterns: { type: "array", items: { type: "object", additionalProperties: false, required: ["wrong", "right"],
      properties: { wrong: { type: "string" }, right: { type: "string" } } } },
    phrasesUsed: { type: "array", items: { type: "string" } },
    next: { type: "object", additionalProperties: false, required: ["focus", "phrases", "drill"],
      properties: { focus: { type: "string" },
        phrases: { type: "array", items: { type: "object", additionalProperties: false, required: ["en", "ru"], properties: { en: { type: "string" }, ru: { type: "string" } } } },
        drill: { type: "array", items: { type: "string" } } } }
  }
};
async function makeReport(s) {
  if (!client) { reportView(s, "Для разбора нужен ключ Claude."); return; }
  const nextTopic = (s.topic + 1) % TOPICS.length;
  const history = db.sessions.filter(x => x.report && x.id !== s.id).slice(-5)
    .map(x => `Lesson ${x.n} (${x.title}): fluency ${x.report.scores.fluency}, clarity ${x.report.scores.clarity}, vocabulary ${x.report.scores.vocabulary}, confidence ${x.report.scores.confidence}; avg ${x.avgWords} words per answer.`).join("\n") || "(first lesson)";
  const errors = db.profile.errors.filter(e => e.status !== "fixed").map(e => `${e.wrong} → ${e.right} (seen ${e.count}x)`).join("; ") || "none yet";
  const tr = s.transcript.map(t => (t.who === "me" ? "LEARNER: " : "COACH: ") + t.text).join("\n");
  const prompt = `You are an expert English speaking coach. Analyse this voice lesson of a Russian-speaking IT professional (understands ~95%, struggles to express thoughts). Fluency and getting ideas across matter more than grammar. The learner's lines come from speech recognition: ignore obvious recognition errors.

Lesson ${s.n}: "${s.title}". Target phrases: ${s.phrases.map(p => p[0]).join(" | ")}.
Metrics: ${s.answers} answers, ${s.words} words, average ${s.avgWords} words per answer, longest ${s.longest} words, speaking time ${s.speakSec}s, stages reached ${s.stagesReached} of 5.
Mistakes the coach logged during the lesson: ${s.notes.map(n => `"${n.said}" → "${n.better}"`).join("; ") || "none"}.
Known recurring errors: ${errors}.
Earlier lessons:
${history}

TRANSCRIPT
${tr.slice(-20000)}

Write the report in Russian (English examples stay in English):
- summary: 2-3 sentences, honest overall picture, compare with earlier lessons when possible.
- wins: 2-4 concrete things that went well.
- mistakes: the 3-6 most important language problems, each with the learner's exact phrase, the natural version, and a short reason.
- scores 1-5 for fluency, clarity, vocabulary, confidence (calibrated, not generous).
- level: short estimate of spoken level, e.g. "B1+ (говорение)".
- strengths / weaknesses: up-to-date profile (up to 4 each), merging earlier knowledge with today.
- patterns: recurring error patterns worth drilling (wrong → right), up to 5.
- phrasesUsed: which of today's target phrases the learner actually used (exact English text from the list).
- next: the next lesson is on "${TOPICS[nextTopic].t}". focus = 1-2 sentences in Russian on what it will train and why; phrases = exactly 3 English phrases with Russian glosses that fix today's weak spots and fit the next topic; drill = up to 3 short items the coach should make the learner practise.`;
  try {
    const stream = client.beta.messages.stream({
      model: db.settings.model, max_tokens: 16000, betas: BETAS, fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema", schema: REPORT_SCHEMA } },
      messages: [{ role: "user", content: prompt }]
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("refusal");
    const r = JSON.parse(msg.content.filter(b => b.type === "text").map(b => b.text).join(""));
    const clamp = v => Math.min(5, Math.max(1, Math.round(+v) || 1));
    r.scores = { fluency: clamp(r.scores.fluency), clarity: clamp(r.scores.clarity), vocabulary: clamp(r.scores.vocabulary), confidence: clamp(r.scores.confidence) };
    s.report = r; save("sessions");
    applyReport(s, r, nextTopic);
    reportView(s);
  } catch (e) {
    reportView(s, (e && e.message === "refusal") ? "Не удалось составить разбор для этого урока." : apiError(e) + " Урок сохранён, разбор можно запросить повторно.");
  }
}
function applyReport(s, r, nextTopic) {
  const P = db.profile;
  P.level = r.level || P.level;
  if ((r.strengths || []).length) P.strengths = r.strengths.slice(0, 4);
  if ((r.weaknesses || []).length) P.weaknesses = r.weaknesses.slice(0, 4);
  const seenNow = new Set();
  for (const p of r.patterns || []) {
    const ex = P.errors.find(e => norm(e.right) === norm(p.right) || norm(e.wrong) === norm(p.wrong));
    if (ex) { ex.count++; ex.lastSeen = s.n; ex.status = "active"; seenNow.add(ex); }
    else { const e = { wrong: p.wrong, right: p.right, count: 1, firstSeen: s.n, lastSeen: s.n, status: "active" }; P.errors.push(e); seenNow.add(e); }
  }
  for (const e of P.errors) if (!seenNow.has(e) && e.status !== "fixed" && s.n - e.lastSeen >= 3) e.status = "fixed";
  P.errors = P.errors.slice(-30);
  for (const [en, ru] of s.phrases) {
    let ph = P.phrases.find(x => norm(x.en) === norm(en));
    if (!ph) { ph = { en, ru, used: 0, lessons: [] }; P.phrases.push(ph); }
    if ((r.phrasesUsed || []).some(u => norm(u) === norm(en))) { ph.used++; if (!ph.lessons.includes(s.n)) ph.lessons.push(s.n); }
  }
  P.phrases = P.phrases.slice(-40);
  save("profile");
  db.next = { topic: nextTopic, focus: r.next.focus, phrases: (r.next.phrases || []).slice(0, 3), drill: (r.next.drill || []).slice(0, 3), fromLesson: s.n };
  save("next");
}

/* ================= read-aloud drill ================= */
let D = null;
function drillItems(s) {
  const items = [];
  const add = t => { t = String(t || "").replace(/[…]+/g, "").replace(/\s+/g, " ").trim(); if (t && !items.some(x => norm(x) === norm(t))) items.push(t); };
  if (s) {
    (s.report && s.report.mistakes || []).forEach(m => add(m.better));
    s.phrases.forEach(p => add(p[0]));
  }
  unclearWords(4).forEach(x => add(x.w));
  if (!items.length) ["I think this is a really good idea.", "Three things matter the most.", "What would you do with the whole world?", "The weather was worse than we thought."].forEach(add);
  return items.slice(0, 12);
}
function drillView(s) {
  if (micBlocked) { toast("Для тренировки нужен микрофон. Разрешите его в настройках браузера."); return; }
  if (canSpeak) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); }
  D = { items: drillItems(s), results: {}, busy: -1, from: s ? s.n : null };
  show("drill"); drillUI();
}
function drillUI() {
  fill($("#drillBody"),
    el("span", { class: "label" }, D.from ? `Фразы вслух · по уроку ${D.from}` : "Фразы вслух"),
    el("h2", {}, "Послушайте и повторите"),
    el("p", { class: "note" }, "Нажмите ▶, чтобы услышать образец, затем ● и произнесите фразу. Красным отмечены слова, которые распознавание не разобрало: обычно это слова, произнесённые неразборчиво. Это проверка разборчивости, отдельные звуки она не оценивает."),
    el("ul", { class: "drill" }, D.items.map((t, i) => {
      const r = D.results[i];
      return el("li", {},
        el("div", { class: "row" },
          el("button", { class: "tool", "aria-label": "Послушать образец", onclick: () => { stopSpeaking(); speakQueue(t); } }, "▶"),
          el("button", { class: "tool rec" + (D.busy === i ? " on" : ""), "aria-label": "Сказать", disabled: D.busy >= 0 && D.busy !== i, onclick: () => drillRecord(i) }, D.busy === i ? "Слушаю… нажмите, когда закончите" : "● Сказать"),
          r && r.diff ? el("span", { class: "sc" }, `${r.score}%`) : null),
        el("p", { class: "dtext" }, r && r.diff ? r.diff.map(x => el("span", { class: "w " + (x.ok ? "good" : "bad") }, x.w + " ")) : t),
        r && r.heard ? el("p", { class: "note" }, `Распознано: «${r.heard}»`) : null,
        r && r.error ? el("p", { class: "note err" }, r.error) : null);
    })),
    el("div", { class: "row" }, el("button", { class: "btn primary", onclick: homeUI }, "На главную"))
  );
}
function drillRecord(i) {
  if (D.busy === i) { finishInput(); return; }
  if (D.busy >= 0) return;
  stopSpeaking();
  D.busy = i; drillUI();
  const ok = startInput({ auto: true, onFail: msg => { D.busy = -1; D.results[i] = { error: msg }; drillUI(); }, onDone: text => {
    D.busy = -1;
    if (!text) D.results[i] = { error: "Ничего не услышал. Нажмите «Сказать» и говорите сразу." };
    else {
      const diff = wordDiff(D.items[i], text);
      recordUnclear(diff);
      D.results[i] = { diff, heard: text, score: Math.round(100 * diff.filter(x => x.ok).length / diff.length) };
    }
    drillUI();
  } });
  if (!ok) { D.busy = -1; D.results[i] = { error: "Микрофон недоступен." }; drillUI(); }
}

/* ================= UI: lesson ================= */
function stageBar() {
  if (!L) return;
  const st = STAGES[L.stage], left = st.sec - (Date.now() - L.stageStart) / 1000;
  $("#stages").replaceChildren(...STAGES.map((s, i) => el("span", { class: "seg" + (i < L.stage ? " fin" : i === L.stage ? " cur" : "") })));
  $("#stageName").textContent = `${L.stage + 1}/5 · ${st.name}`;
  $("#stageTime").textContent = left > 0 ? fmtTime(left) : "+" + fmtTime(-left);
}
function draftUI() {
  const d = $("#draft"); if (!d || !L) return;
  d.textContent = L.draft || "Говорите — здесь появится то, что я слышу";
  d.classList.toggle("empty", !L.draft);
}
/* the one place that says what is happening and what to do now */
function statusUI() {
  if (!L) return;
  const rec = L.recStart ? fmtTime((Date.now() - L.recStart) / 1000) : "0:00";
  const S = {
    thinking: ["wait", "Алекс думает…", "Секунду."],
    speaking: ["ai", "🔊 Алекс говорит", "Слушайте. Когда он закончит, нажмите на микрофон и ответьте."],
    idle: ["you", "Ваша очередь", L.error || (canListen() ? "Нажмите на микрофон и отвечайте по-английски. Запись идёт, пока кнопка красная." : "Микрофон недоступен: напишите ответ ниже.")],
    starting: ["wait", "Включаю микрофон…", "Если телефон спросит разрешение на микрофон — разрешите."],
    listening: ["rec", `● Идёт запись · ${rec}`, db.settings.handsFree ? "Говорите. После паузы ответ уйдёт сам." : "Говорите. Закончили — нажмите на красную кнопку, ответ уйдёт Алексу."],
    error: ["err", "Не получилось", L.error || "Нажмите на кнопку, чтобы попробовать ещё раз."]
  }[L.state] || ["wait", "", ""];
  const st = $("#status"); st.dataset.kind = S[0];
  $("#statusTitle").textContent = S[1];
  $("#statusSub").textContent = S[2];
  const label = { thinking: "", speaking: "Перебить и ответить", idle: "Нажмите, чтобы говорить", starting: "Отменить", listening: "Нажмите, чтобы отправить", error: "Повторить" }[L.state] || "";
  $("#micLabel").textContent = label;
  $("#micBtn").setAttribute("aria-label", label || "Микрофон");
  $("#micBtn").dataset.state = L.state;
}
function chatUI() {
  const box = $("#chat");
  const items = L.transcript.map((t, i) => ({ ...t, last: false, i }));
  const lastAi = items.map(t => t.who).lastIndexOf("ai");
  if (lastAi >= 0) items[lastAi].last = true;
  // the reply that is still being written
  if ((L.state === "thinking" || L.state === "speaking") && L.transcript.at(-1)?.who !== "ai") items.push({ who: "ai", text: L.last.text || "…", last: true, live: true });
  fill(box, items.length ? items.map(t => el("div", { class: "msg " + (t.who === "ai" ? "ai" : "me") },
    el("span", { class: "who" }, t.who === "ai" ? "Алекс" : "Вы"),
    el("p", {}, t.text),
    t.who === "ai" && t.last && L.showRu && L.last.ru && !t.live ? el("p", { class: "ru" }, L.last.ru) : null)) : el("p", { class: "note" }, "Здесь будет ваш разговор."));
  box.scrollTop = box.scrollHeight;
}
function lessonUI() {
  if (!L) return;
  const intro = L.state === "intro";
  $("#intro").hidden = !intro;
  for (const id of ["#chat", "#tools", "#status", "#micWrap"]) $(id).hidden = intro;
  stageBar();
  $("#stageHint").textContent = STAGES[L.stage].ru || "";
  if (intro) return;
  chatUI();
  const hint = $("#hint"); hint.hidden = !(L.showHint && L.last.hint); hint.textContent = L.last.hint ? `Можно начать так: ${L.last.hint}` : "";
  statusUI();
  const d = $("#draft"); d.hidden = L.state !== "listening"; draftUI();
  $("#chips").replaceChildren(...L.plan.phrases.map(([en, ru]) => el("button", { class: "chip", title: ru, onclick: () => { if (!L || L.state === "thinking") return; stopInput(); stopSpeaking(); speakQueue(en); L.state = "speaking"; lessonUI(); whenSpoken(() => { if (L && L.state === "speaking") { L.state = "idle"; lessonUI(); } }); } }, en)));
}
function micPressed() {
  if (!L) return;
  switch (L.state) {
    case "listening": finishInput(); break;
    case "starting": stopInput(); L.state = "idle"; lessonUI(); break;
    case "speaking": stopSpeaking(); listen(); break;
    case "error": aiTurn(); break;
    case "idle": listen(); break;
  }
}

/* ================= UI: home ================= */
function streak() {
  const days = new Set(db.sessions.map(s => dayKey(s.date)));
  let n = 0; const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function spark(values, max, label) {
  const w = 280, h = 56, n = values.length;
  if (n < 2) return el("p", { class: "note" }, "График появится после двух уроков.");
  const x = i => 6 + i * (w - 12) / (n - 1), y = v => h - 6 - (v / max) * (h - 14);
  const svg = `<svg viewBox="0 0 ${w} ${h}" class="spark" role="img" aria-label="${label}"><polyline points="${values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>` +
    values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="${i === n - 1 ? 4 : 2.5}" fill="var(--accent)"/>`).join("") +
    `<text x="${x(n - 1) - 6}" y="${Math.max(12, y(values[n - 1]) - 8)}" text-anchor="end" class="sv">${values[n - 1]}</text></svg>`;
  const d = el("div"); d.innerHTML = svg; return d;
}
const stat = (v, l) => el("div", { class: "stat" }, el("b", {}, String(v)), el("span", {}, l));
function homeUI() {
  if (!client) { setupUI(); return; }
  show("home");
  const ss = db.sessions, withRep = ss.filter(s => s.report);
  const plan = buildPlan(topicIndex());
  const sel = el("select", { id: "topicSel", "aria-label": "Тема урока" }, TOPICS.map((t, i) => el("option", { value: i, selected: i === plan.topic }, t.ru)));
  const errs = db.profile.errors.slice().sort((a, b) => (a.status === "fixed") - (b.status === "fixed") || b.count - a.count).slice(0, 8);
  const unclear = unclearWords();
  const cur = savedLesson();
  fill($("#homeBody"),
    el("section", { class: "stats" },
      stat(ss.length, "уроков"), stat(Math.round(ss.reduce((a, s) => a + s.speakSec, 0) / 60), "минут речи"),
      stat(streak(), "дней подряд"), stat(ss.length ? ss.at(-1).avgWords : "–", "слов в ответе")),
    micBlocked ? el("section", { class: "card warn" }, el("p", {}, SR
      ? "Нет доступа к микрофону. Разрешите его: Настройки → Safari → Микрофон, затем перезагрузите страницу."
      : "Этот браузер не распознаёт речь. На iPhone откройте страницу в Safari, на компьютере — в Chrome.")) : null,
    cur ? el("section", { class: "card resume" },
      el("span", { class: "label" }, "Незаконченный урок"),
      el("h2", {}, `Урок ${cur.plan.n}: ${cur.plan.title}`),
      el("p", { class: "note" }, `Этап ${cur.stage + 1} из 5 · ${STAGES[cur.stage].name} · ответов: ${cur.answers} · сохранено ${new Date(cur.savedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`),
      el("div", { class: "row" },
        el("button", { class: "btn primary big", onclick: () => resumeLesson(false) }, "▶ Продолжить урок"),
        cur.answers >= 3 ? el("button", { class: "btn", onclick: () => resumeLesson(true) }, "Закончить и получить разбор") : null)) : null,
    el("section", { class: "card next" },
      el("span", { class: "label" }, cur ? `Или новый урок ${plan.n}` : `Урок ${plan.n}`),
      el("h2", {}, plan.title),
      plan.focus ? el("p", { class: "focus" }, plan.focus) : el("p", { class: "note" }, "20 минут голосом: разминка, фразы урока, разговор, ролевая ситуация, работа над ошибками. В конце разбор."),
      el("div", { class: "phr" }, plan.phrases.map(([en, ru]) => el("div", {}, el("b", {}, en), el("span", {}, ru)))),
      plan.drill.length ? el("p", { class: "note" }, "Будем отрабатывать: " + plan.drill.join("; ")) : null,
      el("div", { class: "row" },
        el("button", { class: cur ? "btn" : "btn primary big", onclick: e => {
          if (cur && !e.currentTarget.dataset.sure) { e.currentTarget.dataset.sure = "1"; e.currentTarget.textContent = "Точно? Незаконченный урок удалится"; return; }
          discardProgress(); startLesson(+sel.value);
        } }, cur ? "Начать новый урок" : "▶ Начать урок"),
        el("label", { class: "row small" }, "Тема: ", sel))),
    el("section", { class: "card" },
      el("h3", {}, "Фразы вслух"),
      el("p", { class: "note" }, "Повторяйте за Алексом фразы и исправленные ошибки урока. Слова, которые распознавание не разобрало, отмечаются красным и копятся здесь."),
      unclear.length ? el("div", {}, el("span", { class: "label" }, "Чаще всего не распознаются"),
        el("p", {}, unclear.map(x => el("b", { class: "bw", title: `не распознано ${x.miss} из ${x.t}` }, x.w)))) : null,
      el("div", { class: "row" }, el("button", { class: "btn", onclick: () => drillView(ss.at(-1)) }, "Тренировать фразы вслух"))),
    el("section", { class: "card" },
      el("h3", {}, "Речь"),
      el("div", { class: "two" },
        el("div", {}, el("span", { class: "label" }, "Беглость, 1–5"), spark(withRep.map(s => s.report.scores.fluency), 5, "Беглость")),
        el("div", {}, el("span", { class: "label" }, "Слов в среднем ответе"), spark(ss.map(s => s.avgWords), Math.max(12, ...ss.map(s => s.avgWords)), "Длина ответа"))),
      db.profile.level ? el("p", { class: "note" }, `Уровень: ${db.profile.level}`) : null),
    errs.length ? el("section", { class: "card" }, el("h3", {}, "Банк ошибок"),
      el("ul", { class: "bank" }, errs.map(e => el("li", {},
        el("span", { class: "pill " + e.status }, e.status === "fixed" ? "исправлено" : `×${e.count}`),
        el("span", {}, el("s", {}, e.wrong), " → ", el("b", {}, e.right)))))) : null,
    db.profile.phrases.length ? el("section", { class: "card" }, el("h3", {}, "Фразы в активе"),
      el("div", { class: "chips multi" }, db.profile.phrases.slice(-16).map(p => el("span", { class: "chip " + (p.lessons.length >= 2 ? "own" : p.used ? "used" : ""), title: p.ru }, p.en))),
      el("p", { class: "note" }, "Заливка — использована в двух уроках и больше, рамка — пока один раз.")) : null,
    ss.length ? el("section", { class: "card" }, el("h3", {}, "История"),
      el("ul", { class: "hist" }, ss.slice().reverse().slice(0, 20).map(s => el("li", {},
        el("button", { class: "linkish", onclick: () => reportView(s) },
          el("span", { class: "hn" }, `#${s.n}`),
          el("span", { class: "ht" }, s.title, el("small", {}, `${new Date(s.date).toLocaleDateString("ru-RU")} · ${Math.round(s.durationSec / 60)} мин · ${s.avgWords} слов/ответ`)),
          el("span", { class: "hs" }, s.report ? `${s.report.scores.fluency}/5` : "—")))))) : null
  );
  settingsUI();
}

/* ================= UI: report ================= */
function reportView(s, error, pending) {
  show("report");
  const r = s.report;
  const bars = sc => el("div", { class: "scores" }, [["fluency", "Беглость"], ["clarity", "Понятность"], ["vocabulary", "Словарь"], ["confidence", "Уверенность"]].map(([k, n]) =>
    el("div", { class: "score" }, el("span", {}, `${n} · ${sc[k]}/5`), el("div", { class: "track" }, [1, 2, 3, 4, 5].map(i => el("i", { class: i <= sc[k] ? "on" : "" }))))));
  const list = (t, items) => items && items.length ? el("div", { class: "sec" }, el("h3", {}, t), el("ul", {}, items.map(x => el("li", {}, x)))) : null;
  fill($("#reportBody"),
    el("span", { class: "label" }, `Урок ${s.n} · ${new Date(s.date).toLocaleDateString("ru-RU")}`),
    el("h2", {}, s.title),
    el("section", { class: "stats" }, stat(Math.round(s.durationSec / 60), "минут"), stat(s.answers, "ответов"), stat(s.avgWords, "слов в ответе"), stat(s.longest, "самый длинный")),
    pending && !r ? el("div", { class: "card" }, el("p", {}, "Claude разбирает урок. Обычно это 20–60 секунд.")) : null,
    error ? el("div", { class: "card err" }, el("p", {}, error),
      !r && s.answers >= 3 && client ? el("button", { class: "btn", onclick: () => { reportView(s, null, true); makeReport(s); } }, "Запросить разбор ещё раз") : null) : null,
    r ? el("div", { class: "card" }, el("p", {}, r.summary), bars(r.scores)) : null,
    r ? list("Что получилось", r.wins) : null,
    r && r.mistakes.length ? el("div", { class: "sec" }, el("h3", {}, "Главные ошибки"),
      el("ul", { class: "mist" }, r.mistakes.map(m => el("li", {}, el("s", {}, m.said), el("b", {}, m.better), el("small", {}, m.why))))) : null,
    r ? el("div", { class: "row" }, el("button", { class: "btn primary", onclick: () => drillView(s) }, "Повторить фразы урока вслух")) : null,
    r ? el("div", { class: "card next" }, el("h3", {}, "Следующий урок"), el("p", {}, r.next.focus),
      el("div", { class: "phr" }, r.next.phrases.map(p => el("div", {}, el("b", {}, p.en), el("span", {}, p.ru))))) : null,
    el("div", { class: "row" }, el("button", { class: "btn", onclick: homeUI }, "На главную"))
  );
}

/* ================= UI: settings & setup ================= */
function settingsUI() {
  const st = db.settings, vs = voices();
  fill($("#settingsBody"),
    el("label", { class: "field" }, "Модель Claude",
      el("select", { id: "modelSel", onchange: e => { st.model = e.target.value; save("settings"); } },
        Object.entries(MODELS).map(([id, l]) => el("option", { value: id, selected: st.model === id }, l)))),
    el("label", { class: "field" }, "Пауза перед отправкой ответа",
      el("select", { id: "silSel", onchange: e => { st.silence = +e.target.value; save("settings"); } },
        [[1800, "1,8 с — быстро"], [2500, "2,5 с — обычно"], [3500, "3,5 с — с паузами на подумать"], [5000, "5 с — очень медленно"]].map(([v, l]) => el("option", { value: v, selected: st.silence === v }, l)))),
    el("label", { class: "field" }, "Скорость речи Алекса",
      el("select", { id: "rateSel", onchange: e => { st.rate = +e.target.value; save("settings"); } },
        [[0.8, "Медленно"], [0.95, "Обычно"], [1.1, "Быстро"]].map(([v, l]) => el("option", { value: v, selected: st.rate === v }, l)))),
    vs.length ? el("label", { class: "field" }, "Голос",
      el("select", { id: "voiceSel", onchange: e => { st.voice = e.target.value; save("settings"); speakQueue("Hi! This is my voice."); } },
        el("option", { value: "" }, "Автоматически"), vs.map(v => el("option", { value: v.name, selected: st.voice === v.name }, `${v.name} (${v.lang})`)))) : null,
    el("p", { class: "note" }, "На iPhone качественные голоса скачиваются в Настройки → Универсальный доступ → Устный контент → Голоса → English."),
    el("label", { class: "row small" }, el("input", { type: "checkbox", id: "handsFree", checked: st.handsFree, onchange: e => { st.handsFree = e.target.checked; save("settings"); } }),
      "Режим без рук: микрофон включается сам, ответ уходит после паузы (на iPhone может не работать)"),
    el("div", { class: "row" },
      el("button", { class: "btn", onclick: setupUI }, "Ключ Claude"),
      el("button", { class: "btn", onclick: exportData }, "Скачать резервную копию"),
      el("label", { class: "btn" }, "Загрузить копию", el("input", { type: "file", accept: "application/json", hidden: true, onchange: importData })))
  );
}
function exportData() {
  const blob = new Blob([JSON.stringify({ v: 3, profile: db.profile, sessions: db.sessions, next: db.next, settings: db.settings }, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `english-coach-${dayKey(Date.now())}.json` }); document.body.append(a); a.click(); a.remove();
}
async function importData(e) {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.sessions) || !d.profile) throw new Error();
    db.profile = { unclear: {}, ...d.profile }; db.sessions = d.sessions; db.next = d.next || null;
    if (d.settings) db.settings = { ...db.settings, ...d.settings };
    ["profile", "sessions", "next", "settings"].forEach(save);
    toast("Копия загружена"); homeUI();
  } catch { toast("Это не файл резервной копии"); }
}
function setupUI() {
  show("setup");
  $("#keyInput").value = db.keys.claude;
  $("#noSR").hidden = !!SR;
}
$("#saveKey").addEventListener("click", async () => {
  const k = $("#keyInput").value.trim();
  if (!k) { toast("Вставьте ключ Claude"); return; }
  const b = $("#saveKey"); b.disabled = true; b.textContent = "Проверяю ключ…";
  try {
    const c = new Anthropic({ apiKey: k, dangerouslyAllowBrowser: true });
    await c.models.retrieve(db.settings.model);
    db.keys = { claude: k }; save("keys"); makeClient();
    toast("Ключ работает"); homeUI();
  } catch (e) { toast(apiError(e)); }
  b.disabled = false; b.textContent = "Сохранить и продолжить";
});
$("#micTest").addEventListener("click", () => {
  const out = $("#micOut"); out.hidden = false;
  if (micBlocked) { out.textContent = SR ? "Нет доступа к микрофону. Разрешите его в настройках браузера." : "Этот браузер не распознаёт речь. Откройте страницу в Safari (iPhone) или Chrome."; return; }
  out.textContent = "Включаю микрофон…";
  const ok = startInput({
    auto: true,
    onStart: () => { out.textContent = "● Идёт запись. Скажите что-нибудь по-английски…"; },
    onUpdate: t => { out.textContent = "● " + t; },
    onDone: t => { out.textContent = t ? `Работает. Распознано: «${t}».` : "Ничего не услышал. Нажмите ещё раз и говорите сразу."; },
    onFail: msg => { out.textContent = msg; }
  });
  if (!ok) out.textContent = "Не удалось включить микрофон.";
});

/* ================= wiring ================= */
// after a replayed line the learner answers when ready (hands-free mode starts the mic itself)
const afterReplay = () => { tts.rateMul = 1; if (!L || L.finished || L.state !== "speaking") return; if (db.settings.handsFree && canListen()) listen(); else { L.state = "idle"; lessonUI(); } };
$("#micBtn").addEventListener("click", micPressed);
$("#beginBtn").addEventListener("click", beginLesson);
$("#repeatBtn").addEventListener("click", () => { if (!L || !L.last.text || L.state === "thinking") return; stopInput(); stopSpeaking(); tts.rateMul = 1; speakQueue(L.last.text); L.state = "speaking"; lessonUI(); whenSpoken(afterReplay); });
$("#slowBtn").addEventListener("click", () => { if (!L || !L.last.text || L.state === "thinking") return; stopInput(); stopSpeaking(); tts.rateMul = 0.75; speakQueue(L.last.text); L.state = "speaking"; lessonUI(); whenSpoken(afterReplay); });
$("#ruBtn").addEventListener("click", () => { if (!L) return; L.showRu = !L.showRu; lessonUI(); });
$("#hintBtn").addEventListener("click", () => { if (!L) return; L.showHint = !L.showHint; lessonUI(); });
$("#skipBtn").addEventListener("click", skipStage);
$("#endBtn").addEventListener("click", endLesson);
$("#typeForm").addEventListener("submit", e => {
  e.preventDefault();
  const t = $("#typeInput").value.trim(); if (!t || !L || L.state === "thinking" || L.state === "intro") return;
  $("#typeInput").value = ""; stopInput(); stopSpeaking(); userSays(t, 0);
});
$("#homeLink").addEventListener("click", () => { if (L && !L.finished) { toast("Сначала завершите урок кнопкой «Закончить»"); return; } homeUI(); });
if (canSpeak) speechSynthesis.onvoiceschanged = () => { if (!$("#home").hidden) settingsUI(); };
window.addEventListener("beforeunload", e => { if (L && !L.finished) { e.preventDefault(); e.returnValue = ""; } });

makeClient();
homeUI();
