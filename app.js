// =========================================
// app.js - 화면 전환 및 사용자 동작
// =========================================
'use strict';

(function () {

  // 앱 버전: 업데이트할 때마다 index.html의 ?v= 숫자와 함께 올림 (오늘 화면 맨 아래에 표시)
  const APP_VERSION = 'v39';

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
