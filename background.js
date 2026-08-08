"use strict";

const TIME_ZONE = "Asia/Shanghai";
const DAILY_ALARM = "caimogu-daily-sign";
const RETRY_ALARM = "caimogu-daily-sign-retry";
const SIGN_PAGE = "https://www.caimogu.cc/vip/daily/sign.html?caimogu_auto=1";
const SIGN_ENDPOINT = "https://www.caimogu.cc/vip/daily/sign";
const DAILY_HOUR = 9;
const DAILY_MINUTE = 0;
const PAGE_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 30 * 60 * 1000;
const MAX_RETRIES_PER_DAY = 3;

// A tiny data URL keeps failure notifications self-contained and avoids storing
// any user data or remote assets in the extension.
const NOTIFICATION_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let activeRun = null;

function getBeijingParts(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(timestamp));

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute
  };
}

function beijingDateKey(timestamp = Date.now()) {
  const { year, month, day } = getBeijingParts(timestamp);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nextDailyAlarmTime(timestamp = Date.now()) {
  const { year, month, day } = getBeijingParts(timestamp);

  // Beijing is UTC+08:00 with no DST.  09:00 Beijing is 01:00 UTC.
  let target = Date.UTC(year, month - 1, day, DAILY_HOUR - 8, DAILY_MINUTE, 0, 0);
  if (target <= timestamp) {
    target = Date.UTC(year, month - 1, day + 1, DAILY_HOUR - 8, DAILY_MINUTE, 0, 0);
  }
  return target;
}

async function readState() {
  return chrome.storage.local.get(["lastSuccessDate", "lastResult", "retryState"]);
}

async function updateBadge(outcome) {
  const badgeByOutcome = {
    running: { text: "…", color: "#d97706" },
    complete: { text: "✓", color: "#16a34a" },
    failure: { text: "!", color: "#dc2626" },
    clear: { text: "", color: "#64748b" }
  };
  const badge = badgeByOutcome[outcome] || badgeByOutcome.clear;

  try {
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } catch {
    // Badge updates are cosmetic and must not affect the sign-in flow.
  }
}

async function refreshBadgeFromState() {
  const state = await readState();
  const today = beijingDateKey();
  if (state.lastSuccessDate === today) {
    await updateBadge("complete");
  } else if (state.lastResult?.date === today && state.lastResult.outcome !== "success") {
    await updateBadge("failure");
  } else {
    await updateBadge("clear");
  }
}

async function ensureDailyAlarm() {
  const existing = await chrome.alarms.get(DAILY_ALARM);
  if (
    !existing ||
    existing.periodInMinutes !== 24 * 60 ||
    !existing.scheduledTime ||
    existing.scheduledTime <= Date.now()
  ) {
    await chrome.alarms.create(DAILY_ALARM, {
      when: nextDailyAlarmTime(),
      periodInMinutes: 24 * 60
    });
  }
}

function waitForTabComplete(tabId, timeoutMs = PAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let timer;
    let finished = false;

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };

    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      cleanup();
      callback(value);
    };

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish(resolve, tab);
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        finish(reject, new Error("签到页在加载完成前被关闭"));
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    timer = setTimeout(
      () => finish(reject, new Error("签到页加载超时")),
      timeoutMs
    );

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish(resolve, tab);
      })
      .catch((error) => finish(reject, error));
  });
}

async function executePageSign(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [SIGN_ENDPOINT, REQUEST_TIMEOUT_MS],
    func: async (endpoint, timeoutMs) => {
      const currentUrl = new URL(location.href);
      const isLoginPath = /login|passport|signin/i.test(currentUrl.pathname);

      if (isLoginPath || currentUrl.hostname !== "www.caimogu.cc") {
        return {
          outcome: "login_required",
          message: "踩蘑菇登录状态不可用，请重新登录"
        };
      }

      if (!currentUrl.pathname.startsWith("/vip/daily/sign")) {
        return {
          outcome: "site_changed",
          message: "签到页地址发生变化"
        };
      }

      const button = document.querySelector(".btn-check");
      if (!button) {
        return {
          outcome: "site_changed",
          message: "未找到签到控件"
        };
      }

      const buttonText = (button.textContent || "").replace(/\s+/g, " ").trim();
      if (button.classList.contains("active") || /今日\s*已签到/.test(buttonText)) {
        return {
          outcome: "already_signed",
          message: buttonText || "今日已签到"
        };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest"
          },
          body: "",
          signal: controller.signal
        });

        const rawBody = await response.text();
        let payload = null;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          // The login page and server error pages are HTML, not JSON.
        }

        const responseUrl = new URL(response.url || endpoint, location.href);
        if (
          responseUrl.hostname !== "www.caimogu.cc" ||
          /login|passport|signin/i.test(responseUrl.pathname) ||
          (payload && Number(payload.status) === -1001) ||
          (!payload && /登录|用户名|password/i.test(rawBody.slice(0, 3000)))
        ) {
          return {
            outcome: "login_required",
            message: payload?.info || "踩蘑菇登录状态不可用，请重新登录",
            httpStatus: response.status
          };
        }

        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          return {
            outcome: retryable ? "network_error" : "site_error",
            message: payload?.info || `签到请求返回 HTTP ${response.status}`,
            retryable,
            httpStatus: response.status
          };
        }

        if (payload && Number(payload.status) === 1) {
          return {
            outcome: "success",
            message: payload.info || "签到成功",
            data: payload.data || null
          };
        }

        const info = String(payload?.info || rawBody || "签到未成功");
        if (/已签到|重复|今日.*签到/.test(info)) {
          return {
            outcome: "already_signed",
            message: info,
            data: payload?.data || null
          };
        }

        return {
          outcome: "site_error",
          message: info.slice(0, 500),
          httpStatus: response.status
        };
      } catch (error) {
        const isTimeout = error?.name === "AbortError";
        return {
          outcome: "network_error",
          message: isTimeout ? "签到请求超时" : `签到请求失败：${error?.message || error}`,
          retryable: true
        };
      } finally {
        clearTimeout(timeout);
      }
    }
  });

  if (!injection || !injection.result) {
    throw new Error("签到页没有返回执行结果");
  }
  return injection.result;
}

function errorToResult(error) {
  return {
    outcome: "network_error",
    message: error?.message || "无法打开签到页",
    retryable: true
  };
}

function compactResult(trigger, result, date, retryCount) {
  const data = result.data && typeof result.data === "object" ? result.data : {};
  return {
    date,
    attemptedAt: new Date().toISOString(),
    trigger,
    outcome: result.outcome,
    message: String(result.message || "").slice(0, 500),
    httpStatus: result.httpStatus || null,
    today: data.today ?? null,
    points: data.points ?? null,
    continuousDays: data.continuous_days ?? null,
    retryable: Boolean(result.retryable),
    retryCount
  };
}

async function showFailureNotification(result) {
  const title =
    result.outcome === "login_required"
      ? "踩蘑菇需要重新登录"
      : "踩蘑菇签到失败";
  const notificationId = `caimogu-sign-${Date.now()}`;

  try {
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON,
      title,
      message: result.message || "请打开踩蘑菇页面检查状态",
      priority: 2
    });
  } catch {
    // A notification failure must not hide the stored result or badge.
  }
}

async function recordResult(trigger, result) {
  const date = beijingDateKey();
  const current = await readState();
  const previousRetry = current.retryState?.date === date ? current.retryState : { date, count: 0 };
  const isComplete = result.outcome === "success" || result.outcome === "already_signed";
  let retryCount = previousRetry.count;
  let retryState = previousRetry;
  let retryScheduled = false;

  if (isComplete) {
    retryState = { date, count: 0 };
    await chrome.alarms.clear(RETRY_ALARM);
    await updateBadge("complete");
  } else {
    await updateBadge("failure");
    if (result.retryable && retryCount < MAX_RETRIES_PER_DAY) {
      retryCount += 1;
      retryState = { date, count: retryCount };
      await chrome.alarms.create(RETRY_ALARM, {
        when: Date.now() + RETRY_DELAY_MS
      });
      retryScheduled = true;
    }
  }

  const lastResult = compactResult(trigger, result, date, retryCount);
  const values = {
    lastResult,
    retryState
  };
  if (isComplete) values.lastSuccessDate = date;
  await chrome.storage.local.set(values);

  const shouldNotify = !isComplete && (!retryScheduled || retryCount >= MAX_RETRIES_PER_DAY);
  if (shouldNotify) await showFailureNotification(lastResult);
  return lastResult;
}

async function executeSign(trigger) {
  await updateBadge("running");
  let tabId = null;
  let result;

  try {
    const tab = await chrome.tabs.create({ url: SIGN_PAGE, active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId);
    result = await executePageSign(tabId);
  } catch (error) {
    result = errorToResult(error);
  } finally {
    if (tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // The tab may have been closed by Chrome or by the user already.
      }
    }
  }

  return recordResult(trigger, result);
}

function runOnce(trigger) {
  if (activeRun) return activeRun;
  activeRun = executeSign(trigger).finally(() => {
    activeRun = null;
  });
  return activeRun;
}

async function runIfDue(trigger) {
  const today = beijingDateKey();
  const state = await readState();
  if (state.lastSuccessDate === today) {
    await chrome.alarms.clear(RETRY_ALARM);
    await updateBadge("complete");
    return { outcome: "already_signed", date: today };
  }
  return runOnce(trigger);
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await ensureDailyAlarm();
    await runIfDue("install");
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureDailyAlarm();
    await runIfDue("startup");
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    if (alarm.name === DAILY_ALARM) {
      await ensureDailyAlarm();
      await runIfDue("scheduled");
    } else if (alarm.name === RETRY_ALARM) {
      await runIfDue("retry");
    }
  })();
});

chrome.action.onClicked.addListener(() => {
  void runOnce("manual");
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith("caimogu-sign-")) return;
  void chrome.tabs.create({ url: SIGN_PAGE, active: true });
});

void ensureDailyAlarm();
void refreshBadgeFromState();
