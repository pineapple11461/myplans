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

  // 새 할 일: 할 일 1개 + 회차 기록 1개를 한 번에 저장
  // fields: { title, categoryId, memo, date, time }
  //   date: 'YYYY-MM-DD' 또는 null(날짜 없음), time: 'HH:MM' 또는 null
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
      createdAt: now,
      updatedAt: now
    };

    return run(['tasks', 'occurrences'], 'readwrite', (tx) => {
      tx.objectStore('tasks').add(task);
      tx.objectStore('occurrences').add(occurrence);
      return { task: task, occurrence: occurrence };
    });
  }

  // 빠른 추가: 제목과 날짜만
  function addQuickTask(title, dateStr) {
    return addTask({ title: title, date: dateStr });
  }

  // 회차 색인으로 찾은 회차 + 해당 할 일 정보를 함께 가져오기
  // 돌려주는 값: [{ occurrence, task }, ...]
  async function getItemsByIndex(indexName, key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['occurrences', 'tasks'], 'readonly');
      const items = [];
      tx.oncomplete = () => resolve(items);
      tx.onerror = () => reject(tx.error);

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

  // 회차 1개 + 할 일 정보 (없으면 null)
  async function getItem(occurrenceId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['occurrences', 'tasks'], 'readonly');
      let item = null;
      tx.oncomplete = () => resolve(item);
      tx.onerror = () => reject(tx.error);

      const req = tx.objectStore('occurrences').get(occurrenceId);
      req.onsuccess = () => {
        const occ = req.result;
        if (!occ) return;
        const tReq = tx.objectStore('tasks').get(occ.taskId);
        tReq.onsuccess = () => {
          if (tReq.result) item = { occurrence: occ, task: tReq.result };
        };
      };
    });
  }

  // 할 일 수정 (할 일 정보 + 회차 정보를 한 번에 저장)
  // fields: { title, categoryId, memo, date, time, completedDate }
  // 날짜 규칙:
  //   - 처음으로 날짜를 정하는 경우(원래 예정일이 없음): 원래 예정일 = 변경된 예정일 = 새 날짜
  //   - 이미 원래 예정일이 있으면: 변경된 예정일만 바꾸고 원래 예정일은 보존
  // 실제 완료일은 완료된 회차에서만 바꿈
  function updateItem(occurrenceId, fields) {
    return run(['occurrences', 'tasks'], 'readwrite', (tx) => {
      const occStore = tx.objectStore('occurrences');
      const taskStore = tx.objectStore('tasks');
      const now = nowISO();

      const req = occStore.get(occurrenceId);
      req.onsuccess = () => {
        const occ = req.result;
        if (!occ) { tx.abort(); return; }

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

        const newDate = fields.date || null;
        if (occ.originalDate === null) occ.originalDate = newDate;
        occ.scheduledDate = newDate;
        occ.time = newDate ? (fields.time || null) : null;
        if (occ.status === 'done' && fields.completedDate) {
          occ.completedDate = fields.completedDate;
        }
        occ.updatedAt = now;
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

  // 할 일의 완료 기록 개수 (삭제 확인 메시지용)
  function countDoneOccurrences(taskId) {
    return run(['occurrences'], 'readonly',
      (tx) => tx.objectStore('occurrences').index('taskId').getAll(taskId))
      .then((list) => list.filter((o) => o.status === 'done').length);
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
    getItem: getItem,
    updateItem: updateItem,
    setOccurrenceDone: setOccurrenceDone,
    deleteTask: deleteTask,
    countDoneOccurrences: countDoneOccurrences,
    getSetting: getSetting,
    getCategories: getCategories
  };

})();
