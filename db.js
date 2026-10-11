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

  // 빠른 추가: 할 일 1개 + 회차 기록 1개를 한 번에 저장
  // dateStr: 'YYYY-MM-DD' 또는 null(날짜 없음)
  function addQuickTask(title, dateStr) {
    const now = nowISO();
    const task = {
      id: newId(),
      title: title,
      categoryId: null,
      memo: '',
      createdAt: now,
      updatedAt: now
    };
    const occurrence = {
      id: newId(),
      taskId: task.id,
      ruleId: null,               // 반복 규칙 없음 (4단계에서 사용)
      originalDate: dateStr,      // 원래 예정일
      scheduledDate: dateStr,     // 변경된 예정일 (변경 전에는 원래 예정일과 같음)
      time: null,                 // 'HH:MM' 또는 null
      status: 'pending',          // 'pending' | 'done' | 'skipped'
      completedDate: null,        // 실제 완료일
      createdAt: now,
      updatedAt: now
    };

    return run(['tasks', 'occurrences'], 'readwrite', (tx) => {
      tx.objectStore('tasks').add(task);
      tx.objectStore('occurrences').add(occurrence);
      return { task: task, occurrence: occurrence };
    });
  }

  // 특정 날짜의 회차 + 해당 할 일 정보를 함께 가져오기
  // 돌려주는 값: [{ occurrence, task }, ...]
  async function getItemsByDate(dateStr) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['occurrences', 'tasks'], 'readonly');
      const items = [];
      tx.oncomplete = () => resolve(items);
      tx.onerror = () => reject(tx.error);

      const req = tx.objectStore('occurrences').index('scheduledDate').getAll(dateStr);
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
      };
    });
  }

  // ---------- 설정 ----------

  function getSetting(key) {
    return run(['settings'], 'readonly', (tx) => tx.objectStore('settings').get(key))
      .then((row) => (row ? row.value : undefined));
  }

  // ---------- 공개 ----------
  return {
    open: open,
    requestPersist: requestPersist,
    toDateStr: toDateStr,
    addQuickTask: addQuickTask,
    getItemsByDate: getItemsByDate,
    setOccurrenceDone: setOccurrenceDone,
    getSetting: getSetting
  };

})();
