// Reflex drill Mini App. Plain JS, no build step.
// Card flow: cue → revealed → graded → next. Card transitions never wait on the network:
// answers are buffered and flushed in groups of 10 with retry, and at finish.
"use strict";

(function () {
  const FLUSH_EVERY = 10;
  const SWIPE_PX = 60;
  const GRACE_MS = 10000; // after time is up, wait this long for the current card
  const RETRY_MAX_MS = 30000;

  const tg = window.Telegram && window.Telegram.WebApp;
  const $ = (id) => document.getElementById(id);

  // ---------- screens ----------

  const screens = ["message", "loading", "picker", "start", "drill", "summary"];
  function show(name) {
    for (const s of screens) $(`screen-${s}`).hidden = s !== name;
  }

  function message(icon, text, action) {
    $("message-icon").textContent = icon;
    $("message-text").textContent = text;
    const btn = $("message-action");
    btn.hidden = !action;
    if (action) {
      btn.textContent = action.label;
      btn.onclick = action.run;
    }
    show("message");
  }

  function loading(text) {
    $("loading-text").textContent = text;
    show("loading");
  }

  // ---------- API ----------

  class ApiError extends Error {
    constructor(status, code) {
      super(`${status} ${code}`);
      this.status = status;
      this.code = code;
      // 4xx other than timeout/rate limit will not succeed on retry.
      this.permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
    }
  }

  async function api(action, body) {
    let res;
    try {
      res = await fetch(`/api/drill/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-init-data": tg.initData },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ApiError(0, "network");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || "error");
    return data;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- drill state ----------

  let session = null; // { sessionId, cardSeconds, totalSeconds, cards }
  let queue = []; // cards in display order; missed cards are spliced back in
  let index = 0;
  let pos = 0; // display position of graded cards, including repeats
  let seen = new Set(); // expressions already attempted (first try)
  let state = "idle"; // idle | cue | revealed | finishing | done
  let cueStart = 0;
  let latencyMs = null;
  let selected = null; // "hit" | "miss" pre-selection after a timeout
  let deadline = 0;
  let timeUp = false;
  let graceTimer = null;
  let rafId = 0;

  const buffer = [];
  let flushing = null;

  // ---------- scope picker ----------

  let pickerShown = false;

  function pickScope() {
    loading("Đang tải danh sách unit…");
    api("units")
      .then((data) => {
        // A bank without units has nothing to choose from.
        if (!data.units.length) return start(null);
        renderPicker(data.units);
        pickerShown = true;
        show("picker");
      })
      .catch((err) => onLoadError(err, pickScope));
  }

  function pickerRow(opts) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    if (opts.className) btn.className = opts.className;
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = opts.title;
    btn.append(title);
    if (opts.count) {
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = opts.count;
      btn.append(count);
    }
    if (opts.progress !== undefined) {
      const bar = document.createElement("span");
      bar.className = "bar";
      const fill = document.createElement("span");
      fill.style.width = `${Math.round(opts.progress * 100)}%`;
      bar.append(fill);
      btn.append(bar);
    }
    if (opts.sub) {
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = opts.sub;
      btn.append(sub);
    }
    if (opts.run) btn.onclick = opts.run;
    else btn.disabled = true;
    li.append(btn);
    return li;
  }

  function renderPicker(units) {
    const rows = [pickerRow({ className: "all", title: "Tất cả", sub: "Ưu tiên cụm hay quên và đến hạn", run: () => start(null) })];
    for (const u of units) {
      const ready = u.learned > 0;
      rows.push(
        pickerRow({
          title: `Unit ${u.unit}`,
          count: `${u.learned}/${u.total}`,
          progress: u.total ? u.learned / u.total : 0,
          sub: ready ? "" : "Chưa học cụm nào",
          run: ready ? () => start(u.unit) : null,
        }),
      );
    }
    $("picker-list").replaceChildren(...rows);
  }

  // ---------- start ----------

  function start(unit) {
    loading("Đang chuẩn bị bộ thẻ…");
    api("start", { unit })
      .then((data) => {
        session = data;
        queue = data.cards.slice();
        $("start-unit").hidden = data.unit == null;
        $("start-unit").textContent = data.unit == null ? "" : `Unit ${data.unit}`;
        $("start-meta").textContent = `tối đa ${Math.round(data.totalSeconds / 60)} phút · ${data.cards.length} cụm`;
        $("start-btn").onclick = begin;
        $("start-back").hidden = !pickerShown;
        $("start-back").onclick = () => show("picker");
        show("start");
      })
      .catch((err) => onStartError(err, unit));
  }

  function onStartError(err, unit) {
    if (err.code === "no_learned_in_unit" || err.code === "invalid_unit") {
      message("📚", `Bạn chưa học cụm nào trong unit ${unit}. Hãy ôn unit này với bot trước (gửi /next), rồi quay lại luyện phản xạ.`, {
        label: "Chọn unit khác",
        run: pickScope,
      });
    } else onLoadError(err, () => start(unit));
  }

  function onLoadError(err, retry) {
    if (err.code === "unregistered") {
      message("🔒", "Bạn chưa đăng ký. Mở bot và gửi /start <mã mời> để bắt đầu.", closeAction());
    } else if (err.code === "invalid_init_data") {
      message("⏳", "Phiên đã hết hạn. Hãy đóng và mở lại trang luyện tập từ bot.", closeAction());
    } else if (err.code === "no_learned") {
      message("📚", "Bạn chưa có cụm nào đã học. Hãy ôn vài lượt với bot trước (gửi /next), rồi quay lại luyện phản xạ.", closeAction());
    } else {
      message("⚠️", "Không tải được bộ thẻ. Kiểm tra mạng rồi thử lại.", { label: "Thử lại", run: retry });
    }
  }

  function closeAction() {
    return { label: "Đóng", run: () => tg.close() };
  }

  function begin() {
    show("drill");
    deadline = performance.now() + session.totalSeconds * 1000;
    index = 0;
    nextCard();
    tick();
  }

  function current() {
    return queue[index];
  }

  function nextCard() {
    if (timeUp || index >= queue.length) return finish();
    const card = current();
    state = "cue";
    selected = null;
    latencyMs = null;
    $("cue").textContent = card.cue;
    $("en").textContent = card.en;
    $("example").textContent = card.example || "";
    $("example").hidden = !card.example;
    $("answer").hidden = true;
    $("grade").hidden = true;
    $("tap-hint").hidden = false;
    $("countdown").hidden = false;
    $("btn-hit").classList.remove("selected");
    $("btn-miss").classList.remove("selected");
    resetCardPosition();
    // Latency counts from when the cue is actually painted.
    cueStart = 0;
    requestAnimationFrame(() => requestAnimationFrame(() => (cueStart = performance.now())));
  }

  function reveal(byTimeout) {
    if (state !== "cue") return;
    state = "revealed";
    latencyMs = Math.round(performance.now() - (cueStart || performance.now()));
    $("answer").hidden = false;
    $("grade").hidden = false;
    $("tap-hint").hidden = true;
    $("countdown").hidden = true;
    if (byTimeout) {
      selected = "miss";
      $("btn-miss").classList.add("selected");
    }
  }

  function grade(result) {
    if (state !== "revealed") return;
    const card = current();
    const firstTry = !seen.has(card.exprId);
    seen.add(card.exprId);
    pos += 1;
    enqueue({ pos, exprId: card.exprId, result, latencyMs, firstTry });
    if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred("light");

    // A missed card comes back 3–5 cards later until it is answered correctly.
    if (result === "miss") {
      const at = Math.min(queue.length, index + 3 + Math.floor(Math.random() * 3));
      queue.splice(at, 0, card);
    }
    $("counter").textContent = `${pos} thẻ`;
    index += 1;
    nextCard();
  }

  // ---------- timers ----------

  function tick() {
    const now = performance.now();
    const left = Math.max(0, deadline - now);
    const total = session.totalSeconds * 1000;
    $("time-fill").style.transform = `scaleX(${left / total})`;
    const secs = Math.ceil(left / 1000);
    $("time-left").textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

    if (state === "cue" && cueStart) {
      const cardLeft = session.cardSeconds * 1000 - (now - cueStart);
      const el = $("countdown");
      el.textContent = String(Math.max(0, Math.ceil(cardLeft / 1000)));
      el.classList.toggle("low", cardLeft <= 2000);
      if (cardLeft <= 0) reveal(true);
    }

    // Time is up: no new card; finish after this card is graded or the grace period ends.
    if (left <= 0 && !timeUp) {
      timeUp = true;
      if (state === "cue" || state === "revealed") graceTimer = setTimeout(finish, GRACE_MS);
    }

    if (state === "cue" || state === "revealed") rafId = requestAnimationFrame(tick);
  }

  // ---------- answers ----------

  function enqueue(answer) {
    buffer.push(answer);
    if (buffer.length >= FLUSH_EVERY) flush();
  }

  // Sends buffered answers in groups of 10, oldest first. A failed group is retried with
  // backoff while the app is open; the server ignores positions it already has.
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      let backoff = 1000;
      while (buffer.length) {
        const group = buffer.slice(0, FLUSH_EVERY);
        try {
          await api("answers", { sessionId: session.sessionId, answers: group });
          buffer.splice(0, group.length);
          backoff = 1000;
          $("sync-status").hidden = true;
        } catch (err) {
          if (err.permanent) {
            console.warn("dropping answers the server rejected", err, group);
            buffer.splice(0, group.length);
            continue;
          }
          $("sync-status").hidden = false;
          await sleep(backoff);
          backoff = Math.min(backoff * 2, RETRY_MAX_MS);
        }
      }
    })().finally(() => (flushing = null));
    return flushing;
  }

  async function finish() {
    if (state === "finishing" || state === "done") return;
    state = "finishing";
    clearTimeout(graceTimer);
    cancelAnimationFrame(rafId);
    loading("Đang lưu kết quả…");

    // Keep flushing until every answer is stored (a flush started earlier may still be running).
    while (buffer.length || flushing) await flush();

    let backoff = 1000;
    for (;;) {
      try {
        const summary = await api("finish", { sessionId: session.sessionId });
        state = "done";
        return showSummary(summary);
      } catch (err) {
        if (err.permanent) {
          state = "done";
          return message("⚠️", "Không lưu được kết quả của lượt này.", closeAction());
        }
        loading("Mất kết nối, đang thử lại…");
        await sleep(backoff);
        backoff = Math.min(backoff * 2, RETRY_MAX_MS);
      }
    }
  }

  function showSummary(s) {
    $("sum-unit").hidden = s.unit == null;
    $("sum-unit").textContent = s.unit == null ? "" : `Unit ${s.unit}`;
    $("sum-cards").textContent = String(s.cards);
    $("sum-accuracy").textContent = s.firstTryAccuracy === null ? "–" : `${Math.round(s.firstTryAccuracy * 100)}%`;
    $("sum-latency").textContent = s.medianLatencyMs === null ? "–" : `${(s.medianLatencyMs / 1000).toFixed(1).replace(".", ",")}s`;
    const list = $("sum-missed-list");
    list.replaceChildren(
      ...s.missed.map((m) => {
        const li = document.createElement("li");
        const b = document.createElement("b");
        b.textContent = m.en;
        const span = document.createElement("span");
        span.textContent = m.cue;
        li.append(b, span);
        return li;
      }),
    );
    $("sum-missed").hidden = s.missed.length === 0;
    $("close-btn").onclick = () => tg.close();
    show("summary");
    if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
  }

  // ---------- input ----------

  const card = $("card");
  let drag = null;

  function resetCardPosition() {
    card.classList.remove("dragging", "lean-hit", "lean-miss");
    card.style.transform = "";
  }

  card.addEventListener("pointerdown", (e) => {
    if (state === "cue") return reveal(false);
    if (state !== "revealed") return;
    drag = { x: e.clientX, dx: 0 };
    card.setPointerCapture(e.pointerId);
    card.classList.add("dragging");
  });

  card.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.dx = e.clientX - drag.x;
    card.style.transform = `translateX(${drag.dx}px) rotate(${drag.dx / 25}deg)`;
    card.classList.toggle("lean-hit", drag.dx > SWIPE_PX);
    card.classList.toggle("lean-miss", drag.dx < -SWIPE_PX);
  });

  function endDrag() {
    if (!drag) return;
    const dx = drag.dx;
    drag = null;
    resetCardPosition();
    if (dx > SWIPE_PX) grade("hit");
    else if (dx < -SWIPE_PX) grade("miss");
  }
  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);

  $("btn-hit").addEventListener("click", () => grade("hit"));
  $("btn-miss").addEventListener("click", () => grade("miss"));

  // Desktop: Space/Enter reveals, → correct, ← wrong.
  document.addEventListener("keydown", (e) => {
    if (state === "cue" && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      reveal(false);
    } else if (state === "revealed" && e.key === "ArrowRight") grade("hit");
    else if (state === "revealed" && e.key === "ArrowLeft") grade("miss");
    else if (state === "revealed" && e.key === "Enter" && selected) grade(selected);
  });

  // ---------- boot ----------

  if (!tg || !tg.initData) {
    message("📱", "Hãy mở trang này trong Telegram: vào bot Expression Drill và bấm nút Luyện phản xạ.");
    return;
  }
  tg.ready();
  tg.expand();
  if (tg.isVersionAtLeast && tg.isVersionAtLeast("7.7") && tg.disableVerticalSwipes) tg.disableVerticalSwipes();
  // `/drill N` opens /drill/?unit=N and skips the picker.
  const unitParam = new URLSearchParams(location.search).get("unit");
  if (unitParam && /^[1-9]\d{0,3}$/.test(unitParam)) start(Number(unitParam));
  else pickScope();
})();
