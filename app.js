// =========================================
// app.js - 화면 전환 및 사용자 동작
// =========================================
'use strict';

(function () {

  // 앱 버전: 업데이트할 때마다 index.html의 ?v= 숫자와 함께 올림 (오늘 화면 맨 아래에 표시)
  const APP_VERSION = 'v44';

  const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const SCREENS = ['today', 'tasks', 'calendar', 'tracker', 'pikmin', 'ledger', 'review'];

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
  let missions = [];               // 모든 미션 (보관한 것 포함)
  let missionWeek = { targets: {}, logs: [] };   // 보고 있는 주의 미션 목표 고침·실천 기록
  let missionArchivedOpen = false;
  let trackerEditing = null;       // 트래커 수정창 상태: { kind: 'habit', item }
  let saveQueue = Promise.resolve();   // 칸을 빠르게 연달아 눌러도 순서대로 저장

  // 리뷰 화면
  let reviewTab = 'diary';                         // 'diary' | 'tasks' | 'goals' | 'habits' | 'missions'
  let reviewYear = new Date().getFullYear();
  let reviewMonth = new Date().getMonth() + 1;     // 1~12
  let reviewLoadId = 0;                            // 빠르게 탭·달을 바꿀 때 늦게 온 결과 무시

  // 백업·복원
  let pendingRestore = null;                       // 검사를 통과한, 복원 대기 중인 백업 내용

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

  // 아이콘 하나 만들기 (index.html 맨 위에 정의한 모양을 사용)
  // tint: 'pink' | 'mint' | 'butter' | 'lav' (동그라미 아이콘일 때 바탕색), 없으면 바탕 없음
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function iconEl(name, tint) {
    const wrap = document.createElement('span');
    wrap.className = 'ic-wrap' + (tint ? ' t-' + tint : '');
    wrap.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('width', '22');    // styles.css가 없어도 크게 나오지 않게 기본 크기
    svg.setAttribute('height', '22');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    wrap.appendChild(svg);
    return wrap;
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
    $('fab-add').hidden = !(name === 'today' || name === 'tasks' || name === 'ledger');
    closeSheet();
    hideToast();

    // 리뷰 화면은 열 때마다 최신 기록을 다시 읽음 (트래커에서 고친 내용 반영)
    if (name === 'review') {
      reviewTab = 'diary';       // 기록 탭을 열면 항상 '일기'부터
      diaryDate = null;          // 일기 쓰기 칸은 오늘
      diaryMood = null;
      loadReview().catch((err) => showError('기록을 불러오지 못했어요.', err));
    }

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

    // 체크리스트가 있으면 '2/5' 버튼: 누르면 줄 아래로 펼쳐짐 (수정창을 열지 않음)
    const ck = checklistProgress(item.task, occ);
    const isOpen = !!ck && openChecklists.has(occ.id);
    if (ck) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.dataset.occ = occ.id;                  // 체크할 때 이 표시만 그 자리에서 고침
      paintBadge(badge, ck, isOpen);
      badge.addEventListener('click', (e) => {
        e.stopPropagation();                       // 수정창이 열리지 않게
        if (openChecklists.has(occ.id)) {
          openChecklists.delete(occ.id);
        } else {
          openChecklists.add(occ.id);
          justOpened = occ.id;                     // 나타나는 효과는 처음 펼칠 때만
        }
        rerenderLists();
        justOpened = null;
      });
      main.appendChild(badge);
    }
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
        const overdue = occ.status === 'pending' && occ.scheduledDate < todayStr;
        const today = occ.scheduledDate === todayStr;
        add((today ? '오늘' : formatShortDate(occ.scheduledDate)) +
            (occ.time ? ' ' + occ.time : ''), overdue ? 'meta-overdue' : '');
      }
      // 검색 결과에는 완료·건너뛴 회차도 나오므로 상태 표시
      if (occ.status === 'done') add((occ.completedDate ? formatMD(occ.completedDate) + ' ' : '') + '완료', 'meta-done');
      if (occ.status === 'skipped') add('건너뜀', 'meta-chip');
      // 원래 예정일은 목록에 표시하지 않음 (수정창과 리뷰 화면에서만 표시)
      if (item.rule && DB.FREQUENCIES[item.rule.frequency]) {
        add('🔁 ' + DB.FREQUENCIES[item.rule.frequency].label, 'meta-repeat');
      }
      const cat = categoryName(item.task.categoryId);
      if (cat) add(cat, 'meta-chip');
      if (item.task.memo) add('📝');

      if (meta.childNodes.length) body.appendChild(meta);
    }

    if (isOpen) {
      body.appendChild(checklistPanel(item));
      li.classList.add('ck-open');               // 펼쳤을 때 완료 동그라미를 첫 줄에 맞춤
    }

    li.appendChild(check);
    li.appendChild(body);
    return li;
  }

  // ---------- 줄 아래로 펼쳐지는 체크리스트 ----------
  const openChecklists = new Set();   // 펼쳐 둔 회차 id (다시 그려도 펼친 상태 유지)

  function rerenderLists() {
    renderToday();
    renderTasks();
    if (searchQuery) runSearch().catch(() => {});
  }

  let justOpened = null;              // 방금 펼친 회차 id (이때만 나타나는 효과)

  function paintBadge(badge, ck, isOpen) {
    badge.className = 'ck-badge' + (ck.done === ck.total ? ' is-full' : '') + (isOpen ? ' is-open' : '');
    badge.textContent = '☑ ' + ck.done + '/' + ck.total + (isOpen ? ' ▴' : ' ▾');
    badge.setAttribute('aria-expanded', String(isOpen));
    badge.setAttribute('aria-label', '체크리스트 ' + ck.done + '/' + ck.total + (isOpen ? ' 접기' : ' 펼치기'));
  }

  function paintCheckRow(row, on) {
    row.classList.toggle('is-done', on);
    const btn = row.querySelector('.ck-check');
    btn.textContent = on ? '✓' : '';
    btn.setAttribute('aria-label', row.dataset.text + (on ? ' 체크 해제' : ' 체크'));
  }

  function checklistPanel(item) {
    const occ = item.occurrence;
    const panel = el('div', 'ck-panel' + (justOpened === occ.id ? ' ck-anim' : ''));
    // 펼친 부분을 눌러도 수정창이 열리지 않게
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('keydown', (e) => e.stopPropagation());

    const checked = new Set(occ.checked || []);
    const list = el('ul', 'ck-list');
    (item.task.checklist || []).forEach((it) => {
      const row = el('li', 'ck-row');
      row.dataset.occ = occ.id;
      row.dataset.item = it.id;
      row.dataset.text = it.text;
      const btn = el('button', 'ck-check');
      btn.type = 'button';
      const text = el('span', 'ck-text', it.text);
      // 누를 때의 '지금 상태'를 보고 반대로 바꿈 (그려 둔 때의 상태를 쓰지 않음)
      const onTap = () => toggleInlineCheck(item, it.id, !row.classList.contains('is-done'));
      btn.addEventListener('click', onTap);
      text.addEventListener('click', onTap);       // 글자를 눌러도 체크
      row.appendChild(btn);
      row.appendChild(text);
      paintCheckRow(row, checked.has(it.id));
      list.appendChild(row);
    });
    panel.appendChild(list);

    // 항목 추가·이름 고치기·삭제는 수정창에서만 (여기서는 체크만)
    return panel;
  }

  // 체크: 다시 그리지 않고 누른 항목과 '2/4' 표시만 그 자리에서 바꾼 뒤 순서대로 저장
  // (같은 회차가 오늘·전체 할 일·검색 결과에 함께 있어도 모두 같이 바뀜)
  function toggleInlineCheck(item, itemId, on) {
    const occId = item.occurrence.id;
    [todayItems, pendingItems, [item]].forEach((arr) => {
      arr.forEach((it) => {
        if (it.occurrence.id !== occId) return;
        const set = new Set(it.occurrence.checked || []);
        if (on) set.add(itemId);
        else set.delete(itemId);
        it.occurrence.checked = Array.from(set);
      });
    });

    document.querySelectorAll('.ck-row').forEach((row) => {
      if (row.dataset.occ === occId && row.dataset.item === itemId) paintCheckRow(row, on);
    });
    const ck = checklistProgress(item.task, item.occurrence);
    document.querySelectorAll('.ck-badge').forEach((badge) => {
      if (badge.dataset.occ === occId && ck) paintBadge(badge, ck, openChecklists.has(occId));
    });

    saveQueue = saveQueue
      .then(() => DB.setChecklistChecked(occId, itemId, on))
      .catch((err) => {
        showError('체크를 저장하지 못했어요.', err);
        return reloadAll().catch(() => {});
      });
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
    if (searchQuery) await runSearch();
  }

  // 체크리스트 진행: { done, total } 또는 null (항목이 없으면)
  function checklistProgress(task, occ) {
    const items = task.checklist || [];
    if (!items.length) return null;
    const checked = new Set(occ.checked || []);
    return { done: items.filter((i) => checked.has(i.id)).length, total: items.length };
  }

  // ---------- 할 일 검색 ----------
  // 이름·메모·체크리스트 항목·카테고리에서 찾고, 미완료·완료·건너뜀을 모두 보여 줌
  let searchQuery = '';
  let searchTimer = null;
  let searchLoadId = 0;

  function onSearchInput() {
    searchQuery = $('task-search').value.trim();
    $('task-search-clear').hidden = !$('task-search').value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      runSearch().catch((err) => showError('검색하지 못했어요.', err));
    }, 150);
  }

  function clearSearch() {
    $('task-search').value = '';
    onSearchInput();
    $('task-search').focus();
  }

  function searchText(item) {
    const t = item.task;
    return [
      t.title,
      t.memo || '',
      (t.checklist || []).map((c) => c.text).join(' '),
      categoryName(t.categoryId)
    ].join(' ').toLowerCase();
  }

  async function runSearch() {
    const section = document.querySelector('section[data-screen="tasks"]');
    const q = searchQuery.toLowerCase();
    if (!q) {
      section.classList.remove('is-searching');
      $('search-card').hidden = true;
      return;
    }
    const myId = ++searchLoadId;
    const all = await DB.getAllItems();
    if (myId !== searchLoadId) return;          // 더 새 검색이 시작됐으면 무시

    const found = all.filter((it) => searchText(it).includes(q));
    // 순서: 기한 지난 일 → 예정된 일 → 날짜 없는 일 → 완료·건너뜀(최근 것부터)
    const rank = (it) => {
      const o = it.occurrence;
      if (o.status !== 'pending') return 3;
      if (!o.scheduledDate) return 2;
      return o.scheduledDate < todayStr ? 0 : 1;
    };
    const doneDate = (o) => o.completedDate || o.skippedDate || o.scheduledDate || '';
    found.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 3) return doneDate(b.occurrence).localeCompare(doneDate(a.occurrence));
      if (ra === 2) return byCreated(a, b);
      return byDateTime(a, b);
    });

    const LIMIT = 100;
    fillList($('search-list'), found.slice(0, LIMIT).map((it) => createTaskItem(it, true)));
    $('search-count').textContent = found.length
      ? (found.length > LIMIT ? LIMIT + '+' : String(found.length)) : '';
    $('search-empty').hidden = found.length > 0;
    $('search-card').hidden = false;
    section.classList.add('is-searching');
  }

  // 데이터가 바뀐 뒤 두 화면을 모두 다시 그림
  // (먼저 반복 규칙에 따라 필요한 회차를 만들어 둠)
  async function reloadAll() {
    await DB.syncRecurrences(todayStr);
    await Promise.all([loadToday(), loadTasks(), loadCalendar(), loadTracker(), loadPikmin(), loadLedger(), loadDiary()]);
    if (currentScreen === 'review') await loadReview();
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

    // 달력 칸 (일요일 시작. 트래커의 주간 기준은 그대로 월~일)
    const grid = $('cal-grid');
    grid.innerHTML = '';
    const firstDow = new Date(calYear, calMonth - 1, 1).getDay();   // 0=일
    const blanks = firstDow;
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
    const dayTitle = $('cal-day-title');
    dayTitle.innerHTML = '';
    dayTitle.appendChild(iconEl('cal', 'mint'));
    dayTitle.appendChild(document.createTextNode(formatShortDate(calSelected)));

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
      DB.getHabitLogs(trackerWeek),
      DB.getMissions(),
      DB.getMissionWeek(trackerWeek)
    ]);
    weeklyGoals = results[0];
    habits = results[1];
    habitLogMap = {};
    results[2].forEach((log) => { habitLogMap[log.id] = log.state; });
    missions = results[3];
    missionWeek = results[4];
    renderTracker();
  }

  function renderTracker() {
    renderWeekNav();
    renderGoals();
    renderHabits();
    renderMissions();
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

      const mark = iconEl('target');
      mark.classList.add('goal-mark');

      // 목표 글자를 누르면 루틴처럼 아래에서 수정창이 열림 (수정·삭제)
      const text = document.createElement('span');
      text.className = 'goal-text';
      text.textContent = goal.text;
      text.setAttribute('role', 'button');
      text.tabIndex = 0;
      text.addEventListener('click', () => openTrackerSheet('goal', goal));
      text.addEventListener('keydown', (e) => { if (e.key === 'Enter') openTrackerSheet('goal', goal); });

      li.appendChild(mark);
      li.appendChild(text);
      list.appendChild(li);
    });
    $('goal-empty').hidden = weeklyGoals.length > 0;
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
      closeSheet();
      await loadTracker();
      showToast('삭제했어요');
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

  // ----- 주간 미션 -----

  // 이 주에 보일 미션 (습관과 같은 규칙)
  function missionsForWeek(week) {
    return missions.filter((m) =>
      (m.startWeek || '') <= week && (!m.archivedWeek || week < m.archivedWeek));
  }

  // 그 주의 목표 횟수: 그 주만 고친 값이 있으면 그것, 없으면 그 주에 적용 중인 목표
  function missionTarget(mission, week) {
    if (missionWeek.targets[mission.id] != null && week === trackerWeek) {
      return missionWeek.targets[mission.id];
    }
    let target = 1;
    (mission.targetHistory || []).forEach((h) => {
      if (h.fromWeek <= week) target = h.target;
    });
    return target;
  }

  function missionCount(mission) {
    return missionWeek.logs.filter((l) => l.missionId === mission.id).length;
  }

  function renderMissions() {
    const thisWeek = DB.weekStartOf(todayStr);
    const isFuture = trackerWeek > thisWeek;
    const visible = missionsForWeek(trackerWeek);
    const list = $('mission-list');
    list.innerHTML = '';

    visible.forEach((m) => {
      const target = missionTarget(m, trackerWeek);
      const count = missionCount(m);
      const achieved = count >= target;

      const li = document.createElement('li');
      li.className = 'mission-item' + (achieved ? ' is-achieved' : '');

      const top = document.createElement('div');
      top.className = 'mission-top';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'mission-name';
      name.textContent = m.name;
      name.addEventListener('click', () => openTrackerSheet('mission', m));
      const cnt = document.createElement('span');
      cnt.className = 'mission-count';
      cnt.textContent = count + '/' + target + '회' + (achieved ? ' 달성 🎉' : '');
      top.appendChild(name);
      top.appendChild(cnt);

      const bottom = document.createElement('div');
      bottom.className = 'mission-bottom';
      const bar = document.createElement('div');
      bar.className = 'mission-bar';
      const fill = document.createElement('div');
      fill.className = 'mission-fill';
      fill.style.width = Math.min(100, Math.round((count / target) * 100)) + '%';
      bar.appendChild(fill);

      const minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'mbtn';
      minus.textContent = '−';
      minus.disabled = count === 0;
      minus.setAttribute('aria-label', m.name + ' 실천 1회 빼기');
      minus.addEventListener('click', () => changeMissionCount(m, -1));

      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = 'mbtn mbtn-plus';
      plus.textContent = '+';
      plus.disabled = isFuture;                      // 미래 주에는 기록 불가
      plus.setAttribute('aria-label', m.name + ' 실천 1회 더하기');
      plus.addEventListener('click', () => changeMissionCount(m, 1));

      bottom.appendChild(bar);
      bottom.appendChild(minus);
      bottom.appendChild(plus);

      li.appendChild(top);
      li.appendChild(bottom);
      list.appendChild(li);
    });
    $('mission-empty').hidden = visible.length > 0;

    renderArchivedSection('mission', missions.filter((m) => m.archivedWeek), missionArchivedOpen,
      (m) => setTrackerArchived('mission', m, false),
      (m) => deleteTrackerFully('mission', m));
  }

  // 보관한 항목 목록 그리기 (미션용. prefix: id 앞부분)
  function renderArchivedSection(prefix, items, open, onRestore, onDelete) {
    $(prefix + '-archived').hidden = items.length === 0;
    $(prefix + '-archived-count').textContent = String(items.length);
    $(prefix + '-archived-toggle').setAttribute('aria-expanded', String(open));
    const alist = $(prefix + '-archived-list');
    alist.hidden = !open;
    alist.innerHTML = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'archived-name';
      name.textContent = item.name;
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn btn-soft archived-btn';
      restore.textContent = '보관 해제';
      restore.addEventListener('click', () => onRestore(item));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-danger archived-btn';
      del.textContent = '삭제';
      del.addEventListener('click', () => onDelete(item));
      li.appendChild(name);
      li.appendChild(restore);
      li.appendChild(del);
      alist.appendChild(li);
    });
  }

  // + / − : 실천 기록 1개 추가 / 가장 최근 기록 1개 삭제
  async function changeMissionCount(mission, delta) {
    if (busy) return;
    const thisWeek = DB.weekStartOf(todayStr);
    busy = true;
    try {
      if (delta > 0) {
        // 이번 주면 오늘 날짜, 지난 주면 날짜 없이 그 주의 기록으로 저장
        await DB.addMissionLog(mission.id, trackerWeek, trackerWeek === thisWeek ? todayStr : null);
      } else {
        await DB.removeLastMissionLog(mission.id, trackerWeek);
      }
      await loadTracker();
    } catch (err) {
      showError('미션 기록을 저장하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  async function addMission(event) {
    event.preventDefault();
    if (busy) return;
    const input = $('mission-add-input');
    const targetInput = $('mission-add-target');
    const name = input.value.trim();
    const target = parseInt(targetInput.value, 10);
    if (!name) { shake(input); return; }
    if (!(target >= 1 && target <= 99)) { shake(targetInput); return; }
    const thisWeek = DB.weekStartOf(todayStr);
    const startWeek = trackerWeek < thisWeek ? trackerWeek : thisWeek;
    busy = true;
    try {
      await DB.addMission(name, target, startWeek);
      input.value = '';
      targetInput.value = '3';
      await loadTracker();
    } catch (err) {
      showError('미션을 저장하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  // ----- 보관 / 완전 삭제 (습관·미션 공통으로 호출) -----
  function setTrackerArchived(kind, item, archive) {
    if (kind === 'habit') return setHabitArchived(item, archive);
    return setMissionArchived(item, archive);
  }
  function deleteTrackerFully(kind, item) {
    if (kind === 'goal') return deleteGoal(item);
    if (kind === 'habit') return deleteHabitFully(item);
    return deleteMissionFully(item);
  }

  async function setMissionArchived(mission, archive) {
    if (busy) return;
    busy = true;
    try {
      await DB.updateMission(mission.id, { archivedWeek: archive ? DB.weekStartOf(todayStr) : null });
      closeSheet();
      await loadTracker();
      showToast(archive ? '\'' + mission.name + '\'을(를) 보관했어요' : '보관을 해제했어요');
    } catch (err) {
      showError('저장하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  async function deleteMissionFully(mission) {
    if (busy) return;
    try {
      const count = await DB.countMissionLogs(mission.id);
      let msg = '\'' + mission.name + '\' 미션을 완전히 삭제할까요?';
      if (count > 0) msg += '\n\n실천 기록 ' + count + '개도 함께 삭제되며 되돌릴 수 없어요.';
      msg += '\n\n기록을 남기고 목록에서만 빼려면 \'보관\'을 사용하세요.';
      if (!confirm(msg)) return;
      busy = true;
      await DB.deleteMission(mission.id);
      closeSheet();
      await loadTracker();
      showToast('삭제했어요');
    } catch (err) {
      showError('삭제하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  // 보관 여부 (습관·미션은 주 단위, 루틴은 날짜 단위로 저장)
  function isTrackerArchived(item) {
    return !!(item.archivedWeek || item.archivedDate);
  }

  // ----- 트래커 항목 수정창 (습관·미션·루틴 공통) -----
  function openTrackerSheet(kind, item) {
    trackerEditing = { kind: kind, item: item };
    const isGoal = kind === 'goal';
    const isArchived = isTrackerArchived(item);
    const label = { goal: '목표', habit: '습관', mission: '미션' }[kind];
    $('tracker-sheet-title').textContent = label + ' 수정';
    $('tracker-name').value = isGoal ? item.text : item.name;
    $('tracker-name').maxLength = isGoal ? 100 : 50;
    // 목표는 주마다 따로 적는 것이라 '보관' 없이 수정·삭제만
    $('tracker-archive').hidden = isGoal;
    $('tracker-archive').textContent = isArchived ? '보관 해제' : '보관';
    $('tracker-sheet-hint').textContent = isGoal
      ? ''
      : isArchived
        ? '보관 중인 ' + label + '이에요'
        : '보관하면 이번 주부터 목록에서 사라지고, 지난 기록은 그대로 남아요';

    // 미션만: 목표 횟수
    const isMission = kind === 'mission';
    $('tracker-target-field').hidden = !isMission;
    if (isMission) {
      const thisWeek = DB.weekStartOf(todayStr);
      $('tracker-target').value = String(missionTarget(item, trackerWeek));
      $('tracker-target-hint').textContent = trackerWeek < thisWeek
        ? '지난 주를 보고 있어요. 바꾸면 이 주의 목표만 바뀌어요'
        : '바꾸면 이 주부터 앞으로 적용돼요 (지난 주 목표는 그대로)';
    }

    hideToast();
    $('sheet-backdrop').classList.add('open');
    $('tracker-sheet').classList.add('open');
  }

  async function submitTrackerSheet(event) {
    event.preventDefault();
    if (busy || !trackerEditing) return;
    const kind = trackerEditing.kind;
    const item = trackerEditing.item;
    const input = $('tracker-name');
    const name = input.value.trim();
    if (!name) { shake(input); return; }

    let newTarget = null;
    if (kind === 'mission') {
      const t = parseInt($('tracker-target').value, 10);
      if (!(t >= 1 && t <= 99)) { shake($('tracker-target')); return; }
      if (t !== missionTarget(item, trackerWeek)) newTarget = t;
    }
    const original = kind === 'goal' ? item.text : item.name;
    if (name === original && newTarget === null) { closeSheet(); return; }

    busy = true;
    try {
      // 이름을 바꾸면 지난 주에도 새 이름으로 보임 (기록은 그대로)
      if (kind === 'goal') {
        await DB.updateWeeklyGoal(item.id, name);
      } else if (kind === 'habit') {
        await DB.updateHabit(item.id, { name: name });
      } else {
        if (name !== item.name) await DB.updateMission(item.id, { name: name });
        if (newTarget !== null) {
          const thisWeek = DB.weekStartOf(todayStr);
          if (trackerWeek < thisWeek) {
            await DB.setMissionWeekTarget(item.id, trackerWeek, newTarget);   // 지난 주: 그 주만
          } else {
            await DB.updateMission(item.id, { targetFrom: { week: trackerWeek, target: newTarget } });
          }
        }
      }
      closeSheet();
      await loadTracker();
    } catch (err) {
      showError('저장하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  // ---------- 리뷰 및 기록 화면 ----------
  // 기록 종류별로 나눠서 보여 줌. 할 일 기록은 수정창에서, 트래커 기록은 트래커 화면에서 고침
  // (고치는 곳을 한 군데로 두어 다른 종류의 기록에 영향이 가지 않게 함)

  const REVIEW_NAMES = { tasks: '할 일', goals: '주간 목표', habits: '습관', missions: '미션', diary: '일기' };

  function monthRangeOf(y, m) {
    const last = new Date(y, m, 0).getDate();
    const prefix = y + '-' + pad2(m) + '-';
    return { start: prefix + '01', end: prefix + pad2(last) };
  }

  // 그 달에 시작하는(월요일이 그 달에 있는) 주들, 최신 주부터. 이번 주 이후는 제외
  function weeksInMonth(y, m) {
    const thisWeek = DB.weekStartOf(todayStr);
    const last = new Date(y, m, 0).getDate();
    const out = [];
    for (let d = 1; d <= last; d++) {
      const s = y + '-' + pad2(m) + '-' + pad2(d);
      if (new Date(y, m - 1, d).getDay() === 1 && s <= thisWeek) out.push(s);
    }
    return out.reverse();
  }

  function dayDiff(from, to) {
    const a = from.split('-').map(Number);
    const b = to.split('-').map(Number);
    return Math.round((new Date(b[0], b[1] - 1, b[2]) - new Date(a[0], a[1] - 1, a[2])) / 86400000);
  }

  function isThisMonth(y, m) {
    return todayStr.slice(0, 7) === y + '-' + pad2(m);
  }

  function renderReviewHeader() {
    $('review-title').textContent = reviewYear + '년 ' + reviewMonth + '월';
    $('review-sub').textContent = reviewTab === 'tasks'
      ? '완료하거나 건너뛴 할 일'
      : reviewTab === 'diary' ? '하루 한 편'
      : REVIEW_NAMES[reviewTab] + ' · 월요일 기준 주별 기록';
    const thisMonth = isThisMonth(reviewYear, reviewMonth);
    $('review-this').hidden = thisMonth;
    $('review-next').disabled = thisMonth;
    document.querySelectorAll('#review-tabs .seg-tab').forEach((b) => {
      const on = b.dataset.tab === reviewTab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
  }

  async function loadReview() {
    const myId = ++reviewLoadId;
    renderReviewHeader();
    let cards;
    if (reviewTab === 'tasks') {
      const r = monthRangeOf(reviewYear, reviewMonth);
      const items = await DB.getReviewTasks(r.start, r.end);
      if (myId !== reviewLoadId) return;
      cards = renderReviewTasks(items);
    } else if (reviewTab === 'diary') {
      cards = await renderDiaryCards();
      if (myId !== reviewLoadId) return;
    } else {
      const weeks = weeksInMonth(reviewYear, reviewMonth);
      const data = await Promise.all(weeks.map((w) => loadWeekRecords(w)));
      if (myId !== reviewLoadId) return;
      cards = renderReviewWeeks(weeks, data);
    }
    const body = $('review-body');
    body.innerHTML = '';
    cards.forEach((c) => body.appendChild(c));
  }

  function loadWeekRecords(week) {
    if (reviewTab === 'goals') return DB.getWeeklyGoals(week);
    if (reviewTab === 'habits') return DB.getHabitLogs(week);
    return DB.getMissionWeek(week);
  }

  function emptyCard(text) {
    const card = document.createElement('div');
    card.className = 'card placeholder';
    const emoji = iconEl('book', 'lav');
    emoji.classList.add('placeholder-icon');
    card.appendChild(emoji);
    card.appendChild(document.createTextNode(text));
    return card;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ----- 할 일 기록 -----
  function renderReviewTasks(items) {
    if (!items.length) return [emptyCard('이 달에 완료하거나 건너뛴 할 일이 없어요')];

    const keyOf = (it) => it.occurrence.status === 'done' ? it.occurrence.completedDate : it.occurrence.skippedDate;
    const groups = {};
    items.forEach((it) => { (groups[keyOf(it)] = groups[keyOf(it)] || []).push(it); });
    const dates = Object.keys(groups).sort().reverse();

    const card = el('div', 'card');
    const total = items.filter((it) => it.occurrence.status === 'done').length;
    const doneTitle = el('h2', 'card-title');
    doneTitle.appendChild(iconEl('check', 'mint'));
    doneTitle.appendChild(document.createTextNode('완료한 할 일 ' + total + '개'));
    card.appendChild(doneTitle);

    dates.forEach((d) => {
      card.appendChild(el('h3', 'review-date', formatShortDate(d)));
      const list = el('ul', 'review-list');
      groups[d].sort(byCreated).forEach((it) => list.appendChild(reviewTaskRow(it)));
      card.appendChild(list);
    });
    return [card];
  }

  function reviewTaskRow(item) {
    const occ = item.occurrence;
    const li = el('li', 'review-row');
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    li.addEventListener('click', () => openEdit(occ.id));

    const top = el('div', 'review-row-top');
    top.appendChild(el('span', 'review-row-title', item.task.title));
    if (occ.status === 'skipped') top.appendChild(el('span', 'badge', '건너뜀'));
    li.appendChild(top);

    const meta = el('div', 'task-meta');
    if (occ.status === 'done') {
      if (!occ.scheduledDate) {
        meta.appendChild(el('span', '', '날짜 없던 일'));
      } else if (occ.scheduledDate === occ.completedDate) {
        meta.appendChild(el('span', '', '예정일에 완료'));
      } else {
        const diff = dayDiff(occ.scheduledDate, occ.completedDate);
        meta.appendChild(el('span', diff > 0 ? 'meta-overdue' : '',
          '예정 ' + formatMD(occ.scheduledDate) + ' → ' +
          (diff > 0 ? diff + '일 늦게 완료' : (-diff) + '일 일찍 완료')));
      }
    } else if (occ.scheduledDate) {
      meta.appendChild(el('span', '', '예정 ' + formatMD(occ.scheduledDate)));
    }
    if (occ.originalDate && occ.originalDate !== occ.scheduledDate) {
      meta.appendChild(el('span', '', '원래 ' + formatMD(occ.originalDate)));
    }
    if (occ.ruleId) meta.appendChild(el('span', 'meta-repeat', '🔁'));
    const cat = categoryName(item.task.categoryId);
    if (cat) meta.appendChild(el('span', 'meta-chip', cat));
    li.appendChild(meta);
    return li;
  }

  // ----- 트래커 기록 (주별) -----
  function missionTargetFor(mission, week, overrides) {
    if (overrides && overrides[mission.id] != null) return overrides[mission.id];
    let target = 1;
    (mission.targetHistory || []).forEach((h) => { if (h.fromWeek <= week) target = h.target; });
    return target;
  }

  function renderReviewWeeks(weeks, data) {
    const thisWeek = DB.weekStartOf(todayStr);
    const cards = [];
    weeks.forEach((week, i) => {
      const body = reviewWeekBody(week, data[i]);
      if (!body) return;
      const card = el('div', 'card');
      const head = el('div', 'card-head');
      const title = el('h2', 'card-title review-week-title',
        formatMD(week) + ' ~ ' + formatMD(DB.addDays(week, 6)));
      if (week === thisWeek) title.appendChild(el('span', 'count', '이번 주'));
      const go = el('button', 'review-go', '이 주 고치기 ›');
      go.type = 'button';
      go.addEventListener('click', () => goTrackerWeek(week));
      head.appendChild(title);
      head.appendChild(go);
      card.appendChild(head);
      card.appendChild(body);
      cards.push(card);
    });
    if (!cards.length) cards.push(emptyCard('이 달에는 ' + REVIEW_NAMES[reviewTab] + ' 기록이 없어요'));
    return cards;
  }

  // 한 주의 내용. 보여 줄 게 없으면 null
  function reviewWeekBody(week, records) {
    const days = [0, 1, 2, 3, 4, 5, 6].map((n) => DB.addDays(week, n));
    const list = el('ul', 'review-list');

    if (reviewTab === 'goals') {
      if (!records.length) return null;
      records.forEach((g) => {
        const li = el('li', 'review-line');
        const gm = iconEl('target');
        gm.classList.add('goal-mark');
        li.appendChild(gm);
        li.appendChild(el('span', 'review-line-name', g.text));
        list.appendChild(li);
      });
      return list;
    }

    if (reviewTab === 'habits') {
      const map = {};
      records.forEach((l) => { map[l.id] = l.state; });
      const shown = habits.filter((h) =>
        habitsForWeek(week).includes(h) || records.some((l) => l.habitId === h.id));
      if (!shown.length) return null;
      shown.forEach((h) => {
        const li = el('li', 'review-line');
        li.appendChild(el('span', 'review-line-name', h.name));
        const cells = el('span', 'mini-cells');
        let done = 0;
        days.forEach((d) => {
          const st = map[h.id + '|' + d] || 'none';
          if (st === 'done') done++;
          cells.appendChild(el('i', 'mini mini-' + (d > todayStr ? 'future' : st),
            st === 'done' ? '✓' : st === 'not_done' ? '✕' : ''));
        });
        li.appendChild(cells);
        li.appendChild(el('span', 'review-line-count', done + '회'));
        list.appendChild(li);
      });
      return list;
    }

    if (reviewTab === 'missions') {
      const shown = missions.filter((m) =>
        missionsForWeek(week).includes(m) || records.logs.some((l) => l.missionId === m.id));
      if (!shown.length) return null;
      shown.forEach((m) => {
        const target = missionTargetFor(m, week, records.targets);
        const count = records.logs.filter((l) => l.missionId === m.id).length;
        const li = el('li', 'review-line');
        li.appendChild(el('span', 'review-line-name', m.name));
        if (count >= target) li.appendChild(el('span', 'badge badge-done', '달성'));
        li.appendChild(el('span', 'review-line-count', count + '/' + target + '회'));
        list.appendChild(li);
      });
      return list;
    }

    return null;
  }

  // 리뷰에서 '이 주 고치기' → 트래커의 그 주로 이동
  function goTrackerWeek(week) {
    trackerWeek = week;
    showScreen('tracker');
    loadTracker().catch((err) => showError('트래커를 불러오지 못했어요.', err));
  }

  function moveReviewMonth(delta) {
    if (delta === 0) {
      diaryDate = null;          // 일기 쓰기 칸도 오늘로
      diaryMood = null;
      const t = todayStr.split('-').map(Number);
      reviewYear = t[0];
      reviewMonth = t[1];
    } else {
      const d = new Date(reviewYear, reviewMonth - 1 + delta, 1);
      reviewYear = d.getFullYear();
      reviewMonth = d.getMonth() + 1;
    }
    loadReview().catch((err) => showError('기록을 불러오지 못했어요.', err));
  }

  // ----- 수정창: 완료 취소 / 건너뛰기 취소 -----
  async function undoneEditing() {
    if (busy || !editing || editing.mode !== 'edit') return;
    const item = editing.item;
    busy = true;
    try {
      await DB.setOccurrenceDone(item.occurrence.id, false, null);
      closeSheet();
      await reloadAll();
      showToast('완료를 취소했어요');
    } catch (err) {
      showError('완료를 취소하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  async function unskipEditing() {
    if (busy || !editing || editing.mode !== 'edit') return;
    const item = editing.item;
    busy = true;
    try {
      await DB.setOccurrenceSkipped(item.occurrence.id, false, null);
      closeSheet();
      await reloadAll();
      showToast('건너뛰기를 취소했어요');
    } catch (err) {
      showError('건너뛰기를 취소하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  // ---------- 데이터 백업 · 복원 ----------

  // 복원 확인 표에 보여 줄 항목 (서랍 이름 → 사람이 읽는 이름)
  const BACKUP_LABELS = [
    ['tasks', '할 일'],
    ['occurrences', '할 일 회차 기록'],
    ['rules', '반복 규칙'],
    ['weeklyGoals', '주간 목표'],
    ['habits', '습관'],
    ['habitLogs', '습관 기록'],
    ['missions', '미션'],
    ['missionLogs', '미션 실천 기록'],
    ['routines', '루틴'],
    ['routineLogs', '루틴 기록']
  ];

  // ISO 시각 → '2026년 10월 12일 00:40'
  function formatDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // ---------- 카테고리 관리 (설정 창) ----------
  // 줄마다: 이름 칸(고치고 다른 곳을 누르거나 엔터 → 저장) · ↑ · ↓ · 삭제

  function renderCategoryManager() {
    const list = $('cat-list');
    list.innerHTML = '';
    categories.forEach((cat, i) => {
      const li = el('li', 'cat-row');

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'sheet-input cat-name';
      input.value = cat.name;
      input.maxLength = 20;
      input.setAttribute('enterkeyhint', 'done');
      input.setAttribute('aria-label', '카테고리 이름');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = cat.name; input.blur(); }
      });
      input.addEventListener('blur', () => renameCategory(cat, input));

      const up = el('button', 'cat-btn', '↑');
      up.type = 'button';
      up.disabled = i === 0;
      up.setAttribute('aria-label', cat.name + ' 위로');
      up.addEventListener('click', () => moveCategory(i, -1));

      const down = el('button', 'cat-btn', '↓');
      down.type = 'button';
      down.disabled = i === categories.length - 1;
      down.setAttribute('aria-label', cat.name + ' 아래로');
      down.addEventListener('click', () => moveCategory(i, 1));

      const del = el('button', 'btn btn-danger cat-del', '삭제');
      del.type = 'button';
      del.addEventListener('click', () => removeCategory(cat));

      li.appendChild(input);
      li.appendChild(up);
      li.appendChild(down);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  // 카테고리를 바꾼 뒤: 필터 버튼과 할 일 목록을 새 이름으로 다시 그림
  async function afterCategoryChange() {
    categories = await DB.getCategories();
    if (tasksFilter !== 'all' && !categories.some((c) => c.id === tasksFilter)) tasksFilter = 'all';
    renderCategoryManager();
    renderFilterChips();
    await reloadAll();
  }

  async function saveCategoryList(list, okMessage) {
    if (busy) return;
    busy = true;
    try {
      await DB.saveCategories(list);
      await afterCategoryChange();
      if (okMessage) showToast(okMessage);
    } catch (err) {
      showError('카테고리를 저장하지 못했어요.', err);
      renderCategoryManager();
    } finally {
      busy = false;
    }
  }

  function isDuplicateName(name, exceptId) {
    return categories.some((c) => c.id !== exceptId && c.name === name);
  }

  function renameCategory(cat, input) {
    const name = input.value.trim();
    if (name === cat.name) return;
    if (!name) {                      // 빈칸이면 원래 이름으로 (삭제는 '삭제' 버튼으로만)
      input.value = cat.name;
      return;
    }
    if (isDuplicateName(name, cat.id)) {
      input.value = cat.name;
      showToast('같은 이름의 카테고리가 이미 있어요');
      return;
    }
    const list = categories.map((c) => (c.id === cat.id ? { id: c.id, name: name } : c));
    saveCategoryList(list, '이름을 바꿨어요');
  }

  function moveCategory(index, delta) {
    const to = index + delta;
    if (to < 0 || to >= categories.length) return;
    const list = categories.slice();
    const moved = list.splice(index, 1)[0];
    list.splice(to, 0, moved);
    saveCategoryList(list);
  }

  async function addCategory(event) {
    event.preventDefault();
    const input = $('cat-add-input');
    const name = input.value.trim();
    if (!name) { shake(input); return; }
    if (isDuplicateName(name, null)) {
      shake(input);
      showToast('같은 이름의 카테고리가 이미 있어요');
      return;
    }
    const list = categories.concat([{ id: DB.newCategoryId(), name: name }]);
    await saveCategoryList(list, '카테고리를 추가했어요');
    input.value = '';
  }

  async function removeCategory(cat) {
    if (busy) return;
    try {
      const count = await DB.countTasksInCategory(cat.id);
      let msg = '\'' + cat.name + '\' 카테고리를 삭제할까요?';
      if (count > 0) msg += '\n\n이 카테고리의 할 일 ' + count + '개는 \'없음\'으로 바뀌어요. 할 일과 기록은 그대로 남아요.';
      if (!confirm(msg)) return;
      busy = true;
      await DB.deleteCategory(cat.id);
      await afterCategoryChange();
      showToast('삭제했어요');
    } catch (err) {
      showError('카테고리를 삭제하지 못했어요.', err);
    } finally {
      busy = false;
    }
  }

  async function openDataSheet() {
    closeSheet();
    hideRestorePanel();
    renderCategoryManager();
    $('cat-add-input').value = '';
    try {
      const last = await DB.getSetting('lastBackupAt');
      $('data-last-backup').textContent = last
        ? '마지막 백업: ' + formatDateTime(last)
        : '아직 백업한 적이 없어요';
    } catch (err) {
      $('data-last-backup').textContent = '';
    }
    hideToast();
    $('sheet-backdrop').classList.add('open');
    $('data-sheet').classList.add('open');
    $('data-sheet').scrollTop = 0;
  }

  // 백업 파일 저장. 성공하면 true
  async function exportBackup() {
    try {
      const backup = await DB.exportAll(APP_VERSION);
      const json = JSON.stringify(backup, null, 1);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'life-planner-backup-' + todayStr + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      await DB.setLastBackup(backup.exportedAt);
      $('data-last-backup').textContent = '마지막 백업: ' + formatDateTime(backup.exportedAt);
      showToast('백업 파일을 저장했어요 (다운로드 폴더)');
      return true;
    } catch (err) {
      showError('백업 파일을 만들지 못했어요.', err);
      return false;
    }
  }

  function hideRestorePanel() {
    pendingRestore = null;
    $('restore-panel').hidden = true;
    $('restore-backed-up').hidden = true;
  }

  // 파일을 고르면: 읽기 → 검사 → 지금 데이터와 비교해서 보여 주기 (아직 아무것도 바꾸지 않음)
  async function onBackupFilePicked(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = '';               // 같은 파일을 다시 골라도 동작하도록
    hideRestorePanel();
    if (!file) return;

    if (file.size > 50 * 1024 * 1024) {
      showError('파일이 너무 커요. 이 앱의 백업 파일이 맞는지 확인해 주세요.');
      return;
    }

    let backup;
    try {
      const text = await file.text();
      backup = JSON.parse(text);
    } catch (err) {
      showError('파일을 읽을 수 없어요. 이 앱에서 저장한 백업 파일(.json)인지 확인해 주세요.', err);
      return;
    }

    const check = DB.validateBackup(backup);
    if (!check.ok) {
      showError('이 파일로는 복원할 수 없어요.\n' + check.error);
      return;
    }

    let current;
    try {
      current = await DB.countAll();
    } catch (err) {
      showError('현재 데이터를 확인하지 못했어요.', err);
      return;
    }

    pendingRestore = backup;
    $('restore-file').textContent = '📄 ' + file.name + '\n백업한 때: ' +
      (formatDateTime(backup.exportedAt) || '알 수 없음') +
      (backup.appVersion ? ' (앱 ' + backup.appVersion + ')' : '');

    const table = $('restore-table');
    table.innerHTML = '';
    const head = document.createElement('tr');
    ['', '지금', '파일'].forEach((t) => head.appendChild(el('th', '', t)));
    table.appendChild(head);
    BACKUP_LABELS.forEach(([name, label]) => {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', '', label));
      tr.appendChild(el('td', 'num', String(current[name] || 0)));
      tr.appendChild(el('td', 'num', String(check.counts[name] || 0)));
      table.appendChild(tr);
    });

    $('restore-panel').hidden = false;
    $('restore-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function backupBeforeRestore() {
    if (busy) return;
    busy = true;
    const ok = await exportBackup();
    busy = false;
    if (ok) $('restore-backed-up').hidden = false;
  }

  async function runRestore() {
    if (busy || !pendingRestore) return;
    let msg = '정말 복원할까요?\n\n지금 데이터가 모두 지워지고 백업 파일의 내용으로 바뀌어요.';
    if ($('restore-backed-up').hidden) {
      msg += '\n\n⚠️ 아직 현재 데이터를 백업하지 않았어요.';
    }
    if (!confirm(msg)) return;

    busy = true;
    try {
      await DB.importAll(pendingRestore);
      // 지금 데이터 = 그 백업 파일의 내용이므로, 마지막 백업 시각을 그 파일의 시각으로 표시
      if (pendingRestore.exportedAt) {
        await DB.setLastBackup(pendingRestore.exportedAt).catch(() => {});
      }
      alert('복원을 마쳤어요. 앱을 새로 불러올게요.');
      location.reload();
    } catch (err) {
      // 복원은 하나의 묶음으로 처리되므로, 실패하면 아무것도 바뀌지 않음
      showError('복원하지 못했어요. 기존 데이터는 그대로 남아 있어요.\n(' + (err && err.message ? err.message : err) + ')', err);
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
    if (document.activeElement) document.activeElement.blur();   // 고치던 칸이 있으면 여기서 저장됨
    $('sheet-backdrop').classList.remove('open');
    $('quick-add-sheet').classList.remove('open');
    $('edit-sheet').classList.remove('open');
    $('tracker-sheet').classList.remove('open');
    $('data-sheet').classList.remove('open');
    $('pikmin-sheet').classList.remove('open');
    $('ledger-sheet').classList.remove('open');
    $('ledger-settings-sheet').classList.remove('open');
    lgEditing = null;
    editing = null;
    trackerEditing = null;
    pendingRestore = null;
    // 체크리스트를 바꿨으면 저장이 끝난 뒤 목록의 '2/5' 표시를 새로 그림
  }

  function isSheetOpen() {
    return $('quick-add-sheet').classList.contains('open') ||
      $('edit-sheet').classList.contains('open') ||
      $('tracker-sheet').classList.contains('open') ||
      $('data-sheet').classList.contains('open') ||
      $('pikmin-sheet').classList.contains('open') ||
      $('ledger-sheet').classList.contains('open') ||
      $('ledger-settings-sheet').classList.contains('open');
  }

  // '+' 버튼: 오늘 화면은 빠른 추가, 전체 할 일 화면은 상세 추가
  function onFabClick() {
    if (currentScreen === 'tasks') openNew();
    else if (currentScreen === 'ledger') openLedgerSheet(null);
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
      case 'fourweekly': text = '4주마다 ' + wd + '요일'; break;
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
    // 완료 취소 / 건너뛰기 취소: 이미 완료했거나 건너뛴 회차
    const canUndone = isEdit && occ.status === 'done';
    const canUnskip = isEdit && occ.status === 'skipped';
    $('edit-skip').hidden = !canSkip;
    $('edit-stop').hidden = !canStop;
    $('edit-undone').hidden = !canUndone;
    $('edit-unskip').hidden = !canUnskip;
    $('occ-actions').hidden = !(canSkip || canStop || canUndone || canUnskip);

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

  // ---------- 수정창의 체크리스트 ----------
  // 새 할 일: 항목을 모아 두었다가 '저장'할 때 함께 저장
  // 기존 할 일도 마찬가지로 '저장'을 눌러야 반영되고, '취소'하면 바뀐 것이 모두 버려짐
  // (줄 아래로 펼친 체크리스트는 취소 버튼이 없으므로 누르는 즉시 저장)

  function renderChecklist() {
    if (!editing) return;
    const isEdit = editing.mode === 'edit';
    const items = editing.checklist;
    const checked = editing.checked;
    const list = $('checklist-list');
    list.innerHTML = '';

    items.forEach((it) => {
      const isOn = checked.has(it.id);
      const li = el('li', 'checklist-item' + (isOn ? ' is-done' : ''));

      if (isEdit) {
        const btn = el('button', 'check', isOn ? '✓' : '');
        btn.type = 'button';
        btn.setAttribute('aria-label', it.text + (isOn ? ' 체크 해제' : ' 체크'));
        btn.addEventListener('click', () => toggleChecklistItem(it));
        li.appendChild(btn);
      }

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'sheet-input checklist-text';
      input.value = it.text;
      input.maxLength = 60;
      input.setAttribute('enterkeyhint', 'done');
      input.setAttribute('aria-label', '체크리스트 항목');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }   // 엔터로 창 전체가 저장되지 않게
        if (e.key === 'Escape') { input.value = it.text; input.blur(); }
      });
      input.addEventListener('blur', () => {
        const text = input.value.trim();
        if (!text) { input.value = it.text; return; }      // 빈칸이면 원래대로 (삭제는 ✕)
        if (text === it.text) return;
        it.text = text;
        saveChecklistItems();
      });
      li.appendChild(input);

      const del = el('button', 'icon-btn', '✕');
      del.type = 'button';
      del.setAttribute('aria-label', it.text + ' 삭제');
      del.addEventListener('click', () => {
        editing.checklist = editing.checklist.filter((x) => x.id !== it.id);
        editing.checked.delete(it.id);
        renderChecklist();
        saveChecklistItems();
      });
      li.appendChild(del);
      list.appendChild(li);
    });

    const done = items.filter((i) => checked.has(i.id)).length;
    $('checklist-progress').textContent = items.length && isEdit ? done + '/' + items.length : '';

    let hint = '';
    if (!isEdit && items.length) hint = '체크는 저장한 뒤에 할 수 있어요';
    else if (isEdit && editing.item.occurrence.ruleId) {
      hint = '항목은 모든 회차에 같고, 체크는 이번 회차에만 표시돼요';
    }
    $('checklist-hint').textContent = hint;
  }

  function addChecklistItem() {
    if (!editing) return;
    const input = $('checklist-add-input');
    const text = input.value.trim();
    if (!text) { shake(input); return; }
    editing.checklist.push({ id: DB.newChecklistItemId(), text: text });
    input.value = '';
    renderChecklist();
    saveChecklistItems();
    input.focus();
  }

  // 기존 할 일이면 항목 목록을 바로 저장 (순서대로)
  // 수정창에서 바꾼 체크리스트는 창 안에만 들고 있다가 '저장'을 누를 때 함께 저장 (취소하면 버림)
  function saveChecklistItems() {
    if (editing) editing.checklistChanged = true;
  }

  function toggleChecklistItem(it) {
    if (!editing || editing.mode !== 'edit') return;
    if (editing.checked.has(it.id)) editing.checked.delete(it.id);
    else editing.checked.add(it.id);
    editing.checklistChanged = true;
    renderChecklist();
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
    editing.checklist = [];
    editing.checked = new Set();
    $('checklist-add-input').value = '';
    renderChecklist();
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
      editing.checklist = (item.task.checklist || []).map((i) => ({ id: i.id, text: i.text }));
      editing.checked = new Set(occ.checked || []);
      $('checklist-add-input').value = '';
      renderChecklist();
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
    // 체크리스트: 아직 '추가'를 누르지 않고 칸에 남은 항목도 함께 넣음
    const pending = $('checklist-add-input').value.trim();
    if (pending) {
      editing.checklist.push({ id: DB.newChecklistItemId(), text: pending });
      editing.checklistChanged = true;
    }
    if (editing.mode === 'new' || editing.checklistChanged) {
      fields.checklist = editing.checklist.map((i) => ({ id: i.id, text: i.text }));
    }
    if (editing.mode === 'edit' && editing.checklistChanged) {
      const ids = new Set(editing.checklist.map((i) => i.id));
      fields.checked = Array.from(editing.checked).filter((id) => ids.has(id));   // 지운 항목의 체크는 뺌
    }
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
      // 트래커가 '오늘'을 보고 있었다면 새 날짜로 따라감
      if (trackerWeek === DB.weekStartOf(todayStr)) trackerWeek = DB.weekStartOf(now);
      if (lgMonth === todayStr.slice(0, 7)) lgMonth = now.slice(0, 7);
      todayStr = now;
      renderDate();
      reloadAll().catch((err) => showError('목록을 불러오지 못했어요.', err));
    }
  }

  // =========================================
  // 피크민 이벤트 미션
  // 저장 위치: 설정 서랍의 'pikmin' 한 칸 (백업 파일에 자동으로 함께 들어감)
  //   { current: 이벤트 또는 null, past: [지난 이벤트...] }
  //   이벤트 = { id, name, endDate, perDay, base, logs: { 'YYYY-MM-DD': 깬 수 }, stages, done: [미션 열쇠], createdAt }
  //   base = 앱에 기록하기 전에 이미 깬 버섯 수
  // 날짜 계산: 진행은 버섯으로만 바뀜. 남은 버섯을 하루 perDay개씩 깬다고 보고,
  //   버섯이 아닌 미션은 '그 단계가 열린 날 ~ 다음 버섯을 깨기 전 날'에 하면 됨
  // =========================================
  let pik = { current: null, past: [] };
  let pikSaveChain = Promise.resolve();
  let pikFoldOpen = new Map();     // '바퀴-스테이지' → 펼침(true)/접힘(false). 직접 누른 것만 기억
  let pikFoldEventId = null;
  let pikSheetEdit = false;

  async function loadPikmin() {
    const saved = await DB.getSetting('pikmin');
    pik = (saved && typeof saved === 'object') ? saved : { current: null, past: [] };
    if (!Array.isArray(pik.past)) pik.past = [];
    // v34에서 저장한 체크(바퀴 번호 없음)는 1바퀴째로 봄
    if (pik.current && Array.isArray(pik.current.done)) {
      pik.current.done = pik.current.done.map((k) => (k.indexOf(':') < 0 ? '1:' + k : k));
    }
    renderPikmin();
  }

  function savePik() {
    const snapshot = JSON.parse(JSON.stringify(pik));
    pikSaveChain = pikSaveChain
      .then(() => DB.setSetting('pikmin', snapshot))
      .catch((err) => showError('피크민 기록을 저장하지 못했어요.', err));
    return pikSaveChain;
  }

  // 붙여 넣은 글 → 스테이지/단계/미션
  function parsePikText(text) {
    const stages = [];
    let stage = null;
    let stepNo = null;
    String(text || '').split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      if (/^스테이지\s*\d*/.test(line) && !/^스테이지\s*\d+\s*[.\-]/.test(line)) {
        stage = { steps: [] };
        stages.push(stage);
        stepNo = null;
        return;
      }
      if (!stage) { stage = { steps: [] }; stages.push(stage); }
      let no = stepNo === null ? '?' : stepNo;
      let body = line;
      const m = line.match(/^(\d+)\s*[.\-]\s*\d+\s*(.*)$/);
      if (m) { no = m[1]; body = m[2].trim(); }
      if (!body) return;
      if (no !== stepNo || stage.steps.length === 0) {
        stage.steps.push({ items: [] });
        stepNo = no;
      }
      const mm = body.match(/버섯\s*([\d,]+)\s*개/);
      const mush = mm ? parseInt(mm[1].replace(/,/g, ''), 10) || 0 : 0;
      stage.steps[stage.steps.length - 1].items.push({ text: body, mush: mush });
    });
    return stages.filter((st) => st.steps.length > 0);
  }

  function pikText(ev) {
    const lines = [];
    ev.stages.forEach((st, si) => {
      lines.push('스테이지 ' + (si + 1));
      st.steps.forEach((step, pi) => {
        step.items.forEach((it, ii) => lines.push((pi + 1) + '.' + (ii + 1) + ' ' + it.text));
      });
    });
    return lines.join('\n');
  }

  // 미션 열쇠: '바퀴:스테이지.단계|미션 글' (예: '2:1.4|꽃 1000송이 심기')
  // 스테이지 4가 끝나면 같은 미션으로 다시 스테이지 1부터 시작(바퀴)하므로 바퀴 번호를 함께 기억함
  const pikKey = (r, si, pi, text) => (r + 1) + ':' + (si + 1) + '.' + (pi + 1) + '|' + text;
  const pikKeyBase = (key) => key.slice(key.indexOf(':') + 1);

  // 한 바퀴의 버섯 수(total), 어제까지(past)·오늘(today) 기록, 지금까지 깬 버섯(done, 모든 바퀴 합계)
  function pikCounts(ev) {
    let total = 0;
    ev.stages.forEach((st) => st.steps.forEach((step) => step.items.forEach((it) => { total += it.mush; })));
    let past = 0;
    Object.keys(ev.logs || {}).forEach((d) => { if (d < todayStr) past += ev.logs[d]; });
    const today = (ev.logs && ev.logs[todayStr]) || 0;
    const done = Math.max(0, (ev.base || 0) + past + today);
    return { total: total, past: past, today: today, done: done };
  }

  // 누적 u번째 버섯을 며칠 뒤에 깨게 되는지 (-1 = 이미 깸, 0 = 오늘, 1 = 내일 …)
  function pikUnitDay(u, c, perDay) {
    if (u <= c.done) return -1;
    const leftToday = Math.max(0, perDay - c.today);
    const k = u - c.done;
    if (k <= leftToday) return 0;
    return 1 + Math.floor((k - leftToday - 1) / perDay);
  }

  function pikDayLabel(n) {
    if (n <= 0) return '오늘';
    if (n === 1) return '내일';
    if (n === 2) return '모레';
    const d = DB.addDays(todayStr, n);
    return parseInt(d.slice(5, 7), 10) + '/' + parseInt(d.slice(8, 10), 10);
  }
  function shortDate(d) {
    return parseInt(d.slice(5, 7), 10) + '/' + parseInt(d.slice(8, 10), 10);
  }
  function daysBetween(from, to) {
    const p = (s) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
    return Math.round((p(to) - p(from)) / 86400000);
  }

  // 버섯이 아닌 미션의 색: a = 할 수 있는 첫날, b = 늦어도 해야 하는 날 (0 = 오늘)
  //   분홍 = 오늘 꼭, 파랑 = 내일 꼭(내일 하루뿐),
  //   흰색 = 이틀 이상 중 아무 날이나 (오늘이나 내일부터 시작), 테두리만 = 모레 이후에 시작
  function pikColor(a, b) {
    if (b <= 0) return ['c-n', '오늘 꼭'];
    if (a <= 0) return ['c-mid', b === 1 ? '오늘·내일' : '오늘~' + pikDayLabel(b)];
    if (a === 1 && b === 1) return ['c-n1', '내일 꼭'];
    if (a === 1) return ['c-mid', (b === 2 ? '내일·모레' : '내일~' + pikDayLabel(b))];
    return ['c-later', pikDayLabel(a) + '부터'];
  }

  // 마감일까지 하루 perDay개씩 깨면 어디까지 갈 수 있는지 한 줄로
  function pikForecast(ev, c, perDay) {
    if (!ev.endDate || c.total === 0 || todayStr > ev.endDate) return '';
    const capacity = Math.max(0, perDay - c.today) + daysBetween(todayStr, ev.endDate) * perDay;
    const reach = c.done + capacity;
    const laps = Math.floor(reach / c.total);
    const rem = reach - laps * c.total;
    if (rem === 0) return '마감(' + shortDate(ev.endDate) + ')까지 ' + laps + '바퀴를 다 돌 수 있어요';
    let cum = 0;
    let stageNo = ev.stages.length;
    for (let si = 0; si < ev.stages.length; si++) {
      ev.stages[si].steps.forEach((step) => step.items.forEach((it) => { cum += it.mush; }));
      if (cum >= rem) { stageNo = si + 1; break; }
    }
    return '마감(' + shortDate(ev.endDate) + ')까지 ' +
      (laps > 0 ? laps + '바퀴 다 돌고 ' + (laps + 1) + '바퀴째 ' : '') + '스테이지 ' + stageNo + '까지 갈 수 있어요';
  }

  function renderPikmin() {
    const ev = pik.current;
    $('pik-empty').hidden = !!ev;
    $('pik-main').hidden = !ev;
    $('pik-edit').hidden = !ev;
    if (!ev) return;

    if (pikFoldEventId !== ev.id) { pikFoldOpen = new Map(); pikFoldEventId = ev.id; }

    const perDay = Math.max(1, ev.perDay || 3);
    const c = pikCounts(ev);
    const T = c.total;
    // 지금 바퀴: 다음에 깰 버섯이 속한 바퀴 (0부터)
    const cur = T > 0 ? Math.floor(c.done / T) : 0;
    const doneSet = new Set(ev.done || []);

    // 이벤트 카드
    $('pik-name').textContent = ev.name;
    $('pik-end').textContent = ev.endDate ? '~ ' + shortDate(ev.endDate) : '';
    $('pik-bar').style.width = (T ? ((c.done - cur * T) / T * 100) : 0) + '%';
    let text;
    if (T === 0) {
      text = '버섯 미션이 없어요';
    } else {
      const lapEnd = DB.addDays(todayStr, pikUnitDay((cur + 1) * T, c, perDay));
      text = (cur + 1) + '바퀴째 · 버섯 ' + (c.done - cur * T) + ' / ' + T + ' · 이번 바퀴는 ' + shortDate(lapEnd) + '에 끝나요';
    }
    if (ev.endDate && todayStr > ev.endDate) text = '이벤트가 끝났어요 · ' + text;
    $('pik-summary').textContent = text;
    const fc = pikForecast(ev, c, perDay);
    $('pik-forecast').textContent = fc;
    $('pik-forecast').hidden = !fc;

    // 오늘 깬 버섯
    $('pik-perday').textContent = '하루 ' + perDay + '개 기준';
    $('pik-today').textContent = c.today;
    $('pik-minus').disabled = c.today <= 0;
    const dots = $('pik-dots');
    dots.innerHTML = '';
    for (let i = 0; i < perDay; i++) dots.appendChild(el('span', i < c.today ? 'on' : ''));
    if (c.today > perDay) dots.appendChild(el('em', '+' + (c.today - perDay) + ' 보너스'));

    // 보여 줄 바퀴: 지난 바퀴(체크 안 한 미션이 남았을 때만) · 지금 바퀴 · 다음 바퀴(내일까지 시작될 때만)
    const rounds = [];
    if (T > 0 && cur > 0) {
      const hasLeft = ev.stages.some((st, si) => st.steps.some((step, pi) =>
        step.items.some((it) => it.mush === 0 && !doneSet.has(pikKey(cur - 1, si, pi, it.text)))));
      if (hasLeft) rounds.push(cur - 1);
    }
    rounds.push(cur);
    if (T > 0 && pikUnitDay((cur + 1) * T, c, perDay) <= 1) rounds.push(cur + 1);

    const wrap = $('pik-stages');
    wrap.innerHTML = '';
    rounds.forEach((r) => {
      if (T > 0) wrap.appendChild(el('p', 'pik-round', (r + 1) + '바퀴째'));
      renderPikRound(wrap, ev, r, c, perDay, doneSet);
    });
  }

  // 한 바퀴(스테이지 1~끝) 그리기. r = 바퀴 번호(0부터)
  function renderPikRound(wrap, ev, r, c, perDay, doneSet) {
    const rOff = r * c.total;          // 이 바퀴 앞까지의 버섯 수
    let cum = rOff;
    ev.stages.forEach((stage, si) => {
      const sStart = cum;
      const stepEls = [];
      let allDone = true;
      let anySoon = false;     // 오늘·내일 색이 하나라도 있는지
      stage.steps.forEach((step, pi) => {
        const m = step.items.reduce((n, it) => n + it.mush, 0);
        const b = cum;
        const e = cum + m;
        cum = e;
        const unlocked = b <= c.done;
        const a = b === 0 ? 0 : Math.max(0, pikUnitDay(b, c, perDay));
        // 늦어도: 다음 버섯(다음 바퀴의 첫 버섯 포함)을 깨기 전
        const last = c.total > 0 ? pikUnitDay(e + 1, c, perDay) : -1;

        const box = el('div', 'pik-step');
        const head = el('p', 'pik-step-h', (si + 1) + '-' + (pi + 1));
        if (!unlocked) head.appendChild(el('span', 'lock', '아직 잠김'));
        box.appendChild(head);

        let off = b;   // 같은 단계에 버섯 미션이 여러 줄이면 앞줄 다음부터 셈
        step.items.forEach((it) => {
          if (it.mush > 0) {
            const from = off;
            off += it.mush;
            const got = Math.min(Math.max(c.done - from, 0), it.mush);
            const row = el('div', 'pik-row');
            const chk = el('span', 'pik-chk shroom');
            const tx = el('span', 'tx', it.text);
            const prog = el('span', 'prog', got + '/' + it.mush);
            if (got >= it.mush) {
              row.classList.add('done');
              chk.textContent = '✓';
            } else {
              allDone = false;
              const byDay = new Map();
              for (let u = from + got + 1; u <= from + it.mush; u++) {
                const d = pikUnitDay(u, c, perDay);
                byDay.set(d, (byDay.get(d) || 0) + 1);
              }
              const days = Array.from(byDay.keys()).sort((x, y) => x - y);
              const chips = el('div', 'pik-chips');
              days.forEach((d) => {
                chips.appendChild(el('span', d <= 0 ? 'n' : d === 1 ? 'n1' : '', pikDayLabel(d) + ' ' + byDay.get(d)));
              });
              tx.appendChild(chips);
              const first = days[0];
              row.classList.add(first <= 0 ? 'c-n' : first === 1 ? 'c-n1' : 'c-later');
              if (first <= 1) anySoon = true;
            }
            row.append(chk, tx, prog);
            box.appendChild(row);
          } else {
            const key = pikKey(r, si, pi, it.text);
            const isDone = doneSet.has(key);
            const row = el('button', 'pik-row');
            row.type = 'button';
            row.dataset.key = key;
            const chk = el('span', 'pik-chk', isDone ? '✓' : '');
            const tx = el('span', 'tx', it.text);
            row.append(chk, tx);
            if (isDone) {
              row.classList.add('done');
            } else {
              allDone = false;
              const col = pikColor(a, last);
              row.classList.add(col[0]);
              row.appendChild(el('span', 'tag', col[1]));
              if (col[0] !== 'c-later') anySoon = true;
            }
            box.appendChild(row);
          }
        });
        stepEls.push(box);
      });

      const foldKey = r + '-' + si;
      const card = el('div', 'card pik-stage');
      const stageMush = cum - sStart;
      const stageGot = Math.min(Math.max(c.done - sStart, 0), stageMush);
      const defaultOpen = !allDone && anySoon;
      const open = pikFoldOpen.has(foldKey) ? pikFoldOpen.get(foldKey) : defaultOpen;

      const fold = el('button', 'pik-fold');
      fold.type = 'button';
      fold.dataset.fold = foldKey;
      fold.setAttribute('aria-expanded', String(open));
      fold.appendChild(el('h2', 'card-title', '스테이지 ' + (si + 1)));
      let subText;
      if (allDone) subText = '✓ 완료';
      else if (sStart > c.done) subText = '버섯 ' + stageGot + ' / ' + stageMush + ' · ' + pikDayLabel(pikUnitDay(sStart, c, perDay)) + ' 열림';
      else subText = '버섯 ' + stageGot + ' / ' + stageMush;
      const sub = el('span', 'pik-fold-sub' + (allDone ? ' ok' : ''), subText + (open ? ' ▴' : ' ▾'));
      fold.appendChild(sub);
      card.appendChild(fold);
      if (open) stepEls.forEach((x) => card.appendChild(x));
      wrap.appendChild(card);
    });
  }

  function onPikStagesClick(e) {
    const fold = e.target.closest('[data-fold]');
    if (fold) {
      pikFoldOpen.set(fold.dataset.fold, fold.getAttribute('aria-expanded') !== 'true');
      renderPikmin();
      return;
    }
    const row = e.target.closest('[data-key]');
    if (!row || !pik.current) return;
    const ev = pik.current;
    const set = new Set(ev.done || []);
    if (set.has(row.dataset.key)) set.delete(row.dataset.key);
    else set.add(row.dataset.key);
    ev.done = Array.from(set);
    renderPikmin();
    savePik();
  }

  function changePikToday(delta) {
    const ev = pik.current;
    if (!ev) return;
    if (!ev.logs) ev.logs = {};
    const next = Math.max(0, (ev.logs[todayStr] || 0) + delta);
    if (next === 0) delete ev.logs[todayStr];
    else ev.logs[todayStr] = next;
    renderPikmin();
    savePik();
  }

  // ----- 넣기·수정 창 -----
  function openPikSheet(edit) {
    const ev = pik.current;
    pikSheetEdit = !!(edit && ev);
    hideToast();
    if (pikSheetEdit) {
      const c = pikCounts(ev);
      $('pik-sheet-title').textContent = '이벤트 수정';
      $('pik-f-name').value = ev.name;
      $('pik-f-end').value = ev.endDate || '';
      $('pik-f-perday').value = ev.perDay || 3;
      $('pik-f-done').value = (ev.base || 0) + c.past;
      $('pik-f-text').value = pikText(ev);
    } else {
      const y = parseInt(todayStr.slice(0, 4), 10);
      const mo = parseInt(todayStr.slice(5, 7), 10);
      const lastDay = new Date(y, mo, 0).getDate();
      $('pik-sheet-title').textContent = ev ? '새 이벤트 넣기' : '이벤트 넣기';
      $('pik-f-name').value = mo + '월 이벤트';
      $('pik-f-end').value = todayStr.slice(0, 8) + String(lastDay).padStart(2, '0');
      $('pik-f-perday').value = 3;
      $('pik-f-done').value = 0;
      $('pik-f-text').value = '';
    }
    $('pik-delete').hidden = !pikSheetEdit;
    renderPikParse();
    $('sheet-backdrop').classList.add('open');
    $('pikmin-sheet').classList.add('open');
    $('pikmin-sheet').scrollTop = 0;
  }

  // 붙여 넣은 글을 어떻게 나눴는지 미리 보여 줌
  function renderPikParse() {
    const box = $('pik-parse');
    const text = $('pik-f-text').value;
    if (!text.trim()) { box.innerHTML = ''; return; }
    const stages = parsePikText(text);
    box.innerHTML = '';
    let items = 0;
    let mush = 0;
    const ul = el('ul');
    stages.forEach((st, si) => {
      let sm = 0;
      let si2 = 0;
      st.steps.forEach((step) => step.items.forEach((it) => { si2++; sm += it.mush; }));
      items += si2;
      mush += sm;
      ul.appendChild(el('li', '', '스테이지 ' + (si + 1) + ': 단계 ' + st.steps.length + '개 · 미션 ' + si2 + '개 · 버섯 ' + sm + '개'));
    });
    if (items === 0) {
      box.appendChild(el('span', 'bad', '미션을 찾지 못했어요.'));
      return;
    }
    box.appendChild(el('strong', '', '스테이지 ' + stages.length + '개 · 미션 ' + items + '개 · 버섯 ' + mush + '개'));
    box.appendChild(ul);
    if (mush === 0) box.appendChild(el('p', 'bad', '버섯 미션이 없어서 날짜를 계산할 수 없어요.'));
  }

  async function submitPikSheet(e) {
    e.preventDefault();
    const stages = parsePikText($('pik-f-text').value);
    if (!stages.length) { shake($('pik-f-text')); return; }
    const name = $('pik-f-name').value.trim() || '피크민 이벤트';
    const endDate = $('pik-f-end').value || null;
    const perDay = Math.min(20, Math.max(1, parseInt($('pik-f-perday').value, 10) || 3));
    const doneBefore = Math.max(0, parseInt($('pik-f-done').value, 10) || 0);

    if (pikSheetEdit && pik.current) {
      const ev = pik.current;
      const c = pikCounts(ev);
      ev.name = name;
      ev.endDate = endDate;
      ev.perDay = perDay;
      ev.base = doneBefore - c.past;      // 어제까지 합계가 입력한 값이 되도록
      ev.stages = stages;
      const keys = new Set();
      stages.forEach((st, si) => st.steps.forEach((step, pi) => step.items.forEach((it) => keys.add(pikKeyBase(pikKey(0, si, pi, it.text))))));
      ev.done = (ev.done || []).filter((k) => keys.has(pikKeyBase(k)));   // 지운 미션의 체크는 정리
    } else {
      if (pik.current) {
        const ok = confirm('지금 보고 있는 \'' + pik.current.name + '\'은(는) 화면에서 사라지고 백업 파일에만 남아요. 새 이벤트를 넣을까요?');
        if (!ok) return;
        pik.past.push(pik.current);
      }
      pik.current = {
        id: 'pk-' + Date.now(),
        name: name,
        endDate: endDate,
        perDay: perDay,
        base: doneBefore,
        logs: {},
        stages: stages,
        done: [],
        createdAt: new Date().toISOString()
      };
    }
    closeSheet();
    renderPikmin();
    await savePik();
  }

  async function deletePikEvent() {
    const ev = pik.current;
    if (!ev) return;
    if (!confirm('\'' + ev.name + '\' 이벤트를 지울까요? 체크한 기록과 버섯 기록도 함께 지워져요.')) return;
    pik.current = null;
    closeSheet();
    renderPikmin();
    await savePik();
  }

  // =========================================
  // 가계부
  // 저장 위치: 설정 서랍의 'ledger' 한 칸 (백업 파일에 자동으로 함께 들어감)
  //   { entries: [내역], cats: { out: [], in: [], save: [] }, methods: [결제수단], cards: [카드] }
  //   내역 = { id, date, type: 'out'|'in'|'save', amount, cat, method, memo, createdAt }
  //   결제수단 = { id, name, cardId }   (cardId가 있으면 그 카드 실적에 더함)
  //   카드 = { id, name, target(월 실적 목표), startDay(실적 시작일, 기본 1), fee(연회비), feeMonth(청구 달 1~12) }
  // 실적: '지출' 내역만 셈 (저축·상환, 수입은 셈하지 않음)
  // =========================================
  const LG_TYPES = { out: '지출', in: '수입', save: '저축·상환' };
  const LG_DEFAULT_CATS = {
    out: ['식비', '카페·간식', '생활', '쇼핑', '교통', '주거·통신', '의료', '문화·여가', '경조사', '기타'],
    in: ['급여', '용돈', '환급', '기타 수입'],
    save: ['적금', '투자', '대출 상환']
  };
  let lg = null;
  let lgSaveChain = Promise.resolve();
  let lgMonth = todayStr.slice(0, 7);     // 보고 있는 달 'YYYY-MM'
  let lgEditing = null;                   // 고치는 내역 (새로 적을 때 null)
  let lgSheetCat = null;                  // 적기 창에서 고른 분류
  let lgCatTab = 'out';                   // 설정 창 분류 탭

  const lgId = (p) => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const won = (n) => Math.round(n).toLocaleString('ko-KR');

  function lgDefault() {
    const cats = {};
    Object.keys(LG_DEFAULT_CATS).forEach((t) => {
      cats[t] = LG_DEFAULT_CATS[t].map((name, i) => ({ id: 'lc-' + t + '-' + i, name: name }));
    });
    return { entries: [], cats: cats, methods: [{ id: 'lm-cash', name: '현금·계좌이체', cardId: null }], cards: [] };
  }

  async function loadLedger() {
    const saved = await DB.getSetting('ledger');
    lg = (saved && typeof saved === 'object' && Array.isArray(saved.entries)) ? saved : lgDefault();
    if (!lg.cats) lg.cats = lgDefault().cats;
    ['out', 'in', 'save'].forEach((t) => { if (!Array.isArray(lg.cats[t])) lg.cats[t] = []; });
    if (!Array.isArray(lg.methods)) lg.methods = [];
    if (!Array.isArray(lg.cards)) lg.cards = [];
    renderLedger();
  }

  function saveLedger() {
    const snapshot = JSON.parse(JSON.stringify(lg));
    lgSaveChain = lgSaveChain
      .then(() => DB.setSetting('ledger', snapshot))
      .catch((err) => showError('가계부를 저장하지 못했어요.', err));
    return lgSaveChain;
  }

  const lgCat = (type, id) => (lg.cats[type] || []).find((c) => c.id === id);
  const lgCatIndex = (type, id) => (lg.cats[type] || []).findIndex((c) => c.id === id);
  const lgMethod = (id) => lg.methods.find((m) => m.id === id);
  const lgCard = (id) => lg.cards.find((c) => c.id === id);

  function lgMonthEnd(ym) {
    const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    return ym + '-' + pad2(new Date(y, m, 0).getDate());
  }
  function lgShiftMonth(ym, n) {
    const y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
    const d = new Date(y, m, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }
  // 카드 실적 기간: 그 달 startDay일 ~ 다음 달 startDay-1일 (startDay 1이면 1일~말일)
  function lgCardRange(card, ym) {
    const sd = Math.min(28, Math.max(1, card.startDay || 1));
    const start = ym + '-' + pad2(sd);
    const end = DB.addDays(lgShiftMonth(ym, 1) + '-' + pad2(sd), -1);
    return { start: start, end: end };
  }

  function renderLedger() {
    if (!lg) return;
    const ym = lgMonth;
    const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    $('lg-month-title').textContent = y + '년 ' + m + '월';
    $('lg-this').hidden = ym === todayStr.slice(0, 7);
    const start = ym + '-01', end = lgMonthEnd(ym);
    $('lg-sum-range').textContent = m + '/1 ~ ' + m + '/' + (+end.slice(8));

    const list = lg.entries.filter((e) => e.date >= start && e.date <= end);
    let out = 0, inc = 0;
    const saveBy = new Map(), outBy = new Map();
    list.forEach((e) => {
      if (e.type === 'out') { out += e.amount; outBy.set(e.cat, (outBy.get(e.cat) || 0) + e.amount); }
      else if (e.type === 'in') inc += e.amount;
      else saveBy.set(e.cat, (saveBy.get(e.cat) || 0) + e.amount);
    });
    $('lg-total-out').textContent = won(out);
    $('lg-total-in').textContent = won(inc);

    const saveTotal = Array.from(saveBy.values()).reduce((a, b) => a + b, 0);
    const saveLine = $('lg-save-line');
    saveLine.hidden = saveTotal === 0;
    if (saveTotal) {
      const parts = Array.from(saveBy.entries()).sort((a, b) => b[1] - a[1])
        .map(([id, v]) => ((lgCat('save', id) || {}).name || '미분류') + ' ' + won(v));
      saveLine.textContent = '저축·상환 ' + won(saveTotal) + ' · ' + parts.join(' · ');
    }

    const cats = $('lg-cats');
    cats.innerHTML = '';
    Array.from(outBy.entries()).sort((a, b) => b[1] - a[1]).forEach(([id, v]) => {
      const sp = el('span', '', (lgCat('out', id) || {}).name || '미분류');
      sp.appendChild(el('i', '', won(v)));
      cats.appendChild(sp);
    });

    renderLedgerCards(ym);

    // 내역 (최근 날짜가 위)
    const box = $('lg-list');
    box.innerHTML = '';
    $('lg-empty').hidden = list.length > 0;
    $('lg-count').textContent = list.length ? list.length + '건' : '';
    const sorted = list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));
    let curDate = null, dayHead = null, daySum = 0;
    const flushDay = () => {
      if (dayHead) dayHead.lastChild.textContent = (daySum > 0 ? '+' : daySum < 0 ? '−' : '') + won(Math.abs(daySum));
    };
    sorted.forEach((e) => {
      if (e.date !== curDate) {
        flushDay();
        curDate = e.date;
        daySum = 0;
        const wd = '일월화수목금토'[new Date(+e.date.slice(0, 4), +e.date.slice(5, 7) - 1, +e.date.slice(8, 10)).getDay()];
        dayHead = el('p', 'lg-day');
        dayHead.append(el('span', '', (+e.date.slice(5, 7)) + '월 ' + (+e.date.slice(8, 10)) + '일 (' + wd + ')'), el('span', '', ''));
        box.appendChild(dayHead);
      }
      if (e.type === 'out') daySum -= e.amount;
      else if (e.type === 'in') daySum += e.amount;

      const cat = lgCat(e.type, e.cat);
      const idx = Math.max(0, lgCatIndex(e.type, e.cat));
      const row = el('button', 'lg-tx');
      row.type = 'button';
      row.dataset.id = e.id;
      const badge = el('span', 'lg-badge lg-b' + (e.type === 'save' ? 3 : e.type === 'in' ? 2 : idx % 5), cat ? lgBadgeText(cat.name) : '미분류');
      const mid = el('span', 'm');
      mid.appendChild(el('b', '', e.memo || (cat ? cat.name : LG_TYPES[e.type])));
      const method = lgMethod(e.method);
      mid.appendChild(el('span', '', (e.type === 'out' ? '' : LG_TYPES[e.type] + (method ? ' · ' : '')) + (method ? method.name : '')));
      const sign = e.type === 'in' ? '+' : '−';
      const amt = el('span', 'a' + (e.type === 'in' ? ' in' : e.type === 'save' ? ' save' : ''), sign + won(e.amount));
      row.append(badge, mid, amt);
      box.appendChild(row);
    });
    flushDay();
  }

  // 내역 앞 작은 표시: '카페·간식' → '카페', '대출 상환' → '대출상환' (최대 4글자)
  function lgBadgeText(name) {
    return name.split('·')[0].replace(/\s+/g, '').slice(0, 4);
  }

  function renderLedgerCards(ym) {
    const wrap = $('lg-cards');
    const fees = $('lg-fees');
    wrap.innerHTML = '';
    fees.innerHTML = '';
    $('lg-cards-card').hidden = lg.cards.length === 0;
    const m = +ym.slice(5, 7);
    const nextM = m === 12 ? 1 : m + 1;
    lg.cards.forEach((card) => {
      const r = lgCardRange(card, ym);
      const methodIds = new Set(lg.methods.filter((x) => x.cardId === card.id).map((x) => x.id));
      const used = lg.entries
        .filter((e) => e.type === 'out' && methodIds.has(e.method) && e.date >= r.start && e.date <= r.end)
        .reduce((a, e) => a + e.amount, 0);
      const target = card.target || 0;
      const ok = target > 0 && used >= target;
      const row = el('div', 'lg-cardrow' + (ok ? ' ok' : ''));
      const h = el('div', 'h');
      h.append(el('span', '', card.name), el('span', '', target ? won(used) + ' / ' + won(target) : won(used) + '원'));
      row.appendChild(h);
      if (target) {
        const bar = el('div', 'bar');
        const fill = el('i');
        fill.style.width = Math.min(100, used / target * 100) + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el('p', 's', ok ? '✓ 달성' : won(target - used) + '원 더 쓰면 달성'));
      }
      if ((card.startDay || 1) !== 1) {
        row.appendChild(el('p', 's', '실적 기간 ' + shortDate(r.start) + ' ~ ' + shortDate(r.end)));
      }
      wrap.appendChild(row);

      if (card.fee && card.feeMonth) {
        let when = null;
        if (card.feeMonth === m) when = '이 달에';
        else if (card.feeMonth === nextM) when = '다음 달(' + nextM + '월)에';
        if (when) fees.appendChild(el('p', 'lg-fee', '연회비 · ' + card.name + ' ' + won(card.fee) + '원이 ' + when + ' 청구돼요'));
      }
    });
  }

  function moveLedgerMonth(n) {
    lgMonth = n === 0 ? todayStr.slice(0, 7) : lgShiftMonth(lgMonth, n);
    renderLedger();
  }

  // ----- 적기·고치기 창 -----
  function lgType() {
    const r = document.querySelector('input[name="lg-type"]:checked');
    return r ? r.value : 'out';
  }

  function renderLgSheetCats() {
    const type = lgType();
    const wrap = $('lg-f-cats');
    wrap.innerHTML = '';
    if (!lgCat(type, lgSheetCat)) lgSheetCat = null;
    (lg.cats[type] || []).forEach((c) => {
      const b = el('button', 'chip' + (c.id === lgSheetCat ? ' active' : ''), c.name);
      b.type = 'button';
      b.dataset.cat = c.id;
      wrap.appendChild(b);
    });
    // 결제수단: 수입에는 숨김
    $('lg-f-method-field').hidden = type === 'in';
  }

  function fillLgMethods(selected) {
    const sel = $('lg-f-method');
    sel.innerHTML = '';
    const none = el('option', '', '선택 안 함');
    none.value = '';
    sel.appendChild(none);
    lg.methods.forEach((mt) => {
      const o = el('option', '', mt.name);
      o.value = mt.id;
      sel.appendChild(o);
    });
    sel.value = selected && lgMethod(selected) ? selected : '';
  }

  function openLedgerSheet(entry) {
    if (!lg) return;
    lgEditing = entry || null;
    hideToast();
    const e = entry || { type: 'out', amount: '', cat: null, method: lg.lastMethod || '', date: lgDefaultDate(), memo: '' };
    $('lg-sheet-title').textContent = entry ? '내역 고치기' : '내역 적기';
    document.querySelectorAll('input[name="lg-type"]').forEach((r) => { r.checked = r.value === e.type; });
    $('lg-f-amount').value = e.amount ? won(e.amount) : '';
    lgSheetCat = e.cat;
    renderLgSheetCats();
    fillLgMethods(e.method);
    $('lg-f-date').value = e.date;
    $('lg-f-memo').value = e.memo || '';
    $('lg-delete').hidden = !entry;
    $('sheet-backdrop').classList.add('open');
    $('ledger-sheet').classList.add('open');
    $('ledger-sheet').scrollTop = 0;
    if (!entry) setTimeout(() => $('lg-f-amount').focus(), 60);
  }

  // 새 내역 날짜: 이번 달을 보고 있으면 오늘, 다른 달이면 그 달 1일
  function lgDefaultDate() {
    return lgMonth === todayStr.slice(0, 7) ? todayStr : lgMonth + '-01';
  }

  function onLgAmountInput() {
    const input = $('lg-f-amount');
    const digits = input.value.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '');
    input.value = digits ? won(+digits) : '';
  }

  async function submitLedgerSheet(ev) {
    ev.preventDefault();
    const amount = +$('lg-f-amount').value.replace(/[^\d]/g, '');
    if (!amount) { shake($('lg-f-amount')); return; }
    const date = $('lg-f-date').value;
    if (!date) { shake($('lg-f-date')); return; }
    const type = lgType();
    const method = type === 'in' ? null : ($('lg-f-method').value || null);
    const data = {
      date: date,
      type: type,
      amount: amount,
      cat: lgSheetCat,
      method: method,
      memo: $('lg-f-memo').value.trim()
    };
    if (lgEditing) {
      Object.assign(lgEditing, data);
    } else {
      lg.entries.push(Object.assign({ id: lgId('le'), createdAt: new Date().toISOString() }, data));
      if (method) lg.lastMethod = method;      // 다음에 적을 때 같은 결제수단을 먼저 골라 둠
    }
    // 적은 날짜의 달로 이동해서 바로 보이게
    lgMonth = date.slice(0, 7);
    closeSheet();
    renderLedger();
    await saveLedger();
  }

  async function deleteLedgerEntry() {
    if (!lgEditing) return;
    const target = lgEditing;
    lg.entries = lg.entries.filter((e) => e !== target);
    closeSheet();
    renderLedger();
    await saveLedger();
    showToast('내역을 지웠어요', '되돌리기', () => {
      lg.entries.push(target);
      renderLedger();
      saveLedger();
    });
  }

  // ----- 가계부 설정 창 -----
  function openLedgerSettings() {
    if (!lg) return;
    hideToast();
    renderLgSettings();
    $('sheet-backdrop').classList.add('open');
    $('ledger-settings-sheet').classList.add('open');
    $('ledger-settings-sheet').scrollTop = 0;
  }

  function renderLgSettings() {
    renderLgCardList();
    renderLgMethodList();
    renderLgCatList();
  }

  // 이름 칸: 빈칸이면 원래대로, Enter로 확정
  function lgNameInput(value, label, onSave) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sheet-input cat-name';
    input.value = value;
    input.maxLength = 24;
    input.setAttribute('enterkeyhint', 'done');
    input.setAttribute('aria-label', label);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    input.addEventListener('blur', () => {
      const v = input.value.trim();
      if (!v) { input.value = value; return; }
      if (v !== value) { value = v; onSave(v); }
    });
    return input;
  }

  function lgNumberField(labelText, value, attrs, onSave) {
    const wrap = el('div');
    const id = lgId('lf');
    const lab = el('label', '', labelText);
    lab.htmlFor = id;
    const input = document.createElement('input');
    input.id = id;
    input.className = 'sheet-input';
    input.inputMode = 'numeric';
    input.type = 'text';
    input.value = value ? (attrs.money ? won(value) : String(value)) : '';
    input.placeholder = attrs.placeholder || '';
    if (attrs.money) input.addEventListener('input', () => {
      const d = input.value.replace(/[^\d]/g, '');
      input.value = d ? won(+d) : '';
    });
    input.addEventListener('change', () => {
      let n = +input.value.replace(/[^\d]/g, '') || 0;
      if (attrs.max) n = Math.min(attrs.max, n);
      if (attrs.min && n) n = Math.max(attrs.min, n);
      input.value = n ? (attrs.money ? won(n) : String(n)) : '';
      onSave(n || null);
    });
    wrap.append(lab, input);
    return wrap;
  }

  function lgAfterSettingChange() {
    renderLedger();
    saveLedger();
  }

  function renderLgCardList() {
    const box = $('lg-card-list');
    box.innerHTML = '';
    lg.cards.forEach((card) => {
      const b = el('div', 'lg-card-box');
      const row = el('div', 'cat-row');
      row.appendChild(lgNameInput(card.name, '카드 이름', (v) => { card.name = v; lgAfterSettingChange(); }));
      const del = el('button', 'btn btn-danger cat-del', '삭제');
      del.type = 'button';
      del.addEventListener('click', () => {
        if (!confirm('\'' + card.name + '\' 카드를 지울까요? 적어 둔 내역은 그대로 남고, 이 카드에 연결된 결제수단은 연결만 풀려요.')) return;
        lg.cards = lg.cards.filter((c) => c !== card);
        lg.methods.forEach((mt) => { if (mt.cardId === card.id) mt.cardId = null; });
        renderLgSettings();
        lgAfterSettingChange();
      });
      row.appendChild(del);
      b.appendChild(row);

      const grid = el('div', 'lg-card-grid');
      grid.appendChild(lgNumberField('월 실적 목표 (원)', card.target, { money: true, placeholder: '300,000' }, (n) => { card.target = n; lgAfterSettingChange(); }));
      grid.appendChild(lgNumberField('실적 시작일 (매월)', card.startDay || 1, { min: 1, max: 28 }, (n) => { card.startDay = n || 1; lgAfterSettingChange(); }));
      grid.appendChild(lgNumberField('연회비 (원)', card.fee, { money: true, placeholder: '15,000' }, (n) => { card.fee = n; lgAfterSettingChange(); }));
      grid.appendChild(lgNumberField('연회비 청구 달', card.feeMonth, { min: 1, max: 12, placeholder: '예: 3' }, (n) => { card.feeMonth = n; lgAfterSettingChange(); }));
      b.appendChild(grid);
      box.appendChild(b);
    });
  }

  function addLgCard(ev) {
    ev.preventDefault();
    const input = $('lg-card-add-input');
    const name = input.value.trim();
    if (!name) { shake(input); return; }
    const card = { id: lgId('lk'), name: name, target: null, startDay: 1, fee: null, feeMonth: null };
    lg.cards.push(card);
    if (!lg.methods.some((mt) => mt.name === name)) lg.methods.push({ id: lgId('lm'), name: name, cardId: card.id });
    input.value = '';
    renderLgSettings();
    lgAfterSettingChange();
  }

  function renderLgMethodList() {
    const list = $('lg-method-list');
    list.innerHTML = '';
    lg.methods.forEach((mt, i) => {
      const li = el('li', 'cat-row');
      li.appendChild(lgNameInput(mt.name, '결제수단 이름', (v) => { mt.name = v; lgAfterSettingChange(); }));
      const sel = el('select', 'sheet-input lg-method-card');
      sel.setAttribute('aria-label', mt.name + ' 연결 카드');
      const none = el('option', '', '카드 연결 안 함');
      none.value = '';
      sel.appendChild(none);
      lg.cards.forEach((c) => {
        const o = el('option', '', c.name);
        o.value = c.id;
        sel.appendChild(o);
      });
      sel.value = mt.cardId && lgCard(mt.cardId) ? mt.cardId : '';
      sel.addEventListener('change', () => { mt.cardId = sel.value || null; lgAfterSettingChange(); });
      li.appendChild(sel);
      const up = el('button', 'cat-btn', '↑');
      up.type = 'button';
      up.disabled = i === 0;
      up.setAttribute('aria-label', mt.name + ' 위로');
      up.addEventListener('click', () => { lgMove(lg.methods, i, -1); renderLgMethodList(); lgAfterSettingChange(); });
      li.appendChild(up);
      const del = el('button', 'btn btn-danger cat-del', '삭제');
      del.type = 'button';
      del.addEventListener('click', () => {
        const n = lg.entries.filter((e) => e.method === mt.id).length;
        if (n && !confirm('\'' + mt.name + '\'(으)로 적은 내역이 ' + n + '건 있어요. 지우면 그 내역의 결제수단은 비어요. 지울까요?')) return;
        lg.methods = lg.methods.filter((x) => x !== mt);
        lg.entries.forEach((e) => { if (e.method === mt.id) e.method = null; });
        if (lg.lastMethod === mt.id) lg.lastMethod = null;
        renderLgMethodList();
        lgAfterSettingChange();
      });
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  function addLgMethod(ev) {
    ev.preventDefault();
    const input = $('lg-method-add-input');
    const name = input.value.trim();
    if (!name) { shake(input); return; }
    lg.methods.push({ id: lgId('lm'), name: name, cardId: null });
    input.value = '';
    renderLgMethodList();
    lgAfterSettingChange();
  }

  function lgMove(arr, i, d) {
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }

  function renderLgCatList() {
    document.querySelectorAll('#lg-cat-tabs .seg-tab').forEach((b) => b.classList.toggle('active', b.dataset.type === lgCatTab));
    const list = $('lg-cat-list');
    list.innerHTML = '';
    const arr = lg.cats[lgCatTab];
    arr.forEach((c, i) => {
      const li = el('li', 'cat-row');
      li.appendChild(lgNameInput(c.name, '분류 이름', (v) => { c.name = v; lgAfterSettingChange(); }));
      const up = el('button', 'cat-btn', '↑');
      up.type = 'button';
      up.disabled = i === 0;
      up.setAttribute('aria-label', c.name + ' 위로');
      up.addEventListener('click', () => { lgMove(arr, i, -1); renderLgCatList(); lgAfterSettingChange(); });
      const down = el('button', 'cat-btn', '↓');
      down.type = 'button';
      down.disabled = i === arr.length - 1;
      down.setAttribute('aria-label', c.name + ' 아래로');
      down.addEventListener('click', () => { lgMove(arr, i, 1); renderLgCatList(); lgAfterSettingChange(); });
      const del = el('button', 'btn btn-danger cat-del', '삭제');
      del.type = 'button';
      del.addEventListener('click', () => {
        const n = lg.entries.filter((e) => e.type === lgCatTab && e.cat === c.id).length;
        if (n && !confirm('\'' + c.name + '\'(으)로 적은 내역이 ' + n + '건 있어요. 지우면 그 내역은 \'미분류\'가 돼요. 지울까요?')) return;
        lg.cats[lgCatTab] = arr.filter((x) => x !== c);
        renderLgCatList();
        lgAfterSettingChange();
      });
      li.append(up, down, del);
      list.appendChild(li);
    });
  }

  function addLgCat(ev) {
    ev.preventDefault();
    const input = $('lg-cat-add-input');
    const name = input.value.trim();
    if (!name) { shake(input); return; }
    if (lg.cats[lgCatTab].some((c) => c.name === name)) { showToast('같은 이름의 분류가 이미 있어요'); return; }
    lg.cats[lgCatTab].push({ id: lgId('lc'), name: name });
    input.value = '';
    renderLgCatList();
    lgAfterSettingChange();
  }

  // =========================================
  // 일기 (기록 탭의 '일기')
  // 저장 위치: 설정 서랍의 'diary' 한 칸 (백업 파일에 자동으로 함께 들어감)
  //   { entries: { 'YYYY-MM-DD': { mood(v40~42에 고른 기분, 지금은 안 보임), text, updatedAt } } }   하루 한 편
  // 쓰기 칸의 내용은 '저장'을 눌러야 남음
  // =========================================
  const MOODS = [
    { id: 1, name: '아주 좋음' }, { id: 2, name: '좋음' }, { id: 3, name: '그저 그럼' },
    { id: 4, name: '슬픔' }, { id: 5, name: '화남' }
  ];
  let diary = null;
  let diarySaveChain = Promise.resolve();
  let diaryDate = null;              // 쓰기 칸의 날짜 (null이면 오늘)
  let diaryMood = null;              // 쓰기 칸에서 고른 기분
  let diaryOpen = new Set();         // '더 보기'로 펼친 날짜

  async function loadDiary() {
    const saved = await DB.getSetting('diary');
    diary = (saved && typeof saved === 'object' && saved.entries && typeof saved.entries === 'object')
      ? saved : { entries: {} };
  }

  function saveDiary() {
    const snapshot = JSON.parse(JSON.stringify(diary));
    diarySaveChain = diarySaveChain
      .then(() => DB.setSetting('diary', snapshot))
      .catch((err) => showError('일기를 저장하지 못했어요.', err));
    return diarySaveChain;
  }

  // ----- 임시 저장 (저장 버튼을 누르기 전의 글) -----
  // 휴대폰이 앱을 갑자기 꺼도 남도록, 바로 기록되는 브라우저 저장소(localStorage)에 날짜별로 둠.
  // 이 기기에만 남는 임시 글이라 백업 파일에는 들어가지 않음
  const DIARY_DRAFT_KEY = 'oneul-diary-drafts';
  let diaryDraftBox = null;          // 지금 화면의 쓰기 칸 { date, ta, savedText }
  let diaryDraftTimer = null;

  function readDiaryDrafts() {
    try { return JSON.parse(localStorage.getItem(DIARY_DRAFT_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function getDiaryDraft(date) {
    const d = readDiaryDrafts()[date];
    return d && typeof d.text === 'string' ? d.text : null;
  }
  function setDiaryDraft(date, text) {
    try {
      const all = readDiaryDrafts();
      if (text === null) delete all[date];
      else all[date] = { text: text, at: new Date().toISOString() };
      localStorage.setItem(DIARY_DRAFT_KEY, JSON.stringify(all));
    } catch (e) { /* 저장소를 못 쓰는 환경이면 임시 저장만 건너뜀 */ }
  }
  // 쓰기 칸의 글을 임시로 남김 (저장된 글과 같으면 임시 글 지움)
  function flushDiaryDraft() {
    clearTimeout(diaryDraftTimer);
    const box = diaryDraftBox;
    if (!box || !box.ta.isConnected) return;
    const text = box.ta.value;
    setDiaryDraft(box.date, text === box.savedText || (!text.trim() && !box.savedText) ? null : text);
  }
  // 앱이 뒤로 가거나 닫힐 때 바로 남김
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDiaryDraft(); });
  window.addEventListener('pagehide', flushDiaryDraft);

  function moodIcon(id, size) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'mood-ic mood-c' + id);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-mood' + id);
    svg.appendChild(use);
    return svg;
  }

  function diaryDateLabel(d) {
    const wd = '일월화수목금토'[new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)).getDay()];
    return (+d.slice(5, 7)) + '월 ' + (+d.slice(8, 10)) + '일 (' + wd + ')';
  }

  // 기록 탭 '일기'에 들어갈 카드 2장: 쓰기 칸 + 이 달의 일기
  async function renderDiaryCards() {
    flushDiaryDraft();                 // 화면을 다시 그리기 전에 쓰던 글을 남겨 둠
    if (!diary) await loadDiary();
    const date = diaryDate || todayStr;
    const saved = diary.entries[date];
    return [diaryWriteCard(date, saved), diaryListCard()];
  }

  function diaryWriteCard(date, saved) {
    const card = el('div', 'card diary-write');
    const head = el('h2', 'card-title pik-title');
    head.appendChild(el('span', '', date === todayStr ? '오늘의 일기' : (+date.slice(5, 7)) + '월 ' + (+date.slice(8, 10)) + '일 일기'));
    // 날짜 고르기: 글자 위에 투명한 날짜 칸을 겹쳐서, 누르면 휴대폰 달력이 열림
    const pickWrap = el('label', 'diary-date');
    pickWrap.appendChild(el('span', '', diaryDateLabel(date) + ' ▾'));
    const pick = document.createElement('input');
    pick.type = 'date';
    pick.value = date;
    pick.max = todayStr;
    pick.setAttribute('aria-label', '일기 날짜 고르기');
    pick.addEventListener('change', () => {
      if (!pick.value) return;
      diaryDate = pick.value > todayStr ? todayStr : pick.value;
      diaryMood = null;
      loadReview().catch((err) => showError('기록을 불러오지 못했어요.', err));
    });
    pickWrap.appendChild(pick);
    head.appendChild(pickWrap);
    card.appendChild(head);

    // v43: 기분 얼굴은 없앰 (이모지는 글 안에 직접 씀). 예전에 고른 기분은 저장된 그대로 둠
    diaryMood = saved ? (saved.mood || null) : null;

    const ta = document.createElement('textarea');
    ta.className = 'sheet-input diary-text';
    ta.id = 'diary-text';
    ta.rows = 4;
    ta.placeholder = '오늘 있었던 일을 적어 보세요';
    ta.value = saved ? saved.text : '';
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight, 96) + 'px'; };
    ta.addEventListener('input', grow);

    // 임시 저장: 저장 안 한 글이 남아 있으면 불러오고, 쓰는 동안 계속 임시로 남겨 둠
    const draft = getDiaryDraft(date);
    if (draft !== null && draft !== ta.value) {
      ta.value = draft;
      const note = el('div', 'diary-draft-note');
      note.appendChild(el('span', '', '저장 안 한 글을 불러왔어요'));
      const drop = el('button', 'diary-draft-drop', '임시 글 버리기');
      drop.type = 'button';
      drop.addEventListener('click', () => {
        clearTimeout(diaryDraftTimer);
        diaryDraftBox = null;
        setDiaryDraft(date, null);
        loadReview().catch((err) => showError('기록을 불러오지 못했어요.', err));
      });
      note.appendChild(drop);
      card.appendChild(note);
    }
    diaryDraftBox = { date: date, ta: ta, savedText: saved ? saved.text : '' };
    ta.addEventListener('input', () => {
      clearTimeout(diaryDraftTimer);
      diaryDraftTimer = setTimeout(flushDiaryDraft, 800);
    });
    setTimeout(grow, 0);
    card.appendChild(ta);

    const row = el('div', 'diary-actions');
    if (saved) {
      const del = el('button', 'btn btn-danger', '지우기');
      del.type = 'button';
      del.addEventListener('click', () => deleteDiary(date));
      row.appendChild(del);
    }
    row.appendChild(el('span', 'spacer'));
    const save = el('button', 'btn btn-primary', '저장');
    save.type = 'button';
    save.addEventListener('click', () => submitDiary(date, ta));
    row.appendChild(save);
    card.appendChild(row);
    return card;
  }

  function diaryListCard() {
    const prefix = reviewYear + '-' + pad2(reviewMonth) + '-';
    const dates = Object.keys(diary.entries).filter((d) => d.startsWith(prefix)).sort().reverse();
    const card = el('div', 'card diary-list');
    const head = el('h2', 'card-title pik-title');
    head.appendChild(el('span', '', reviewMonth + '월의 일기'));
    head.appendChild(el('small', '', dates.length ? dates.length + '편' : ''));
    card.appendChild(head);
    if (!dates.length) {
      card.appendChild(el('p', 'empty', '이 달에 쓴 일기가 없어요'));
      return card;
    }
    dates.forEach((d) => {
      const e = diary.entries[d];
      const row = el('div', 'diary-entry' + (d === (diaryDate || todayStr) ? ' is-editing' : ''));
      const side = el('button', 'diary-day');
      side.type = 'button';
      side.setAttribute('aria-label', diaryDateLabel(d) + ' 일기 고치기');
      side.appendChild(el('b', '', String(+d.slice(8, 10))));
      side.appendChild(el('small', '', '일월화수목금토'[new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)).getDay()]));
      side.addEventListener('click', () => editDiaryDate(d));
      const body = el('div', 'diary-body');
      const p = el('p', 'diary-p' + (diaryOpen.has(d) ? '' : ' clip'), e.text || '(내용 없음)');
      body.appendChild(p);
      const more = el('button', 'diary-more', diaryOpen.has(d) ? '접기' : '더 보기');
      more.type = 'button';
      more.hidden = true;
      more.addEventListener('click', () => {
        if (diaryOpen.has(d)) diaryOpen.delete(d); else diaryOpen.add(d);
        const open = diaryOpen.has(d);
        p.classList.toggle('clip', !open);
        more.textContent = open ? '접기' : '더 보기';
      });
      body.appendChild(more);
      // 3줄을 넘는 일기에만 '더 보기' 표시 (화면에 그려진 뒤에 높이를 재야 알 수 있음)
      requestAnimationFrame(() => {
        if (diaryOpen.has(d) || p.scrollHeight > p.clientHeight + 2) more.hidden = false;
      });
      p.addEventListener('click', () => editDiaryDate(d));
      row.append(side, body);
      card.appendChild(row);
    });
    return card;
  }

  function editDiaryDate(d) {
    diaryDate = d === todayStr ? null : d;
    diaryMood = null;
    loadReview()
      .then(() => {
        const box = document.querySelector('.diary-write');
        if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch((err) => showError('기록을 불러오지 못했어요.', err));
  }

  async function submitDiary(date, ta) {
    const text = ta.value.replace(/\s+$/, '');
    if (!text.trim()) { shake(ta); return; }
    diary.entries[date] = { mood: diaryMood, text: text, updatedAt: new Date().toISOString() };
    clearTimeout(diaryDraftTimer);
    diaryDraftBox = null;
    setDiaryDraft(date, null);          // 저장했으니 임시 글은 지움
    // 다른 달 날짜에 썼으면 그 달 목록으로 이동
    reviewYear = +date.slice(0, 4);
    reviewMonth = +date.slice(5, 7);
    await saveDiary();
    await loadReview();
    showToast('일기를 저장했어요');
  }

  async function deleteDiary(date) {
    const old = diary.entries[date];
    if (!old) return;
    if (!confirm(diaryDateLabel(date) + ' 일기를 지울까요?')) return;
    delete diary.entries[date];
    diaryDraftBox = null;
    setDiaryDraft(date, null);
    diaryMood = null;
    await saveDiary();
    await loadReview();
    showToast('일기를 지웠어요', '되돌리기', async () => {
      diary.entries[date] = old;
      diaryMood = null;
      await saveDiary();
      await loadReview();
    });
  }

  // ---------- 홈 화면 앱(PWA) ----------
  // 서비스 워커(sw.js) 등록: 인터넷이 되면 항상 최신 파일, 안 되면 보관한 파일로 열림
  // 실패해도 앱 사용에는 지장 없음 (그냥 일반 웹페이지처럼 동작)
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('서비스 워커 등록 실패', err);
    });
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
        setTrackerArchived(trackerEditing.kind, item, !isTrackerArchived(item));
      }
    });
    $('tracker-delete').addEventListener('click', () => {
      if (trackerEditing) deleteTrackerFully(trackerEditing.kind, trackerEditing.item);
    });
    // 카드 제목 옆 + 버튼: 누르면 추가 줄이 열리고, 다시 누르면 닫힘
    document.querySelectorAll('.add-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const form = $(btn.dataset.form);
        const willOpen = form.hidden;
        form.hidden = !willOpen;
        btn.setAttribute('aria-expanded', String(willOpen));
        if (willOpen) {
          const input = form.querySelector('input');
          if (input) input.focus();
        }
      });
    });
    $('mission-add-form').addEventListener('submit', addMission);
    $('mission-archived-toggle').addEventListener('click', () => {
      missionArchivedOpen = !missionArchivedOpen;
      renderMissions();
    });

    // 피크민
    $('pik-new').addEventListener('click', () => openPikSheet(false));
    $('pik-new2').addEventListener('click', () => openPikSheet(false));
    $('pik-edit').addEventListener('click', () => openPikSheet(true));
    $('pik-minus').addEventListener('click', () => changePikToday(-1));
    $('pik-plus').addEventListener('click', () => changePikToday(1));
    $('pik-stages').addEventListener('click', onPikStagesClick);
    $('pikmin-sheet').addEventListener('submit', submitPikSheet);
    $('pik-cancel').addEventListener('click', closeSheet);
    $('pik-delete').addEventListener('click', deletePikEvent);
    $('pik-f-text').addEventListener('input', renderPikParse);

    // 가계부
    $('lg-prev').addEventListener('click', () => moveLedgerMonth(-1));
    $('lg-next').addEventListener('click', () => moveLedgerMonth(1));
    $('lg-this').addEventListener('click', () => moveLedgerMonth(0));
    $('lg-list').addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (row && lg) openLedgerSheet(lg.entries.find((x) => x.id === row.dataset.id));
    });
    $('ledger-sheet').addEventListener('submit', submitLedgerSheet);
    $('lg-cancel').addEventListener('click', closeSheet);
    $('lg-delete').addEventListener('click', deleteLedgerEntry);
    $('lg-f-amount').addEventListener('input', onLgAmountInput);
    $('lg-f-amount').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }   // 엔터로 바로 저장되지 않게 (휴대폰 키보드만 닫힘)
    });
    $('lg-f-memo').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });
    document.querySelectorAll('input[name="lg-type"]').forEach((r) => r.addEventListener('change', renderLgSheetCats));
    $('lg-f-cats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      lgSheetCat = lgSheetCat === b.dataset.cat ? null : b.dataset.cat;   // 한 번 더 누르면 선택 해제
      renderLgSheetCats();
    });
    $('lg-open-settings').addEventListener('click', openLedgerSettings);
    $('lg-settings-close').addEventListener('click', closeSheet);
    $('lg-card-add').addEventListener('submit', addLgCard);
    $('lg-method-add').addEventListener('submit', addLgMethod);
    $('lg-cat-add').addEventListener('submit', addLgCat);
    document.querySelectorAll('#lg-cat-tabs .seg-tab').forEach((b) => b.addEventListener('click', () => {
      lgCatTab = b.dataset.type;
      renderLgCatList();
    }));

    // 백업·복원
    $('open-data').addEventListener('click', openDataSheet);
    $('data-close').addEventListener('click', closeSheet);
    $('cat-add-form').addEventListener('submit', addCategory);

    // 체크리스트 (수정창 안)
    $('checklist-add-btn').addEventListener('click', addChecklistItem);
    $('checklist-add-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addChecklistItem(); }   // 엔터로 창 전체가 저장되지 않게
    });

    // 할 일 검색
    $('task-search').addEventListener('input', onSearchInput);
    $('task-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }      // 휴대폰 키보드 닫기
    });
    $('task-search-clear').addEventListener('click', clearSearch);
    $('data-export').addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      await exportBackup();
      busy = false;
    });
    $('data-file').addEventListener('change', onBackupFilePicked);
    $('restore-backup-first').addEventListener('click', backupBeforeRestore);
    $('restore-run').addEventListener('click', runRestore);
    $('restore-cancel').addEventListener('click', hideRestorePanel);

    // 리뷰
    document.querySelectorAll('#review-tabs .seg-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        reviewTab = btn.dataset.tab;
        loadReview().catch((err) => showError('기록을 불러오지 못했어요.', err));
      });
    });
    $('review-prev').addEventListener('click', () => moveReviewMonth(-1));
    $('review-next').addEventListener('click', () => moveReviewMonth(1));
    $('review-this').addEventListener('click', () => moveReviewMonth(0));
    $('edit-undone').addEventListener('click', undoneEditing);
    $('edit-unskip').addEventListener('click', unskipEditing);

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
    document.querySelectorAll('.clear-btn[data-clear]').forEach((btn) => {   // 날짜·시간 칸의 ✕만
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
      registerServiceWorker();
      categories = await DB.getCategories();
      renderFilterChips();
      await reloadAll();
    } catch (err) {
      showError('데이터를 불러오지 못했어요. 브라우저의 시크릿 모드에서는 저장이 안 될 수 있어요.', err);
    }
  }

  init();

})();
