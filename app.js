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
