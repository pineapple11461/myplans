// =========================================
// app.js - 화면 전환 및 사용자 동작
// =========================================
'use strict';

(function () {

  const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const SCREENS = ['today', 'tasks', 'calendar', 'tracker', 'review'];

  const $ = (id) => document.getElementById(id);

  // -----------------------------------------
  // [1단계 임시] 메모리에만 저장되는 할 일 목록
  // 새로고침하면 사라짐. 2~3단계에서 IndexedDB(db.js)로 교체 예정.
  // 오늘 화면에서 추가한 할 일은 '오늘 날짜'를 가진 할 일로 취급함.
  // -----------------------------------------
  let tempTasks = [];
  let nextTempId = 1;

  let doneExpanded = false;   // 완료 목록 펼침 상태

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
  function createTaskItem(task) {
    const li = document.createElement('li');
    li.className = 'task-item' + (task.done ? ' is-done' : '');

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'check';
    check.setAttribute('aria-label', task.done ? '완료 취소' : '완료');
    check.textContent = task.done ? '✓' : '';
    check.addEventListener('click', () => toggleDone(task.id));

    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;   // textContent 사용: 입력한 글자가 HTML로 해석되지 않음

    li.appendChild(check);
    li.appendChild(title);
    return li;
  }

  // ---------- 오늘 화면 그리기 ----------
  function renderToday() {
    // 시간 지정 일정: 시간 설정 기능은 3단계에서 추가. 지금은 항상 비어 있음.
    fillList($('list-timed'), []);
    $('empty-timed').hidden = false;

    const pending = tempTasks.filter((t) => !t.done);
    const done = tempTasks.filter((t) => t.done);

    fillList($('list-untimed'), pending.map(createTaskItem));
    $('empty-untimed').hidden = pending.length > 0;

    fillList($('list-done'), done.map(createTaskItem));
    $('done-count').textContent = String(done.length);
    $('done-card').hidden = done.length === 0;
    if (done.length === 0) doneExpanded = false;
    $('list-done').hidden = !doneExpanded;
    $('done-toggle').setAttribute('aria-expanded', String(doneExpanded));
  }

  function toggleDone(id) {
    const task = tempTasks.find((t) => t.id === id);
    if (!task) return;
    task.done = !task.done;
    renderToday();
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

  function submitQuickAdd(event) {
    event.preventDefault();   // 폼 제출로 페이지가 새로고침되는 것을 막음
    const input = $('quick-add-input');
    const title = input.value.trim();

    if (!title) {
      input.classList.remove('shake');
      void input.offsetWidth;          // 애니메이션 다시 시작
      input.classList.add('shake');
      input.focus();
      return;
    }

    tempTasks.push({ id: nextTempId++, title: title, done: false });
    closeSheet();
    renderToday();
  }

  // ---------- 시작 ----------
  function init() {
    renderDate();
    renderToday();
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
  }

  init();

})();
