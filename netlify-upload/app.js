(function () {
  "use strict";

  var DATA = window.GRE_APP_DATA;
  if (!DATA || !Array.isArray(DATA.modules) || DATA.modules.length === 0) {
    document.body.insertAdjacentHTML(
      "afterbegin",
      '<p style="padding:20px;font-family:sans-serif">词汇数据文件缺失或格式不正确。</p>'
    );
    return;
  }

  var MODULES = DATA.modules;
  var STORAGE_KEY = "gre-eq-5day-profile-v1";
  var AUTH_KEY = "gre-auth-user-v1";
  var VIEW_IDS = [
    "authView",
    "homeView",
    "practiceView",
    "summaryView",
    "wrongView",
    "profileView"
  ];
  var activeModuleId = MODULES[0].id;

  var meaningPools = {};
  var equivDayPools = {};
  var globalEquivalents = [];

  MODULES.forEach(function (module) {
    var entries = module.kind === "single"
      ? module.entries
      : module.days.reduce(function (acc, day) {
          return acc.concat(day.entries);
        }, []);
    meaningPools[module.id] = unique(entries.map(function (entry) {
      return entry.meaning;
    }));
    if (module.kind === "daily") {
      equivDayPools[module.id] = module.days.map(function (day) {
        return unique(
          day.entries.reduce(function (acc, entry) {
            return acc.concat(entry.equivalents || []);
          }, [])
        );
      });
    }
    if (module.hasEquivalentStep) {
      globalEquivalents = unique(
        globalEquivalents.concat(
          entries.reduce(function (acc, entry) {
            return acc.concat(entry.equivalents || []);
          }, [])
        )
      );
    }
  });

  var state = loadState();
  var session = null;
  var sync = { userId: null, username: null, token: null, online: false };
  var syncTimer = null;
  var authMode = "login";

  function $(selector) {
    return document.querySelector(selector);
  }

  function $$(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  function unique(values) {
    return Array.from(new Set(values));
  }

  function shuffle(values) {
    var arr = values.slice();
    for (var i = arr.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[ch];
    });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function fmtTime(iso) {
    if (!iso) return "暂无";
    return new Date(iso).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function fmtClock(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function fmtPercent(value) {
    if (value == null || Number.isNaN(value)) return "--";
    return Math.round(value * 100) + "%";
  }

  function blankState() {
    var modules = {};
    MODULES.forEach(function (module) {
      if (module.kind === "single") {
        modules[module.id] = {
          progress: {},
          wrong: {},
          completedAt: null,
          firstPracticeAt: null
        };
      } else {
        var days = {};
        module.days.forEach(function (day) {
          days[String(day.day)] = {
            progress: {},
            wrong: {},
            completedAt: null,
            firstPracticeAt: null
          };
        });
        modules[module.id] = days;
      }
    });
    return {
      version: 2,
      savedAt: null,
      lastPractice: null,
      sessions: [],
      modules: modules
    };
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return blankState();
      var parsed = JSON.parse(raw);
      var base = blankState();

      if (parsed && parsed.version === 1 && parsed.days) {
        for (var i = 1; i <= 5; i += 1) {
          var key = String(i);
          if (parsed.days[key]) {
            var oldDay = parsed.days[key];
            var firstTime = null;
            Object.keys(oldDay.progress || {}).forEach(function (entryId) {
              var stamp = oldDay.progress[entryId].completedAt;
              if (stamp && (!firstTime || stamp < firstTime)) firstTime = stamp;
            });
            base.modules.sixTwo[key] = {
              progress: oldDay.progress || {},
              wrong: oldDay.wrong || {},
              completedAt: oldDay.completedAt || null,
              firstPracticeAt: firstTime
            };
          }
        }
        base.savedAt = parsed.savedAt || null;
        base.lastPractice = parsed.lastPractice || null;
        return base;
      }

      if (!parsed || parsed.version !== 2) return blankState();
      if (parsed.modules) {
        MODULES.forEach(function (module) {
          if (parsed.modules[module.id]) {
            if (module.kind === "single") {
              base.modules[module.id] = {
                progress: parsed.modules[module.id].progress || {},
                wrong: parsed.modules[module.id].wrong || {},
                completedAt: parsed.modules[module.id].completedAt || null,
                firstPracticeAt: parsed.modules[module.id].firstPracticeAt || null
              };
            } else {
              module.days.forEach(function (day) {
                var key = String(day.day);
                var incoming = parsed.modules[module.id][key] || {};
                base.modules[module.id][key] = {
                  progress: incoming.progress || {},
                  wrong: incoming.wrong || {},
                  completedAt: incoming.completedAt || null,
                  firstPracticeAt: incoming.firstPracticeAt || null
                };
              });
            }
          }
        });
      }
      base.savedAt = parsed.savedAt || null;
      base.lastPractice = parsed.lastPractice || null;
      base.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      return base;
    } catch (err) {
      return blankState();
    }
  }

  function saveState() {
    state.savedAt = nowIso();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      // localStorage can be unavailable; the app still works for the session.
    }
    renderSaveIndicator();
    pushSync();
  }

  function apiFetch(path, options) {
    options = options || {};
    var headers = options.headers || {};
    if (sync.token) {
      headers["Authorization"] = "Bearer " + sync.token;
    }
    options.headers = headers;
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () {
        return {};
      }).then(function (data) {
        if (!response.ok) {
          var message = data.error || "http " + response.status;
          var err = new Error(message);
          err.status = response.status;
          throw err;
        }
        return data;
      });
    });
  }

  function saveLocalOnly() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      // ignore storage errors
    }
  }

  function pushSync() {
    if (!sync.token) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      apiFetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: state })
      }).then(function () {
        sync.online = true;
        renderSyncStatus();
      }).catch(function () {
        sync.online = false;
        renderSyncStatus();
      });
    }, 400);
  }

  function flushSync() {
    if (!sync.token) return;
    clearTimeout(syncTimer);
    try {
      fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: state }),
        keepalive: true
      }).catch(function () {
        sync.online = false;
      });
    } catch (err) {
      // ignore network errors
    }
  }

  function normalizeServerState(parsed) {
    var base = blankState();
    if (!parsed || parsed.version !== 2) return base;
    if (parsed.modules) {
      MODULES.forEach(function (module) {
        if (!parsed.modules[module.id]) return;
        if (module.kind === "single") {
          base.modules[module.id] = {
            progress: parsed.modules[module.id].progress || {},
            wrong: parsed.modules[module.id].wrong || {},
            completedAt: parsed.modules[module.id].completedAt || null,
            firstPracticeAt: parsed.modules[module.id].firstPracticeAt || null
          };
        } else {
          module.days.forEach(function (day) {
            var key = String(day.day);
            var incoming = parsed.modules[module.id][key] || {};
            base.modules[module.id][key] = {
              progress: incoming.progress || {},
              wrong: incoming.wrong || {},
              completedAt: incoming.completedAt || null,
              firstPracticeAt: incoming.firstPracticeAt || null
            };
          });
        }
      });
    }
    base.savedAt = parsed.savedAt || null;
    base.lastPractice = parsed.lastPractice || null;
    base.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    return base;
  }

  function saveAuth() {
    try {
      localStorage.setItem(
        AUTH_KEY,
        JSON.stringify({
          userId: sync.userId,
          username: sync.username,
          token: sync.token
        })
      );
    } catch (err) {
      // ignore storage errors
    }
  }

  function clearAuth() {
    try {
      localStorage.removeItem(AUTH_KEY);
    } catch (err) {
      // ignore storage errors
    }
    sync.userId = null;
    sync.username = null;
    sync.token = null;
    sync.online = false;
  }

  function boot() {
    var stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    } catch (err) {
      stored = null;
    }

    if (stored && stored.token) {
      sync.userId = stored.userId;
      sync.username = stored.username;
      sync.token = stored.token;
      apiFetch("/api/profile").then(function (profile) {
        sync.online = true;
        if (profile && profile.state) {
          state = normalizeServerState(profile.state);
          saveLocalOnly();
        }
        renderHome();
      }).catch(function (err) {
        sync.online = false;
        if (err.status === 401) {
          clearAuth();
          renderAuth();
        } else {
          renderHome();
        }
      });
      return;
    }

    renderAuth();
  }

  function renderAuth() {
    showView("authView");
    setAuthMode(authMode);
    document.getElementById("authUsername").focus();
  }

  function setAuthMode(mode) {
    authMode = mode;
    var isLogin = mode === "login";
    document
      .getElementById("authLoginTab")
      .classList.toggle("is-active", isLogin);
    document
      .getElementById("authRegisterTab")
      .classList.toggle("is-active", !isLogin);
    document.getElementById("authSubmit").textContent = isLogin ? "登录" : "注册";
    document.getElementById("authPassword").autocomplete = isLogin
      ? "current-password"
      : "new-password";
    document.getElementById("authError").textContent = "";
  }

  function submitAuth(event) {
    event.preventDefault();
    var username = document.getElementById("authUsername").value.trim();
    var password = document.getElementById("authPassword").value;
    var errorBox = document.getElementById("authError");
    if (!username || !password) {
      errorBox.textContent = "请输入名字和密码。";
      return;
    }

    apiFetch("/api/" + authMode, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password })
    }).then(function (profile) {
      sync.userId = profile.userId;
      sync.username = profile.username;
      sync.token = profile.token;
      sync.online = true;
      saveAuth();
      if (profile.state) {
        state = normalizeServerState(profile.state);
        try {
          localStorage.setItem("gre-account-migrated", "1");
        } catch (err) {
          // ignore storage errors
        }
      } else {
        var localHasData = totalAnswered() > 0 || state.sessions.length > 0;
        var migrated = false;
        try {
          migrated = localStorage.getItem("gre-account-migrated") === "1";
        } catch (err) {
          migrated = false;
        }
        if (localHasData && !migrated) {
          try {
            localStorage.setItem("gre-account-migrated", "1");
          } catch (err) {
            // ignore storage errors
          }
        } else {
          state = blankState();
        }
      }
      saveLocalOnly();
      pushSync();
      renderHome();
    }).catch(function (err) {
      if (authMode === "register" && err.status === 409) {
        errorBox.textContent = "这个名字已经被使用了，换一个名字或直接登录。";
      } else if (authMode === "login" && err.status === 404) {
        errorBox.textContent = "没有找到这个名字，请先注册。";
      } else if (authMode === "login" && err.status === 401) {
        errorBox.textContent = "密码不正确。";
      } else {
        errorBox.textContent = "无法连接服务器，请稍后重试，或先使用本机模式。";
      }
    });
  }

  function enterLocalMode() {
    clearAuth();
    sync.online = false;
    renderHome();
  }

  function logout() {
    clearAuth();
    renderAuth();
  }

  function renderSyncStatus() {
    var status = document.getElementById("syncStatus");
    if (!status) return;
    if (!sync.token) {
      status.innerHTML =
        '<div class="record-meta"><span>本机模式（未登录）</span></div>';
      return;
    }
    var onlineText = sync.online ? "已连接服务器" : "服务器暂不可用（本机模式）";
    status.innerHTML =
      '<div class="record-meta">' +
      "<span>当前用户：<strong>" +
      esc(sync.username) +
      "</strong></span>" +
      "<span>" +
      onlineText +
      "</span>" +
      "</div>";
  }

  function moduleById(moduleId) {
    for (var i = 0; i < MODULES.length; i += 1) {
      if (MODULES[i].id === moduleId) return MODULES[i];
    }
    return null;
  }

  function moduleDays(module) {
    if (module.kind === "single") {
      return [{ day: 1, title: module.name, entries: module.entries }];
    }
    return module.days;
  }

  function dayEntries(module, dayNumber) {
    var days = moduleDays(module);
    for (var i = 0; i < days.length; i += 1) {
      if (Number(days[i].day) === Number(dayNumber)) return days[i].entries;
    }
    return [];
  }

  function dayState(moduleId, dayNumber) {
    var module = moduleById(moduleId);
    var base = state.modules[moduleId] || {};
    if (module.kind === "single") return base;
    var key = String(dayNumber);
    if (!base[key]) base[key] = { progress: {}, wrong: {}, completedAt: null };
    return base[key];
  }

  function dayTotal(moduleId, dayNumber) {
    return dayEntries(moduleById(moduleId), dayNumber).length;
  }

  function dayDone(moduleId, dayNumber) {
    return Object.keys(dayState(moduleId, dayNumber).progress).length;
  }

  function dayWrongCount(moduleId, dayNumber) {
    return Object.keys(dayState(moduleId, dayNumber).wrong).length;
  }

  function isDayComplete(moduleId, dayNumber) {
    return dayDone(moduleId, dayNumber) >= dayTotal(moduleId, dayNumber);
  }

  function moduleUnitCount() {
    var count = 0;
    MODULES.forEach(function (module) {
      moduleDays(module).forEach(function (day) {
        if (isDayComplete(module.id, day.day)) count += 1;
      });
    });
    return count;
  }

  function totalAnswered() {
    var count = 0;
    MODULES.forEach(function (module) {
      moduleDays(module).forEach(function (day) {
        count += dayDone(module.id, day.day);
      });
    });
    return count;
  }

  function totalWrong() {
    var count = 0;
    MODULES.forEach(function (module) {
      moduleDays(module).forEach(function (day) {
        count += dayWrongCount(module.id, day.day);
      });
    });
    return count;
  }

  function moduleTotalEntries(module) {
    return moduleDays(module).reduce(function (sum, day) {
      return sum + day.entries.length;
    }, 0);
  }

  function showView(viewId) {
    VIEW_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle("is-hidden", id !== viewId);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderSaveIndicator() {
    var el = document.getElementById("saveText");
    if (el) {
      el.textContent = state.savedAt ? "已保存 " + fmtClock(state.savedAt) : "";
    }
    var topbar = document.getElementById("topbarSave");
    if (topbar) {
      topbar.textContent = state.savedAt
        ? "已保存 " + fmtClock(state.savedAt)
        : "学习档案";
    }
  }

  function renderModuleTabs() {
    $$("#moduleTabs .module-tab").forEach(function (button) {
      var moduleId = button.dataset.module;
      button.classList.toggle("is-active", moduleId === activeModuleId);
    });
  }

  function renderHome() {
    showView("homeView");
    var module = moduleById(activeModuleId);
    if (!module) return;
    renderModuleTabs();

    var total = moduleTotalEntries(module);
    document.getElementById("homeTitle").textContent =
      module.kind === "single" ? module.name : module.name + " · 选择当天任务";
    document.getElementById("homeSubtitle").textContent =
      module.kind === "single"
        ? "共 " + total + " 词条"
        : "共 " + module.days.length + " 天 · " + total + " 词条";

    var list = document.getElementById("dayList");
    list.innerHTML = moduleDays(module).map(function (day) {
      return dayRowHtml(module, day.day);
    }).join("");
    renderProfilePanel();
  }

  function dayRowHtml(module, dayNumber) {
    var total = dayTotal(module.id, dayNumber);
    var done = dayDone(module.id, dayNumber);
    var wrong = dayWrongCount(module.id, dayNumber);
    var complete = isDayComplete(module.id, dayNumber);
    var percent = total ? Math.round((done / total) * 100) : 0;
    var status = complete
      ? "已完成"
      : done > 0
        ? "进行中"
        : "未开始";
    var title = module.kind === "single" ? module.name : "第 " + dayNumber + " 天";

    var buttons = "";
    if (complete) {
      buttons +=
        '<button type="button" class="btn btn-secondary" data-action="redo" data-module="' +
        module.id +
        '" data-day="' +
        dayNumber +
        '">重新练习</button>';
    } else {
      buttons +=
        '<button type="button" class="btn btn-primary" data-action="start" data-module="' +
        module.id +
        '" data-day="' +
        dayNumber +
        '">' +
        (done > 0 ? "继续练习" : "开始练习") +
        "</button>";
    }
    if (wrong > 0) {
      buttons +=
        '<button type="button" class="btn btn-secondary" data-action="wrong" data-module="' +
        module.id +
        '" data-day="' +
        dayNumber +
        '">错词重练 (' +
        wrong +
        ")</button>";
    }

    return (
      '<article class="day-row">' +
      '<div class="day-index">' +
      (module.kind === "single" ? "数" : dayNumber) +
      "</div>" +
      '<div class="day-main">' +
      "<h3>" +
      esc(title) +
      "</h3>" +
      '<p class="day-status">' +
      status +
      " · 完成 " +
      done +
      " / " +
      total +
      " · 错词 " +
      wrong +
      "</p>" +
      '<div class="mini-track"><div class="mini-fill" style="width:' +
      percent +
      '%"></div></div>' +
      "</div>" +
      '<div class="day-actions">' +
      buttons +
      "</div>" +
      "</article>"
    );
  }

  function renderProfilePanel() {
    var stats = document.getElementById("profileStats");
    stats.innerHTML =
      "<div><dt>已完成词条</dt><dd>" +
      totalAnswered() +
      " / " +
      MODULES.reduce(function (sum, module) {
        return sum + moduleTotalEntries(module);
      }, 0) +
      "</dd></div>" +
      "<div><dt>完成天数</dt><dd>" +
      moduleUnitCount() +
      " / " +
      MODULES.reduce(function (sum, module) {
        return sum + moduleDays(module).length;
      }, 0) +
      "</dd></div>" +
      "<div><dt>错词累计</dt><dd>" +
      totalWrong() +
      "</dd></div>" +
      "<div><dt>上次练习</dt><dd>" +
      fmtTime(state.lastPractice) +
      "</dd></div>";

    var note = document.getElementById("saveNote");
    note.textContent = state.savedAt
      ? "最近保存：" + fmtTime(state.savedAt) + " · 退出时也会自动保存"
      : "档案自动保存在本机浏览器中";
  }

  function startSession(moduleId, dayNumber, mode, resume) {
    var module = moduleById(moduleId);
    var entries = dayEntries(module, dayNumber);
    var ds = dayState(moduleId, dayNumber);
    var ids;

    if (mode === "wrong") {
      ids = Object.keys(ds.wrong);
    } else if (resume && dayDone(moduleId, dayNumber) > 0) {
      ids = entries
        .filter(function (entry) { return !ds.progress[entry.id]; })
        .map(function (entry) { return entry.id; });
    } else {
      ids = entries.map(function (entry) { return entry.id; });
    }

    if (ids.length === 0) {
      renderHome();
      return;
    }

    session = {
      moduleId: moduleId,
      day: dayNumber,
      mode: mode,
      ids: ids,
      index: 0,
      stage: "meaning",
      answered: false,
      options: [],
      correct: "",
      result: {},
      log: { correctWords: 0, wrongIds: [], questionCorrect: 0, questionTotal: 0 }
    };
    renderPractice();
  }

  function currentEntry() {
    var module = moduleById(session.moduleId);
    var entries = dayEntries(module, session.day);
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i].id === session.ids[session.index]) return entries[i];
    }
    return null;
  }

  function renderPractice() {
    showView("practiceView");
    var module = moduleById(session.moduleId);
    var done = dayDone(session.moduleId, session.day);
    var total = dayTotal(session.moduleId, session.day);
    var percent = total ? Math.round((done / total) * 100) : 0;
    var label =
      module.kind === "single"
        ? module.name
        : module.name + " · 第 " + session.day + " 天";

    document.getElementById("progressText").textContent =
      label + " · 当天完成 " + done + " / " + total;
    document.getElementById("progressFill").style.width = percent + "%";
    document.getElementById("entryCounter").textContent =
      "第 " + (session.index + 1) + " / " + session.ids.length + " 词";
    renderQuestion();
  }

  function renderQuestion() {
    var entry = currentEntry();
    if (!entry) {
      finishSession();
      return;
    }

    var module = moduleById(session.moduleId);
    var hasEquivStep = moduleHasEquiv(module);
    session.answered = false;
    session.options = [];
    session.correct = "";

    document.getElementById("questionWord").textContent = entry.word;
    var prompt = document.getElementById("questionPrompt");
    var badge = document.getElementById("stageBadge");
    var feedback = document.getElementById("feedbackBox");
    feedback.className = "feedback is-hidden";
    feedback.innerHTML = "";
    document.getElementById("nextBtn").classList.add("is-hidden");

    if (session.stage === "meaning") {
      badge.textContent = hasEquivStep ? "第一步 · 中文释义" : "中文释义";
      prompt.textContent = "选出「" + entry.word + "」的正确中文释义（只有一个正确答案）";
      session.options = buildMeaningOptions(entry);
      session.correct = entry.meaning;
    } else {
      if (!entry.equivalents || !entry.equivalents.length) {
        badge.textContent = "本题说明";
        prompt.textContent = "该词条在 PDF 原表中未提供等价词，仅记录中文释义。";
        document.getElementById("optionList").innerHTML = "";
        feedback.className = "feedback";
        feedback.innerHTML =
          '<div class="feedback-title">资料缺等价词</div>' +
          '<div class="feedback-body">「' +
          esc(entry.word) +
          "」的释义：<strong>" +
          esc(entry.meaning) +
          "</strong></div>";
        session.result.equivCorrect = null;
        session.answered = true;
        var finalLabel = session.index >= session.ids.length - 1 ? "查看本日结果" : "下一词";
        var nextBtn = document.getElementById("nextBtn");
        nextBtn.textContent = finalLabel;
        nextBtn.classList.remove("is-hidden");
        return;
      }
      badge.textContent = "第二步 · 等价词";
      prompt.textContent = "选出「" + entry.word + "」的正确等价词（只有一个正确答案）";
      var built = buildEquivOptions(entry);
      session.options = built.options;
      session.correct = built.correct;
    }

    renderOptions();
  }

  function moduleHasEquiv(module) {
    return !!module.hasEquivalentStep;
  }

  function buildMeaningOptions(entry) {
    var correct = entry.meaning;
    var distractors = pickDistractors(
      correct,
      meaningPools[session.moduleId],
      [],
      5
    );
    return shuffle([correct].concat(distractors)).map(function (text) {
      return { text: text, isCorrect: text === correct };
    });
  }

  function buildEquivOptions(entry) {
    var target =
      entry.equivalents[Math.floor(Math.random() * entry.equivalents.length)];
    var excluded = new Set(entry.equivalents);
    var distractors = [];
    var seen = new Set(excluded);
    var pools = [equivDayPools[session.moduleId][session.day - 1], globalEquivalents];
    for (var i = 0; i < pools.length && distractors.length < 5; i += 1) {
      for (var j = 0; j < pools[i].length && distractors.length < 5; j += 1) {
        var value = pools[i][j];
        if (!seen.has(value)) {
          seen.add(value);
          distractors.push(value);
        }
      }
    }
    return {
      options: shuffle([target].concat(distractors)).map(function (text) {
        return { text: text, isCorrect: text === target };
      }),
      correct: target
    };
  }

  function pickDistractors(correct, primaryPool, fallbackPool, count) {
    var seen = new Set([correct]);
    var out = [];
    var pools = [primaryPool].concat(fallbackPool);
    for (var i = 0; i < pools.length && out.length < count; i += 1) {
      for (var j = 0; j < pools[i].length && out.length < count; j += 1) {
        var value = pools[i][j];
        if (!seen.has(value)) {
          seen.add(value);
          out.push(value);
        }
      }
    }
    return shuffle(out).slice(0, count);
  }

  function renderOptions() {
    var list = document.getElementById("optionList");
    list.innerHTML = session.options
      .map(function (option, index) {
        return (
          '<button type="button" class="option" data-answer="' +
          esc(option.text) +
          '">' +
          '<span class="option-key">' +
          String.fromCharCode(65 + index) +
          "</span>" +
          '<span class="option-text">' +
          esc(option.text) +
          "</span>" +
          "</button>"
        );
      })
      .join("");
  }

  function answerQuestion(selected) {
    if (!session || session.answered) return;
    session.answered = true;
    var isCorrect = selected === session.correct;
    var entry = currentEntry();
    if (!entry) return;

    $$("#optionList .option").forEach(function (btn) {
      btn.disabled = true;
      if (btn.dataset.answer === session.correct) {
        btn.classList.add("is-correct");
      } else if (!isCorrect && btn.dataset.answer === selected) {
        btn.classList.add("is-wrong");
      }
    });

    if (isCorrect) session.log.questionCorrect += 1;
    session.log.questionTotal += 1;

    if (session.stage === "meaning") {
      session.result.meaningCorrect = isCorrect;
    } else {
      session.result.equivCorrect = isCorrect;
    }

    if (!isCorrect) {
      recordWrong(entry);
    }

    renderFeedback(entry, isCorrect);

    var module = moduleById(session.moduleId);
    var isLast = session.index >= session.ids.length - 1;
    var label;
    if (
      session.stage === "meaning" &&
      moduleHasEquiv(module) &&
      entry.equivalents &&
      entry.equivalents.length
    ) {
      label = "继续：选择等价词";
    } else {
      label = isLast ? "查看本日结果" : "下一词";
    }
    var nextBtn = document.getElementById("nextBtn");
    nextBtn.textContent = label;
    nextBtn.classList.remove("is-hidden");
    state.lastPractice = nowIso();
    saveState();
  }

  function recordWrong(entry) {
    var ds = dayState(session.moduleId, session.day);
    var previous = ds.wrong[entry.id] || { count: 0 };
    ds.wrong[entry.id] = {
      word: entry.word,
      meaning: entry.meaning,
      equivalents: (entry.equivalents || []).slice(),
      wrongAt: nowIso(),
      count: (previous.count || 0) + 1
    };
  }

  function renderFeedback(entry, isCorrect) {
    var box = document.getElementById("feedbackBox");
    box.className = "feedback " + (isCorrect ? "feedback-good" : "feedback-bad");
    var module = moduleById(session.moduleId);
    var title;
    if (!moduleHasEquiv(module)) {
      title = isCorrect ? "释义正确" : "释义选错了";
    } else {
      title =
        session.stage === "meaning"
          ? isCorrect
            ? "释义正确"
            : "释义选错了"
          : isCorrect
            ? "等价词正确"
            : "等价词选错了";
    }
    var body;
    if (!moduleHasEquiv(module) || session.stage === "meaning") {
      var equivalentText = entry.equivalents && entry.equivalents.length
        ? esc(entry.equivalents.join("、"))
        : "（资料未提供等价词）";
      body =
        "正确释义：<strong>" +
        esc(entry.meaning) +
        "</strong><br>等价词：" +
        equivalentText;
    } else {
      body =
        "正确等价词：<strong>" +
        esc(session.correct) +
        "</strong><br>中文释义：" +
        esc(entry.meaning);
    }
    box.innerHTML =
      '<div class="feedback-title">' + title + "</div>" +
      '<div class="feedback-body">' + body + "</div>";
  }

  function nextStep() {
    if (!session || !session.answered) return;
    var entry = currentEntry();
    if (!entry) {
      finishSession();
      return;
    }

    var module = moduleById(session.moduleId);
    if (
      session.stage === "meaning" &&
      moduleHasEquiv(module) &&
      entry.equivalents &&
      entry.equivalents.length
    ) {
      session.stage = "equivalent";
      renderQuestion();
      return;
    }

    finalizeEntry(entry);
    session.index += 1;
    if (session.index >= session.ids.length) {
      finishSession();
    } else {
      session.stage = "meaning";
      renderQuestion();
    }
  }

  function finalizeEntry(entry) {
    var module = moduleById(session.moduleId);
    var ds = dayState(session.moduleId, session.day);
    var meaningCorrect = session.result.meaningCorrect == null
      ? null
      : session.result.meaningCorrect;
    var equivCorrect = session.result.equivCorrect == null
      ? null
      : session.result.equivCorrect;
    if (!ds.firstPracticeAt && !ds.progress[entry.id]) {
      ds.firstPracticeAt = nowIso();
    }
    ds.progress[entry.id] = {
      meaningCorrect: meaningCorrect,
      equivCorrect: equivCorrect,
      completedAt: nowIso()
    };
    state.lastPractice = nowIso();

    var fullyCorrect;
    if (!moduleHasEquiv(module) || !entry.equivalents || !entry.equivalents.length) {
      fullyCorrect = meaningCorrect === true;
    } else {
      fullyCorrect = meaningCorrect === true && equivCorrect === true;
    }
    if (fullyCorrect) {
      session.log.correctWords += 1;
    } else {
      session.log.wrongIds.push(entry.id);
    }

    if (session.mode === "wrong" && fullyCorrect) {
      delete ds.wrong[entry.id];
    }
    saveState();
  }

  function finishSession() {
    if (!session) return;
    var ds = dayState(session.moduleId, session.day);
    if (
      session.mode === "all" &&
      dayDone(session.moduleId, session.day) >= dayTotal(session.moduleId, session.day)
    ) {
      ds.completedAt = nowIso();
      state.lastPractice = nowIso();
    }

    var totalWords = session.ids.length;
    var accuracy = totalWords ? session.log.correctWords / totalWords : 0;
    state.sessions.push({
      id: "s" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      moduleId: session.moduleId,
      day: session.day,
      mode: session.mode,
      date: nowIso(),
      totalWords: totalWords,
      correctWords: session.log.correctWords,
      wrongIds: session.log.wrongIds.slice(),
      questionCorrect: session.log.questionCorrect,
      questionTotal: session.log.questionTotal,
      accuracy: accuracy
    });
    saveState();
    renderSummary();
  }

  function renderSummary() {
    showView("summaryView");
    var module = moduleById(session.moduleId);
    var number = session.day;
    var ds = dayState(session.moduleId, number);
    var wrongCount = dayWrongCount(session.moduleId, number);
    var done = dayDone(session.moduleId, number);
    var total = dayTotal(session.moduleId, number);
    var unitLabel =
      module.kind === "single"
        ? module.name
        : module.name + " · 第 " + number + " 天";

    document.getElementById("summaryTitle").textContent =
      session.mode === "wrong"
        ? unitLabel + "错词重练完成"
        : unitLabel + "完成";
    document.getElementById("summarySubtitle").textContent =
      session.mode === "wrong"
        ? "本次错词练习已结束，仍未掌握的单词保留在错词本中。"
        : "本组词条已全部覆盖，答错的单词已记录到错词本。";
    document.getElementById("summaryStats").innerHTML =
      '<div class="stat-box"><strong>' +
      done +
      " / " +
      total +
      "</strong><span>本组已完成词条</span></div>" +
      '<div class="stat-box"><strong>' +
      wrongCount +
      "</strong><span>本组错词</span></div>" +
      '<div class="stat-box"><strong>' +
      moduleUnitCount() +
      " / " +
      MODULES.reduce(function (sum, m) {
        return sum + moduleDays(m).length;
      }, 0) +
      "</strong><span>已完成组别</span></div>";

    var wrongEntries = Object.keys(ds.wrong)
      .map(function (key) { return ds.wrong[key]; })
      .sort(function (a, b) {
        return String(a.wrongAt).localeCompare(String(b.wrongAt));
      });

    var wrongContainer = document.getElementById("summaryWrong");
    if (wrongEntries.length) {
      wrongContainer.innerHTML =
        "<h3>本组错误单词</h3>" +
        wrongEntries.map(wrongRowHtml).join("");
    } else {
      wrongContainer.innerHTML =
        "<h3>本组错误单词</h3><p>本次练习没有答错的单词。</p>";
    }

    var redoBtn = document.getElementById("redoWrongBtn");
    redoBtn.classList.toggle("is-hidden", wrongEntries.length === 0);
    saveState();
  }

  function wrongRowHtml(entry) {
    return (
      '<div class="wrong-entry">' +
      "<strong>" +
      esc(entry.word) +
      "</strong>" +
      '<span class="detail">' +
      esc(entry.meaning) +
      "</span>" +
      '<span class="detail">' +
      esc((entry.equivalents || []).join("、")) +
      "</span>" +
      '<span class="date">' +
      fmtTime(entry.wrongAt) +
      "</span>" +
      "</div>"
    );
  }

  function renderWrongView() {
    showView("wrongView");
    var content = document.getElementById("wrongContent");
    var hasWrong = false;
    var html = "";

    MODULES.forEach(function (module) {
      moduleDays(module).forEach(function (day) {
        var ds = dayState(module.id, day.day);
        var entries = Object.keys(ds.wrong)
          .map(function (key) { return ds.wrong[key]; })
          .sort(function (a, b) {
            return String(a.wrongAt).localeCompare(String(b.wrongAt));
          });
        if (!entries.length) return;
        hasWrong = true;
        var unitLabel = module.kind === "single"
          ? module.name
          : module.name + " · 第 " + day.day + " 天";
        html +=
          '<section class="wrong-module"><h3>' +
          esc(unitLabel) +
          "</h3><p>" +
          entries.length +
          " 个错词</p>" +
          entries.map(wrongRowHtml).join("") +
          "</section>";
      });
    });

    if (!hasWrong) {
      content.innerHTML =
        '<div class="empty-state">还没有错词记录。完成练习后，答错的单词会自动收进这里。</div>';
    } else {
      content.innerHTML = html;
    }
  }

  function renderProfile() {
    showView("profileView");
    var totalWords = 0;
    var correctWords = 0;
    state.sessions.forEach(function (record) {
      totalWords += record.totalWords;
      correctWords += record.correctWords;
    });
    var accuracy = totalWords ? correctWords / totalWords : null;

    document.getElementById("profileOverall").innerHTML =
      '<div class="stat-box"><strong>' +
      state.sessions.length +
      "</strong><span>总练习次数</span></div>" +
      '<div class="stat-box"><strong>' +
      totalAnswered() +
      " / " +
      MODULES.reduce(function (sum, module) {
        return sum + moduleTotalEntries(module);
      }, 0) +
      "</strong><span>累计完成词条</span></div>" +
      '<div class="stat-box"><strong>' +
      fmtPercent(accuracy) +
      "</strong><span>综合正确率</span></div>" +
      '<div class="stat-box"><strong>' +
      totalWrong() +
      "</strong><span>累计错词</span></div>";

    renderSyncStatus();
    renderFirstRecords();
    renderSessionLog();
  }

  function renderFirstRecords() {
    var container = document.getElementById("firstRecords");
    var html = "";
    MODULES.forEach(function (module) {
      moduleDays(module).forEach(function (day) {
        var records = state.sessions
          .filter(function (record) {
            return (
              record.moduleId === module.id &&
              record.day === day.day &&
              record.mode === "all"
            );
          })
          .sort(function (a, b) {
            return String(a.date).localeCompare(String(b.date));
          });
        var unitLabel = module.kind === "single"
          ? module.name
          : module.name + " · 第 " + day.day + " 天";
        if (!records.length) {
          var ds = dayState(module.id, day.day);
          if (ds.firstPracticeAt) {
            var startedWrong = Object.keys(ds.wrong).length;
            var progressStatus = ds.completedAt ? "已完成整组" : "尚未完成整组背词";
            html +=
              '<div class="first-record"><h4>' +
              esc(unitLabel) +
              "</h4>" +
              '<div class="record-meta">' +
              "<span>首次背词：<strong>" +
              fmtTime(ds.firstPracticeAt) +
              "</strong></span>" +
              "<span>当前错词：<strong>" +
              startedWrong +
              "</strong></span>" +
              "<span>" +
              progressStatus +
              "</span>" +
              "</div></div>";
          } else {
          html +=
            '<div class="first-record"><h4>' +
            esc(unitLabel) +
            '</h4><div class="record-meta">尚未开始首次背词</div></div>';
          }
          return;
        }
        var first = records[0];
        var wrongWords = first.wrongIds
          .map(function (id) { return entryById(module.id, day.day, id); })
          .filter(Boolean);
        var chips = wrongWords.length
          ? '<div class="chips">' +
            wrongWords.map(function (entry) {
              return '<span class="chip">' + esc(entry.word) + "</span>";
            }).join("") +
            "</div>"
          : "";
        html +=
          '<div class="first-record"><h4>' +
          esc(unitLabel) +
          "</h4>" +
          '<div class="record-meta">' +
          "<span>首次背词：<strong>" +
          fmtTime(first.date) +
          "</strong></span>" +
          "<span>正确率：<strong>" +
          fmtPercent(first.accuracy) +
          "</strong></span>" +
          "<span>答对：<strong>" +
          first.correctWords +
          " / " +
          first.totalWords +
          "</strong></span>" +
          "<span>错词：<strong>" +
          wrongWords.length +
          "</strong></span>" +
          "</div>" +
          chips +
          "</div>";
      });
    });
    container.innerHTML = html;
  }

  function renderSessionLog() {
    var container = document.getElementById("sessionLog");
    var records = state.sessions.slice().sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
    if (!records.length) {
      container.innerHTML =
        '<div class="empty-state">还没有背词记录，完成一次练习后会显示在这里。</div>';
      return;
    }
    var rows = records.map(function (record) {
      var module = moduleById(record.moduleId);
      var unitLabel = module.kind === "single"
        ? module.name
        : module.name + " · 第 " + record.day + " 天";
      return (
        "<tr>" +
        "<td>" +
        fmtTime(record.date) +
        "</td>" +
        "<td>" +
        esc(unitLabel) +
        "</td>" +
        "<td>" +
        (record.mode === "wrong" ? "错词重练" : "整组练习") +
        "</td>" +
        "<td>" +
        record.totalWords +
        "</td>" +
        "<td>" +
        record.correctWords +
        "</td>" +
        "<td>" +
        fmtPercent(record.accuracy) +
        "</td>" +
        "<td>" +
        record.wrongIds.length +
        "</td>" +
        "</tr>"
      );
    }).join("");
    container.innerHTML =
      '<div class="session-table-wrap"><table class="session-table">' +
      "<thead><tr><th>日期</th><th>模块</th><th>类型</th><th>总词</th><th>答对</th><th>正确率</th><th>错词</th></tr></thead>" +
      "<tbody>" +
      rows +
      "</tbody></table></div>";
  }

  function entryById(moduleId, dayNumber, entryId) {
    var module = moduleById(moduleId);
    var entries = dayEntries(module, dayNumber);
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i].id === entryId) return entries[i];
    }
    return null;
  }

  function resetDay(moduleId, dayNumber) {
    var ds = dayState(moduleId, dayNumber);
    ds.progress = {};
    ds.completedAt = null;
    ds.wrong = {};
    saveState();
  }

  function resetAll() {
    if (!window.confirm("确定清空全部学习档案吗？此操作无法撤销。")) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem("gre-sync-user");
      localStorage.removeItem("gre-sync-code");
    } catch (err) {
      // ignore storage errors and continue with an in-memory reset
    }
    state = blankState();
    session = null;
    saveLocalOnly();
    if (sync.token) pushSync();
    renderHome();
  }

  document.getElementById("moduleTabs").addEventListener("click", function (event) {
    var button = event.target.closest("button[data-module], button[data-action]");
    if (!button) return;
    if (button.dataset.module) {
      activeModuleId = button.dataset.module;
      renderHome();
    } else if (button.dataset.action === "profile") {
      renderProfile();
    }
  });

  document.getElementById("dayList").addEventListener("click", function (event) {
    var button = event.target.closest("button[data-action]");
    if (!button) return;
    var moduleId = button.dataset.module;
    var dayNumber = Number(button.dataset.day);
    var action = button.dataset.action;
    if (action === "start") {
      startSession(moduleId, dayNumber, "all", true);
    } else if (action === "redo") {
      if (
        window.confirm("重新练习本组会清空当天进度和错词记录，确定吗？")
      ) {
        resetDay(moduleId, dayNumber);
        startSession(moduleId, dayNumber, "all", false);
      }
    } else if (action === "wrong") {
      startSession(moduleId, dayNumber, "wrong", false);
    }
  });

  document.getElementById("optionList").addEventListener("click", function (event) {
    var button = event.target.closest("button.option");
    if (button) answerQuestion(button.dataset.answer);
  });

  document.getElementById("nextBtn").addEventListener("click", nextStep);
  document.getElementById("exitBtn").addEventListener("click", function () {
    saveState();
    session = null;
    renderHome();
  });
  document.getElementById("backHomeBtn").addEventListener("click", function () {
    session = null;
    renderHome();
  });
  document.getElementById("redoWrongBtn").addEventListener("click", function () {
    if (session) startSession(session.moduleId, session.day, "wrong", false);
  });
  document.getElementById("wrongBackBtn").addEventListener("click", function () {
    session = null;
    renderHome();
  });
  document.getElementById("profileBackBtn").addEventListener("click", function () {
    session = null;
    renderHome();
  });
  document.getElementById("openWrongBtn").addEventListener("click", renderWrongView);
  document.getElementById("resetBtn").addEventListener("click", resetAll);
  document.getElementById("authLoginTab").addEventListener("click", function () {
    setAuthMode("login");
  });
  document.getElementById("authRegisterTab").addEventListener("click", function () {
    setAuthMode("register");
  });
  document.getElementById("authForm").addEventListener("submit", submitAuth);
  document.getElementById("authOfflineBtn").addEventListener("click", enterLocalMode);
  document.getElementById("logoutBtn").addEventListener("click", logout);

  document.addEventListener("keydown", function (event) {
    if (event.repeat) return;
    var practiceHidden = document
      .getElementById("practiceView")
      .classList.contains("is-hidden");
    if (practiceHidden) return;

    if (!session || session.answered) {
      if (event.key === "Enter" || event.key === " ") {
        var next = document.getElementById("nextBtn");
        if (!next.classList.contains("is-hidden")) {
          event.preventDefault();
          next.click();
        }
      }
      return;
    }

    var digits = ["1", "2", "3", "4", "5", "6"];
    var index = digits.indexOf(event.key);
    var numpad = [
      "Numpad1",
      "Numpad2",
      "Numpad3",
      "Numpad4",
      "Numpad5",
      "Numpad6"
    ];
    if (index === -1) index = numpad.indexOf(event.code);
    if (index >= 0) {
      var buttons = $$("#optionList .option");
      if (buttons[index]) {
        event.preventDefault();
        buttons[index].click();
      }
    }
  });

  window.addEventListener("beforeunload", function () {
    saveState();
    flushSync();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      saveState();
      flushSync();
    }
  });
  window.setInterval(saveState, 30000);

  boot();
})();
