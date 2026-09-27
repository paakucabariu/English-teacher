
/* ================= storage: artifact database, browser fallback ================= */
const local = {
  get(k, d) { try { const v = localStorage.getItem("coach:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("coach:" + k, JSON.stringify(v)); } catch {} }
};
const db = {
  settings: { rate: 0.95, voice: "", tier: "quick", autoMic: true, ...local.get("settings", {}) },
  profile: { level: "", strengths: [], weaknesses: [], errors: [], phrases: [] },
  sessions: [],
  next: null
};
let store = null, mode = "local";
const chains = {}; let pending = 0;
function setSync(s, t) { const e = $("#sync"); e.dataset.s = s; e.textContent = t; }
function syncIdle() { mode === "server" ? setSync("server", "Сохранено на сервере") : setSync("local", "Сохраняется в браузере"); }
function persist(path, obj) {
  const doc = JSON.parse(JSON.stringify(obj));
  if (mode !== "server") { local.set(path, doc); return Promise.resolve(); }
  pending++; setSync("saving", "Сохраняю…");
  chains[path] = (chains[path] || Promise.resolve()).then(() => store.doc(path).set(doc)).then(
    () => { if (--pending === 0) syncIdle(); },
    e => { pending--; setSync("error", e && e.code === "quota_exceeded" ? "Место на сервере закончилось" : "Не сохранилось"); });
  return chains[path];
}
const saveProfile = () => persist("coach/profile", db.profile);
const saveNext = () => persist("coach/next", db.next || { empty: true });
const saveSession = s => persist("sessions/" + s.id, s);
const saveSettings = () => local.set("settings", db.settings);
function cleanProfile(p) {
  return { level: String(p.level || ""), strengths: Array.isArray(p.strengths) ? p.strengths : [], weaknesses: Array.isArray(p.weaknesses) ? p.weaknesses : [],
    errors: Array.isArray(p.errors) ? p.errors.map(e => ({ ...e })) : [], phrases: Array.isArray(p.phrases) ? p.phrases.map(x => ({ ...x, lessons: [...(x.lessons || [])] })) : [] };
}
function loadLocal() {
  const p = local.get("coach/profile", null); if (p) db.profile = cleanProfile(p);
  const n = local.get("coach/next", null); db.next = n && !n.empty ? n : null;
  db.sessions = local.get("sessions/index", []).map(id => local.get("sessions/" + id, null)).filter(Boolean);
}
async function loadServer() {
  const [p, n, ss] = await Promise.all([store.doc("coach/profile").get(), store.doc("coach/next").get(), store.collection("sessions").get()]);
  if (!p.exists && !ss.size) {
    // first run on the server: carry over whatever this browser has
    const w = [saveProfile(), saveNext(), ...db.sessions.map(saveSession)];
    await Promise.all(w); return;
  }
  if (p.exists) db.profile = cleanProfile(p.data());
  const nd = n.exists ? n.data() : null; db.next = nd && !nd.empty ? JSON.parse(JSON.stringify(nd)) : null;
  db.sessions = ss.docs.map(d => JSON.parse(JSON.stringify(d.data()))).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  // Claude can rewrite the plan from outside the app: follow it live
  store.doc("coach/next").onSnapshot(s => { const d = s.exists ? s.data() : null; db.next = d && !d.empty ? JSON.parse(JSON.stringify(d)) : null; if (!$("#home").hidden) homeUI(); }, () => {});
}
function rememberLocalSession(s) { if (mode === "server") return; const ids = local.get("sessions/index", []); if (!ids.includes(s.id)) { ids.push(s.id); local.set("sessions/index", ids); } }

/* ================= helpers ================= */
function $(s) { return document.querySelector(s); }
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
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 4000); }
const words = s => (s.trim().match(/[A-Za-zА-Яа-яЁё0-9']+/g) || []).length;
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, "0")}`;
const dayKey = d => new Date(d).toISOString().slice(0, 10);
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
function show(screen) { for (const s of ["home", "lesson", "report"]) $("#" + s).hidden = s !== screen; window.scrollTo(0, 0); }
let sample = null, sampleReady = false;
const FATAL = ["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"];
function aiError(e) {
  const c = e && e.code;
  if (FATAL.includes(c)) return "Claude недоступен в этом окне. Откройте урок по ссылке в Claude и разрешите странице использовать Claude.";
  if (c === "rate_limited") return "Лимит запросов подписки на сейчас исчерпан или запросов слишком много. Подождите и нажмите ещё раз.";
  if (c === "session_expired") return "Сессия Claude истекла: войдите снова и обновите страницу.";
  if (c === "refused") return "Claude не стал отвечать на это. Скажите иначе.";
  if (c === "invalid_json") return "Claude ответил в неожиданном формате. Попробуйте ещё раз.";
  return "Не получилось получить ответ. Нажмите ещё раз.";
}

/* ================= speech output ================= */
const canSpeak = "speechSynthesis" in window;
function voices() { return canSpeak ? speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang)) : []; }
function pickVoice() {
  const vs = voices();
  return vs.find(v => v.name === db.settings.voice) ||
    vs.find(v => /en[-_]US/i.test(v.lang) && /natural|premium|enhanced|google|samantha|aria|jenny|ava/i.test(v.name)) ||
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
function setLive() { $("#lamp").classList.toggle("live", tts.speaking || mic.active); }

/* ================= speech input (browser mic, when the page is allowed to use it) ================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = { active: false, rec: null, carry: "", interim: "", lastChange: 0, firstAt: 0, timer: null, onDone: null, onUpdate: null, blocked: !SR };
function micText() { return (mic.carry + " " + mic.interim).replace(/\s+/g, " ").trim(); }
function startMic(onUpdate, onDone) {
  if (mic.blocked) return false;
  stopMic();
  Object.assign(mic, { active: true, carry: "", interim: "", lastChange: Date.now(), firstAt: 0, onDone, onUpdate });
  const run = () => {
    if (!mic.active) return;
    let rec;
    try { rec = new SR(); } catch { blockMic(); return; }
    rec.lang = "en-US"; rec.continuous = false; rec.interimResults = true;
    rec.onresult = ev => {
      let fin = "", inter = "";
      for (let i = 0; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) fin += r[0].transcript + " "; else inter += r[0].transcript; }
      if (fin) { mic.carry = (mic.carry + " " + fin).trim(); mic.interim = ""; } else mic.interim = inter;
      if (!mic.firstAt) mic.firstAt = Date.now();
      mic.lastChange = Date.now();
      mic.onUpdate && mic.onUpdate(micText());
    };
    rec.onerror = ev => { if (["not-allowed", "service-not-allowed", "audio-capture"].includes(ev.error)) blockMic(); };
    rec.onend = () => { if (mic.active) setTimeout(run, 60); };
    try { rec.start(); mic.rec = rec; } catch { blockMic(); }
  };
  run();
  clearInterval(mic.timer);
  mic.timer = setInterval(() => { if (mic.active && micText() && Date.now() - mic.lastChange > 2500) finishMic(); }, 200);
  setLive();
  return mic.active;
}
function blockMic() {
  mic.blocked = true; stopMic();
  if (L && !L.finished) { L.state = "idle"; lessonUI(); }
}
function finishMic() {
  if (!mic.active) return;
  const text = micText(), ms = mic.firstAt ? Date.now() - mic.firstAt : 0, done = mic.onDone;
  stopMic(); done && done(text, ms);
}
function stopMic() { mic.active = false; clearInterval(mic.timer); try { mic.rec && mic.rec.abort(); } catch {} mic.rec = null; setLive(); }

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
    lastPhrases: (db.sessions.at(-1) && db.sessions.at(-1).phrases || []).map(p => p[0]).slice(0, 3)
  };
}

/* ================= lesson runtime ================= */
let L = null;
function rulesTurn() {
  const p = L.plan, st = STAGES[L.stage], elapsed = (Date.now() - L.stageStart) / 1000, prof = db.profile;
  const stageLines = STAGES.map((s, i) => `${i + 1}. ${s.name} (${Math.round(s.sec / 60)} min): ${s.goal}`).join("\n");
  const notes = L.notes.slice(-8).map(n => `- "${n.said}" → "${n.better}"`).join("\n") || "- (none yet)";
  let now = `CURRENT STAGE: ${L.stage + 1}. ${st.name}. Time in this stage: ${Math.round(elapsed)}s of ${st.sec}s.`;
  if (L.justStarted && L.stage === 0 && L.turns === 0) now += "\nThe lesson is starting now: greet the learner briefly, name today's topic in a few words, and ask the first warm-up question.";
  else if (L.justStarted) now += "\nThis stage has JUST started: react to the learner's last message in one short sentence, then open this stage with a clear one-sentence transition.";
  if (L.ending) now += "\nThis is your LAST reply of the lesson: react briefly, tell the learner in one sentence what they did well today, and say their report is coming. Do not ask a question.";
  return `[Instructions from the lesson app. Follow them for every reply.]
You are Alex, a warm, witty native English speaker and an experienced speaking coach, leading a live spoken lesson with a Russian-speaking adult learner who works in IT. They understand about 95% of spoken English but struggle to put their thoughts into words. The goal is fluency and getting ideas across, not grammar.

HOW YOU SPEAK
- Your spoken part is read aloud by text-to-speech: plain conversational sentences only. No lists, no markdown, no emojis, no stage names.
- Usually 1-3 short sentences, then ONE question. Leave the learner most of the talking time.
- The learner dictates by voice, so messages may contain dictation errors. Guess the intended meaning when it is clear. If a message is garbled, say you didn't quite catch it and ask them to say it again. Never treat a garbled message as a request to stop.
- Never end, pause or wrap up the lesson on your own and never ask whether the learner wants to stop: the app controls the lesson and its stages.
- Messages in square brackets are signals from the app, not from the learner.

LESSON ${p.n}: "${p.title}". Topic for discussion: ${p.talk}.
Target phrases: ${p.phrases.map(x => x[0]).join(" | ")}.
${p.lastPhrases.length ? `Phrases from the last lesson to recycle in the warm-up: ${p.lastPhrases.join(" | ")}.` : ""}
Role-play situation: ${p.role}
${p.focus ? `Coach's focus for today (from the last analysis): ${p.focus}` : ""}
${p.drill.length ? `Known weak spots to watch for: ${p.drill.join("; ")}` : ""}
Learner profile: ${prof.level ? "level " + prof.level + "; " : ""}${prof.weaknesses.slice(0, 4).join("; ") || "no history yet"}.

STAGES (the app moves between them)
${stageLines}

${now}

MISTAKES LOGGED SO FAR TODAY
${notes}

OUTPUT FORMAT
First the spoken text. Then on a new line write @@META and then one line of JSON:
{"notes":[{"said":"the learner's exact phrase","better":"how a native speaker would say it","why":"up to 8 words in Russian"}],"done":false,"hint":"a short English phrase the learner could start their answer with","ru":"Russian translation of your spoken text"}
"notes": only real problems in the learner's LAST message that make it unclear or clearly unnatural (skip small slips and likely dictation errors); [] if none.
"done": true only when the current stage's goal is complete.`;
}

function startLesson(topicIdx) {
  if (!sample) { toast(sampleReady ? "Claude недоступен в этом окне: откройте урок по ссылке в Claude." : "Подключаю Claude, секунду…"); return; }
  if (canSpeak) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } // unlocks speech on iOS
  L = { plan: buildPlan(topicIdx), stage: 0, stageStart: Date.now(), startedAt: Date.now(), messages: [], notes: [],
        transcript: [], turns: 0, justStarted: true, stageDone: false, ending: false, finished: false,
        speakMs: 0, words: 0, answers: 0, longest: 0, state: "thinking", last: { text: "", ru: "", hint: "" }, showRu: false, showHint: false,
        draft: "", ctl: null, confirmEnd: 0, tick: null, error: "" };
  L.messages.push({ role: "user", content: "[The learner has joined. Start the lesson.]" });
  $("#answer").value = "";
  show("lesson"); lessonUI();
  L.tick = setInterval(() => { if (L && !L.finished) stageBar(); }, 1000);
  aiTurn();
}

function maybeAdvance() {
  const st = STAGES[L.stage], elapsed = (Date.now() - L.stageStart) / 1000;
  L.justStarted = false;
  if (L.stage < STAGES.length - 1 && (L.stageDone || elapsed >= st.sec)) { L.stage++; L.stageStart = Date.now(); L.justStarted = true; L.stageDone = false; }
  else if (L.stage === STAGES.length - 1 && (L.stageDone || elapsed >= st.sec)) L.ending = true;
}

function userSays(text, ms) {
  text = text.trim();
  if (!text || !L || L.finished || L.state === "thinking") return;
  stopMic(); stopSpeaking();
  L.answers++; const w = words(text); L.words += w; L.longest = Math.max(L.longest, w); L.speakMs += ms || 0;
  L.transcript.push({ who: "me", text });
  L.messages.push({ role: "user", content: text });
  L.turns++;
  $("#answer").value = "";
  maybeAdvance();
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
  const turns = [{ role: "user", content: rulesTurn() }, ...L.messages.slice(-30)];
  try {
    const res = await sample(turns, {
      modelTier: db.settings.tier, cache: false, signal: ctl.signal,
      onText: ({ text }) => { if (!L || ctl.signal.aborted) return; buf = text; L.state = "speaking"; L.last.text = spokenPart().trim(); lessonUI(); flush(false); }
    });
    if (!L || ctl.signal.aborted) return;
    buf = res.text; flush(true);
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
    L.state = "speaking"; lessonUI();
    whenSpoken(() => {
      if (!L || L.finished) return;
      if (L.ending) { finishLesson(); return; }
      if (db.settings.autoMic && !mic.blocked) listen();
      else { L.state = "idle"; lessonUI(); }
    });
  } catch (e) {
    if (ctl.signal.aborted || !L) return;
    stopSpeaking();
    if (FATAL.includes(e && e.code)) sample = null;
    L.state = "error"; L.error = aiError(e); lessonUI();
  } finally { if (L && L.ctl === ctl) L.ctl = null; }
}

function listen() {
  if (!L || L.finished) return;
  stopSpeaking();
  L.draft = "";
  const ok = startMic(t => { L.draft = t; $("#answer").value = t; }, (t, ms) => confirmSend(t, ms));
  L.state = ok ? "listening" : "idle"; lessonUI();
}
function confirmSend(text, ms) {
  if (!text.trim()) { listen(); return; }
  L.state = "confirm"; L.draft = text; L.pendingMs = ms; $("#answer").value = text; lessonUI();
  clearTimeout(L.sendTimer);
  L.sendTimer = setTimeout(() => { if (L && L.state === "confirm") userSays(L.draft, L.pendingMs); }, 1200);
}
function skipStage() {
  if (!L || L.state === "thinking") return;
  stopMic(); stopSpeaking(); clearTimeout(L.sendTimer);
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
  L.finished = true; clearInterval(L.tick); clearTimeout(L.sendTimer);
  stopMic(); stopSpeaking(); if (L.ctl) L.ctl.abort();
  const s = {
    id: "s" + Date.now().toString(36), date: new Date().toISOString(), n: L.plan.n, topic: L.plan.topic, title: L.plan.title,
    durationSec: Math.round((Date.now() - L.startedAt) / 1000), speakSec: Math.round(L.speakMs / 1000),
    words: L.words, answers: L.answers, longest: L.longest, avgWords: L.answers ? Math.round(L.words / L.answers * 10) / 10 : 0,
    stagesReached: L.stage + 1, phrases: L.plan.phrases, notes: L.notes, transcript: L.transcript.slice(-80), report: null
  };
  db.sessions.push(s); rememberLocalSession(s); saveSession(s);
  L = null;
  if (s.answers < 3) { reportView(s, "Урок слишком короткий для разбора: меньше трёх ответов. Статистика сохранена."); return; }
  reportView(s, null, true);
  await makeReport(s);
}

/* ================= report ================= */
async function makeReport(s) {
  if (!sample) { reportView(s, "Разбор делает Claude: откройте урок по ссылке в Claude."); return; }
  const nextTopic = (s.topic + 1) % TOPICS.length;
  const history = db.sessions.filter(x => x.report && x.id !== s.id).slice(-5)
    .map(x => `Lesson ${x.n} (${x.title}): fluency ${x.report.scores.fluency}, clarity ${x.report.scores.clarity}, vocabulary ${x.report.scores.vocabulary}, confidence ${x.report.scores.confidence}; avg ${x.avgWords} words per answer.`).join("\n") || "(first lesson)";
  const errors = db.profile.errors.filter(e => e.status !== "fixed").map(e => `${e.wrong} → ${e.right} (seen ${e.count}x)`).join("; ") || "none yet";
  const tr = s.transcript.map(t => (t.who === "me" ? "LEARNER: " : "COACH: ") + t.text).join("\n");
  const prompt = `You are an expert English speaking coach. Analyse this spoken lesson of a Russian-speaking IT professional (understands ~95%, struggles to express thoughts). Fluency and getting ideas across matter more than grammar. The learner dictated by voice: ignore obvious dictation errors.

Lesson ${s.n}: "${s.title}". Target phrases: ${s.phrases.map(p => p[0]).join(" | ")}.
Metrics: ${s.answers} answers, ${s.words} words, average ${s.avgWords} words per answer, longest ${s.longest} words, stages reached ${s.stagesReached} of 5.
Mistakes the coach logged during the lesson: ${s.notes.map(n => `"${n.said}" → "${n.better}"`).join("; ") || "none"}.
Known recurring errors: ${errors}.
Earlier lessons:
${history}

TRANSCRIPT
${tr.slice(-20000)}

Reply with only a JSON object. Text in Russian, English examples in English:
{
 "summary": "2-3 sentences: honest overall picture, compared with earlier lessons when possible",
 "wins": ["2-4 concrete things that went well"],
 "mistakes": [{"said": "learner's exact phrase", "better": "natural version", "why": "short reason"}],
 "scores": {"fluency": 1-5, "clarity": 1-5, "vocabulary": 1-5, "confidence": 1-5},
 "level": "short spoken-level estimate, e.g. B1+ (говорение)",
 "strengths": ["up to 4, merging earlier knowledge with today"],
 "weaknesses": ["up to 4"],
 "patterns": [{"wrong": "recurring error pattern", "right": "natural version"}],
 "phrasesUsed": ["which of today's target phrases the learner actually used, exact English text from the list"],
 "next": {"focus": "1-2 sentences on what the next lesson (topic: ${TOPICS[nextTopic].t}) will train and why", "phrases": [{"en": "English phrase", "ru": "Russian gloss"}], "drill": ["up to 3 short items to practise"]}
}
Give 3-6 mistakes, up to 5 patterns, exactly 3 next.phrases that fix today's weak spots and fit the next topic. Be calibrated with scores, not generous.`;
  try {
    const r = await sample.json(prompt, { modelTier: "default", cache: false });
    const sc = r && r.scores || {};
    const clamp = v => Math.min(5, Math.max(1, Math.round(+v) || 1));
    const arr = (a, n) => Array.isArray(a) ? a.slice(0, n) : [];
    const rep = {
      summary: String(r.summary || ""), wins: arr(r.wins, 5).map(String),
      mistakes: arr(r.mistakes, 6).filter(m => m && m.said).map(m => ({ said: String(m.said), better: String(m.better || ""), why: String(m.why || "") })),
      scores: { fluency: clamp(sc.fluency), clarity: clamp(sc.clarity), vocabulary: clamp(sc.vocabulary), confidence: clamp(sc.confidence) },
      level: String(r.level || ""), strengths: arr(r.strengths, 4).map(String), weaknesses: arr(r.weaknesses, 4).map(String),
      patterns: arr(r.patterns, 5).filter(p => p && p.wrong && p.right).map(p => ({ wrong: String(p.wrong), right: String(p.right) })),
      phrasesUsed: arr(r.phrasesUsed, 5).map(String),
      next: { focus: String(r.next && r.next.focus || ""), phrases: arr(r.next && r.next.phrases, 3).filter(p => p && p.en).map(p => ({ en: String(p.en), ru: String(p.ru || "") })), drill: arr(r.next && r.next.drill, 3).map(String) }
    };
    s.report = rep; saveSession(s);
    applyReport(s, rep, nextTopic);
    reportView(s);
  } catch (e) {
    if (FATAL.includes(e && e.code)) sample = null;
    reportView(s, aiError(e) + " Урок сохранён, разбор можно запросить повторно.");
  }
}

function applyReport(s, r, nextTopic) {
  const P = db.profile;
  P.level = r.level || P.level;
  if (r.strengths.length) P.strengths = r.strengths;
  if (r.weaknesses.length) P.weaknesses = r.weaknesses;
  const seenNow = new Set();
  for (const p of r.patterns) {
    const ex = P.errors.find(e => norm(e.right) === norm(p.right) || norm(e.wrong) === norm(p.wrong));
    if (ex) { ex.count++; ex.lastSeen = s.n; ex.status = "active"; seenNow.add(ex); }
    else { const e = { wrong: p.wrong, right: p.right, count: 1, firstSeen: s.n, lastSeen: s.n, status: "active" }; P.errors.push(e); seenNow.add(e); }
  }
  for (const e of P.errors) if (!seenNow.has(e) && e.status !== "fixed" && s.n - e.lastSeen >= 3) e.status = "fixed";
  P.errors = P.errors.slice(-30);
  for (const [en, ru] of s.phrases) {
    let ph = P.phrases.find(x => norm(x.en) === norm(en));
    if (!ph) { ph = { en, ru, used: 0, lessons: [] }; P.phrases.push(ph); }
    if (r.phrasesUsed.some(u => norm(u) === norm(en))) { ph.used++; if (!ph.lessons.includes(s.n)) ph.lessons.push(s.n); }
  }
  P.phrases = P.phrases.slice(-40);
  saveProfile();
  db.next = { topic: nextTopic, focus: r.next.focus, phrases: r.next.phrases, drill: r.next.drill, fromLesson: s.n, source: "app", createdAt: new Date().toISOString() };
  saveNext();
}

/* ================= UI: lesson ================= */
function stageBar() {
  if (!L) return;
  const st = STAGES[L.stage], left = st.sec - (Date.now() - L.stageStart) / 1000;
  $("#stages").replaceChildren(...STAGES.map((s, i) => el("span", { class: "seg" + (i < L.stage ? " fin" : i === L.stage ? " cur" : "") })));
  $("#stageName").textContent = `${L.stage + 1}/5 · ${st.name}`;
  $("#stageTime").textContent = left > 0 ? fmtTime(left) : "+" + fmtTime(-left);
}
function lessonUI() {
  if (!L) return;
  stageBar();
  $("#aiText").textContent = L.last.text || (L.state === "thinking" ? "…" : "");
  const ru = $("#aiRu"); ru.hidden = !(L.showRu && L.last.ru); ru.textContent = L.last.ru;
  const hint = $("#hint"); hint.hidden = !(L.showHint && L.last.hint); hint.textContent = L.last.hint;
  const labels = {
    thinking: "Алекс думает…", speaking: "Алекс говорит",
    listening: "Слушаю. Пауза — и ответ отправится", confirm: "Отправляю…",
    idle: mic.blocked ? "Ваша очередь: нажмите на поле, затем 🎤 на клавиатуре и говорите" : "Ваша очередь",
    error: L.error || "Ошибка"
  };
  $("#state").textContent = labels[L.state];
  $("#state").classList.toggle("err", L.state === "error");
  $("#retryBtn").hidden = L.state !== "error";
  $("#micBtn").hidden = mic.blocked;
  $("#micBtn").dataset.state = L.state;
  $("#sendBtn").disabled = L.state === "thinking";
  $("#chips").replaceChildren(...L.plan.phrases.map(([en, ru]) => el("button", { class: "chip", title: ru, onclick: () => { stopSpeaking(); speakQueue(en); } }, en)));
}

/* ================= UI: home ================= */
function streak() {
  const days = new Set(db.sessions.map(s => dayKey(s.date)));
  let n = 0; const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function spark(values, max) {
  const w = 280, h = 56, n = values.length;
  if (n < 2) return el("p", { class: "note" }, "График появится после двух уроков.");
  const x = i => 6 + i * (w - 12) / (n - 1), y = v => h - 6 - (v / max) * (h - 14);
  const svg = `<svg viewBox="0 0 ${w} ${h}" class="spark" role="img" aria-label="Динамика"><polyline points="${values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>` +
    values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="${i === n - 1 ? 4 : 2.5}" fill="var(--accent)"/>`).join("") +
    `<text x="${x(n - 1) - 6}" y="${Math.max(12, y(values[n - 1]) - 8)}" text-anchor="end" class="sv">${values[n - 1]}</text></svg>`;
  const d = el("div"); d.innerHTML = svg; return d;
}
const stat = (v, l) => el("div", { class: "stat" }, el("b", {}, String(v)), el("span", {}, l));
function homeUI() {
  show("home");
  const ss = db.sessions, withRep = ss.filter(s => s.report);
  const plan = buildPlan(topicIndex());
  const sel = el("select", { id: "topicSel", "aria-label": "Тема урока" }, TOPICS.map((t, i) => el("option", { value: i, selected: i === plan.topic }, t.ru)));
  const errs = db.profile.errors.slice().sort((a, b) => (a.status === "fixed") - (b.status === "fixed") || b.count - a.count).slice(0, 8);
  fill($("#homeBody"),
    el("section", { class: "stats" },
      stat(ss.length, "уроков"), stat(Math.round(ss.reduce((a, s) => a + s.durationSec, 0) / 60), "минут практики"),
      stat(streak(), "дней подряд"), stat(ss.length ? ss.at(-1).avgWords : "–", "слов в ответе")),
    el("section", { class: "card next" },
      el("span", { class: "label" }, `Урок ${plan.n}` + (db.next && db.next.source === "claude" ? " · скорректирован Claude" : "")),
      el("h2", {}, plan.title),
      plan.focus ? el("p", { class: "focus" }, plan.focus) : el("p", { class: "note" }, "20 минут разговора: разминка, фразы урока, разговор на тему, ролевая ситуация, работа над ошибками. В конце разбор."),
      el("div", { class: "phr" }, plan.phrases.map(([en, ru]) => el("div", {}, el("b", {}, en), el("span", {}, ru)))),
      plan.drill.length ? el("p", { class: "note" }, "Будем отрабатывать: " + plan.drill.join("; ")) : null,
      el("div", { class: "row" },
        el("button", { class: "btn primary big", onclick: () => startLesson(+sel.value) }, "▶ Начать урок"),
        el("label", { class: "row small" }, "Тема: ", sel)),
      !sampleReady ? el("p", { class: "note" }, "Подключаю Claude…") : !sample ? el("p", { class: "note err" }, "Claude недоступен в этом окне. Откройте урок по ссылке в Claude.") : null),
    el("section", { class: "card" },
      el("h3", {}, "Как отвечать голосом"),
      el("p", { class: "note" }, "Алекс говорит вслух. Вы отвечаете голосом через клавиатуру телефона: нажмите на поле ответа, затем значок микрофона на клавиатуре, говорите по-английски и нажмите «Отправить». Если позволяет устройство, на телефоне можно включить английский язык диктовки.")),
    el("section", { class: "card" },
      el("h3", {}, "Прогресс"),
      el("div", { class: "two" },
        el("div", {}, el("span", { class: "label" }, "Беглость, 1–5"), spark(withRep.map(s => s.report.scores.fluency), 5)),
        el("div", {}, el("span", { class: "label" }, "Слов в среднем ответе"), spark(ss.map(s => s.avgWords), Math.max(12, ...ss.map(s => s.avgWords))))),
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
          el("span", { class: "hs" }, s.report ? `${s.report.scores.fluency}/5` : "—")))))) : null,
    el("section", { class: "card" }, el("h3", {}, "Разбор с Claude"),
      el("p", { class: "note" }, mode === "server"
        ? "Уроки, разборы и план хранятся на сервере этого артефакта. В Claude Code можно попросить: «Проанализируй мои уроки On Air English и скорректируй план». Claude прочитает историю и перепишет следующий урок, изменения появятся здесь сразу."
        : "Сейчас прогресс хранится только в этом браузере. Откройте урок по ссылке в Claude, чтобы он сохранялся на сервере."))
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
      !r && s.answers >= 3 && sample ? el("button", { class: "btn", onclick: () => { reportView(s, null, true); makeReport(s); } }, "Запросить разбор ещё раз") : null) : null,
    r ? el("div", { class: "card" }, el("p", {}, r.summary), bars(r.scores)) : null,
    r ? list("Что получилось", r.wins) : null,
    r && r.mistakes.length ? el("div", { class: "sec" }, el("h3", {}, "Главные ошибки"),
      el("ul", { class: "mist" }, r.mistakes.map(m => el("li", {}, el("s", {}, m.said), el("b", {}, m.better), el("small", {}, m.why))))) : null,
    r && r.next ? el("div", { class: "card next" }, el("h3", {}, "Следующий урок"), el("p", {}, r.next.focus),
      el("div", { class: "phr" }, r.next.phrases.map(p => el("div", {}, el("b", {}, p.en), el("span", {}, p.ru))))) : null,
    el("div", { class: "row" }, el("button", { class: "btn primary", onclick: homeUI }, "На главную"))
  );
}

/* ================= UI: settings ================= */
function settingsUI() {
  const st = db.settings, vs = voices();
  fill($("#settingsBody"),
    el("label", { class: "field" }, "Ответы Алекса",
      el("select", { id: "tierSel", onchange: e => { st.tier = e.target.value; saveSettings(); } },
        el("option", { value: "quick", selected: st.tier === "quick" }, "Быстрые — живой темп разговора"),
        el("option", { value: "default", selected: st.tier === "default" }, "Вдумчивые — умнее, но пауза 5–30 с"))),
    el("label", { class: "field" }, "Скорость речи Алекса",
      el("select", { id: "rateSel", onchange: e => { st.rate = +e.target.value; saveSettings(); } },
        [[0.8, "Медленно"], [0.95, "Обычно"], [1.1, "Быстро"]].map(([v, l]) => el("option", { value: v, selected: st.rate === v }, l)))),
    vs.length ? el("label", { class: "field" }, "Голос",
      el("select", { id: "voiceSel", onchange: e => { st.voice = e.target.value; saveSettings(); speakQueue("Hi! This is my voice."); } },
        el("option", { value: "" }, "Автоматически"), vs.map(v => el("option", { value: v.name, selected: st.voice === v.name }, `${v.name} (${v.lang})`)))) : null,
    canSpeak ? null : el("p", { class: "note" }, "Этот браузер не умеет озвучивать текст: ответы Алекса будут только на экране.")
  );
}

/* ================= wiring ================= */
$("#micBtn").addEventListener("click", () => {
  if (!L) return;
  if (L.state === "listening") finishMic();
  else if (L.state === "confirm") { clearTimeout(L.sendTimer); listen(); }
  else if (L.state !== "thinking") listen();
});
$("#answerForm").addEventListener("submit", e => { e.preventDefault(); if (L) { clearTimeout(L.sendTimer); userSays($("#answer").value, 0); } });
$("#answer").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#answerForm").requestSubmit(); } });
$("#answer").addEventListener("focus", () => { if (L && L.state === "speaking") stopSpeaking(); if (L && (L.state === "speaking")) { L.state = "idle"; lessonUI(); } });
$("#retryBtn").addEventListener("click", () => { if (L && L.state === "error") aiTurn(); });
$("#repeatBtn").addEventListener("click", () => { if (!L || !L.last.text) return; stopMic(); stopSpeaking(); tts.rateMul = 1; speakQueue(L.last.text); });
$("#slowBtn").addEventListener("click", () => { if (!L || !L.last.text) return; stopMic(); stopSpeaking(); tts.rateMul = 0.75; speakQueue(L.last.text); whenSpoken(() => { tts.rateMul = 1; }); });
$("#ruBtn").addEventListener("click", () => { if (!L) return; L.showRu = !L.showRu; lessonUI(); });
$("#hintBtn").addEventListener("click", () => { if (!L) return; L.showHint = !L.showHint; lessonUI(); });
$("#skipBtn").addEventListener("click", skipStage);
$("#endBtn").addEventListener("click", endLesson);
$("#homeLink").addEventListener("click", () => { if (L && !L.finished) { toast("Сначала завершите урок кнопкой «Закончить»"); return; } homeUI(); });
if (canSpeak) speechSynthesis.onvoiceschanged = () => { if (!$("#home").hidden) settingsUI(); };

loadLocal();
syncIdle();
homeUI();
(async () => {
  const use = (window.claude && typeof window.claude.use === "function") ? n => window.claude.use(n).catch(() => null) : () => Promise.resolve(null);
  const [dbNs, sampleNs] = await Promise.all([use("db"), use("sample")]);
  sample = sampleNs; sampleReady = true;
  if (dbNs) {
    store = dbNs; mode = "server"; setSync("saving", "Загружаю с сервера…");
    try { await loadServer(); syncIdle(); }
    catch { mode = "local"; store = null; setSync("error", "Сервер недоступен, сохраняю в браузере"); }
  }
  if (!L) { const r = $("#report"); if (r.hidden) homeUI(); }
})();
