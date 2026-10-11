// =========================================
// db.js - IndexedDB 데이터 저장 및 조회
// =========================================
// 다른 파일에서는 DB.함수이름() 형태로 사용합니다.
// 모든 함수는 Promise를 돌려주므로 app.js에서 await로 기다립니다.
'use strict';

const DB = (function () {

  const DB_NAME = 'life-planner';
  const DB_VERSION = 1;   // 서랍 구조를 바꿀 때만 올림 (데이터는 유지됨)

  // 초기 카테고리 (id는 고정, 이름은 나중에 바꿔도 연결이 끊기지 않음)
  const DEFAULT_CATEGORIES = [
    { id: 'cat-house',   name: '집안일' },
    { id: 'cat-shop',    name: '장보기·생필품' },
    { id: 'cat-money',   name: '돈 관리' },
    { id: 'cat-car',     name: '자동차' },
    { id: 'cat-admin',   name: '생활 행정' },
    { id: 'cat-self',    name: '자기 관리' },
    { id: 'cat-etc',     name: '기타' }
  ];

  let dbPromise = null;

  // ---------- 날짜·ID 도우미 ----------

  // 한국 시간(기기 시간) 기준 'YYYY-MM-DD' 글자
  function toDateStr(d) {
    d = d || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function nowISO() {
    return new Date().toISOString();   // 기록용 시각(생성·수정 시각)
  }

  function newId() {
    if (window.crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // ---------- 반복 날짜 계산 ----------

  const FREQUENCIES = {
    daily:      { days: 1,    label: '매일',      unit: '1일' },
    weekly:     { days: 7,    label: '매주',      unit: '1주' },
    biweekly:   { days: 14,   label: '2주마다',   unit: '2주' },
    monthly:    { months: 1,  label: '매월',      unit: '1개월' },
    quarterly:  { months: 3,  label: '3개월마다', unit: '3개월' },
    semiannual: { months: 6,  label: '6개월마다', unit: '6개월' },
    yearly:     { months: 12, label: '매년',      unit: '1년' }
  };

  function parseDate(str) {
    const p = str.split('-').map(Number);
    return { y: p[0], m: p[1], d: p[2] };
  }

  function daysInMonth(y, m) {          // m: 1~12
    return new Date(y, m, 0).getDate();
  }

  // 기준일(anchorDate)에서 n번째(0부터) 반복 날짜
  // 월 단위 반복은 '원래 기준일(anchorDay)'로 매번 새로 계산하므로
  // 31일 → 2월 28일 → 3월 31일처럼 원래 날짜로 돌아옴 (그 달에 없으면 마지막 날)
  function nthDate(anchorDate, frequency, n, anchorDay) {
    const f = FREQUENCIES[frequency];
    const a = parseDate(anchorDate);
    if (f.days) {
      return toDateStr(new Date(a.y, a.m - 1, a.d + f.days * n));
    }
    const total = (a.m - 1) + f.months * n;
    const y = a.y + Math.floor(total / 12);
    const m = (total % 12) + 1;
    const day = Math.min(anchorDay || a.d, daysInMonth(y, m));
    return toDateStr(new Date(y, m - 1, day));
  }

  // 'YYYY-MM-DD'에 n일 더하기 (음수면 빼기)
  function addDays(dateStr, n) {
    const a = parseDate(dateStr);
    return toDateStr(new Date(a.y, a.m - 1, a.d + n));
  }

  // 그 날짜가 속한 주의 월요일 (주간 기준: 월요일~일요일)
  function weekStartOf(dateStr) {
    const a = parseDate(dateStr);
    const dow = new Date(a.y, a.m - 1, a.d).getDay();   // 0=일, 1=월 … 6=토
    return addDays(dateStr, -((dow + 6) % 7));
  }

  // 완료일 기준 반복: 완료(또는 건너뛴) 날에서 한 주기 뒤
  function nextFromBase(frequency, baseDate) {
    return nthDate(baseDate, frequency, 1, parseDate(baseDate).d);
  }

  // 반복 규칙 만들기. repeat: { frequency, basis }
  function makeRule(taskId, repeat, anchorDate, time, now) {
    return {
      id: newId(),
      taskId: taskId,
      frequency: repeat.frequency,
      basis: repeat.basis === 'completed' ? 'completed' : 'scheduled',  // 기본: 예정일 기준
      anchorDate: anchorDate,                 // 첫 회차 날짜 (계산 기준)
      anchorDay: parseDate(anchorDate).d,     // 원래 기준일 (예: 31)
      time: time || null,                     // 새로 생기는 회차의 기본 시간
      nextIndex: 1,                           // 예정일 기준: 다음에 만들 회차 번호 (0번은 만들 때 생성)
      active: true,                           // false = 중단됨 (앞으로 생성 안 함)
      createdAt: now,
      endedAt: null
    };
  }

  // ---------- 데이터베이스 열기 ----------

  // 버전 1: 서랍 12개 만들기
  function createV1(db, upgradeTx) {
    // 할 일
    db.createObjectStore('tasks', { keyPath: 'id' });

    const rules = db.createObjectStore('rules', { keyPath: 'id' });
    rules.createIndex('taskId', 'taskId');

    const occ = db.createObjectStore('occurrences', { keyPath: 'id' });
    occ.createIndex('taskId', 'taskId');
    // 날짜가 없는(null) 회차는 이 색인에 들어가지 않음 → 날짜별 조회에서 자연스럽게 제외됨
    occ.createIndex('scheduledDate', 'scheduledDate');
    occ.createIndex('status', 'status');

    // 트래커
    const goals = db.createObjectStore('weeklyGoals', { keyPath: 'id' });
    goals.createIndex('weekStart', 'weekStart');

    db.createObjectStore('habits', { keyPath: 'id' });
    const habitLogs = db.createObjectStore('habitLogs', { keyPath: 'id' });   // id = habitId|date
    habitLogs.createIndex('habitId', 'habitId');
    habitLogs.createIndex('date', 'date');

    db.createObjectStore('missions', { keyPath: 'id' });
    const mTargets = db.createObjectStore('missionTargets', { keyPath: 'id' }); // id = missionId|weekStart
    mTargets.createIndex('missionId', 'missionId');
    mTargets.createIndex('weekStart', 'weekStart');
    const mLogs = db.createObjectStore('missionLogs', { keyPath: 'id' });
    mLogs.createIndex('missionId', 'missionId');
    mLogs.createIndex('date', 'date');

    db.createObjectStore('routines', { keyPath: 'id' });
    const rLogs = db.createObjectStore('routineLogs', { keyPath: 'id' });     // id = routineId|date
    rLogs.createIndex('routineId', 'routineId');
    rLogs.createIndex('date', 'date');

    // 설정
    const settings = db.createObjectStore('settings', { keyPath: 'key' });
    settings.put({ key: 'categories', value: DEFAULT_CATEGORIES });
  }

  function open() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('이 브라우저에서는 데이터를 저장할 수 없어요 (IndexedDB 미지원).'));
        return;
      }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (event.oldVersion < 1) createV1(db, req.transaction);
        // 나중에 구조를 바꿀 때: if (event.oldVersion < 2) { ... } 를 여기에 추가
      };

      req.onsuccess = () => {
        const db = req.result;
        // 다른 탭에서 새 버전으로 열려고 하면 이 연결을 닫아 줌
        db.onversionchange = () => db.close();
        resolve(db);
      };

      req.onerror = () => reject(req.error || new Error('데이터베이스를 열지 못했어요.'));
    });

    // 실패하면 다음 호출 때 다시 시도할 수 있게
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  // 브라우저가 저장 공간이 부족할 때 데이터를 지우지 않도록 요청 (지원하는 브라우저만)
  async function requestPersist() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        return await navigator.storage.persist();
      }
    } catch (e) { /* 지원하지 않으면 무시 */ }
    return false;
  }

  // 트랜잭션 실행 도우미
  // fn 안에서 여러 서랍을 한꺼번에 수정하면, 전부 성공하거나 전부 취소됨(중간 상태로 남지 않음)
  async function run(storeNames, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let out;
      tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('저장이 취소되었어요.'));
      try {
        out = fn(tx);
      } catch (err) {
        try { tx.abort(); } catch (e) { /* 이미 끝난 경우 무시 */ }
        reject(err);
      }
    });
  }

  // ---------- 할 일 ----------

  // 새 할 일: 할 일 1개 + 회차 기록 1개 (+ 반복 규칙)를 한 번에 저장
  // fields: { title, categoryId, memo, date, time, repeat }
  //   date: 'YYYY-MM-DD' 또는 null(날짜 없음), time: 'HH:MM' 또는 null
  //   repeat: { frequency, basis } 또는 null (날짜가 있어야 반복 가능)
  function addTask(fields) {
    const now = nowISO();
    const date = fields.date || null;
    const task = {
      id: newId(),
      title: fields.title,
      categoryId: fields.categoryId || null,
      memo: fields.memo || '',
      createdAt: now,
      updatedAt: now
    };
    const occurrence = {
      id: newId(),
      taskId: task.id,
      ruleId: null,               // 반복 규칙 없음 (4단계에서 사용)
      originalDate: date,         // 원래 예정일
      scheduledDate: date,        // 변경된 예정일 (변경 전에는 원래 예정일과 같음)
      time: date ? (fields.time || null) : null,   // 날짜가 없으면 시간도 없음
      status: 'pending',          // 'pending' | 'done' | 'skipped'
      completedDate: null,        // 실제 완료일
      createdBy: 'user',          // 'user'(직접 만듦) | 'auto'(반복 규칙이 만듦)
      createdAt: now,
      updatedAt: now
    };

    let rule = null;
    if (fields.repeat && date) {
      rule = makeRule(task.id, fields.repeat, date, occurrence.time, now);
      occurrence.ruleId = rule.id;
      occurrence.seq = 0;         // 이 규칙의 0번째 회차
    }

    return run(['tasks', 'occurrences', 'rules'], 'readwrite', (tx) => {
      tx.objectStore('tasks').add(task);
      tx.objectStore('occurrences').add(occurrence);
      if (rule) tx.objectStore('rules').add(rule);
      return { task: task, occurrence: occurrence };
    });
  }

  // 빠른 추가: 제목과 날짜만
  function addQuickTask(title, dateStr) {
    return addTask({ title: title, date: dateStr });
  }

  // 회차 색인으로 찾은 회차 + 해당 할 일 정보 + 진행 중인 반복 규칙을 함께 가져오기
  // 돌려주는 값: [{ occurrence, task, rule }, ...]  (rule: 반복 중이 아니면 null)
  async function getItemsByIndex(indexName, key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['occurrences', 'tasks', 'rules'], 'readonly');
      const items = [];
      const activeRuleByTask = {};
      tx.oncomplete = () => {
        items.forEach((it) => { it.rule = activeRuleByTask[it.task.id] || null; });
        resolve(items);
      };
      tx.onerror = () => reject(tx.error);

      const rReq = tx.objectStore('rules').getAll();
      rReq.onsuccess = () => rReq.result.forEach((rule) => {
        if (rule.active) activeRuleByTask[rule.taskId] = rule;
      });

      const req = tx.objectStore('occurrences').index(indexName).getAll(key);
      req.onsuccess = () => {
        req.result.forEach((occ) => {
          const tReq = tx.objectStore('tasks').get(occ.taskId);
          tReq.onsuccess = () => {
            if (tReq.result) items.push({ occurrence: occ, task: tReq.result });
          };
        });
      };
    });
  }

  // 특정 날짜(변경된 예정일 기준)의 회차
  function getItemsByDate(dateStr) {
    return getItemsByIndex('scheduledDate', dateStr);
  }

  // 미완료 회차 전체 (전체 할 일 화면용)
  function getPendingItems() {
    return getItemsByIndex('status', 'pending');
  }

  // 달력용: 기간(start~end) 안에 예정된 회차 + 기간 안에 완료한 회차, 할 일 정보, 진행 중인 규칙
  // 돌려주는 값: { items: [{ occurrence, task }], rules: [...], tasksById: { id: task } }
  async function getCalendarData(start, end) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['occurrences', 'tasks', 'rules'], 'readonly');
      const byId = {};
      const tasksById = {};
      let rules = [];
      tx.oncomplete = () => {
        const items = Object.keys(byId)
          .map((id) => byId[id])
          .filter((o) => tasksById[o.taskId])
          .map((o) => ({ occurrence: o, task: tasksById[o.taskId] }));
        resolve({ items: items, rules: rules, tasksById: tasksById });
      };
      tx.onerror = () => reject(tx.error);

      const os = tx.objectStore('occurrences');
      const r1 = os.index('scheduledDate').getAll(IDBKeyRange.bound(start, end));
      r1.onsuccess = () => r1.result.forEach((o) => { byId[o.id] = o; });
      const r2 = os.index('status').getAll('done');
      r2.onsuccess = () => r2.result.forEach((o) => {
        if (o.completedDate && o.completedDate >= start && o.completedDate <= end) byId[o.id] = o;
      });
      const r3 = tx.objectStore('tasks').getAll();
      r3.onsuccess = () => r3.result.forEach((t) => { tasksById[t.id] = t; });
      const r4 = tx.objectStore('rules').getAll();
      r4.onsuccess = () => { rules = r4.result.filter((r) => r.active); };
    });
  }

  // 회차 1개 + 할 일 정보 + 진행 중인 반복 규칙 (없으면 null)
  async function getItem(occurrenceId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['occurrences', 'tasks', 'rules'], 'readonly');
      let item = null;
      let activeRule = null;
      tx.oncomplete = () => {
        if (item) item.rule = activeRule;
        resolve(item);
      };
      tx.onerror = () => reject(tx.error);

      const req = tx.objectStore('occurrences').get(occurrenceId);
      req.onsuccess = () => {
        const occ = req.result;
        if (!occ) return;
        const tReq = tx.objectStore('tasks').get(occ.taskId);
        tReq.onsuccess = () => {
          if (tReq.result) item = { occurrence: occ, task: tReq.result };
        };
        const rReq = tx.objectStore('rules').index('taskId').getAll(occ.taskId);
        rReq.onsuccess = () => {
          activeRule = rReq.result.find((r) => r.active) || null;
        };
      };
    });
  }

  // 날짜 변경이 '실수 수정'인지 판단 (true면 원래 예정일을 남기지 않음)
  //   - 원래 예정일이 아직 오지 않음: 미리 계획을 바꾸는 것
  //   - 오늘 직접 만든 회차: 방금 잘못 넣은 것
  //     (반복 규칙이 자동으로 만든 회차는 제외 → 오늘 회차를 다른 날로 옮기면 '미룸'으로 기록)
  // 그 외(예정일 당일이나 지난 뒤 변경)는 '미룸'으로 보고 원래 예정일 보존
  function isDateCorrection(occ, todayStr) {
    if (!occ.originalDate) return true;
    if (occ.originalDate > todayStr) return true;
    const byUser = occ.createdBy
      ? occ.createdBy === 'user'
      : !(occ.seq > 0) && !occ.generatedFrom;     // 이 규칙 이전에 만든 기록용 판단
    return byUser && toDateStr(new Date(occ.createdAt)) === todayStr;
  }

  // 할 일 수정 (할 일 정보 + 회차 정보 + 반복 규칙을 한 번에 저장)
  // fields: { title, categoryId, memo, date, time, completedDate,
  //           repeat, repeatChanged, applyTimeToRule }
  // 날짜 규칙:
  //   - 처음으로 날짜를 정하는 경우(원래 예정일이 없음): 원래 예정일 = 변경된 예정일 = 새 날짜
  //   - 이미 원래 예정일이 있으면: 변경된 예정일만 바꾸고 원래 예정일은 보존
  //   - 날짜 변경은 이 회차에만 적용 (다른 회차와 반복 일정은 그대로)
  // 실제 완료일은 완료된 회차에서만 바꿈
  // 반복 설정 변경(repeatChanged): 미완료 회차에서만 가능.
  //   기존 규칙은 지우지 않고 '중단'으로 표시, 이 회차부터 새 규칙 시작.
  //   기존 규칙으로 이미 만들어진 미완료 회차는 그대로 둠.
  function updateItem(occurrenceId, fields) {
    return run(['occurrences', 'tasks', 'rules'], 'readwrite', (tx) => {
      const occStore = tx.objectStore('occurrences');
      const taskStore = tx.objectStore('tasks');
      const ruleStore = tx.objectStore('rules');
      const now = nowISO();

      const req = occStore.get(occurrenceId);
      req.onsuccess = () => {
        const occ = req.result;
        if (!occ) { tx.abort(); return; }

        // 1) 할 일 정보: 모든 회차(과거 기록 포함)에 공통으로 적용됨
        const tReq = taskStore.get(occ.taskId);
        tReq.onsuccess = () => {
          const task = tReq.result;
          if (!task) { tx.abort(); return; }
          task.title = fields.title;
          task.categoryId = fields.categoryId || null;
          task.memo = fields.memo || '';
          task.updatedAt = now;
          taskStore.put(task);
        };

        // 2) 이 회차의 날짜·시간
        const newDate = fields.date || null;
        const newTime = newDate ? (fields.time || null) : null;
        // 실수 수정이면 원래 예정일도 함께 고침 (기록 안 남김), 미룬 것이면 원래 예정일 보존
        if (occ.originalDate === null || isDateCorrection(occ, toDateStr())) {
          occ.originalDate = newDate;
        }
        occ.scheduledDate = newDate;
        occ.time = newTime;
        occ.auto = false;            // 사용자가 손댄 회차 (자동 정리 대상에서 제외)
        occ.updatedAt = now;

        // 3) 실제 완료일
        const oldCompleted = occ.completedDate;
        if (occ.status === 'done' && fields.completedDate) {
          occ.completedDate = fields.completedDate;
        }
        const completedChanged = occ.status === 'done' && occ.completedDate !== oldCompleted;

        // 4-a) 반복 설정 변경
        if (fields.repeatChanged && occ.status === 'pending') {
          const rq = ruleStore.index('taskId').getAll(occ.taskId);
          rq.onsuccess = () => {
            rq.result.forEach((rule) => {
              if (rule.active) {
                rule.active = false;
                rule.endedAt = now;
                ruleStore.put(rule);
              }
            });
            if (fields.repeat && newDate) {
              const rule = makeRule(occ.taskId, fields.repeat, newDate, newTime, now);
              ruleStore.add(rule);
              occ.ruleId = rule.id;
              occ.seq = 0;
              occ.generatedFrom = null;
            }
            occStore.put(occ);
          };
          return;   // occ는 위에서 저장
        }

        // 4-b) 시간을 앞으로 생길 회차에도 적용
        if (fields.applyTimeToRule && occ.ruleId) {
          const rr = ruleStore.get(occ.ruleId);
          rr.onsuccess = () => {
            const rule = rr.result;
            if (rule && rule.active) {
              rule.time = newTime;
              ruleStore.put(rule);
            }
          };
        }

        // 4-c) 완료일 기준 반복에서 완료일을 고치면, 자동으로 만들어진 다음 회차 날짜도 맞춰 줌
        if (completedChanged && occ.ruleId) {
          const rr = ruleStore.get(occ.ruleId);
          rr.onsuccess = () => {
            const rule = rr.result;
            if (!rule || rule.basis !== 'completed') return;
            const cq = occStore.index('taskId').getAll(occ.taskId);
            cq.onsuccess = () => cq.result.forEach((child) => {
              if (child.generatedFrom === occ.id && child.status === 'pending' && child.auto) {
                const d = nextFromBase(rule.frequency, occ.completedDate);
                child.originalDate = d;
                child.scheduledDate = d;
                child.updatedAt = now;
                occStore.put(child);
              }
            });
          };
        }

        occStore.put(occ);
      };
    });
  }

  // 할 일 삭제: 할 일 + 모든 회차 + 반복 규칙을 한 번에 삭제
  function deleteTask(taskId) {
    return run(['tasks', 'occurrences', 'rules'], 'readwrite', (tx) => {
      tx.objectStore('tasks').delete(taskId);
      ['occurrences', 'rules'].forEach((name) => {
        const store = tx.objectStore(name);
        const req = store.index('taskId').getAllKeys(taskId);
        req.onsuccess = () => req.result.forEach((key) => store.delete(key));
      });
    });
  }

  // 할 일의 회차 개수 (삭제 확인 메시지용): { total, done }
  function countOccurrences(taskId) {
    return run(['occurrences'], 'readonly',
      (tx) => tx.objectStore('occurrences').index('taskId').getAll(taskId))
      .then((list) => ({
        total: list.length,
        done: list.filter((o) => o.status === 'done').length
      }));
  }

  // 완료(또는 건너뛰기)를 취소할 때:
  // 그 회차를 완료해서 '자동으로' 생긴 다음 회차가 아직 손대지 않은 미완료 상태면 지움.
  // (완료일 기준 반복에서 완료 → 취소를 반복해도 회차가 중복으로 쌓이지 않게 하기 위함.
  //  사용자가 수정한 회차나 완료한 회차는 절대 지우지 않음)
  function removeAutoChildren(store, occ) {
    const req = store.index('taskId').getAll(occ.taskId);
    req.onsuccess = () => req.result.forEach((o) => {
      if (o.generatedFrom === occ.id && o.status === 'pending' && o.auto) store.delete(o.id);
    });
  }

  // 회차 완료 / 완료 취소
  // done=true  → 상태 '완료', 실제 완료일 기록
  // done=false → 상태 '미완료', 실제 완료일 지움 (예정일은 건드리지 않음)
  function setOccurrenceDone(occurrenceId, done, completedDate) {
    return run(['occurrences'], 'readwrite', (tx) => {
      const store = tx.objectStore('occurrences');
      const req = store.get(occurrenceId);
      req.onsuccess = () => {
        const occ = req.result;
        if (!occ) {
          tx.abort();
          return;
        }
        occ.status = done ? 'done' : 'pending';
        occ.completedDate = done ? completedDate : null;
        occ.updatedAt = nowISO();
        store.put(occ);
        if (!done) removeAutoChildren(store, occ);
      };
    });
  }

  // 이번 회차 건너뛰기 / 건너뛰기 취소 (기록은 '건너뜀'으로 남음)
  function setOccurrenceSkipped(occurrenceId, skipped, skippedDate) {
    return run(['occurrences'], 'readwrite', (tx) => {
      const store = tx.objectStore('occurrences');
      const req = store.get(occurrenceId);
      req.onsuccess = () => {
        const occ = req.result;
        if (!occ) { tx.abort(); return; }
        occ.status = skipped ? 'skipped' : 'pending';
        occ.skippedDate = skipped ? skippedDate : null;
        occ.completedDate = null;
        occ.updatedAt = nowISO();
        store.put(occ);
        if (!skipped) removeAutoChildren(store, occ);
      };
    });
  }

  // 반복 중단: 규칙만 '중단'으로 표시. 지난 기록과 남은 미완료 회차는 그대로
  function stopRule(ruleId) {
    return run(['rules'], 'readwrite', (tx) => {
      const store = tx.objectStore('rules');
      const req = store.get(ruleId);
      req.onsuccess = () => {
        const rule = req.result;
        if (!rule) return;
        rule.active = false;
        rule.endedAt = nowISO();
        store.put(rule);
      };
    });
  }

  // ---------- 반복 회차 만들기 ----------
  // 앱을 열 때와 데이터가 바뀔 때마다 실행. 필요한 회차만 만들고, 이미 있는 회차는 건드리지 않음.
  //
  // 예정일 기준: 오늘까지 도래한 회차를 모두 만들고(놓친 회차는 '기한 지남'으로 남음),
  //             다음 회차 1개를 미리 만들어 둠 (미리 완료·날짜 변경 가능하도록)
  // 완료일 기준: 미완료 회차가 없을 때만, 마지막 회차의 완료일(또는 건너뛴 날)에서 한 주기 뒤 회차를 만듦
  const MAX_CREATE = 1000;   // 안전장치: 한 번에 만드는 최대 회차 수

  function syncRecurrences(todayStr) {
    return run(['rules', 'occurrences'], 'readwrite', (tx) => {
      const ruleStore = tx.objectStore('rules');
      const occStore = tx.objectStore('occurrences');
      const now = nowISO();

      function create(rule, date, seq, fromId) {
        occStore.add({
          id: newId(),
          taskId: rule.taskId,
          ruleId: rule.id,
          originalDate: date,
          scheduledDate: date,
          time: rule.time,
          status: 'pending',
          completedDate: null,
          seq: seq,
          generatedFrom: fromId || null,
          auto: true,                 // 자동으로 만든 회차 (아직 손대지 않음)
          createdBy: 'auto',
          createdAt: now,
          updatedAt: now
        });
      }

      function syncScheduled(rule) {
        const dateAt = (k) => nthDate(rule.anchorDate, rule.frequency, k, rule.anchorDay);
        const req = occStore.index('taskId').getAll(rule.taskId);
        req.onsuccess = () => {
          const mine = req.result.filter((o) => o.ruleId === rule.id);
          const start = rule.nextIndex;
          let k = start;
          let count = 0;

          // 1) 오늘까지 도래한 회차를 모두 만듦 (놓친 회차는 '기한 지남'으로 남음)
          while (count < MAX_CREATE && dateAt(k) <= todayStr) {
            create(rule, dateAt(k), k);
            k++;
            count++;
          }

          // 2) 앞으로 할 '미완료' 회차가 하나도 없으면 다음 회차 1개를 만듦
          //    (다음 회차를 미리 완료하거나 건너뛰면 바로 그다음 회차가 생김)
          const hasUpcoming = mine.some((o) =>
            o.status === 'pending' && o.scheduledDate && o.scheduledDate > todayStr);
          if (!hasUpcoming) {
            create(rule, dateAt(k), k);
            k++;
          }

          if (k !== start) {
            rule.nextIndex = k;
            ruleStore.put(rule);
          }
        };
      }

      function syncCompleted(rule) {
        const req = occStore.index('taskId').getAll(rule.taskId);
        req.onsuccess = () => {
          const list = req.result.filter((o) => o.ruleId === rule.id);
          if (!list.length || list.some((o) => o.status === 'pending')) return;
          const latest = list.reduce((a, b) => ((b.seq || 0) > (a.seq || 0) ? b : a));
          const base = latest.status === 'done' ? latest.completedDate : latest.skippedDate;
          if (!base) return;
          create(rule, nextFromBase(rule.frequency, base), (latest.seq || 0) + 1, latest.id);
        };
      }

      const req = ruleStore.getAll();
      req.onsuccess = () => req.result.forEach((rule) => {
        if (!rule.active || !FREQUENCIES[rule.frequency]) return;
        if (rule.basis === 'completed') syncCompleted(rule);
        else syncScheduled(rule);
      });
    });
  }

  // ---------- 트래커: 주간 목표 ----------
  // 기록: { id, weekStart(그 주 월요일), text, createdAt, updatedAt }
  // 할 일 데이터와 완전히 별개로 저장됨

  function getWeeklyGoals(weekStart) {
    return run(['weeklyGoals'], 'readonly',
      (tx) => tx.objectStore('weeklyGoals').index('weekStart').getAll(weekStart))
      .then((list) => list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  function addWeeklyGoal(weekStart, text) {
    const now = nowISO();
    const goal = { id: newId(), weekStart: weekStart, text: text, createdAt: now, updatedAt: now };
    return run(['weeklyGoals'], 'readwrite', (tx) => {
      tx.objectStore('weeklyGoals').add(goal);
      return goal;
    });
  }

  function updateWeeklyGoal(id, text) {
    return run(['weeklyGoals'], 'readwrite', (tx) => {
      const store = tx.objectStore('weeklyGoals');
      const req = store.get(id);
      req.onsuccess = () => {
        const goal = req.result;
        if (!goal) { tx.abort(); return; }
        goal.text = text;
        goal.updatedAt = nowISO();
        store.put(goal);
      };
    });
  }

  function deleteWeeklyGoal(id) {
    return run(['weeklyGoals'], 'readwrite', (tx) => {
      tx.objectStore('weeklyGoals').delete(id);
    });
  }

  // ---------- 트래커: 주간 습관 ----------
  // 습관: { id, name, startWeek(이 주부터 표에 표시), archivedWeek(이 주부터 숨김, 없으면 null), createdAt, updatedAt }
  // 기록: { id: 'habitId|date', habitId, date, state: 'done' | 'not_done', updatedAt }
  //   기록이 없으면 '미기록'

  function getHabits() {
    return run(['habits'], 'readonly', (tx) => tx.objectStore('habits').getAll())
      .then((list) => list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  function addHabit(name, startWeek) {
    const now = nowISO();
    const habit = { id: newId(), name: name, startWeek: startWeek, archivedWeek: null, createdAt: now, updatedAt: now };
    return run(['habits'], 'readwrite', (tx) => {
      tx.objectStore('habits').add(habit);
      return habit;
    });
  }

  // changes: { name } 또는 { archivedWeek } (보관: 주 시작일, 보관 해제: null)
  function updateHabit(id, changes) {
    return run(['habits'], 'readwrite', (tx) => {
      const store = tx.objectStore('habits');
      const req = store.get(id);
      req.onsuccess = () => {
        const habit = req.result;
        if (!habit) { tx.abort(); return; }
        if ('name' in changes) habit.name = changes.name;
        if ('archivedWeek' in changes) habit.archivedWeek = changes.archivedWeek;
        habit.updatedAt = nowISO();
        store.put(habit);
      };
    });
  }

  // 완전 삭제: 습관 + 모든 기록
  function deleteHabit(id) {
    return run(['habits', 'habitLogs'], 'readwrite', (tx) => {
      tx.objectStore('habits').delete(id);
      const logs = tx.objectStore('habitLogs');
      const req = logs.index('habitId').getAllKeys(id);
      req.onsuccess = () => req.result.forEach((key) => logs.delete(key));
    });
  }

  // 기록 개수 (삭제 확인 메시지용): 미기록은 세지 않음
  function countHabitLogs(id) {
    return run(['habitLogs'], 'readonly', (tx) => tx.objectStore('habitLogs').index('habitId').count(id));
  }

  // 한 주(월~일)의 모든 습관 기록
  function getHabitLogs(weekStart) {
    const range = IDBKeyRange.bound(weekStart, addDays(weekStart, 6));
    return run(['habitLogs'], 'readonly', (tx) => tx.objectStore('habitLogs').index('date').getAll(range));
  }

  // state: 'done' | 'not_done' | null(미기록 → 기록 삭제)
  function setHabitLog(habitId, date, state) {
    const id = habitId + '|' + date;
    return run(['habitLogs'], 'readwrite', (tx) => {
      const store = tx.objectStore('habitLogs');
      if (state) store.put({ id: id, habitId: habitId, date: date, state: state, updatedAt: nowISO() });
      else store.delete(id);
    });
  }

  // ---------- 설정 ----------

  function getSetting(key) {
    return run(['settings'], 'readonly', (tx) => tx.objectStore('settings').get(key))
      .then((row) => (row ? row.value : undefined));
  }

  // 카테고리 목록 [{ id, name }, ...]
  function getCategories() {
    return getSetting('categories').then((list) => list || DEFAULT_CATEGORIES);
  }

  // ---------- 공개 ----------
  return {
    open: open,
    requestPersist: requestPersist,
    toDateStr: toDateStr,
    addTask: addTask,
    addQuickTask: addQuickTask,
    getItemsByDate: getItemsByDate,
    getPendingItems: getPendingItems,
    getCalendarData: getCalendarData,
    getItem: getItem,
    updateItem: updateItem,
    setOccurrenceDone: setOccurrenceDone,
    setOccurrenceSkipped: setOccurrenceSkipped,
    stopRule: stopRule,
    syncRecurrences: syncRecurrences,
    deleteTask: deleteTask,
    countOccurrences: countOccurrences,
    getSetting: getSetting,
    getCategories: getCategories,
    FREQUENCIES: FREQUENCIES,
    nthDate: nthDate,
    isDateCorrection: isDateCorrection,
    addDays: addDays,
    weekStartOf: weekStartOf,
    getWeeklyGoals: getWeeklyGoals,
    addWeeklyGoal: addWeeklyGoal,
    updateWeeklyGoal: updateWeeklyGoal,
    deleteWeeklyGoal: deleteWeeklyGoal,
    getHabits: getHabits,
    addHabit: addHabit,
    updateHabit: updateHabit,
    deleteHabit: deleteHabit,
    countHabitLogs: countHabitLogs,
    getHabitLogs: getHabitLogs,
    setHabitLog: setHabitLog
  };

})();
