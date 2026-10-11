// =========================================
// app.js - 화면 전환 및 사용자 동작
// =========================================
'use strict';

(function () {

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

  function showError(message, err) {
    if (err) console.error(err);
    alert('⚠️ ' + message);
  }

  // ---------- 공통 도우미 ----------
  function fillList(listEl, items) {
    listEl.innerHTML = '';
    items.forEach((el) => listEl.appendChild(el));
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

    // '+' 버튼은 오늘 화면에서만 보임
    $('fab-add').hidden = name !== 'today';
    if (name !== 'today') closeSheet();

    window.scrollTo(0, 0);
  }

  // ---------- 할 일 한 줄 만들기 ----------
  function createTaskItem(item) {
    const occ = item.occurrence;
    const isDone = occ.status === 'done';

    const li = document.createElement('li');
    li.className = 'task-item' + (isDone ? ' is-done' : '');

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'check';
    check.setAttribute('aria-label', isDone ? '완료 취소' : '완료');
    check.textContent = isDone ? '✓' : '';
    check.addEventListener('click', () => toggleDone(occ.id));

    // 시간 지정 일정이면 시간 표시
    if (occ.time) {
      const time = document.createElement('span');
      time.className = 'task-time';
      time.textContent = occ.time;
      li.appendChild(check);
      li.appendChild(time);
    } else {
      li.appendChild(check);
    }

    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = item.task.title;   // textContent 사용: 입력한 글자가 HTML로 해석되지 않음

    li.appendChild(title);
    return li;
  }

  // ---------- 오늘 화면 그리기 ----------
  function renderToday() {
    const byCreated = (a, b) => a.occurrence.createdAt.localeCompare(b.occurrence.createdAt);

    const pending = todayItems.filter((it) => it.occurrence.status === 'pending');
    const done = todayItems
      .filter((it) => it.occurrence.status === 'done')
      .sort(byCreated);

    // 시간 지정 일정: 시간순 (시간 입력 기능은 3단계에서 추가)
    const timed = pending
      .filter((it) => it.occurrence.time)
      .sort((a, b) => a.occurrence.time.localeCompare(b.occurrence.time) || byCreated(a, b));
    const untimed = pending
      .filter((it) => !it.occurrence.time)
      .sort(byCreated);

    fillList($('list-timed'), timed.map(createTaskItem));
    $('empty-timed').hidden = timed.length > 0;

    fillList($('list-untimed'), untimed.map(createTaskItem));
    $('empty-untimed').hidden = untimed.length > 0;

    fillList($('list-done'), done.map(createTaskItem));
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

  async function toggleDone(occurrenceId) {
    if (busy) return;
    const item = todayItems.find((it) => it.occurrence.id === occurrenceId);
    if (!item) return;

    const makeDone = item.occurrence.status !== 'done';
    busy = true;
    try {
      // 실제 완료일은 오늘 날짜로 기록 (수정 기능은 3단계에서 추가)
      await DB.setOccurrenceDone(occurrenceId, makeDone, todayStr);
      await loadToday();
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

  // ---------- 빠른 추가 입력창 ----------
  function openSheet() {
    const input = $('quick-add-input');
    input.value = '';
    $('sheet-backdrop').classList.add('open');
    $('quick-add-sheet').classList.add('open');
    // 입력창이 보이기 시작한 뒤에 커서를 넣어야 키보드가 안정적으로 열림
    setTimeout(() => input.focus(), 60);
  }

  function closeSheet() {
    const input = $('quick-add-input');
    input.value = '';     // 취소하면 저장하지 않음
    input.blur();
    $('sheet-backdrop').classList.remove('open');
    $('quick-add-sheet').classList.remove('open');
  }

  function isSheetOpen() {
    return $('quick-add-sheet').classList.contains('open');
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
      await loadToday();
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
      loadToday().catch((err) => showError('오늘 목록을 불러오지 못했어요.', err));
    }
  }

  // ---------- 시작 ----------
  async function init() {
    renderDate();
    renderToday();          // 데이터를 불러오기 전에 빈 화면부터 표시
    showScreen('today');

    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => showScreen(btn.dataset.target));
    });

    $('fab-add').addEventListener('click', openSheet);
    $('quick-add-cancel').addEventListener('click', closeSheet);
    $('sheet-backdrop').addEventListener('click', closeSheet);
    $('quick-add-sheet').addEventListener('submit', submitQuickAdd);
    $('quick-add-input').addEventListener('animationend', (e) => {
      e.target.classList.remove('shake');
    });
    $('done-toggle').addEventListener('click', toggleDoneList);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isSheetOpen()) closeSheet();
    });

    // 다른 앱을 보다가 돌아왔을 때 날짜가 바뀌었는지 확인
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshIfDateChanged();
    });

    // 저장소 연결 후 오늘 데이터 불러오기
    try {
      await DB.open();
      DB.requestPersist();   // 결과를 기다리지 않음 (실패해도 앱 사용에 지장 없음)
      await loadToday();
    } catch (err) {
      showError('데이터를 불러오지 못했어요. 브라우저의 시크릿 모드에서는 저장이 안 될 수 있어요.', err);
    }
  }

  init();

})();
