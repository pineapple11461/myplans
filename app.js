// =========================================
// app.js - 화면 전환 및 사용자 동작
// =========================================
'use strict';

(function () {

  // 앱 버전: 업데이트할 때마다 index.html의 ?v= 숫자와 함께 올림 (오늘 화면 맨 아래에 표시)
  const APP_VERSION = 'v9';

  const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const SCREENS = ['today', 'tasks', 'calendar', 'tracker', 'review'];

  const $ = (id) => document.getElementById(id);

  // -----------------------------------------
  // 오늘 화면 데이터 (IndexedDB에서 불러온 값을 화면용으로 들고 있음)
  // 오늘 화면에서 추가한 할 일은 '오늘 날짜'를 가진 할 일로 저장함.
  // -----------------------------------------
  let todayStr = DB.toDateStr();   // 'YYYY-MM-DD'
  let todayItems = [];             // [{ occurrence, task }, ...]
  let busy = false;                // 저장 중 중복 터치 방지

  let doneExpanded = false;   // 완료 목록 펼침 상태

  // 전체 할 일 화면 데이터
  let pendingItems = [];      // 미완료 회차 전체 [{ occurrence, task }, ...]
  let tasksFilter = 'all';    // 'all' 또는 카테고리 id
  let categories = [];        // [{ id, name }, ...]

  // 달력 화면 데이터
  let calYear = new Date().getFullYear();
  let calMonth = new Date().getMonth() + 1;   // 1~12
  let calSelected = todayStr;                 // 선택한 날짜 'YYYY-MM-DD'
  let calData = { items: [], rules: [], tasksById: {} };

  // 트래커 화면 데이터
  let trackerWeek = DB.weekStartOf(todayStr);   // 보고 있는 주의 월요일
  let weeklyGoals = [];
  let habits = [];                 // 모든 습관 (보관한 것 포함)
  let habitLogMap = {};            // 'habitId|date' → 'done' | 'not_done'
  let habitArchivedOpen = false;   // 보관한 습관 목록 펼침 상태
  let trackerEditing = null;       // 트래커 수정창 상태: { kind: 'habit', item }
  let saveQueue = Promise.resolve();   // 칸을 빠르게 연달아 눌러도 순서대로 저장

  let currentScreen = 'today';
  let editing = null;         // 수정창 상태: { mode: 'new' } 또는 { mode: 'edit', item }
  let toastTimer = null;

  function showError(message, err) {
    if (err) console.error(err);
    alert('⚠️ ' + message);
  }

  // ---------- 공통 도우미 ----------
  function fillList(listEl, items) {
    listEl.innerHTML = '';
    items.forEach((el) => listEl.appendChild(el));
  }

  // 정렬 기준
  function byCreated(a, b) {
    return a.occurrence.createdAt.localeCompare(b.occurrence.createdAt);
  }
  // 같은 날짜 안에서는 시간 지정 일정이 먼저, 그다음 시간 없는 일
  function byTime(a, b) {
    return (a.occurrence.time || '99:99').localeCompare(b.occurrence.time || '99:99');
  }
  function byDateTime(a, b) {
    return a.occurrence.scheduledDate.localeCompare(b.occurrence.scheduledDate) ||
      byTime(a, b) || byCreated(a, b);
  }

  function categoryName(id) {
    const c = categories.find((cat) => cat.id === id);
    return c ? c.name : '';
  }

  // 'YYYY-MM-DD' → '10월 12일 (월)' (올해가 아니면 연도도 표시)
  function formatShortDate(str) {
    const parts = str.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    const wd = '일월화수목금토'[d.getDay()];
    const yearPart = parts[0] !== new Date().getFullYear() ? parts[0] + '년 ' : '';
    return yearPart + parts[1] + '월 ' + parts[2] + '일 (' + wd + ')';
  }

  // 입력칸 흔들기 (필수 입력 안내)
  function shake(input) {
    input.classList.remove('shake');
    void input.offsetWidth;          // 애니메이션 다시 시작
    input.classList.add('shake');
    input.focus();
  }

  // 잠깐 나타나는 알림 띠. actionLabel/onAction을 주면 버튼이 생김
  function showToast(text, actionLabel, onAction) {
    const toast = $('toast');
    const btn = $('toast-action');
    $('toast-text').textContent = text;
    btn.hidden = !actionLabel;
    btn.textContent = actionLabel || '';
    btn.onclick = actionLabel ? () => { hideToast(); onAction(); } : null;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 4000);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').classList.remove('show');
    $('toast-action').onclick = null;
  }

  // ---------- 오늘 날짜 ----------
  function renderDate() {
    const d = new Date();
    $('today-year').textContent = d.getFullYear() + '년';
    $('today-date').textContent =
      (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + WEEKDAYS[d.getDay()];
  }

  // ---------- 화면 전환 ----------
  function showScreen(name) {
    if (!SCREENS.includes(name)) return;

    document.querySelectorAll('.screen').forEach((sec) => {
      sec.hidden = sec.dataset.screen !== name;
    });

    document.querySelectorAll('.nav-btn').forEach((btn) => {
      const isActive = btn.dataset.target === name;
      btn.classList.toggle('active', isActive);
      if (isActive) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });

    // '+' 버튼은 오늘 화면과 전체 할 일 화면에서만 보임
    currentScreen = name;
    $('fab-add').hidden = !(name === 'today' || name === 'tasks');
    closeSheet();
    hideToast();

    window.scrollTo(0, 0);
  }

  // ---------- 할 일 한 줄 만들기 ----------
  // showMeta: true면 제목 아래에 날짜·카테고리·메모 표시 (전체 할 일 화면용)
  //           false면 시간만 제목 앞에 표시 (오늘 화면용, 카테고리 숨김)
  function createTaskItem(item, showMeta) {
    const occ = item.occurrence;
    const isDone = occ.status === 'done';

    const li = document.createElement('li');
    li.className = 'task-item' + (isDone ? ' is-done' : '');

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'check';
    check.setAttribute('aria-label', isDone ? '완료 취소' : '완료');
    check.textContent = isDone ? '✓' : '';
    // 전체 할 일 화면에서 완료하면 목록에서 사라지므로 되돌리기 알림을 띄움
    check.addEventListener('click', () => setDone(item, !isDone, showMeta));

    // 체크 버튼 외의 부분을 누르면 수정창이 열림
    const body = document.createElement('div');
    body.className = 'task-body';
    body.setAttribute('role', 'button');
    body.tabIndex = 0;
    body.addEventListener('click', () => openEdit(occ.id));
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openEdit(occ.id);
    });

    const main = document.createElement('div');
    main.className = 'task-main';

    if (occ.time && !showMeta) {
      const time = document.createElement('span');
      time.className = 'task-time';
      time.textContent = occ.time;
      main.appendChild(time);
    }

    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = item.task.title;   // textContent 사용: 입력한 글자가 HTML로 해석되지 않음
    main.appendChild(title);
    body.appendChild(main);

    if (showMeta) {
      const meta = document.createElement('div');
      meta.className = 'task-meta';
      const add = (text, cls) => {
        const s = document.createElement('span');
        if (cls) s.className = cls;
        s.textContent = text;
        meta.appendChild(s);
      };

      if (occ.scheduledDate) {
        const overdue = occ.scheduledDate < todayStr;
        const today = occ.scheduledDate === todayStr;
        add((today ? '오늘' : formatShortDate(occ.scheduledDate)) +
            (occ.time ? ' ' + occ.time : ''), overdue ? 'meta-overdue' : '');
      }
      // 원래 예정일은 목록에 표시하지 않음 (수정창과 리뷰 화면에서만 표시)
      if (item.rule && DB.FREQUENCIES[item.rule.frequency]) {
        add('🔁 ' + DB.FREQUENCIES[item.rule.frequency].label, 'meta-repeat');
      }
      const cat = categoryName(item.task.categoryId);
      if (cat) add(cat, 'meta-chip');
      if (item.task.memo) add('📝');

      if (meta.childNodes.length) body.appendChild(meta);
    }

    li.appendChild(check);
    li.appendChild(body);
    return li;
  }

  // ---------- 오늘 화면 그리기 ----------
  function renderToday() {
    const row = (it) => createTaskItem(it, false);

    const pending = todayItems.filter((it) => it.occurrence.status === 'pending');
    const done = todayItems
      .filter((it) => it.occurrence.status === 'done')
      .sort(byCreated);

    // 시간 지정 일정: 시간순
    const timed = pending
      .filter((it) => it.occurrence.time)
      .sort((a, b) => a.occurrence.time.localeCompare(b.occurrence.time) || byCreated(a, b));
    const untimed = pending
      .filter((it) => !it.occurrence.time)
      .sort(byCreated);

    fillList($('list-timed'), timed.map(row));
    $('empty-timed').hidden = timed.length > 0;

    fillList($('list-untimed'), untimed.map(row));
    $('empty-untimed').hidden = untimed.length > 0;

    fillList($('list-done'), done.map(row));
    $('done-count').textContent = String(done.length);
    $('done-card').hidden = done.length === 0;
    if (done.length === 0) doneExpanded = false;
    $('list-done').hidden = !doneExpanded;
    $('done-toggle').setAttribute('aria-expanded', String(doneExpanded));
  }

  // 저장소에서 오늘 데이터를 다시 읽어 화면을 그림
  async function loadToday() {
    todayItems = await DB.getItemsByDate(todayStr);
    renderToday();
  }

  async function loadTasks() {
    pendingItems = await DB.getPendingItems();
    renderTasks();
  }

  // 데이터가 바뀐 뒤 두 화면을 모두 다시 그림
  // (먼저 반복 규칙에 따라 필요한 회차를 만들어 둠)
  async function reloadAll() {
    await DB.syncRecurrences(todayStr);
    await Promise.all([loadToday(), loadTasks(), loadCalendar(), loadTracker()]);
  }

  // 완료 / 완료 취소. 실제 완료일은 오늘 날짜로 자동 기록 (수정창에서 변경 가능)
  async function setDone(item, makeDone, withUndo) {
    if (busy) return;
    busy = true;
    try {
      await DB.setOccurrenceDone(item.occurrence.id, makeDone, todayStr);
      await reloadAll();
      if (withUndo && makeDone) {
        showToast('완료했어요', '되돌리기', () => setDone(item, false, false));
      }
    } catch (err) {
      showError('완료 상태를 저장하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  function toggleDoneList() {
    doneExpanded = !doneExpanded;
    renderToday();
  }

  // ---------- 전체 할 일 화면 그리기 ----------
  function renderTasks() {
    const row = (it) => createTaskItem(it, true);
    const list = pendingItems.filter((it) =>
      tasksFilter === 'all' || it.task.categoryId === tasksFilter);

    const overdue = list
      .filter((it) => it.occurrence.scheduledDate && it.occurrence.scheduledDate < todayStr)
      .sort(byDateTime);
    const upcoming = list
      .filter((it) => it.occurrence.scheduledDate && it.occurrence.scheduledDate >= todayStr)
      .sort(byDateTime);
    const nodate = list
      .filter((it) => !it.occurrence.scheduledDate)
      .sort(byCreated);

    [['overdue', overdue], ['upcoming', upcoming], ['nodate', nodate]].forEach(([key, items]) => {
      fillList($('list-' + key), items.map(row));
      $('empty-' + key).hidden = items.length > 0;
      $('count-' + key).textContent = items.length ? String(items.length) : '';
    });
  }

  // ---------- 달력 화면 ----------
  const pad2 = (n) => String(n).padStart(2, '0');

  function calRange() {
    const last = new Date(calYear, calMonth, 0).getDate();
    const prefix = calYear + '-' + pad2(calMonth) + '-';
    return { start: prefix + '01', end: prefix + pad2(last), last: last };
  }

  // '10월 12일' (요일 없이 짧게)
  function formatMD(str) {
    const p = str.split('-').map(Number);
    return p[1] + '월 ' + p[2] + '일';
  }

  async function loadCalendar() {
    const r = calRange();
    calData = await DB.getCalendarData(r.start, r.end);
    renderCalendar();
  }

  // 예정일 기준 반복 규칙으로 계산한 '앞으로 생길 회차' (저장하지 않음, 보여 주기만)
  // 완료일 기준 반복은 다음 날짜를 미리 알 수 없으므로 이미 만들어진 회차만 표시됨
  function calProjections(start, end) {
    const list = [];
    calData.rules.forEach((rule) => {
      if (rule.basis !== 'scheduled' || !DB.FREQUENCIES[rule.frequency]) return;
      const task = calData.tasksById[rule.taskId];
      if (!task) return;
      for (let k = rule.nextIndex, n = 0; n < 400; k++, n++) {
        const d = DB.nthDate(rule.anchorDate, rule.frequency, k, rule.anchorDay);
        if (d > end) break;
        if (d >= start && d > todayStr) {
          list.push({ date: d, title: task.title, time: rule.time, projection: true });
        }
      }
    });
    return list;
  }

  function dotClass(occ) {
    if (occ.status === 'done') return 'dot-done';
    if (occ.status === 'skipped') return 'dot-skip';
    return occ.scheduledDate < todayStr ? 'dot-overdue' : 'dot-pending';
  }

  function renderCalendar() {
    const r = calRange();
    $('cal-title').textContent = calYear + '년 ' + calMonth + '월';

    // 날짜별로 묶기 (예정일 기준)
    const byDate = {};
    calData.items.forEach((it) => {
      const d = it.occurrence.scheduledDate;
      if (d && d >= r.start && d <= r.end) (byDate[d] = byDate[d] || []).push(it);
    });
    const projByDate = {};
    calProjections(r.start, r.end).forEach((p) => {
      (projByDate[p.date] = projByDate[p.date] || []).push(p);
    });

    // 달력 칸 (월요일 시작)
    const grid = $('cal-grid');
    grid.innerHTML = '';
    const firstDow = new Date(calYear, calMonth - 1, 1).getDay();   // 0=일
    const blanks = (firstDow + 6) % 7;
    for (let i = 0; i < blanks; i++) {
      const b = document.createElement('div');
      b.className = 'cal-blank';
      grid.appendChild(b);
    }
    for (let day = 1; day <= r.last; day++) {
      const dateStr = calYear + '-' + pad2(calMonth) + '-' + pad2(day);
      const dow = new Date(calYear, calMonth - 1, day).getDay();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cal-day' +
        (dow === 6 ? ' sat' : '') + (dow === 0 ? ' sun' : '') +
        (dateStr === todayStr ? ' today' : '') +
        (dateStr === calSelected ? ' selected' : '');

      const num = document.createElement('span');
      num.className = 'cal-num';
      num.textContent = String(day);
      btn.appendChild(num);

      const dots = document.createElement('span');
      dots.className = 'cal-dots';
      const classes = (byDate[dateStr] || []).map((it) => dotClass(it.occurrence))
        .concat((projByDate[dateStr] || []).map(() => 'dot-proj'));
      classes.slice(0, 4).forEach((c) => {
        const dot = document.createElement('i');
        dot.className = 'dot ' + c;
        dots.appendChild(dot);
      });
      if (classes.length > 4) dots.appendChild(document.createTextNode('+'));
      btn.appendChild(dots);

      const count = classes.length;
      btn.setAttribute('aria-label', calMonth + '월 ' + day + '일' + (count ? ', 할 일 ' + count + '개' : ''));
      btn.addEventListener('click', () => {
        calSelected = dateStr;
        renderCalendar();
      });
      grid.appendChild(btn);
    }

    renderCalendarDay(byDate[calSelected] || [], projByDate[calSelected] || []);
  }

  // 선택한 날의 목록: 이날 예정된 할 일 + 이날 완료한 다른 날의 할 일
  function renderCalendarDay(items, projections) {
    $('cal-day-title').textContent = '🗓️ ' + formatShortDate(calSelected);

    const sorted = items.slice().sort((a, b) => byTime(a, b) || byCreated(a, b));
    const rows = sorted.map((it) => calRow(it, null));
    projections
      .slice()
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'))
      .forEach((p) => rows.push(calRow(null, p)));
    fillList($('cal-day-list'), rows);
    $('cal-day-empty').hidden = rows.length > 0;

    const doneElsewhere = calData.items.filter((it) =>
      it.occurrence.status === 'done' &&
      it.occurrence.completedDate === calSelected &&
      it.occurrence.scheduledDate !== calSelected);
    fillList($('cal-done-list'), doneElsewhere.sort(byCreated).map((it) => calRow(it, null, true)));
    $('cal-done-section').hidden = doneElsewhere.length === 0;
  }

  // 달력 목록 한 줄 (완료 체크 버튼 없음. 실제 할 일은 누르면 수정창)
  function calRow(item, proj, elsewhere) {
    const li = document.createElement('li');
    const occ = item ? item.occurrence : null;
    li.className = 'cal-row' +
      (occ && occ.status === 'done' && !elsewhere ? ' is-done' : '') +
      (proj ? ' is-proj' : '');

    const time = proj ? proj.time : occ.time;
    if (time) {
      const t = document.createElement('span');
      t.className = 'task-time';
      t.textContent = time;
      li.appendChild(t);
    }

    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = proj ? proj.title : item.task.title;
    li.appendChild(title);

    let badgeText = '';
    let badgeClass = '';
    if (proj) {
      badgeText = '반복 예정';
      badgeClass = 'badge-proj';
    } else if (elsewhere) {
      badgeText = occ.scheduledDate ? '예정 ' + formatMD(occ.scheduledDate) : '날짜 없던 일';
      badgeClass = 'badge-done';
    } else if (occ.status === 'done') {
      badgeText = occ.completedDate && occ.completedDate !== occ.scheduledDate
        ? formatMD(occ.completedDate) + ' 완료' : '완료';
      badgeClass = 'badge-done';
    } else if (occ.status === 'skipped') {
      badgeText = '건너뜀';
    } else if (occ.scheduledDate < todayStr) {
      badgeText = '기한 지남';
      badgeClass = 'badge-overdue';
    }
    if (badgeText) {
      const badge = document.createElement('span');
      badge.className = 'badge ' + badgeClass;
      badge.textContent = badgeText;
      li.appendChild(badge);
    }

    if (proj) {
      li.addEventListener('click', () =>
        showToast('반복 규칙으로 계산한 예정 회차예요. 날짜가 다가오면 할 일로 생겨요'));
    } else {
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      li.addEventListener('click', () => openEdit(occ.id));
    }
    return li;
  }

  function moveCalendarMonth(delta) {
    const d = new Date(calYear, calMonth - 1 + delta, 1);
    calYear = d.getFullYear();
    calMonth = d.getMonth() + 1;
    const thisMonth = todayStr.slice(0, 7) === calYear + '-' + pad2(calMonth);
    calSelected = thisMonth ? todayStr : calYear + '-' + pad2(calMonth) + '-01';
    loadCalendar().catch((err) => showError('달력을 불러오지 못했어요.', err));
  }

  function goCalendarToday() {
    const t = todayStr.split('-').map(Number);
    calYear = t[0];
    calMonth = t[1];
    calSelected = todayStr;
    loadCalendar().catch((err) => showError('달력을 불러오지 못했어요.', err));
  }

  // ---------- 트래커 화면 ----------
  // 트래커 기록은 할 일과 별개. 할 일이 바뀌어도 트래커는 바뀌지 않고, 그 반대도 마찬가지

  async function loadTracker() {
    const results = await Promise.all([
      DB.getWeeklyGoals(trackerWeek),
      DB.getHabits(),
      DB.getHabitLogs(trackerWeek)
    ]);
    weeklyGoals = results[0];
    habits = results[1];
    habitLogMap = {};
    results[2].forEach((log) => { habitLogMap[log.id] = log.state; });
    renderTracker();
  }

  function renderTracker() {
    renderWeekNav();
    renderGoals();
    renderHabits();
  }

  function renderWeekNav() {
    const thisWeek = DB.weekStartOf(todayStr);
    const a = trackerWeek.split('-').map(Number);
    const b = thisWeek.split('-').map(Number);
    const diff = Math.round((new Date(a[0], a[1] - 1, a[2]) - new Date(b[0], b[1] - 1, b[2])) / (7 * 86400000));
    let title;
    if (diff === 0) title = '이번 주';
    else if (diff === -1) title = '지난주';
    else if (diff === 1) title = '다음 주';
    else title = diff < 0 ? (-diff) + '주 전' : diff + '주 후';
    $('week-title').textContent = title;
    $('week-range').textContent =
      formatShortDate(trackerWeek) + ' ~ ' + formatShortDate(DB.addDays(trackerWeek, 6));
    $('week-this').hidden = diff === 0;
  }

  function moveTrackerWeek(deltaWeeks) {
    trackerWeek = deltaWeeks === 0
      ? DB.weekStartOf(todayStr)
      : DB.addDays(trackerWeek, deltaWeeks * 7);
    loadTracker().catch((err) => showError('트래커를 불러오지 못했어요.', err));
  }

  // ----- 주간 목표 -----
  function renderGoals() {
    const list = $('goal-list');
    list.innerHTML = '';
    weeklyGoals.forEach((goal) => {
      const li = document.createElement('li');
      li.className = 'goal-item';

      const mark = document.createElement('span');
      mark.className = 'goal-mark';
      mark.textContent = '🎯';
      mark.setAttribute('aria-hidden', 'true');

      const text = document.createElement('span');
      text.className = 'goal-text';
      text.textContent = goal.text;
      text.setAttribute('role', 'button');
      text.tabIndex = 0;
      text.addEventListener('click', () => startEditGoal(li, goal));
      text.addEventListener('keydown', (e) => { if (e.key === 'Enter') startEditGoal(li, goal); });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      del.setAttribute('aria-label', '목표 삭제');
      del.textContent = '✕';
      del.addEventListener('click', () => deleteGoal(goal));

      li.appendChild(mark);
      li.appendChild(text);
      li.appendChild(del);
      list.appendChild(li);
    });
    $('goal-empty').hidden = weeklyGoals.length > 0;
  }

  // 목표 글자를 누르면 그 자리에서 고칠 수 있는 입력칸으로 바뀜
  function startEditGoal(li, goal) {
    if (busy) return;
    const textEl = li.querySelector('.goal-text');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sheet-input goal-edit';
    input.value = goal.text;
    input.maxLength = 100;
    input.setAttribute('enterkeyhint', 'done');
    li.replaceChild(input, textEl);
    input.focus();

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      if (!save || !value || value === goal.text) {
        renderGoals();                 // 변경 없음 또는 취소 (빈 칸이면 원래대로)
        return;
      }
      busy = true;
      try {
        await DB.updateWeeklyGoal(goal.id, value);
        await loadTracker();
      } catch (err) {
        showError('목표를 저장하지 못했어요.', err);
        renderGoals();
      } finally {
        busy = false;
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function addGoal(event) {
    event.preventDefault();
    if (busy) return;
    const input = $('goal-add-input');
    const text = input.value.trim();
    if (!text) { shake(input); return; }
    busy = true;
    try {
      await DB.addWeeklyGoal(trackerWeek, text);
      input.value = '';
      await loadTracker();
    } catch (err) {
      showError('목표를 저장하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  async function deleteGoal(goal) {
    if (busy) return;
    if (!confirm('\'' + goal.text + '\' 목표를 삭제할까요?')) return;
    busy = true;
    try {
      await DB.deleteWeeklyGoal(goal.id);
      await loadTracker();
    } catch (err) {
      showError('목표를 삭제하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  // ----- 주간 습관 -----
  const HABIT_NEXT = { none: 'done', done: 'not_done', not_done: 'none' };   // 누를 때마다 바뀌는 순서
  const HABIT_LABEL = { none: '미기록', done: '실천함', not_done: '실천하지 않음' };

  // 이 주에 표에 보일 습관: 시작한 주 이후이고, 보관한 주 이전
  function habitsForWeek(week) {
    return habits.filter((h) =>
      (h.startWeek || '') <= week && (!h.archivedWeek || week < h.archivedWeek));
  }

  function renderHabits() {
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => DB.addDays(trackerWeek, i));
    const visible = habitsForWeek(trackerWeek);
    const table = $('habit-table');
    table.innerHTML = '';

    if (visible.length) {
      // 머리줄: 요일 + 날짜
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      hr.appendChild(document.createElement('th'));
      days.forEach((d, i) => {
        const th = document.createElement('th');
        th.className = 'habit-day' + (d === todayStr ? ' is-today' : '') +
          (i === 5 ? ' sat' : '') + (i === 6 ? ' sun' : '');
        const wd = document.createElement('span');
        wd.textContent = '월화수목금토일'[i];
        const dn = document.createElement('small');
        dn.textContent = String(Number(d.slice(8)));
        th.appendChild(wd);
        th.appendChild(dn);
        hr.appendChild(th);
      });
      const cth = document.createElement('th');
      cth.className = 'habit-count-h';
      cth.textContent = '실천';
      hr.appendChild(cth);
      thead.appendChild(hr);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      visible.forEach((habit) => tbody.appendChild(habitRow(habit, days)));
      table.appendChild(tbody);
    }
    $('habit-empty').hidden = visible.length > 0;
    $('habit-help').hidden = visible.length === 0;

    // 보관한 습관 목록
    const archived = habits.filter((h) => h.archivedWeek);
    $('habit-archived').hidden = archived.length === 0;
    $('habit-archived-count').textContent = String(archived.length);
    $('habit-archived-toggle').setAttribute('aria-expanded', String(habitArchivedOpen));
    const alist = $('habit-archived-list');
    alist.hidden = !habitArchivedOpen;
    alist.innerHTML = '';
    archived.forEach((habit) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'archived-name';
      name.textContent = habit.name;
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn btn-soft archived-btn';
      restore.textContent = '보관 해제';
      restore.addEventListener('click', () => setHabitArchived(habit, false));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-danger archived-btn';
      del.textContent = '삭제';
      del.addEventListener('click', () => deleteHabitFully(habit));
      li.appendChild(name);
      li.appendChild(restore);
      li.appendChild(del);
      alist.appendChild(li);
    });
  }

  function habitRow(habit, days) {
    const tr = document.createElement('tr');

    const nameCell = document.createElement('th');
    nameCell.scope = 'row';
    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'habit-name';
    nameBtn.textContent = habit.name;
    nameBtn.addEventListener('click', () => openTrackerSheet('habit', habit));
    nameCell.appendChild(nameBtn);
    tr.appendChild(nameCell);

    let doneCount = 0;
    days.forEach((d) => {
      const state = habitLogMap[habit.id + '|' + d] || 'none';
      if (state === 'done') doneCount++;
      const td = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hcell hcell-' + state;
      btn.textContent = state === 'done' ? '✓' : state === 'not_done' ? '✕' : '';
      btn.disabled = d > todayStr;                    // 미래 날짜는 기록 불가
      btn.setAttribute('aria-label',
        habit.name + ' ' + formatShortDate(d) + ' ' + HABIT_LABEL[state]);
      btn.addEventListener('click', () => cycleHabit(habit, d));
      td.appendChild(btn);
      tr.appendChild(td);
    });

    const countCell = document.createElement('td');
    countCell.className = 'habit-count';
    countCell.textContent = doneCount + '회';
    tr.appendChild(countCell);
    return tr;
  }

  // 칸 누르기: 화면을 먼저 바꾸고, 저장은 순서대로 진행 (실패하면 저장소 상태로 되돌림)
  function cycleHabit(habit, date) {
    const key = habit.id + '|' + date;
    const next = HABIT_NEXT[habitLogMap[key] || 'none'];
    if (next === 'none') delete habitLogMap[key];
    else habitLogMap[key] = next;
    renderHabits();

    saveQueue = saveQueue
      .then(() => DB.setHabitLog(habit.id, date, next === 'none' ? null : next))
      .catch((err) => {
        showError('습관 기록을 저장하지 못했어요.', err);
        return loadTracker().catch(() => {});
      });
  }

  async function addHabit(event) {
    event.preventDefault();
    if (busy) return;
    const input = $('habit-add-input');
    const name = input.value.trim();
    if (!name) { shake(input); return; }
    // 지난 주를 보면서 추가하면 그 주부터, 그 외에는 이번 주부터 표시
    const thisWeek = DB.weekStartOf(todayStr);
    const startWeek = trackerWeek < thisWeek ? trackerWeek : thisWeek;
    busy = true;
    try {
      await DB.addHabit(name, startWeek);
      input.value = '';
      await loadTracker();
    } catch (err) {
      showError('습관을 저장하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  // 보관: 이번 주부터 표에서 사라짐. 지난 주의 표와 기록은 그대로
  async function setHabitArchived(habit, archive) {
    if (busy) return;
    busy = true;
    try {
      await DB.updateHabit(habit.id, { archivedWeek: archive ? DB.weekStartOf(todayStr) : null });
      closeSheet();
      await loadTracker();
      showToast(archive ? '\'' + habit.name + '\'을(를) 보관했어요' : '보관을 해제했어요');
    } catch (err) {
      showError('저장하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  // 완전 삭제: 기록 개수를 알리고 확인받음
  async function deleteHabitFully(habit) {
    if (busy) return;
    try {
      const count = await DB.countHabitLogs(habit.id);
      let msg = '\'' + habit.name + '\' 습관을 완전히 삭제할까요?';
      if (count > 0) msg += '\n\n기록 ' + count + '개도 함께 삭제되며 되돌릴 수 없어요.';
      msg += '\n\n기록을 남기고 표에서만 빼려면 \'보관\'을 사용하세요.';
      if (!confirm(msg)) return;
      busy = true;
      await DB.deleteHabit(habit.id);
      closeSheet();
      await loadTracker();
      showToast('삭제했어요');
    } catch (err) {
      showError('삭제하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  // ----- 트래커 항목 수정창 (습관용, 이후 미션·루틴도 함께 사용) -----
  function openTrackerSheet(kind, item) {
    trackerEditing = { kind: kind, item: item };
    const isArchived = !!item.archivedWeek;
    $('tracker-sheet-title').textContent = '습관 수정';
    $('tracker-name').value = item.name;
    $('tracker-archive').textContent = isArchived ? '보관 해제' : '보관';
    $('tracker-sheet-hint').textContent = isArchived
      ? '보관 중인 습관이에요'
      : '보관하면 이번 주부터 표에서 사라지고, 지난 기록은 그대로 남아요';
    hideToast();
    $('sheet-backdrop').classList.add('open');
    $('tracker-sheet').classList.add('open');
  }

  async function submitTrackerSheet(event) {
    event.preventDefault();
    if (busy || !trackerEditing) return;
    const input = $('tracker-name');
    const name = input.value.trim();
    if (!name) { shake(input); return; }
    const item = trackerEditing.item;
    if (name === item.name) { closeSheet(); return; }
    busy = true;
    try {
      // 이름을 바꾸면 지난 주의 표에도 새 이름으로 보임 (기록은 그대로)
      await DB.updateHabit(item.id, { name: name });
      closeSheet();
      await loadTracker();
    } catch (err) {
      showError('저장하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  function renderFilterChips() {
    const wrap = $('category-filter');
    wrap.innerHTML = '';
    [{ id: 'all', name: '전체' }].concat(categories).forEach((cat) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip' + (tasksFilter === cat.id ? ' active' : '');
      btn.textContent = cat.name;
      btn.setAttribute('aria-pressed', String(tasksFilter === cat.id));
      btn.addEventListener('click', () => {
        tasksFilter = cat.id;
        renderFilterChips();
        renderTasks();
      });
      wrap.appendChild(btn);
    });
  }

  // ---------- 빠른 추가 입력창 ----------
  function openSheet() {
    const input = $('quick-add-input');
    input.value = '';
    hideToast();
    $('sheet-backdrop').classList.add('open');
    $('quick-add-sheet').classList.add('open');
    // 입력창이 보이기 시작한 뒤에 커서를 넣어야 키보드가 안정적으로 열림
    setTimeout(() => input.focus(), 60);
  }

  // 열려 있는 입력창(빠른 추가·수정)을 모두 닫음. 취소하면 저장하지 않음
  function closeSheet() {
    const input = $('quick-add-input');
    input.value = '';
    if (document.activeElement) document.activeElement.blur();
    $('sheet-backdrop').classList.remove('open');
    $('quick-add-sheet').classList.remove('open');
    $('edit-sheet').classList.remove('open');
    $('tracker-sheet').classList.remove('open');
    editing = null;
    trackerEditing = null;
  }

  function isSheetOpen() {
    return $('quick-add-sheet').classList.contains('open') ||
      $('edit-sheet').classList.contains('open') ||
      $('tracker-sheet').classList.contains('open');
  }

  // '+' 버튼: 오늘 화면은 빠른 추가, 전체 할 일 화면은 상세 추가
  function onFabClick() {
    if (currentScreen === 'tasks') openNew();
    else openSheet();
  }

  // ---------- 추가·수정 입력창 ----------
  function fillCategorySelect(selectedId) {
    const sel = $('edit-category');
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '없음';
    sel.appendChild(none);
    categories.forEach((cat) => {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.name;
      sel.appendChild(opt);
    });
    sel.value = selectedId || '';
  }

  // 날짜가 없으면 시간을 넣을 수 없게 하고, 날짜 관련 안내를 표시
  function updateDateFields() {
    const hasDate = !!$('edit-date').value;
    const timeInput = $('edit-time');
    if (!hasDate) timeInput.value = '';
    timeInput.disabled = !hasDate;
    document.querySelector('[data-clear="edit-date"]').disabled = !hasDate;
    document.querySelector('[data-clear="edit-time"]').disabled = !timeInput.value;

    const hints = [];
    const occ = editing && editing.mode === 'edit' ? editing.item.occurrence : null;
    if (occ && occ.originalDate) {
      const dateChanged = $('edit-date').value !== (occ.scheduledDate || '');
      if (occ.originalDate !== occ.scheduledDate) {
        // 이미 미룬 적이 있는 회차
        hints.push('원래 예정일: ' + formatShortDate(occ.originalDate));
      } else if (dateChanged && !DB.isDateCorrection(occ, todayStr)) {
        // 이번에 바꾸면 '미룸'으로 기록됨
        hints.push('원래 예정일(' + formatShortDate(occ.originalDate) + ')이 기록으로 남아요');
      }
    }
    if (!hasDate) hints.push('날짜를 비우면 \'날짜 없는 할 일\'로 저장돼요');
    $('edit-date-hint').textContent = hints.join(' · ');

    updateRepeatFields();   // 날짜·시간에 따라 반복 안내도 바뀜
  }

  // ---------- 반복 설정 ----------
  function getBasis() {
    const checked = document.querySelector('input[name="edit-basis"]:checked');
    return checked ? checked.value : 'scheduled';
  }

  function setBasis(value) {
    document.querySelectorAll('input[name="edit-basis"]').forEach((r) => {
      r.checked = r.value === value;
    });
  }

  // 수정창에서 고른 반복: { frequency, basis } 또는 null(반복 안 함)
  function readRepeat() {
    const f = $('edit-repeat').value;
    return f ? { frequency: f, basis: getBasis() } : null;
  }

  // 지금 진행 중인 반복 규칙과 달라졌는지 (수정 모드에서만)
  function isRepeatChanged() {
    if (!editing || editing.mode !== 'edit') return false;
    const rule = editing.item.rule;
    const now = readRepeat();
    if (!rule && !now) return false;
    if (!rule || !now) return true;
    return rule.frequency !== now.frequency || rule.basis !== now.basis;
  }

  // 반복 규칙을 사람이 읽기 쉬운 문장으로
  function describeRepeat(repeat, anchorDate) {
    const f = DB.FREQUENCIES[repeat.frequency];
    if (repeat.basis === 'completed') {
      return '완료한 날로부터 ' + f.unit + ' 뒤에 다음 회차가 생겨요';
    }
    const p = anchorDate.split('-').map(Number);
    const wd = '일월화수목금토'[new Date(p[0], p[1] - 1, p[2]).getDay()];
    let text;
    switch (repeat.frequency) {
      case 'daily':    text = '매일'; break;
      case 'weekly':   text = '매주 ' + wd + '요일'; break;
      case 'biweekly': text = '2주마다 ' + wd + '요일'; break;
      case 'yearly':   text = '매년 ' + p[1] + '월 ' + p[2] + '일'; break;
      default:         text = f.label + ' ' + p[2] + '일';
    }
    const mayNotExist = repeat.frequency === 'yearly'
      ? (p[1] === 2 && p[2] === 29)
      : (!f.days && p[2] >= 29);
    if (mayNotExist) text += ' (그 날짜가 없는 달은 마지막 날)';
    return text + ' 반복';
  }

  // 반복 관련 칸·안내·버튼 표시 갱신
  function updateRepeatFields() {
    const isEdit = !!(editing && editing.mode === 'edit');
    const occ = isEdit ? editing.item.occurrence : null;
    const rule = isEdit ? editing.item.rule : null;
    const locked = isEdit && occ.status !== 'pending';
    const repeat = readRepeat();
    const changed = isRepeatChanged();

    $('edit-repeat').disabled = locked;
    document.querySelectorAll('input[name="edit-basis"]').forEach((r) => { r.disabled = locked; });
    $('basis-field').hidden = !repeat;

    let hint = '';
    if (locked) {
      hint = rule ? describeRepeat(rule, rule.anchorDate) + ' · 완료하거나 건너뛴 회차에서는 반복 설정을 바꿀 수 없어요' : '';
    } else if (repeat) {
      const date = $('edit-date').value;
      if (rule && !changed) hint = describeRepeat(rule, rule.anchorDate);
      else if (!date) hint = '반복하려면 날짜를 정해 주세요';
      else {
        hint = describeRepeat(repeat, date);
        if (rule) hint += ' · 저장하면 이 회차부터 새 규칙이 적용돼요 (지난 기록은 그대로)';
      }
    } else if (rule) {
      hint = '저장하면 반복이 중단돼요 (지난 기록과 남은 회차는 그대로)';
    }
    $('edit-repeat-hint').textContent = hint;

    // 건너뛰기: 반복으로 생긴 미완료 회차 / 중단: 진행 중인 규칙이 있을 때
    const canSkip = isEdit && occ.status === 'pending' && !!occ.ruleId;
    const canStop = isEdit && !!rule && !changed;
    $('edit-skip').hidden = !canSkip;
    $('edit-stop').hidden = !canStop;
    $('occ-actions').hidden = !(canSkip || canStop);

    // 시간 적용 체크: 진행 중인 규칙의 미완료 회차에서 시간을 바꿨을 때만 보임
    const showApply = isEdit && !!rule && occ.ruleId === rule.id &&
      occ.status === 'pending' && !changed &&
      ($('edit-time').value || '') !== (rule.time || '');
    $('time-apply-line').hidden = !showApply;
    if (!showApply) $('edit-time-apply').checked = false;
  }

  function openEditSheet() {
    hideToast();
    $('sheet-backdrop').classList.add('open');
    $('edit-sheet').classList.add('open');
    $('edit-sheet').scrollTop = 0;
  }

  // 새 할 일 (전체 할 일 화면의 '+')
  function openNew() {
    editing = { mode: 'new' };
    $('edit-heading').textContent = '할 일 추가';
    $('edit-title').value = '';
    fillCategorySelect(tasksFilter !== 'all' ? tasksFilter : '');   // 필터 중이면 그 카테고리로
    $('edit-date').value = '';
    $('edit-time').value = '';
    $('edit-memo').value = '';
    $('edit-repeat').value = '';
    setBasis('scheduled');
    $('edit-time-apply').checked = false;
    $('edit-completed-field').hidden = true;
    $('edit-delete').hidden = true;
    updateDateFields();
    openEditSheet();
    setTimeout(() => $('edit-title').focus(), 60);
  }

  // 기존 할 일 수정 (항상 저장소에서 최신 값을 다시 읽어 옴)
  async function openEdit(occurrenceId) {
    if (busy) return;
    try {
      const item = await DB.getItem(occurrenceId);
      if (!item) {
        showError('할 일을 찾을 수 없어요. 목록을 새로 고칠게요.');
        await reloadAll();
        return;
      }
      const occ = item.occurrence;
      editing = { mode: 'edit', item: item };
      $('edit-heading').textContent = '할 일 수정';
      $('edit-title').value = item.task.title;
      fillCategorySelect(item.task.categoryId);
      $('edit-date').value = occ.scheduledDate || '';
      $('edit-time').value = occ.time || '';
      $('edit-memo').value = item.task.memo || '';
      $('edit-repeat').value = item.rule ? item.rule.frequency : '';
      setBasis(item.rule ? item.rule.basis : 'scheduled');
      $('edit-time-apply').checked = false;

      const isDone = occ.status === 'done';
      $('edit-completed-field').hidden = !isDone;
      $('edit-completed').value = isDone ? (occ.completedDate || todayStr) : '';
      $('edit-completed').max = todayStr;

      $('edit-delete').hidden = false;
      updateDateFields();
      openEditSheet();
    } catch (err) {
      showError('할 일을 불러오지 못했어요.', err);
    }
  }

  async function submitEdit(event) {
    event.preventDefault();
    if (busy || !editing) return;

    const titleInput = $('edit-title');
    const title = titleInput.value.trim();
    if (!title) { shake(titleInput); return; }

    const fields = {
      title: title,
      categoryId: $('edit-category').value || null,
      memo: $('edit-memo').value.trim(),
      date: $('edit-date').value || null,
      time: $('edit-time').value || null
    };

    if (editing.mode === 'edit' && editing.item.occurrence.status === 'done') {
      const completedInput = $('edit-completed');
      const completed = completedInput.value;
      if (!completed) { shake(completedInput); return; }
      if (completed > todayStr) {
        alert('실제 완료일은 오늘 이후 날짜로 정할 수 없어요.');
        return;
      }
      fields.completedDate = completed;
    }

    // 반복: 새로 반복을 정하거나 바꿀 때는 날짜가 꼭 필요함
    const repeat = readRepeat();
    const repeatChanged = editing.mode === 'new' ? !!repeat : isRepeatChanged();
    if (repeat && repeatChanged && !fields.date) {
      $('edit-repeat-hint').textContent = '반복하려면 날짜를 정해 주세요';
      shake($('edit-date'));
      return;
    }
    fields.repeat = repeat;
    fields.repeatChanged = repeatChanged;
    fields.applyTimeToRule = !$('time-apply-line').hidden && $('edit-time-apply').checked;

    busy = true;
    try {
      if (editing.mode === 'new') await DB.addTask(fields);
      else await DB.updateItem(editing.item.occurrence.id, fields);
      closeSheet();
      await reloadAll();
    } catch (err) {
      // 실패하면 창을 닫지 않음 (입력한 내용 유지, 다시 시도 가능)
      showError('저장하지 못했어요. 다시 시도해 주세요.', err);
    } finally {
      busy = false;
    }
  }

  // 삭제: 완료 기록이 있으면 개수를 알리고 확인받음
  async function deleteEditing() {
    if (busy || !editing || editing.mode !== 'edit') return;
    const task = editing.item.task;
    const recurring = !!editing.item.rule || !!editing.item.occurrence.ruleId;
    try {
      const counts = await DB.countOccurrences(task.id);
      let msg = '\'' + task.title + '\'을(를) 삭제할까요?\n';
      if (recurring || counts.total > 1) {
        msg += '\n이 할 일의 모든 회차(' + counts.total + '개)가 삭제돼요.';
      }
      if (counts.done > 0) {
        msg += '\n완료 기록 ' + counts.done + '개도 함께 삭제되며 되돌릴 수 없어요.';
      }
      if (editing.item.rule) {
        msg += '\n\n반복만 멈추려면 \'반복 중단\'을 사용하세요.';
      }
      if (!confirm(msg.trim())) return;

      busy = true;
      await DB.deleteTask(task.id);
      closeSheet();
      await reloadAll();
      showToast('삭제했어요');
    } catch (err) {
      showError('삭제하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  // 이번 회차 건너뛰기 (기록은 '건너뜀'으로 남고, 다른 회차는 그대로)
  async function skipEditing() {
    if (busy || !editing || editing.mode !== 'edit') return;
    const item = editing.item;
    busy = true;
    try {
      await DB.setOccurrenceSkipped(item.occurrence.id, true, todayStr);
      closeSheet();
      await reloadAll();
      showToast('이번 회차를 건너뛰었어요', '되돌리기', () => undoSkip(item));
    } catch (err) {
      showError('건너뛰지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  async function undoSkip(item) {
    if (busy) return;
    busy = true;
    try {
      await DB.setOccurrenceSkipped(item.occurrence.id, false, null);
      await reloadAll();
    } catch (err) {
      showError('되돌리지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  // 반복 중단: 앞으로 새 회차만 안 생김. 지난 기록과 남은 미완료 회차는 유지
  async function stopEditing() {
    if (busy || !editing || editing.mode !== 'edit' || !editing.item.rule) return;
    const ruleId = editing.item.rule.id;
    const ok = confirm('반복을 중단할까요?\n\n지난 기록과 이미 생긴 미완료 회차는 그대로 남고, ' +
      '앞으로 새 회차만 생기지 않아요.');
    if (!ok) return;
    busy = true;
    try {
      await DB.stopRule(ruleId);
      closeSheet();
      await reloadAll();
      showToast('반복을 중단했어요');
    } catch (err) {
      showError('반복을 중단하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  async function submitQuickAdd(event) {
    event.preventDefault();   // 폼 제출로 페이지가 새로고침되는 것을 막음
    if (busy) return;
    const input = $('quick-add-input');
    const title = input.value.trim();

    if (!title) {
      input.classList.remove('shake');
      void input.offsetWidth;          // 애니메이션 다시 시작
      input.classList.add('shake');
      input.focus();
      return;
    }

    busy = true;
    try {
      await DB.addQuickTask(title, todayStr);
      closeSheet();
      await reloadAll();
    } catch (err) {
      // 저장 실패 시 입력한 글자는 지우지 않고 창을 열어 둠 (다시 시도 가능)
      showError('할 일을 저장하지 못했어요. 다시 시도해 주세요.', err);
    } finally {
      busy = false;
    }
  }

  // 앱을 켜 둔 채 자정이 지나면 날짜와 목록을 새로 고침
  function refreshIfDateChanged() {
    const now = DB.toDateStr();
    if (now !== todayStr) {
      todayStr = now;
      renderDate();
      reloadAll().catch((err) => showError('목록을 불러오지 못했어요.', err));
    }
  }

  // ---------- 시작 ----------
  async function init() {
    $('app-version').textContent = APP_VERSION;
    renderDate();
    renderToday();          // 데이터를 불러오기 전에 빈 화면부터 표시
    showScreen('today');

    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => showScreen(btn.dataset.target));
    });

    $('fab-add').addEventListener('click', onFabClick);
    $('quick-add-cancel').addEventListener('click', closeSheet);
    $('sheet-backdrop').addEventListener('click', closeSheet);
    $('quick-add-sheet').addEventListener('submit', submitQuickAdd);
    $('done-toggle').addEventListener('click', toggleDoneList);

    // 트래커
    $('week-prev').addEventListener('click', () => moveTrackerWeek(-1));
    $('week-next').addEventListener('click', () => moveTrackerWeek(1));
    $('week-this').addEventListener('click', () => moveTrackerWeek(0));
    $('goal-add-form').addEventListener('submit', addGoal);
    $('habit-add-form').addEventListener('submit', addHabit);
    $('habit-archived-toggle').addEventListener('click', () => {
      habitArchivedOpen = !habitArchivedOpen;
      renderHabits();
    });
    $('tracker-sheet').addEventListener('submit', submitTrackerSheet);
    $('tracker-cancel').addEventListener('click', closeSheet);
    $('tracker-archive').addEventListener('click', () => {
      if (trackerEditing) {
        const item = trackerEditing.item;
        setHabitArchived(item, !item.archivedWeek);
      }
    });
    $('tracker-delete').addEventListener('click', () => {
      if (trackerEditing) deleteHabitFully(trackerEditing.item);
    });

    // 달력
    $('cal-prev').addEventListener('click', () => moveCalendarMonth(-1));
    $('cal-next').addEventListener('click', () => moveCalendarMonth(1));
    $('cal-today').addEventListener('click', goCalendarToday);

    // 수정창
    $('edit-sheet').addEventListener('submit', submitEdit);
    $('edit-cancel').addEventListener('click', closeSheet);
    $('edit-delete').addEventListener('click', deleteEditing);
    $('edit-date').addEventListener('change', updateDateFields);
    $('edit-date').addEventListener('input', updateDateFields);
    $('edit-time').addEventListener('change', updateDateFields);
    $('edit-time').addEventListener('input', updateDateFields);
    $('edit-repeat').addEventListener('change', updateRepeatFields);
    document.querySelectorAll('input[name="edit-basis"]').forEach((r) => {
      r.addEventListener('change', updateRepeatFields);
    });
    $('edit-skip').addEventListener('click', skipEditing);
    $('edit-stop').addEventListener('click', stopEditing);
    document.querySelectorAll('.clear-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $(btn.dataset.clear).value = '';
        updateDateFields();
      });
    });

    // 흔들기 애니메이션이 끝나면 표시 제거
    document.addEventListener('animationend', (e) => {
      if (e.target.classList) e.target.classList.remove('shake');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isSheetOpen()) closeSheet();
    });

    // 다른 앱을 보다가 돌아왔을 때 날짜가 바뀌었는지 확인
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshIfDateChanged();
    });

    // 저장소 연결 후 데이터 불러오기
    try {
      await DB.open();
      DB.requestPersist();   // 결과를 기다리지 않음 (실패해도 앱 사용에 지장 없음)
      categories = await DB.getCategories();
      renderFilterChips();
      await reloadAll();
    } catch (err) {
      showError('데이터를 불러오지 못했어요. 브라우저의 시크릿 모드에서는 저장이 안 될 수 있어요.', err);
    }
  }

  init();

})();
