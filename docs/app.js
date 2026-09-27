import Anthropic from "./vendor/anthropic-sdk.mjs";
import { STAGES, TOPICS } from "./lessons.js";

/* ================= configuration ================= */
const MODELS = { "claude-opus-5": "Opus 5 — самый сильный", "claude-sonnet-5": "Sonnet 5 — дешевле и быстрее" };
const BETAS = ["server-side-fallback-2026-07-01"];
const SDK = window.SpeechSDK; // Azure Speech SDK, loaded by a classic script tag

// Russian articulation hints for sounds Russian speakers usually find hard (IPA)
const SOUND_TIPS = {
  "θ": "Как в think: кончик языка между зубами, дуйте воздух. Не «с» и не «ф».",
  "ð": "Как в this: язык между зубами, со звонким голосом. Не «з» и не «д».",
  "w": "Как в we: губы трубочкой, потом резко раскрыть. Не «в»: зубы губу не трогают.",
  "v": "Как в very: верхние зубы касаются нижней губы.",
  "r": "Как в right: язык загнут назад и не касается нёба, без раската «р».",
  "ɹ": "Как в right: язык загнут назад и не касается нёба, без раската «р».",
  "h": "Как в house: просто выдох, мягче русского «х».",
  "ŋ": "Как в thinking: задняя часть языка к нёбу, звук в нос, без «г» в конце.",
  "æ": "Как в cat: рот широко, между «а» и «э».",
  "ɪ": "Как в ship: короткий расслабленный звук, ближе к «ы/и».",
  "i": "Как в sheep: длинный, губы в улыбке.",
  "iː": "Как в sheep: длинный, губы в улыбке.",
  "ʊ": "Как в book: короткий, губы слегка округлены.",
  "u": "Как в food: длинный, губы вперёд.",
  "uː": "Как в food: длинный, губы вперёд.",
  "ɜ": "Как в work: язык в центре, губы нейтральны, не «о».",
  "ɝ": "Как в work: язык в центре и загнут, не «о» и не «ёр».",
  "ə": "Безударный нейтральный звук, как в about. Не выговаривайте чётко «а» или «о».",
  "ʌ": "Как в cup: короткое «а», рот приоткрыт.",
  "d": "Кончик языка на бугорках за верхними зубами, не на зубах.",
  "t": "Кончик языка на бугорках за зубами, с придыханием в начале слова.",
  "l": "В конце слова тёмный: как в feel, язык глубже.",
  "z": "Звонкое окончание, как в plays: не оглушайте в «с».",
  "ʒ": "Как в usually: мягкий звонкий, ближе к «ж».",
  "dʒ": "Как в job: слитно «дж».",
  "tʃ": "Как в check: слитно «тч», мягче русского «ч»."
};

/* ================= storage ================= */
const K = "coach:";
const store = {
  get(k, d) { try { const v = localStorage.getItem(K + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(K + k, JSON.stringify(v)); } catch { toast("Не удалось сохранить: память браузера заполнена или отключена"); } }
};
const db = {
  keys: { claude: "", azure: "", region: "", ...store.get("keys", {}) },
  settings: { silence: 2500, rate: 0.95, voice: "", autoMic: true, model: "claude-opus-5", ...store.get("settings", {}) },
  profile: { level: "", strengths: [], weaknesses: [], errors: [], phrases: [], phonemes: {}, ...store.get("profile", {}) },
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
const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
function show(screen) { for (const s of ["setup", "home", "lesson", "report", "drill"]) $("#" + s).hidden = s !== screen; window.scrollTo(0, 0); }
let client = null;
function makeClient() { client = db.keys.claude ? new Anthropic({ apiKey: db.keys.claude, dangerouslyAllowBrowser: true }) : null; }
const hasAzure = () => !!(SDK && db.keys.azure && db.keys.region);
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
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && L && !L.finished) keepAwake(true); });

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

/* ================= pronunciation (Azure) ================= */
function azConfig() {
  const cfg = SDK.SpeechConfig.fromSubscription(db.keys.azure, db.keys.region);
  cfg.speechRecognitionLanguage = "en-US";
  cfg.outputFormat = SDK.OutputFormat.Detailed;
  cfg.setProperty(SDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, "1200");
  return cfg;
}
function azRecognizer(reference) {
  const r = new SDK.SpeechRecognizer(azConfig(), SDK.AudioConfig.fromDefaultMicrophoneInput());
  const pc = new SDK.PronunciationAssessmentConfig(reference || "", SDK.PronunciationAssessmentGradingSystem.HundredMark, SDK.PronunciationAssessmentGranularity.Phoneme, !!reference);
  pc.phonemeAlphabet = "IPA";
  pc.nbestPhonemeCount = 3;
  pc.enableProsodyAssessment = true;
  pc.applyTo(r);
  return r;
}
function parsePron(result) {
  let j; try { j = JSON.parse(result.properties.getProperty(SDK.PropertyId.SpeechServiceResponse_JsonResult)); } catch { return null; }
  const nb = j && j.NBest && j.NBest[0]; if (!nb) return null;
  const pa = nb.PronunciationAssessment || {};
  return {
    text: nb.Display || j.DisplayText || "",
    acc: pa.AccuracyScore, flu: pa.FluencyScore, pros: pa.ProsodyScore, pron: pa.PronScore, comp: pa.CompletenessScore,
    words: (nb.Words || []).map(w => ({
      w: w.Word, acc: w.PronunciationAssessment ? w.PronunciationAssessment.AccuracyScore : null, err: w.PronunciationAssessment ? w.PronunciationAssessment.ErrorType : "None",
      ph: (w.Phonemes || []).map(p => ({
        p: p.Phoneme, acc: p.PronunciationAssessment ? p.PronunciationAssessment.AccuracyScore : null,
        heard: (p.PronunciationAssessment && p.PronunciationAssessment.NBestPhonemes || []).map(x => x.Phoneme).find(x => x !== p.Phoneme) || ""
      }))
    }))
  };
}
function azError(e) {
  const code = e && e.errorCode;
  if (code === SDK.CancellationErrorCode.AuthenticationFailure) return "Ключ Azure или регион не подошли. Проверьте их в настройках.";
  if (code === SDK.CancellationErrorCode.ConnectionFailure) return "Нет связи с Azure. Проверьте интернет.";
  return "Ошибка распознавания речи" + (e && e.errorDetails ? `: ${e.errorDetails}` : ".");
}
/* weakest sounds and words across a list of assessed segments */
function summarizePron(segs) {
  segs = segs.filter(s => s && s.words && s.words.length);
  if (!segs.length) return null;
  const words = {}, phon = {};
  for (const s of segs) for (const w of s.words) {
    if (w.err === "Insertion" || w.err === "Omission") continue;
    for (const p of w.ph) {
      if (!p.p || p.acc == null) continue;
      const x = phon[p.p] ||= { t: 0, l: 0, ex: [], heard: {} };
      x.t++;
      if (p.acc < 60) { x.l++; if (x.ex.length < 4 && !x.ex.includes(w.w)) x.ex.push(w.w); if (p.heard) x.heard[p.heard] = (x.heard[p.heard] || 0) + 1; }
    }
    if (w.acc != null && (w.acc < 70 || w.err === "Mispronunciation")) {
      const k = norm(w.w); const x = words[k] ||= { w: w.w, n: 0, min: 100, bad: [] };
      x.n++; x.min = Math.min(x.min, Math.round(w.acc));
      for (const p of w.ph) if (p.acc != null && p.acc < 60 && !x.bad.includes(p.p)) x.bad.push(p.p);
    }
  }
  return {
    n: segs.length,
    acc: avg(segs.map(s => s.acc || 0)), flu: avg(segs.map(s => s.flu || 0)),
    pros: avg(segs.filter(s => s.pros != null).map(s => s.pros)), pron: avg(segs.map(s => s.pron || 0)),
    badWords: Object.values(words).sort((a, b) => b.n - a.n || a.min - b.min).slice(0, 12),
    phonemes: phon
  };
}
function mergePhonemes(stats) {
  const P = db.profile.phonemes ||= {};
  for (const [p, x] of Object.entries(stats || {})) {
    const y = P[p] ||= { t: 0, l: 0, ex: [] };
    y.t += x.t; y.l += x.l;
    for (const w of x.ex) if (!y.ex.includes(w)) y.ex.unshift(w);
    y.ex = y.ex.slice(0, 5);
  }
  save("profile");
}
function weakSounds(stats, minTotal = 4, max = 6) {
  return Object.entries(stats || {}).filter(([, x]) => x.t >= minTotal && x.l / x.t >= 0.15)
    .sort((a, b) => b[1].l / b[1].t - a[1].l / a[1].t).slice(0, max)
    .map(([p, x]) => ({ p, rate: Math.round(100 * x.l / x.t), ex: x.ex, heard: Object.entries(x.heard || {}).sort((a, b) => b[1] - a[1]).map(h => h[0])[0] || "" }));
}

/* ================= speech input: Azure (with pronunciation) or browser ================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const input = { active: false, kind: "", rec: null, segs: [], interim: "", carry: "", lastChange: 0, firstAt: 0, timer: null, onDone: null, onUpdate: null, stopping: false };
let browserMicBlocked = !SR;
const canListen = () => hasAzure() || !browserMicBlocked;
function inputText() {
  const base = input.kind === "azure" ? input.segs.map(s => s.text).join(" ") : input.carry;
  return (base + " " + input.interim).replace(/\s+/g, " ").trim();
}
function startInput(onUpdate, onDone) {
  stopInput();
  Object.assign(input, { active: true, segs: [], interim: "", carry: "", lastChange: Date.now(), firstAt: 0, onDone, onUpdate, stopping: false });
  if (hasAzure()) startAzure(); else if (!browserMicBlocked) startBrowser(); else { input.active = false; return false; }
  clearInterval(input.timer);
  input.timer = setInterval(() => {
    if (input.active && !input.stopping && inputText() && !input.interim && Date.now() - input.lastChange > db.settings.silence) finishInput();
  }, 200);
  setLive();
  return true;
}
function startAzure() {
  input.kind = "azure";
  let r;
  try { r = azRecognizer(""); } catch { input.active = false; toast("Не удалось запустить распознавание Azure"); return; }
  input.rec = r;
  r.recognizing = (_, e) => { if (!input.firstAt) input.firstAt = Date.now(); input.interim = e.result.text; input.lastChange = Date.now(); input.onUpdate && input.onUpdate(inputText()); };
  r.recognized = (_, e) => {
    if (e.result.reason === SDK.ResultReason.RecognizedSpeech && e.result.text) {
      input.segs.push({ text: e.result.text, pron: parsePron(e.result) });
      input.interim = ""; input.lastChange = Date.now(); input.onUpdate && input.onUpdate(inputText());
    } else { input.interim = ""; }
  };
  r.canceled = (_, e) => {
    if (e.reason === SDK.CancellationReason.Error) { const msg = azError(e); stopInput(); toast(msg); if (L && !L.finished) { L.state = "idle"; lessonUI(); } }
  };
  r.startContinuousRecognitionAsync(() => {}, err => { stopInput(); toast("Нет доступа к микрофону: " + err); if (L && !L.finished) { L.state = "idle"; lessonUI(); } });
}
function startBrowser() {
  input.kind = "browser";
  const run = () => {
    if (!input.active || input.kind !== "browser") return;
    let rec;
    try { rec = new SR(); } catch { browserMicBlocked = true; stopInput(); return; }
    rec.lang = "en-US"; rec.continuous = false; rec.interimResults = true;
    rec.onresult = ev => {
      let fin = "", inter = "";
      for (let i = 0; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) fin += r[0].transcript + " "; else inter += r[0].transcript; }
      if (fin) { input.carry = (input.carry + " " + fin).trim(); input.interim = ""; } else input.interim = inter;
      if (!input.firstAt) input.firstAt = Date.now();
      input.lastChange = Date.now(); input.onUpdate && input.onUpdate(inputText());
    };
    rec.onerror = ev => { if (["not-allowed", "service-not-allowed", "audio-capture"].includes(ev.error)) { browserMicBlocked = true; stopInput(); toast("Нет доступа к микрофону. Разрешите его в настройках браузера."); if (L && !L.finished) { L.state = "idle"; lessonUI(); } } };
    rec.onend = () => { input.interim = ""; if (input.active && input.kind === "browser") setTimeout(run, 60); };
    try { rec.start(); input.rec = rec; } catch { stopInput(); if (L && !L.finished) { L.state = "idle"; lessonUI(); } }
  };
  run();
}
function finishInput() {
  if (!input.active || input.stopping) return;
  input.stopping = true; clearInterval(input.timer);
  const done = input.onDone, ms = input.firstAt ? Date.now() - input.firstAt : 0;
  const deliver = () => { const text = inputText(), prons = input.segs.map(s => s.pron).filter(Boolean); stopInput(); done && done(text, ms, prons); };
  if (input.kind === "azure" && input.rec) input.rec.stopContinuousRecognitionAsync(deliver, deliver);
  else deliver();
}
function stopInput() {
  const r = input.rec, kind = input.kind;
  input.active = false; input.stopping = false; clearInterval(input.timer); input.rec = null;
  if (r) {
    if (kind === "azure") { try { r.stopContinuousRecognitionAsync(() => r.close(), () => r.close()); } catch { try { r.close(); } catch {} } }
    else { try { r.abort(); } catch {} }
  }
  setLive();
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
    sounds: weakSounds(db.profile.phonemes).slice(0, 3).map(s => `/${s.p}/ (e.g. ${s.ex.slice(0, 2).join(", ")})`)
  };
}

/* ================= lesson runtime ================= */
let L = null;
function systemPrompt() {
  const p = L.plan, st = STAGES[L.stage], elapsed = (Date.now() - L.stageStart) / 1000, prof = db.profile;
  const stageLines = STAGES.map((s, i) => `${i + 1}. ${s.name} (${Math.round(s.sec / 60)} min): ${s.goal}`).join("\n");
  const notes = L.notes.slice(-8).map(n => `- "${n.said}" → "${n.better}"`).join("\n") || "- (none yet)";
  const lastPron = L.lastPron && L.lastPron.badWords.length ? `Pronunciation of the learner's last answer (automatic assessment): mispronounced ${L.lastPron.badWords.slice(0, 4).map(w => `"${w.w}"${w.bad.length ? " (/" + w.bad.join("/, /") + "/)" : ""}`).join(", ")}.` : "";
  let now = `CURRENT STAGE: ${L.stage + 1}. ${st.name}. Time in this stage: ${Math.round(elapsed)}s of ${st.sec}s.`;
  if (L.justStarted && L.stage === 0 && L.turns === 0) now += "\nThe lesson is starting now: greet the learner briefly, name today's topic in a few words, and ask the first warm-up question.";
  else if (L.justStarted) now += "\nThis stage has JUST started: react to the learner's last message in one short sentence, then open this stage with a clear one-sentence transition.";
  if (L.ending) now += "\nThis is your LAST reply of the lesson: react briefly, tell the learner in one sentence what they did well today, and say their report is coming. Do not ask a question.";
  return `You are Alex, a warm, witty native English speaker and an experienced speaking coach. You are leading a live VOICE lesson with a Russian-speaking adult learner who works in IT. They understand about 95% of spoken English but struggle to put their thoughts into words. The goal is fluency and getting ideas across first, then clear pronunciation.

HOW YOU SPEAK
- Your spoken part is read aloud by text-to-speech: plain conversational sentences only. No lists, no markdown, no emojis, no stage names.
- Usually 1-3 short sentences, then ONE question. Leave the learner most of the talking time.
- The learner's messages come from speech recognition and may contain recognition errors. Guess the intended meaning when it is clear. If a message is garbled or makes no sense, say you didn't quite catch it and ask them to say it again. Never treat a garbled message as a request to stop.
- Never end, pause or wrap up the lesson on your own and never ask whether the learner wants to stop: the app controls the lesson and its stages.
- Messages in square brackets are signals from the app, not from the learner.
- Pronunciation: during stages 2 and 5 you may briefly model one mispronounced word ("Try: 'think', with your tongue between your teeth") and ask them to repeat it. In other stages do not interrupt for pronunciation.

LESSON ${p.n}: "${p.title}". Topic for discussion: ${p.talk}.
Target phrases: ${p.phrases.map(x => x[0]).join(" | ")}.
${p.lastPhrases.length ? `Phrases from the last lesson to recycle in the warm-up: ${p.lastPhrases.join(" | ")}.` : ""}
Role-play situation: ${p.role}
${p.focus ? `Coach's focus for today (from the last analysis): ${p.focus}` : ""}
${p.drill.length ? `Known weak spots to watch for: ${p.drill.join("; ")}` : ""}
${p.sounds.length ? `Sounds the learner often mispronounces: ${p.sounds.join("; ")}.` : ""}
Learner profile: ${prof.level ? "level " + prof.level + "; " : ""}${(prof.weaknesses || []).slice(0, 4).join("; ") || "no history yet"}.

STAGES (the app moves between them)
${stageLines}

${now}

MISTAKES LOGGED SO FAR TODAY
${notes}
${lastPron}

OUTPUT FORMAT
First the spoken text. Then on a new line write @@META and then one line of JSON:
{"notes":[{"said":"the learner's exact phrase","better":"how a native speaker would say it","why":"up to 8 words in Russian"}],"done":false,"hint":"a short English phrase the learner could start their answer with","ru":"Russian translation of your spoken text"}
"notes": only real problems in the learner's LAST message that make it unclear or clearly unnatural (skip small grammar slips and likely recognition errors); [] if none.
"done": true only when the current stage's goal is complete.`;
}

function startLesson(topicIdx) {
  if (!client) { setupUI(); return; }
  if (canSpeak) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } // unlocks speech on iOS
  keepAwake(true);
  L = { plan: buildPlan(topicIdx), stage: 0, stageStart: Date.now(), startedAt: Date.now(), messages: [], notes: [], prons: [], lastPron: null,
        transcript: [], turns: 0, justStarted: true, stageDone: false, ending: false, finished: false,
        speakMs: 0, words: 0, answers: 0, longest: 0, state: "thinking", last: { text: "", ru: "", hint: "" }, showRu: false, showHint: false,
        draft: "", ctl: null, confirmEnd: 0, tick: null, error: "" };
  L.messages.push({ role: "user", content: "[The learner has joined. Start the lesson.]" });
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
function userSays(text, ms, prons) {
  text = (text || "").trim();
  if (!L || L.finished) return;
  if (!text) { listen(); return; }
  L.answers++; const w = words(text); L.words += w; L.longest = Math.max(L.longest, w); L.speakMs += ms || 0;
  const answerPron = prons && prons.length ? summarizePron(prons) : null;
  if (prons && prons.length) L.prons.push(...prons);
  L.lastPron = answerPron;
  L.transcript.push({ who: "me", text, pron: answerPron ? answerPron.pron : null });
  L.messages.push({ role: "user", content: text });
  L.turns++;
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
    L.state = "speaking"; lessonUI();
    whenSpoken(() => {
      if (!L || L.finished) return;
      if (L.ending) { finishLesson(); return; }
      if (db.settings.autoMic && canListen()) listen(); else { L.state = "idle"; lessonUI(); }
    });
  } catch (e) {
    if (ctl.signal.aborted || !L) return;
    stopSpeaking();
    L.state = "error"; L.error = apiError(e); lessonUI();
  } finally { if (L && L.ctl === ctl) L.ctl = null; }
}
function listen() {
  if (!L || L.finished) return;
  stopSpeaking(); clearTimeout(L.sendTimer);
  L.draft = "";
  const ok = startInput(t => { L.draft = t; draftUI(); }, (t, ms, prons) => confirmSend(t, ms, prons));
  L.state = ok ? "listening" : "idle"; lessonUI();
}
function confirmSend(text, ms, prons) {
  if (!L || L.finished) return;
  if (!text.trim()) { listen(); return; }
  L.state = "confirm"; L.draft = text; L.pending = { ms, prons }; lessonUI();
  clearTimeout(L.sendTimer);
  L.sendTimer = setTimeout(() => { if (L && L.state === "confirm") userSays(L.draft, L.pending.ms, L.pending.prons); }, 1200);
}
function skipStage() {
  if (!L || L.state === "thinking") return;
  stopInput(); stopSpeaking(); clearTimeout(L.sendTimer);
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
  stopInput(); stopSpeaking(); if (L.ctl) L.ctl.abort(); keepAwake(false);
  const pron = summarizePron(L.prons);
  const s = {
    id: Date.now().toString(36), date: new Date().toISOString(), n: L.plan.n, topic: L.plan.topic, title: L.plan.title, model: db.settings.model,
    durationSec: Math.round((Date.now() - L.startedAt) / 1000), speakSec: Math.round(L.speakMs / 1000),
    words: L.words, answers: L.answers, longest: L.longest, avgWords: L.answers ? Math.round(L.words / L.answers * 10) / 10 : 0,
    stagesReached: L.stage + 1, phrases: L.plan.phrases, notes: L.notes, transcript: L.transcript.slice(-80),
    pron: pron ? { n: pron.n, acc: pron.acc, flu: pron.flu, pros: pron.pros, pron: pron.pron, badWords: pron.badWords } : null,
    report: null
  };
  if (pron) mergePhonemes(pron.phonemes);
  s.weakSounds = pron ? weakSounds(pron.phonemes, 3, 5) : [];
  db.sessions.push(s); save("sessions");
  L = null;
  if (s.answers < 3) { reportView(s, "Урок слишком короткий для разбора: меньше трёх ответов. Статистика сохранена."); return; }
  reportView(s, null, true);
  await makeReport(s);
}

/* ================= report ================= */
const REPORT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["summary", "wins", "mistakes", "scores", "level", "strengths", "weaknesses", "patterns", "phrasesUsed", "pronunciation", "next"],
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
    pronunciation: { type: "object", additionalProperties: false, required: ["summary", "tips"],
      properties: { summary: { type: "string" }, tips: { type: "array", items: { type: "string" } } } },
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
    .map(x => `Lesson ${x.n} (${x.title}): fluency ${x.report.scores.fluency}, clarity ${x.report.scores.clarity}, vocabulary ${x.report.scores.vocabulary}, confidence ${x.report.scores.confidence}; avg ${x.avgWords} words per answer${x.pron ? `; pronunciation ${x.pron.pron}/100` : ""}.`).join("\n") || "(first lesson)";
  const errors = db.profile.errors.filter(e => e.status !== "fixed").map(e => `${e.wrong} → ${e.right} (seen ${e.count}x)`).join("; ") || "none yet";
  const pronText = s.pron
    ? `Automatic pronunciation assessment (0-100): overall ${s.pron.pron}, accuracy ${s.pron.acc}, fluency ${s.pron.flu}, prosody ${s.pron.pros}.
Mispronounced words: ${s.pron.badWords.map(w => `${w.w} (x${w.n}, ${w.min}${w.bad.length ? ", weak /" + w.bad.join("/, /") + "/" : ""})`).join("; ") || "none"}.
Weakest sounds today (IPA, % of low scores): ${s.weakSounds.map(x => `/${x.p}/ ${x.rate}%${x.heard ? " (sounded like /" + x.heard + "/)" : ""} e.g. ${x.ex.join(", ")}`).join("; ") || "none"}.`
    : "No pronunciation assessment for this lesson.";
  const tr = s.transcript.map(t => (t.who === "me" ? "LEARNER: " : "COACH: ") + t.text).join("\n");
  const prompt = `You are an expert English speaking coach. Analyse this voice lesson of a Russian-speaking IT professional (understands ~95%, struggles to express thoughts). Fluency and getting ideas across matter most, then pronunciation. The learner's lines come from speech recognition: ignore obvious recognition errors.

Lesson ${s.n}: "${s.title}". Target phrases: ${s.phrases.map(p => p[0]).join(" | ")}.
Metrics: ${s.answers} answers, ${s.words} words, average ${s.avgWords} words per answer, longest ${s.longest} words, speaking time ${s.speakSec}s, stages reached ${s.stagesReached} of 5.
Mistakes the coach logged during the lesson: ${s.notes.map(n => `"${n.said}" → "${n.better}"`).join("; ") || "none"}.
Known recurring errors: ${errors}.
${pronText}
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
- pronunciation: summary = 1-2 sentences on pronunciation from the assessment data (or say there was no assessment); tips = up to 3 concrete articulation tips in Russian for the weakest sounds, each naming the sound and a practice word.
- next: the next lesson is on "${TOPICS[nextTopic].t}". focus = 1-2 sentences in Russian on what it will train and why; phrases = exactly 3 English phrases with Russian glosses that fix today's weak spots and fit the next topic; drill = up to 3 short items the coach should make the learner practise (may include a pronunciation item).`;
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

/* ================= pronunciation drill ================= */
let D = null;
function drillItems(s) {
  const items = [];
  const add = t => { t = String(t || "").replace(/[…]+/g, "").replace(/\s+/g, " ").trim(); if (t && !items.some(x => norm(x) === norm(t))) items.push(t); };
  if (s) {
    (s.report && s.report.mistakes || []).forEach(m => add(m.better));
    s.phrases.forEach(p => add(p[0]));
    (s.pron && s.pron.badWords || []).slice(0, 6).forEach(w => add(w.w));
  }
  for (const w of weakSounds(db.profile.phonemes)) w.ex.slice(0, 2).forEach(add);
  if (!items.length) ["I think this is a really good idea.", "Three things matter the most.", "What would you do with the whole world?", "The weather was worse than we thought."].forEach(add);
  return items.slice(0, 12);
}
function drillView(s) {
  if (!hasAzure()) { toast("Для оценки произношения нужен ключ Azure Speech: добавьте его в настройках."); setupUI(); return; }
  if (canSpeak) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); }
  D = { items: drillItems(s), results: {}, busy: -1, from: s ? s.n : null };
  show("drill"); drillUI();
}
function drillUI() {
  const colorOf = a => a == null ? "" : a >= 80 ? "good" : a >= 60 ? "mid" : "bad";
  fill($("#drillBody"),
    el("span", { class: "label" }, D.from ? `Произношение · по уроку ${D.from}` : "Произношение"),
    el("h2", {}, "Послушайте и повторите"),
    el("p", { class: "note" }, "Нажмите ▶, чтобы услышать образец, затем ● и произнесите фразу. Красным отмечены слова и звуки, которые прозвучали неточно."),
    el("ul", { class: "drill" }, D.items.map((t, i) => {
      const r = D.results[i];
      return el("li", {},
        el("div", { class: "row" },
          el("button", { class: "tool", "aria-label": "Послушать образец", onclick: () => { stopSpeaking(); speakQueue(t); } }, "▶"),
          el("button", { class: "tool rec" + (D.busy === i ? " on" : ""), "aria-label": "Записать", disabled: D.busy >= 0 && D.busy !== i, onclick: () => drillRecord(i) }, D.busy === i ? "Слушаю…" : "● Сказать"),
          r && !r.error ? el("span", { class: "sc" }, `${Math.round(r.pron)}/100`) : null),
        el("p", { class: "dtext" }, r && r.words && r.words.length
          ? r.words.map(w => el("span", { class: "w " + colorOf(w.err === "Omission" ? 0 : w.acc), title: w.acc != null ? `${Math.round(w.acc)}/100` : "" }, w.w + " "))
          : t),
        r && r.error ? el("p", { class: "note err" }, r.error) : null,
        r && r.words ? el("div", { class: "phon" }, r.words.filter(w => w.acc != null && w.acc < 70).slice(0, 4).map(w => {
          const bad = w.ph.filter(p => p.acc != null && p.acc < 60);
          return el("div", {}, el("b", {}, w.w), " ",
            bad.length ? bad.map(p => `/${p.p}/${p.heard ? " → похоже на /" + p.heard + "/" : ""}`).join(", ") : "неточно",
            bad.map(p => SOUND_TIPS[p.p]).filter(Boolean).slice(0, 1).map(tip => el("small", {}, tip)));
        })) : null,
        r && !r.error ? el("p", { class: "note" }, `Точность ${Math.round(r.acc)} · беглость ${Math.round(r.flu)}${r.pros != null ? ` · интонация ${Math.round(r.pros)}` : ""}${r.comp != null ? ` · полнота ${Math.round(r.comp)}` : ""}`) : null
      );
    })),
    el("div", { class: "row" }, el("button", { class: "btn primary", onclick: homeUI }, "На главную"))
  );
}
function drillRecord(i) {
  if (D.busy >= 0) return;
  stopSpeaking();
  D.busy = i; drillUI(); setLive();
  let r;
  try { r = azRecognizer(D.items[i]); } catch { D.busy = -1; D.results[i] = { error: "Не удалось запустить распознавание" }; drillUI(); return; }
  input.active = true; setLive();
  r.recognizeOnceAsync(res => {
    input.active = false; setLive(); try { r.close(); } catch {}
    if (res.reason === SDK.ResultReason.RecognizedSpeech) {
      const p = parsePron(res);
      D.results[i] = p || { error: "Не удалось оценить. Попробуйте ещё раз." };
      if (p) { const sm = summarizePron([p]); if (sm) mergePhonemes(sm.phonemes); }
    } else if (res.reason === SDK.ResultReason.Canceled) {
      D.results[i] = { error: azError(SDK.CancellationDetails.fromResult(res)) };
    } else D.results[i] = { error: "Ничего не услышал. Нажмите «Сказать» и говорите сразу." };
    D.busy = -1; drillUI();
  }, err => { input.active = false; setLive(); try { r.close(); } catch {} D.busy = -1; D.results[i] = { error: "Нет доступа к микрофону: " + err }; drillUI(); });
}

/* ================= UI: lesson ================= */
function stageBar() {
  if (!L) return;
  const st = STAGES[L.stage], left = st.sec - (Date.now() - L.stageStart) / 1000;
  $("#stages").replaceChildren(...STAGES.map((s, i) => el("span", { class: "seg" + (i < L.stage ? " fin" : i === L.stage ? " cur" : "") })));
  $("#stageName").textContent = `${L.stage + 1}/5 · ${st.name}`;
  $("#stageTime").textContent = left > 0 ? fmtTime(left) : "+" + fmtTime(-left);
}
function draftUI() { const d = $("#draft"); if (d && L) d.textContent = L.draft || "Говорите…"; }
function lessonUI() {
  if (!L) return;
  stageBar();
  $("#aiText").textContent = L.last.text || (L.state === "thinking" ? "…" : "");
  const ru = $("#aiRu"); ru.hidden = !(L.showRu && L.last.ru); ru.textContent = L.last.ru;
  const hint = $("#hint"); hint.hidden = !(L.showHint && L.last.hint); hint.textContent = L.last.hint;
  const labels = {
    thinking: "Алекс думает…", speaking: "Алекс говорит · нажмите, чтобы перебить", listening: "Слушаю. Пауза — и ответ отправится",
    confirm: "Отправляю… нажмите, чтобы сказать заново", idle: canListen() ? "Нажмите и говорите" : "Микрофон недоступен: напишите ответ ниже", error: L.error || "Ошибка"
  };
  $("#state").textContent = labels[L.state];
  $("#state").classList.toggle("err", L.state === "error");
  const b = $("#micBtn"); b.dataset.state = L.state;
  b.setAttribute("aria-label", { listening: "Отправить сейчас", speaking: "Перебить и ответить", confirm: "Сказать заново", error: "Повторить" }[L.state] || "Говорить");
  const d = $("#draft"); d.hidden = !(L.state === "listening" || L.state === "confirm"); d.textContent = L.draft || "Говорите…";
  $("#doneBtn").hidden = L.state !== "listening";
  const lp = $("#lastPron");
  lp.hidden = !(L.lastPron && L.state !== "listening" && L.state !== "confirm");
  if (L.lastPron) fill(lp, el("span", { class: "label" }, `Произношение ответа · ${L.lastPron.pron}/100`),
    L.lastPron.badWords.length ? el("span", {}, "Неточно: ", L.lastPron.badWords.slice(0, 5).map(w => el("b", { class: "bw" }, w.w))) : el("span", {}, "Все слова прозвучали чисто"));
  $("#chips").replaceChildren(...L.plan.phrases.map(([en, ru]) => el("button", { class: "chip", title: ru, onclick: () => { stopInput(); stopSpeaking(); speakQueue(en); if (L) { L.state = "speaking"; lessonUI(); whenSpoken(() => listen()); } } }, en)));
}
function micPressed() {
  if (!L) return;
  switch (L.state) {
    case "listening": finishInput(); break;
    case "confirm": clearTimeout(L.sendTimer); listen(); break;
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
  const ss = db.sessions, withRep = ss.filter(s => s.report), withPron = ss.filter(s => s.pron);
  const plan = buildPlan(topicIndex());
  const sel = el("select", { id: "topicSel", "aria-label": "Тема урока" }, TOPICS.map((t, i) => el("option", { value: i, selected: i === plan.topic }, t.ru)));
  const errs = db.profile.errors.slice().sort((a, b) => (a.status === "fixed") - (b.status === "fixed") || b.count - a.count).slice(0, 8);
  const sounds = weakSounds(db.profile.phonemes);
  fill($("#homeBody"),
    el("section", { class: "stats" },
      stat(ss.length, "уроков"), stat(Math.round(ss.reduce((a, s) => a + s.speakSec, 0) / 60), "минут речи"),
      stat(streak(), "дней подряд"), stat(withPron.length ? withPron.at(-1).pron.pron : "–", "произношение")),
    !hasAzure() ? el("section", { class: "card warn" }, el("p", {}, "Произношение не оценивается: не задан ключ Azure Speech. Распознавание идёт через браузер."),
      el("button", { class: "btn", onclick: setupUI }, "Добавить ключ Azure")) : null,
    el("section", { class: "card next" },
      el("span", { class: "label" }, `Урок ${plan.n}`),
      el("h2", {}, plan.title),
      plan.focus ? el("p", { class: "focus" }, plan.focus) : el("p", { class: "note" }, "20 минут голосом: разминка, фразы урока, разговор, ролевая ситуация, работа над ошибками. В конце разбор речи и произношения."),
      el("div", { class: "phr" }, plan.phrases.map(([en, ru]) => el("div", {}, el("b", {}, en), el("span", {}, ru)))),
      plan.drill.length ? el("p", { class: "note" }, "Будем отрабатывать: " + plan.drill.join("; ")) : null,
      el("div", { class: "row" },
        el("button", { class: "btn primary big", onclick: () => startLesson(+sel.value) }, "▶ Начать урок"),
        el("label", { class: "row small" }, "Тема: ", sel))),
    el("section", { class: "card" },
      el("h3", {}, "Произношение"),
      withPron.length > 1 ? el("div", {}, el("span", { class: "label" }, "Общая оценка, 0–100"), spark(withPron.map(s => s.pron.pron), 100, "Произношение по урокам")) : null,
      sounds.length ? el("ul", { class: "sounds" }, sounds.map(x => el("li", {},
        el("span", { class: "ipa" }, `/${x.p}/`),
        el("span", {}, el("b", {}, `${x.rate}% неточно`), x.heard ? ` · звучит как /${x.heard}/` : "", x.ex.length ? ` · ${x.ex.slice(0, 3).join(", ")}` : "",
          SOUND_TIPS[x.p] ? el("small", {}, SOUND_TIPS[x.p]) : null))))
        : el("p", { class: "note" }, hasAzure() ? "После первого урока здесь появятся звуки, которые получаются хуже всего." : "Нужен ключ Azure Speech."),
      hasAzure() ? el("div", { class: "row" }, el("button", { class: "btn", onclick: () => drillView(ss.at(-1)) }, "Тренировать произношение")) : null),
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
          el("span", { class: "ht" }, s.title, el("small", {}, `${new Date(s.date).toLocaleDateString("ru-RU")} · ${Math.round(s.durationSec / 60)} мин · ${s.avgWords} слов/ответ${s.pron ? ` · произн. ${s.pron.pron}` : ""}`)),
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
    el("section", { class: "stats" }, stat(Math.round(s.durationSec / 60), "минут"), stat(s.answers, "ответов"), stat(s.avgWords, "слов в ответе"), stat(s.pron ? s.pron.pron : "–", "произношение")),
    pending && !r ? el("div", { class: "card" }, el("p", {}, "Claude разбирает урок. Обычно это 20–60 секунд.")) : null,
    error ? el("div", { class: "card err" }, el("p", {}, error),
      !r && s.answers >= 3 && client ? el("button", { class: "btn", onclick: () => { reportView(s, null, true); makeReport(s); } }, "Запросить разбор ещё раз") : null) : null,
    r ? el("div", { class: "card" }, el("p", {}, r.summary), bars(r.scores)) : null,
    r ? list("Что получилось", r.wins) : null,
    r && r.mistakes.length ? el("div", { class: "sec" }, el("h3", {}, "Главные ошибки"),
      el("ul", { class: "mist" }, r.mistakes.map(m => el("li", {}, el("s", {}, m.said), el("b", {}, m.better), el("small", {}, m.why))))) : null,
    s.pron ? el("div", { class: "card" }, el("h3", {}, "Произношение"),
      el("p", { class: "note" }, `Общая ${s.pron.pron} · точность ${s.pron.acc} · беглость ${s.pron.flu} · интонация ${s.pron.pros} (из 100)`),
      r && r.pronunciation ? el("p", {}, r.pronunciation.summary) : null,
      r && r.pronunciation && r.pronunciation.tips.length ? el("ul", {}, r.pronunciation.tips.map(t => el("li", {}, t))) : null,
      s.pron.badWords.length ? el("p", {}, "Слова: ", s.pron.badWords.slice(0, 8).map(w => el("b", { class: "bw" }, w.w))) : null,
      hasAzure() ? el("div", { class: "row" }, el("button", { class: "btn primary", onclick: () => drillView(s) }, "Отработать произношение")) : null) : null,
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
    el("label", { class: "row small" }, el("input", { type: "checkbox", id: "autoMic", checked: st.autoMic, onchange: e => { st.autoMic = e.target.checked; save("settings"); } }), "Включать микрофон сам после ответа Алекса"),
    el("div", { class: "row" },
      el("button", { class: "btn", onclick: setupUI }, "Ключи"),
      el("button", { class: "btn", onclick: exportData }, "Скачать резервную копию"),
      el("label", { class: "btn" }, "Загрузить копию", el("input", { type: "file", accept: "application/json", hidden: true, onchange: importData })))
  );
}
function exportData() {
  const blob = new Blob([JSON.stringify({ v: 2, profile: db.profile, sessions: db.sessions, next: db.next, settings: db.settings }, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `english-coach-${dayKey(Date.now())}.json` }); document.body.append(a); a.click(); a.remove();
}
async function importData(e) {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.sessions) || !d.profile) throw new Error();
    db.profile = { phonemes: {}, ...d.profile }; db.sessions = d.sessions; db.next = d.next || null;
    if (d.settings) db.settings = { ...db.settings, ...d.settings };
    ["profile", "sessions", "next", "settings"].forEach(save);
    toast("Копия загружена"); homeUI();
  } catch { toast("Это не файл резервной копии"); }
}
function setupUI() {
  show("setup");
  $("#keyInput").value = db.keys.claude;
  $("#azKey").value = db.keys.azure;
  $("#azRegion").value = db.keys.region;
  $("#noSDK").hidden = !!SDK;
}
$("#saveKey").addEventListener("click", async () => {
  const k = $("#keyInput").value.trim(), ak = $("#azKey").value.trim(), reg = $("#azRegion").value.trim().toLowerCase().replace(/\s+/g, "");
  if (!k) { toast("Вставьте ключ Claude"); return; }
  if (ak && !reg) { toast("Укажите регион ресурса Azure, например westeurope"); return; }
  const b = $("#saveKey"); b.disabled = true; b.textContent = "Проверяю ключ Claude…";
  try {
    const c = new Anthropic({ apiKey: k, dangerouslyAllowBrowser: true });
    await c.models.retrieve(db.settings.model);
    db.keys = { claude: k, azure: ak, region: reg }; save("keys"); makeClient();
    toast(ak ? "Ключи сохранены. Проверьте микрофон и Azure кнопкой ниже." : "Ключ Claude работает");
    if (!ak) homeUI();
  } catch (e) { toast(apiError(e)); }
  b.disabled = false; b.textContent = "Сохранить";
});
$("#micTest").addEventListener("click", () => {
  const out = $("#micOut"); out.hidden = false;
  const ak = $("#azKey").value.trim(), reg = $("#azRegion").value.trim().toLowerCase();
  if (SDK && ak && reg) {
    out.textContent = "Скажите по-английски: «I think this is a great idea»";
    const saved = db.keys; db.keys = { ...db.keys, azure: ak, region: reg };
    let r; try { r = azRecognizer("I think this is a great idea"); } catch { out.textContent = "Не удалось запустить Azure."; db.keys = saved; return; }
    db.keys = saved;
    r.recognizeOnceAsync(res => {
      try { r.close(); } catch {}
      if (res.reason === SDK.ResultReason.RecognizedSpeech) { const p = parsePron(res); out.textContent = p ? `Работает. Услышал: «${p.text}». Произношение ${Math.round(p.pron)}/100, точность ${Math.round(p.acc)}.` : `Услышал: «${res.text}»`; }
      else if (res.reason === SDK.ResultReason.Canceled) out.textContent = azError(SDK.CancellationDetails.fromResult(res));
      else out.textContent = "Ничего не услышал. Нажмите ещё раз и говорите сразу.";
    }, err => { try { r.close(); } catch {} out.textContent = "Нет доступа к микрофону: " + err; });
  } else if (SR) {
    out.textContent = "Скажите что-нибудь по-английски…";
    const ok = startInput(t => out.textContent = t, t => out.textContent = t ? `Браузер распознал: «${t}». Без ключа Azure произношение не оценивается.` : "Ничего не услышал.");
    if (!ok) out.textContent = "Распознавание речи недоступно в этом браузере.";
  } else out.textContent = "Этот браузер не распознаёт речь. Добавьте ключ Azure или откройте страницу в Safari или Chrome.";
});

/* ================= wiring ================= */
$("#micBtn").addEventListener("click", micPressed);
$("#doneBtn").addEventListener("click", () => finishInput());
$("#repeatBtn").addEventListener("click", () => { if (!L || !L.last.text) return; stopInput(); stopSpeaking(); tts.rateMul = 1; speakQueue(L.last.text); L.state = "speaking"; lessonUI(); whenSpoken(() => listen()); });
$("#slowBtn").addEventListener("click", () => { if (!L || !L.last.text) return; stopInput(); stopSpeaking(); tts.rateMul = 0.75; speakQueue(L.last.text); L.state = "speaking"; lessonUI(); whenSpoken(() => { tts.rateMul = 1; listen(); }); });
$("#ruBtn").addEventListener("click", () => { if (!L) return; L.showRu = !L.showRu; lessonUI(); });
$("#hintBtn").addEventListener("click", () => { if (!L) return; L.showHint = !L.showHint; lessonUI(); });
$("#skipBtn").addEventListener("click", skipStage);
$("#endBtn").addEventListener("click", endLesson);
$("#typeForm").addEventListener("submit", e => {
  e.preventDefault();
  const t = $("#typeInput").value.trim(); if (!t || !L || L.state === "thinking") return;
  $("#typeInput").value = ""; stopInput(); stopSpeaking(); clearTimeout(L.sendTimer); userSays(t, 0, null);
});
$("#homeLink").addEventListener("click", () => { if (L && !L.finished) { toast("Сначала завершите урок кнопкой «Закончить»"); return; } homeUI(); });
if (canSpeak) speechSynthesis.onvoiceschanged = () => { if (!$("#home").hidden) settingsUI(); };
window.addEventListener("beforeunload", e => { if (L && !L.finished) { e.preventDefault(); e.returnValue = ""; } });

makeClient();
homeUI();
