'use strict';

const APP_VERSION = 1;
const STORAGE_KEY = 'highschoolQuizOX.history';
const RECENT_KEY = 'highschoolQuizOX.recent';
const RECENT_LIMIT = 20;
const CSV_FILE = 'questions.csv';
const REQUIRED_COLUMNS = ['大会', '予選', '問題番号', '問題', '正解', '補足'];
const HISTORY_COLUMNS = ['回答回数', '正解数', '不正解数', '正答率', '最終回答日時', '最終回答'];

const state = {
  entries: [],
  questions: [],
  byId: new Map(),
  history: loadHistory(),
  recentIds: loadRecentIds(),
  current: null,
  answered: false
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  bindElements();
  bindEvents();
  updateStats();
  loadQuestions();
  registerServiceWorker();
});

function bindElements() {
  ['dataStatus','statsToggle','statsPanel','totalAttempts','totalCorrect','totalIncorrect','totalRate','exportCsv','importCsv','importFile','resetHistory','errorPanel','errorMessage','retryLoad','quizCard','contestLabel','prelimLabel','numberLabel','questionText','answerButtons','resultArea','resultMessage','supplement','nextQuestion'].forEach(id => {
    els[id] = document.getElementById(id);
  });
}

function bindEvents() {
  els.statsToggle.addEventListener('click', () => {
    const opening = els.statsPanel.hidden;
    els.statsPanel.hidden = !opening;
    els.statsToggle.setAttribute('aria-expanded', String(opening));
  });
  els.answerButtons.addEventListener('click', event => {
    const button = event.target.closest('[data-answer]');
    if (button) answerQuestion(button.dataset.answer);
  });
  els.nextQuestion.addEventListener('click', showNextQuestion);
  els.exportCsv.addEventListener('click', exportProgressCsv);
  els.importCsv.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', handleImportFile);
  els.resetHistory.addEventListener('click', resetAllHistory);
  els.retryLoad.addEventListener('click', loadQuestions);
}

async function loadQuestions() {
  showError(null);
  els.quizCard.hidden = true;
  els.dataStatus.textContent = '問題を読み込み中…';
  try {
    const response = await fetch(CSV_FILE, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`CSVの取得に失敗しました（HTTP ${response.status}）`);
    const text = await response.text();
    const rows = parseCsv(text);
    const entries = rowsToEntries(rows);
    const questions = entries.filter(q => q.answer);
    if (!questions.length) throw new Error('○または×の正解が設定された問題が見つかりません。');
    state.entries = entries;
    state.questions = questions;
    state.byId = new Map(entries.map(q => [q.id, q]));
    state.recentIds = state.recentIds.filter(id => state.byId.has(id)).slice(-RECENT_LIMIT);
    saveRecentIds();
    const skipped = entries.length - questions.length;
    els.dataStatus.textContent = skipped ? `${questions.length.toLocaleString('ja-JP')}問を出題対象として読み込み済み（正解不明 ${skipped}問を除外）` : `${questions.length.toLocaleString('ja-JP')}問を読み込み済み`;
    showNextQuestion();
  } catch (error) {
    console.error(error);
    els.dataStatus.textContent = '読み込みエラー';
    showError(error instanceof Error ? error.message : String(error));
  }
}

function rowsToEntries(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map(v => v.replace(/^\uFEFF/, '').trim());
  const missing = REQUIRED_COLUMNS.filter(name => !headers.includes(name));
  if (missing.length) throw new Error(`CSVに必要な列がありません: ${missing.join('、')}`);
  const index = Object.fromEntries(headers.map((h, i) => [h, i]));
  const rawEntries = rows.slice(1).filter(row => row.some(cell => cell.trim() !== '')).map(row => {
    const value = name => String(row[index[name]] ?? '').trim();
    return {
      contest: value('大会'), prelim: value('予選'), number: value('問題番号'),
      question: value('問題'), answer: normalizeAnswer(value('正解')), rawAnswer: value('正解'), supplement: value('補足')
    };
  });
  const baseCounts = new Map();
  for (const e of rawEntries) {
    const base = makeQuestionId(e.contest, e.prelim, e.number);
    baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
  }
  const used = new Map();
  return rawEntries.map((e, i) => {
    const base = makeQuestionId(e.contest, e.prelim, e.number);
    let id = baseCounts.get(base) === 1 ? base : `${base}|${escapeIdPart(e.question)}`;
    const seen = used.get(id) || 0;
    used.set(id, seen + 1);
    if (seen) id = `${id}|dup${seen + 1}`;
    return { ...e, id, sourceRow: i + 2 };
  });
}

function escapeIdPart(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function makeQuestionId(contest, prelim, number) {
  return `${escapeIdPart(contest)}|${escapeIdPart(prelim)}|${escapeIdPart(number)}`;
}

function showNextQuestion() {
  if (!state.questions.length) return;
  const recentSet = new Set(state.recentIds);
  let candidates = state.questions.filter(q => !recentSet.has(q.id));
  if (!candidates.length) candidates = state.questions;
  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  state.current = selected;
  state.answered = false;
  state.recentIds.push(selected.id);
  if (state.recentIds.length > RECENT_LIMIT) state.recentIds = state.recentIds.slice(-RECENT_LIMIT);
  saveRecentIds();
  renderQuestion(selected);
}

function renderQuestion(q) {
  els.contestLabel.textContent = `第${q.contest}回大会`;
  els.prelimLabel.textContent = q.prelim || '予選区分なし';
  els.numberLabel.textContent = `問題番号 ${q.number}`;
  els.questionText.textContent = q.question;
  els.resultArea.hidden = true;
  els.supplement.hidden = true;
  els.supplement.textContent = '';
  for (const button of els.answerButtons.querySelectorAll('[data-answer]')) {
    button.disabled = false;
    button.classList.remove('is-correct', 'is-wrong');
  }
  els.quizCard.hidden = false;
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function answerQuestion(userAnswer) {
  if (!state.current || state.answered) return;
  state.answered = true;
  const q = state.current;
  const isCorrect = userAnswer === q.answer;
  const now = new Date().toISOString();
  const old = state.history.records[q.id] || { attempts: 0, correct: 0, incorrect: 0, lastAnsweredAt: null, lastAnswer: null };
  state.history.records[q.id] = {
    attempts: safeInt(old.attempts) + 1,
    correct: safeInt(old.correct) + (isCorrect ? 1 : 0),
    incorrect: safeInt(old.incorrect) + (isCorrect ? 0 : 1),
    lastAnsweredAt: now,
    lastAnswer: userAnswer
  };
  saveHistory();
  updateStats();

  for (const button of els.answerButtons.querySelectorAll('[data-answer]')) {
    button.disabled = true;
    if (button.dataset.answer === q.answer) button.classList.add('is-correct');
    if (!isCorrect && button.dataset.answer === userAnswer) button.classList.add('is-wrong');
  }
  els.resultMessage.textContent = isCorrect ? '正解' : `不正解　正解は${q.answer}`;
  els.resultMessage.className = `result-message ${isCorrect ? 'correct' : 'incorrect'}`;
  if (q.supplement) {
    els.supplement.textContent = q.supplement;
    els.supplement.hidden = false;
  }
  els.resultArea.hidden = false;
}

function loadHistory() {
  const empty = { version: APP_VERSION, records: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.records !== 'object' || parsed.records === null) return empty;
    return migrateHistory(parsed);
  } catch (error) {
    console.warn('履歴データを読み込めなかったため空の履歴で起動します。', error);
    return empty;
  }
}

function migrateHistory(data) {
  const version = Number(data.version) || 1;
  if (version === 1) return { version: APP_VERSION, records: sanitizeRecords(data.records) };
  console.warn(`未知の履歴バージョン ${version} のため、読める範囲で復旧します。`);
  return { version: APP_VERSION, records: sanitizeRecords(data.records) };
}

function sanitizeRecords(records) {
  const clean = {};
  for (const [id, value] of Object.entries(records || {})) {
    if (!value || typeof value !== 'object') continue;
    const attempts = safeInt(value.attempts);
    const correct = Math.min(safeInt(value.correct), attempts);
    const incorrect = Math.min(safeInt(value.incorrect), Math.max(0, attempts - correct));
    clean[id] = {
      attempts,
      correct,
      incorrect: attempts === correct + incorrect ? incorrect : Math.max(0, attempts - correct),
      lastAnsweredAt: typeof value.lastAnsweredAt === 'string' ? value.lastAnsweredAt : null,
      lastAnswer: normalizeAnswer(value.lastAnswer) || null
    };
  }
  return clean;
}

function saveHistory() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.history));
  } catch (error) {
    console.error(error);
    alert('回答履歴を保存できませんでした。Safariのストレージ容量やプライベートブラウズ設定を確認し、成績CSVを保存してください。');
  }
}

function loadRecentIds() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string').slice(-RECENT_LIMIT) : [];
  } catch { return []; }
}

function saveRecentIds() {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(state.recentIds)); } catch (error) { console.warn(error); }
}

function updateStats() {
  let attempts = 0, correct = 0, incorrect = 0;
  for (const record of Object.values(state.history.records)) {
    attempts += safeInt(record.attempts);
    correct += safeInt(record.correct);
    incorrect += safeInt(record.incorrect);
  }
  els.totalAttempts && (els.totalAttempts.textContent = attempts.toLocaleString('ja-JP'));
  els.totalCorrect && (els.totalCorrect.textContent = correct.toLocaleString('ja-JP'));
  els.totalIncorrect && (els.totalIncorrect.textContent = incorrect.toLocaleString('ja-JP'));
  els.totalRate && (els.totalRate.textContent = attempts ? `${(correct / attempts * 100).toFixed(1)}%` : '—');
}

function exportProgressCsv() {
  if (!state.entries.length) return alert('問題データの読み込み後に実行してください。');
  const header = [...REQUIRED_COLUMNS, ...HISTORY_COLUMNS];
  const rows = [header];
  for (const q of state.entries) {
    const r = state.history.records[q.id] || { attempts: 0, correct: 0, incorrect: 0, lastAnsweredAt: '', lastAnswer: '' };
    const attempts = safeInt(r.attempts);
    const correct = safeInt(r.correct);
    rows.push([
      q.contest, q.prelim, q.number, q.question, q.rawAnswer, q.supplement,
      attempts, correct, safeInt(r.incorrect), attempts ? (correct / attempts).toFixed(6) : '', r.lastAnsweredAt || '', r.lastAnswer || ''
    ]);
  }
  const csv = '\uFEFF' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  a.href = url;
  a.download = `高校生クイズ○×成績_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleImportFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('CSVにデータ行がありません。');
    const headers = rows[0].map(v => v.replace(/^\uFEFF/, '').trim());
    const missingBase = REQUIRED_COLUMNS.filter(name => !headers.includes(name));
    if (missingBase.length) throw new Error(`必要な問題列がありません: ${missingBase.join('、')}`);
    const hasHistory = HISTORY_COLUMNS.every(name => headers.includes(name));
    if (!hasHistory) {
      alert('元の問題CSVとして認識しました。履歴列がないため、現在の回答履歴は変更しません。');
      return;
    }
    if (!confirm('このCSVの回答履歴で、現在のlocalStorageの履歴を置き換えます。現在の履歴は上書きされます。復元しますか？')) return;
    const restored = importHistoryRows(rows, headers);
    state.history = { version: APP_VERSION, records: restored };
    saveHistory();
    updateStats();
    alert(`回答履歴を復元しました（記録あり ${Object.keys(restored).length}問）。`);
  } catch (error) {
    console.error(error);
    alert(`CSVを読み込めませんでした。\n${error instanceof Error ? error.message : String(error)}`);
  }
}

function importHistoryRows(rows, headers) {
  const index = Object.fromEntries(headers.map((h, i) => [h, i]));
  const baseRows = rows.slice(1).filter(row => row.some(cell => String(cell).trim() !== ''));
  const prepared = baseRows.map(row => {
    const val = name => String(row[index[name]] ?? '').trim();
    return { row, val, base: makeQuestionId(val('大会'), val('予選'), val('問題番号')), question: val('問題') };
  });
  const baseCounts = new Map();
  for (const item of prepared) baseCounts.set(item.base, (baseCounts.get(item.base) || 0) + 1);
  const used = new Map();
  const records = {};
  for (const item of prepared) {
    const { val, base, question } = item;
    let id = baseCounts.get(base) === 1 ? base : `${base}|${escapeIdPart(question)}`;
    const seen = used.get(id) || 0;
    used.set(id, seen + 1);
    if (seen) id = `${id}|dup${seen + 1}`;
    const attempts = safeInt(val('回答回数'));
    const correct = safeInt(val('正解数'));
    const incorrect = safeInt(val('不正解数'));
    if (attempts === 0 && correct === 0 && incorrect === 0 && !val('最終回答日時') && !val('最終回答')) continue;
    if (correct + incorrect !== attempts) throw new Error(`大会${val('大会')}・${val('予選')}・問題${val('問題番号')}の回数が一致しません。`);
    if (correct > attempts || incorrect > attempts) throw new Error('回答履歴の数値が不正です。');
    const lastAnswer = val('最終回答');
    if (lastAnswer && !normalizeAnswer(lastAnswer)) throw new Error('「最終回答」には○または×を指定してください。');
    records[id] = { attempts, correct, incorrect, lastAnsweredAt: val('最終回答日時') || null, lastAnswer: normalizeAnswer(lastAnswer) || null };
  }
  return records;
}

function resetAllHistory() {
  if (!confirm('全回答履歴を削除します。この操作は元に戻せません。削除しますか？')) return;
  state.history = { version: APP_VERSION, records: {} };
  try { localStorage.removeItem(STORAGE_KEY); } catch (error) { console.warn(error); }
  updateStats();
  alert('全回答履歴を削除しました。');
}

function parseCsv(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') {
        if (text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
  }
  if (inQuotes) throw new Error('CSVの引用符が閉じられていません。');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function normalizeAnswer(value) {
  const s = String(value ?? '').trim();
  if (s === '○' || s === '〇' || s === '◯') return '○';
  if (s === '×' || s.toLowerCase() === 'x') return '×';
  return null;
}

function safeInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function showError(message) {
  if (!message) { els.errorPanel.hidden = true; return; }
  els.errorMessage.textContent = message;
  els.errorPanel.hidden = false;
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(error => console.warn('Service Worker登録失敗', error)));
  }
}
