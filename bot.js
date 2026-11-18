// === БАЗОВЫЕ НАСТРОЙКИ РЕЛИЗА BOTPULT ===
const BOT_CONFIG = {
  version: "1.0.0",          // Текущая версия релиза BotPult
  licenseServerUrl: "https://botpult-license.abuzalgo.workers.dev", // Сервер лицензий и обновлений
  redSecret: "REDCODE_1983_master",             // Секретный ключ для автономных RED-кодов (впишите между кавычками)
  defaultLogin: "admin",     // Логин по умолчанию при первом запуске
  defaultPassword: "05051983", // Пароль по умолчанию при первом запуске
  timezoneOffsetHours: 3,    // Часовой пояс для точного времени (3 = МСК / UTC+3)
  broadcastDelayMs: 45,      // Пауза между сообщениями при массовой рассылке (~22 сообщ/сек)
};

const TG_ALLOWED_UPDATES = ["message", "callback_query", "channel_post", "my_chat_member"];
let schemaMigrated = false;

async function ensureSchemaUpToDate(D1) {
  if (schemaMigrated) return;
  const migrations = [
    "ALTER TABLE funnel_steps ADD COLUMN delete_prev INTEGER DEFAULT 0",
    "ALTER TABLE funnel_steps ADD COLUMN fallback_cfg TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN user_state TEXT DEFAULT ''",
    `CREATE TABLE IF NOT EXISTS consult_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_date TEXT,
      slot_time TEXT,
      slot_ts INTEGER,
      booked_by INTEGER DEFAULT NULL,
      client_name TEXT DEFAULT '',
      client_username TEXT DEFAULT '',
      client_phone TEXT DEFAULT '',
      booked_at INTEGER DEFAULT 0,
      reminded INTEGER DEFAULT 0,
      UNIQUE(slot_date, slot_time)
    )`,
  ];
  for (const sql of migrations) {
    try { await D1.prepare(sql).run(); } catch (e) {}
  }
  schemaMigrated = true;
}

function jsonResp(data, corsHeaders, status = 200) {
  return Response.json(data, { status, headers: corsHeaders });
}

async function registerTgWebhook(token, origin) {
  if (!token) return { ok: false };
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${origin}/webhook`,
      allowed_updates: TG_ALLOWED_UPDATES,
    }),
  });
  return res.json();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    await ensureSchemaUpToDate(env.DB);
    const licenseState = await getLicenseState(env.DB);

    // --- 0. СТАТУС И ОДНОРАЗОВАЯ АКТИВАЦИЯ ЛИЦЕНЗИИ ---
    if (url.pathname === "/api/license/status" && request.method === "GET") {
      return jsonResp({
        activated: Boolean(licenseState.activated),
        version: BOT_CONFIG.version,
        license: licenseState.activated
          ? {
              type: licenseState.type || "standard",
              key_masked: licenseState.key_masked || "",
              activated_at: licenseState.activated_at || 0,
            }
          : null,
      }, corsHeaders);
    }

    if (url.pathname === "/api/license/activate" && request.method === "POST") {
      if (licenseState.activated) {
        return jsonResp({
          success: true,
          already_activated: true,
          license: {
            type: licenseState.type || "standard",
            key_masked: licenseState.key_masked || "",
            activated_at: licenseState.activated_at || 0,
          },
        }, corsHeaders);
      }

      const rateCheck = await checkAuthRateLimit(env);
      if (rateCheck.locked) {
        return jsonResp({ success: false, error: rateCheck.error }, corsHeaders, 429);
      }

      const body = await request.json().catch(() => ({}));
      const upperKey = String(body.key || "").trim().toUpperCase();
      if (!upperKey) {
        return jsonResp({ success: false, error: "Введите лицензионный ключ" }, corsHeaders, 400);
      }

      const now = Math.floor(Date.now() / 1000);

      // А) Автономный RED-код — проверяется локально криптографически без сервера
      if (upperKey.startsWith("RED-")) {
        const isRedValid = await verifyRedCode(upperKey, BOT_CONFIG.redSecret);
        if (!isRedValid) {
          const failMsg = await registerAuthFailure(env, rateCheck.rate, "Недействительный RED-код");
          return jsonResp({ success: false, error: failMsg }, corsHeaders, 401);
        }

        await resetAuthRateLimit(env);
        const savedState = {
          activated: true,
          type: "red",
          key_masked: maskLicenseKey(upperKey),
          activated_at: now,
          domain: url.origin,
        };
        await db.setSetting(env.DB, "license_state", JSON.stringify(savedState));
        return jsonResp({
          success: true,
          license: {
            type: savedState.type,
            key_masked: savedState.key_masked,
            activated_at: savedState.activated_at,
          },
        }, corsHeaders);
      }

      // Б) Обычный ключ (BP-...) — одноразовая проверка на сервере лицензий
      try {
        const verifyRes = await fetch(`${BOT_CONFIG.licenseServerUrl}/api/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            license_key: upperKey,
            instance_id: url.hostname,
            current_version: BOT_CONFIG.version,
          }),
          signal: AbortSignal.timeout(10000),
        });

        const verifyData = await verifyRes.json().catch(() => ({}));
        const isOk = verifyRes.ok && Boolean(verifyData.valid === true || verifyData.success === true || verifyData.ok === true);

        if (!isOk) {
          const serverErr = verifyData.error || verifyData.message || "Ключ недействителен или исчерпан лимит активаций";
          const failMsg = await registerAuthFailure(env, rateCheck.rate, serverErr);
          return jsonResp({ success: false, error: failMsg }, corsHeaders, 400);
        }

        await resetAuthRateLimit(env);
        const savedState = {
          activated: true,
          type: "standard",
          key_masked: maskLicenseKey(upperKey),
          activated_at: now,
          domain: url.origin,
        };
        await db.setSetting(env.DB, "license_state", JSON.stringify(savedState));
        return jsonResp({
          success: true,
          license: {
            type: savedState.type,
            key_masked: savedState.key_masked,
            activated_at: savedState.activated_at,
          },
        }, corsHeaders);
      } catch (err) {
        return jsonResp({
          success: false,
          error: "Сервер лицензий временно недоступен. Попробуйте позже или введите автономный RED-код.",
        }, corsHeaders, 502);
      }
    }

    // Блокировка работы до одноразовой активации лицензии
    if (!licenseState.activated) {
      if (url.pathname === "/webhook") {
        return new Response("OK");
      }
      if (url.pathname.startsWith("/api/")) {
        return jsonResp({ success: false, error: "Требуется активация лицензии BotPult", license_required: true }, corsHeaders, 403);
      }
      return new Response(`BotPult v${BOT_CONFIG.version} (Activation required)`, { headers: corsHeaders });
    }

    const botToken = await getBotToken(env);

    // --- 1. АВТОРИЗАЦИЯ И ВОССТАНОВЛЕНИЕ ДОСТУПА ---
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { login, password } = await request.json();
      const rateCheck = await checkAuthRateLimit(env);
      if (rateCheck.locked) {
        return jsonResp({ success: false, error: rateCheck.error }, corsHeaders, 429);
      }

      const authCfg = await getAuthConfig(env);
      if (String(login).trim() === authCfg.login && String(password) === authCfg.password) {
        await resetAuthRateLimit(env);
        const token = await createSessionToken(authCfg);
        return jsonResp({ success: true, token, is_default: authCfg.is_default, login: authCfg.login }, corsHeaders);
      }
      const failMsg = await registerAuthFailure(env, rateCheck.rate, "Неверный логин или пароль");
      return jsonResp({ success: false, error: failMsg }, corsHeaders, 401);
    }

    if (url.pathname === "/api/recover" && request.method === "POST") {
      const { bot_token, new_login, new_password } = await request.json();
      const rateCheck = await checkAuthRateLimit(env);
      if (rateCheck.locked) {
        return jsonResp({ success: false, error: rateCheck.error }, corsHeaders, 429);
      }

      const submittedToken = String(bot_token || "").trim();
      if (!botToken || !submittedToken || submittedToken !== botToken) {
        const failMsg = await registerAuthFailure(env, rateCheck.rate, "Неверный токен бота");
        return jsonResp({ success: false, error: failMsg }, corsHeaders, 401);
      }

      const cleanLogin = String(new_login || "").trim();
      const cleanPass = String(new_password || "");
      if (!cleanLogin || cleanPass.length < 4) {
        return jsonResp({ success: false, error: "Укажите новый логин и пароль (минимум 4 символа)" }, corsHeaders, 400);
      }

      await resetAuthRateLimit(env);
      const newCfg = { login: cleanLogin, password: cleanPass, is_default: false };
      await db.setSetting(env.DB, "auth_config", JSON.stringify(newCfg));
      const sessionToken = await createSessionToken(newCfg);
      return jsonResp({ success: true, token: sessionToken, is_default: false, login: cleanLogin }, corsHeaders);
    }

    // --- 2. ВЕБХУК ОТ TELEGRAM ---
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (!botToken) return new Response("No bot token");
      const update = await request.json();

      // А) Автофиксация каналов, куда бота добавили админом или откуда удалили
      if (update.my_chat_member) {
        const { chat, new_chat_member } = update.my_chat_member;
        const newStatus = new_chat_member?.status;
        if (chat && (chat.type === "channel" || chat.type === "supergroup")) {
          if (newStatus === "administrator" || newStatus === "creator") {
            await rememberKnownChannel(env.DB, chat);
          } else if (newStatus === "left" || newStatus === "kicked") {
            await forgetKnownChannel(env.DB, chat.id);
          }
        }
        return new Response("OK");
      }

      // Б) Файлы в закрытом канале-хранилище
      if (update.channel_post) {
        const post = update.channel_post;
        if (post.chat) await rememberKnownChannel(env.DB, post.chat);

        const chCfg = await getChannelConfig(env);
        if (chCfg.accept_channel_files === false || isMainSubscriptionChannel(post.chat, chCfg.channel_id)) {
          return new Response("OK");
        }

        let fileId = null;
        let mediaType = null;
        if (post.video) { fileId = post.video.file_id; mediaType = "video"; }
        else if (post.photo) { fileId = post.photo[post.photo.length - 1].file_id; mediaType = "photo"; }
        else if (post.document) { fileId = post.document.file_id; mediaType = "document"; }
        else if (post.audio) { fileId = post.audio.file_id; mediaType = "document"; }
        else if (post.video_note) { fileId = post.video_note.file_id; mediaType = "video"; }

        if (fileId) {
          await sendTelegram(botToken, "sendMessage", {
            chat_id: post.chat.id,
            reply_to_message_id: post.message_id,
            text: `✅ Файл принят в базу!\nТип: <b>${mediaType}</b>\n\nВаш file_id (нажмите, чтобы скопировать):\n<code>${fileId}</code>`,
            parse_mode: "HTML",
          });
        }
        return new Response("OK");
      }

      // В) Нажатия на Inline-кнопки
      if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message.chat.id;
        const msgId = cb.message.message_id;
        const data = cb.data || "";
        const now = Math.floor(Date.now() / 1000);

        if (await db.isUserBanned(env.DB, chatId)) return new Response("OK");

        if (data.startsWith("checksub_")) {
          const isSub = await checkUserSubscription(env, botToken, chatId);
          if (!isSub) {
            await sendTelegram(botToken, "answerCallbackQuery", {
              callback_query_id: cb.id,
              text: "❌ Вы ещё не подписались на канал! Подпишитесь и нажмите кнопку снова.",
              show_alert: true,
            });
            return new Response("OK");
          }

          await sendTelegram(botToken, "answerCallbackQuery", {
            callback_query_id: cb.id,
            text: "✅ Подписка подтверждена!",
          });
          try { await sendTelegram(botToken, "deleteMessage", { chat_id: chatId, message_id: msgId }); } catch (e) {}

          const target = data.replace("checksub_", "");
          if (target.startsWith("step_")) {
            const step = await db.getStepById(env.DB, Number(target.replace("step_", "")));
            if (step) await deliverStep(env, botToken, chatId, step, now, true, true);
          }
          return new Response("OK");
        }

        if (data.startsWith("consult:")) {
          await handleConsultCallback(env, botToken, cb, now);
          return new Response("OK");
        }

        await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id });

        let targetStepId = 0;
        let tagToAdd = "";

        if (data.startsWith("s:")) {
          const parts = data.split(":");
          targetStepId = Number(parts[1] || 0);
          const sourceStepId = Number(parts[2] || 0);
          let btnIdx = -1;

          if (parts.length >= 4 && /^\d+$/.test(parts[3])) {
            btnIdx = Number(parts[3]);
            tagToAdd = parts.slice(4).join(":").trim();
          } else {
            tagToAdd = parts.slice(3).join(":").trim();
          }

          if (sourceStepId > 0) {
            await db.addLog(env.DB, chatId, -sourceStepId, now);
            if (btnIdx >= 0) await db.incrementButtonClick(env.DB, sourceStepId, btnIdx);
          }
        } else if (data.startsWith("step_")) {
          const rawPart = data.replace("step_", "");
          const colonIdx = rawPart.indexOf(":");
          targetStepId = Number(colonIdx === -1 ? rawPart : rawPart.slice(0, colonIdx));
          tagToAdd = colonIdx === -1 ? "" : rawPart.slice(colonIdx + 1).trim();
        }

        if (targetStepId > 0) {
          if (tagToAdd) await db.addUserTag(env.DB, chatId, tagToAdd);
          const step = await db.getStepById(env.DB, targetStepId);
          if (step) {
            if (step.delete_prev === 1 && msgId) {
              try { await sendTelegram(botToken, "deleteMessage", { chat_id: chatId, message_id: msgId }); } catch (e) {}
            }
            await db.addMessage(env.DB, chatId, "user", `[Нажал кнопку → ${step.title || "Шаг #" + step.id}]`, null, now);
            await db.touchUserActivity(env.DB, chatId, now, true);
            await deliverStep(env, botToken, chatId, step, now, true, false);
          }
        }
        return new Response("OK");
      }

      // Г) Личные сообщения, контакты и файлы от пользователей
      if (update.message && update.message.chat.type === "private") {
        const msg = update.message;
        const chatId = msg.chat.id;
        const username = msg.from.username || "";
        const firstName = msg.from.first_name || "Без имени";
        const now = Math.floor(Date.now() / 1000);

        if (await db.isUserBanned(env.DB, chatId)) return new Response("OK");

        let incomingFileId = null;
        let fallbackLabel = "[Медиафайл]";
        if (msg.photo) {
          incomingFileId = "photo:" + msg.photo[msg.photo.length - 1].file_id;
          fallbackLabel = "[Фото]";
        } else if (msg.document) {
          incomingFileId = "document:" + msg.document.file_id;
          fallbackLabel = `[Файл: ${msg.document.file_name || "документ"}]`;
        } else if (msg.video) {
          incomingFileId = "video:" + msg.video.file_id;
          fallbackLabel = "[Видео]";
        } else if (msg.video_note) {
          incomingFileId = "video_note:" + msg.video_note.file_id;
          fallbackLabel = "[Видео-кружочек]";
        } else if (msg.voice) {
          incomingFileId = "voice:" + msg.voice.file_id;
          fallbackLabel = "[Голосовое сообщение]";
        } else if (msg.audio) {
          incomingFileId = "audio:" + msg.audio.file_id;
          fallbackLabel = `[Аудио: ${msg.audio.title || msg.audio.file_name || "аудиофайл"}]`;
        } else if (msg.contact) {
          fallbackLabel = `[Телефон: ${msg.contact.phone_number}]`;
        }

        const rawText = msg.text || msg.caption || fallbackLabel;
        const isStart = rawText === "/start" || rawText.startsWith("/start ");
        const startPayload = rawText.startsWith("/start ") ? rawText.slice(7).trim() : "";

        await db.upsertUser(env.DB, chatId, username, firstName, startPayload, now);
        await db.addMessage(env.DB, chatId, "user", rawText, incomingFileId, now);

        if (isStart) {
          await db.setUserState(env.DB, chatId, "");
          const allSteps = await db.getSteps(env.DB);
          const meta = await getBoardMeta(env.DB);

          let targetStartStep = null;
          if (startPayload) {
            const utmTargetId = meta.utm_links?.[startPayload];
            if (utmTargetId) targetStartStep = allSteps.find(s => Number(s.id) === Number(utmTargetId));
            if (!targetStartStep) targetStartStep = allSteps.find(s => s.trigger_type === "start_source" && s.trigger_value === startPayload);
          }

          if (!targetStartStep) {
            if (meta.default_step_id) targetStartStep = allSteps.find(s => Number(s.id) === Number(meta.default_step_id));
            if (!targetStartStep) targetStartStep = allSteps.find(s => s.trigger_type === "start_default");
          }

          if (targetStartStep) {
            await deliverStep(env, botToken, chatId, targetStartStep, now, false, false);
          }
          return new Response("OK");
        }

        const handledState = await handleUserConsultStateInput(env, botToken, msg, rawText, now);
        if (handledState) return new Response("OK");
      }

      return new Response("OK");
    }

    // --- ПРОВЕРКА АВТОРИЗАЦИИ ДЛЯ ВСЕХ ОСТАЛЬНЫХ /api/* МАРШРУТОВ ---
    if (url.pathname.startsWith("/api/")) {
      const authHeader = request.headers.get("Authorization") || "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      const queryToken = url.searchParams.get("token") || "";
      const authCfg = await getAuthConfig(env);
      if (!(await verifySessionToken(bearerToken || queryToken, authCfg))) {
        return jsonResp({ success: false, error: "Требуется авторизация" }, corsHeaders, 401);
      }
    }

    // --- 3. ЗАЩИЩЁННЫЕ API АДМИНКИ ---
    if (url.pathname === "/api/me" && request.method === "GET") {
      const authCfg = await getAuthConfig(env);
      const testChatId = await db.getSetting(env.DB, "admin_test_chat_id");
      let botUsername = "";
      if (botToken) {
        try {
          const data = await (await fetch(`https://api.telegram.org/bot${botToken}/getMe`)).json();
          botUsername = data.result?.username || "";
        } catch (e) {}
      }
      return jsonResp({
        version: BOT_CONFIG.version,
        license_server_url: BOT_CONFIG.licenseServerUrl,
        license: {
          activated: true,
          type: licenseState.type || "standard",
          key_masked: licenseState.key_masked || "",
          activated_at: licenseState.activated_at || 0,
        },
        login: authCfg.login,
        is_default: authCfg.is_default,
        bot_username: botUsername,
        admin_test_chat_id: testChatId ? Number(testChatId) : null,
      }, corsHeaders);
    }

    // Тихая проверка обновлений (кешируется в D1 на 24 часа, при недоступности сервера молчит)
    if (url.pathname === "/api/version" && request.method === "GET") {
      const now = Math.floor(Date.now() / 1000);
      const force = url.searchParams.get("force") === "1";
      const cacheRaw = await db.getSetting(env.DB, "version_check_cache");
      if (!force && cacheRaw) {
        try {
          const cached = JSON.parse(cacheRaw);
          if (cached && cached.checked_at && (now - cached.checked_at) < 86400) {
            return jsonResp({
              current_version: BOT_CONFIG.version,
              latest_version: cached.latest_version || BOT_CONFIG.version,
              update_url: cached.update_url || "",
              has_update: isNewerVersion(cached.latest_version, BOT_CONFIG.version),
              checked_at: cached.checked_at,
            }, corsHeaders);
          }
        } catch (e) {}
      }

      try {
        const res = await fetch(`${BOT_CONFIG.licenseServerUrl}/api/version`, {
          method: "GET",
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const latestVersion = String(data.latest_version || data.version || BOT_CONFIG.version).trim();
          const updateUrl = String(data.update_url || data.url || "").trim();
          const payload = {
            current_version: BOT_CONFIG.version,
            latest_version: latestVersion,
            update_url: updateUrl,
            has_update: isNewerVersion(latestVersion, BOT_CONFIG.version),
            checked_at: now,
          };
          await db.setSetting(env.DB, "version_check_cache", JSON.stringify(payload));
          return jsonResp(payload, corsHeaders);
        }
      } catch (e) {}

      return jsonResp({
        current_version: BOT_CONFIG.version,
        latest_version: BOT_CONFIG.version,
        update_url: "",
        has_update: false,
      }, corsHeaders);
    }

    if (url.pathname === "/api/settings/test-chat" && request.method === "POST") {
      const { chat_id } = await request.json();
      await db.setSetting(env.DB, "admin_test_chat_id", chat_id ? String(chat_id) : "");
      return jsonResp({ success: true }, corsHeaders);
    }

    if (url.pathname === "/api/funnel/test" && request.method === "POST") {
      const { step_id, chat_id } = await request.json();
      if (!botToken) return jsonResp({ success: false, error: "Сначала подключите бота в настройках" }, corsHeaders, 400);
      const targetChatId = chat_id || Number(await db.getSetting(env.DB, "admin_test_chat_id"));
      if (!targetChatId) return jsonResp({ success: false, error: "Не выбран аккаунт для теста" }, corsHeaders, 400);
      const step = await db.getStepById(env.DB, Number(step_id));
      if (!step) return jsonResp({ success: false, error: "Шаг не найден" }, corsHeaders, 404);

      let parsedButtons = [];
      try { parsedButtons = typeof step.buttons === "string" ? JSON.parse(step.buttons) : (step.buttons || []); } catch (e) {}
      await sendRichMessage(botToken, targetChatId, {
        text: `🧪 <i>[Тест шага: ${escapeHtmlSimple(step.title)}]</i>\n\n${step.text || ""}`,
        attachments: extractAttachments(step),
        buttons: parsedButtons,
        sourceStepId: step.id,
      });
      return jsonResp({ success: true }, corsHeaders);
    }

    if (url.pathname === "/api/settings/auth" && request.method === "POST") {
      const { login, password } = await request.json();
      const cleanLogin = String(login || "").trim();
      const cleanPass = String(password || "");
      if (!cleanLogin || cleanPass.length < 4) {
        return jsonResp({ success: false, error: "Логин обязателен, а пароль должен быть не короче 4 символов" }, corsHeaders, 400);
      }
      const newCfg = { login: cleanLogin, password: cleanPass, is_default: false };
      await db.setSetting(env.DB, "auth_config", JSON.stringify(newCfg));
      return jsonResp({ success: true, token: await createSessionToken(newCfg) }, corsHeaders);
    }

    if (url.pathname === "/api/settings/bot-token" && request.method === "POST") {
      const { token } = await request.json();
      const cleanToken = String(token || "").trim();
      if (!cleanToken) return jsonResp({ success: false, error: "Введите токен бота" }, corsHeaders, 400);

      const checkData = await (await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`)).json();
      if (!checkData.ok || !checkData.result?.username) {
        return jsonResp({ success: false, error: "Telegram отклонил этот токен. Проверьте правильность копирования." }, corsHeaders, 400);
      }

      if (botToken && botToken !== cleanToken) {
        try { await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`); } catch (e) {}
      }

      const whData = await registerTgWebhook(cleanToken, url.origin);
      if (!whData.ok) {
        return jsonResp({ success: false, error: "Не удалось привязать вебхук к новому боту" }, corsHeaders, 400);
      }

      await db.setSetting(env.DB, "bot_token", cleanToken);
      return jsonResp({ success: true, username: checkData.result.username }, corsHeaders);
    }

    if (url.pathname === "/api/export-csv" && request.method === "GET") {
      const users = await db.getUsers(env.DB);
      const header = "Chat ID;Имя;Username;Источник (UTM);Теги;Бан;Дата подписки\n";
      const rows = users.map(u => {
        let tagsStr = "";
        try { tagsStr = JSON.parse(u.tags || "[]").join(", "); } catch (e) {}
        const dateStr = u.joined_at ? new Date(u.joined_at * 1000).toISOString().replace("T", " ").slice(0, 19) : "";
        const safeName = String(u.first_name || "").replace(/;/g, ",");
        return `${u.chat_id};${safeName};${u.username ? "@" + u.username : ""};${u.source || ""};${tagsStr};${u.banned ? "Да" : "Нет"};${dateStr}`;
      }).join("\n");

      return new Response(header + rows, {
        headers: { ...corsHeaders, "Content-Type": "text/csv; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/file" && request.method === "GET") {
      const rawParam = url.searchParams.get("file_id") || "";
      const cleanId = rawParam.replace(/^(photo|document|video|voice|video_note|audio):/, "");
      if (!cleanId || !botToken) return new Response("No file_id", { status: 400 });

      const info = await (await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(cleanId)}`)).json();
      if (!info.ok || !info.result?.file_path) {
        return new Response("Файл недоступен (возможно, он больше 20 МБ или принадлежит старому боту)", { status: 404 });
      }

      const tgFileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`);
      const headers = new Headers(corsHeaders);
      const ct = tgFileRes.headers.get("Content-Type");
      if (ct) headers.set("Content-Type", ct);
      return new Response(tgFileRes.body, { headers });
    }

    if (url.pathname === "/api/users" && request.method === "GET") {
      return jsonResp(await db.getUsers(env.DB), corsHeaders);
    }

    if (url.pathname === "/api/user-action" && request.method === "POST") {
      const { chat_id, action, value } = await request.json();
      if (action === "read") await db.markUserRead(env.DB, chat_id);
      if (action === "pause") await db.setUserPaused(env.DB, chat_id, value ? 1 : 0);
      if (action === "ban") await db.setUserBanned(env.DB, chat_id, value ? 1 : 0);
      if (action === "delete") await db.deleteUserCompletely(env.DB, chat_id);
      return jsonResp({ success: true }, corsHeaders);
    }

    if (url.pathname === "/api/messages" && request.method === "GET") {
      const chatId = Number(url.searchParams.get("chat_id"));
      await db.markUserRead(env.DB, chatId);
      return jsonResp(await db.getMessages(env.DB, chatId), corsHeaders);
    }

    if (url.pathname === "/api/send" && request.method === "POST") {
      const body = await request.json();
      const { chat_id, text } = body;
      const attachments = extractAttachments(body);
      const now = Math.floor(Date.now() / 1000);

      await sendRichMessage(botToken, chat_id, { text, attachments });
      await db.addMessage(env.DB, chat_id, "admin", text || "[Вложение]", serializeStoredFiles(attachments), now);
      await db.touchUserActivity(env.DB, chat_id, now, false);
      return jsonResp({ success: true }, corsHeaders);
    }

    if (url.pathname === "/api/broadcast" && request.method === "POST") {
      const body = await request.json();
      const { target_mode, target_tag, user_ids, text, buttons } = body;
      const attachments = extractAttachments(body);
      const activeUsers = (await db.getUsers(env.DB)).filter(u => !u.banned);
      let targets = [];

      if (target_mode === "all") {
        targets = activeUsers.map(u => u.chat_id);
      } else if (target_mode === "tag" && target_tag) {
        targets = activeUsers
          .filter(u => {
            try { return JSON.parse(u.tags || "[]").includes(target_tag); } catch (e) { return false; }
          })
          .map(u => u.chat_id);
      } else if (target_mode === "manual" && Array.isArray(user_ids)) {
        const activeSet = new Set(activeUsers.map(u => u.chat_id));
        targets = user_ids.filter(id => activeSet.has(id));
      }

      if (targets.length === 0) return jsonResp({ success: false, error: "Нет получателей" }, corsHeaders);

      ctx.waitUntil((async () => {
        const now = Math.floor(Date.now() / 1000);
        const storedFile = serializeStoredFiles(attachments);
        for (const chatId of targets) {
          try {
            await sendRichMessage(botToken, chatId, { text, attachments, buttons });
            await db.addMessage(env.DB, chatId, "admin", `[Рассылка] ${text || "[Вложение]"}`, storedFile, now);
          } catch (e) {}
          await new Promise(r => setTimeout(r, BOT_CONFIG.broadcastDelayMs));
        }
      })());

      return jsonResp({ success: true, count: targets.length }, corsHeaders);
    }

    if (url.pathname === "/api/board-meta") {
      if (request.method === "GET") return jsonResp(await getBoardMeta(env.DB), corsHeaders);
      if (request.method === "POST") {
        await db.setSetting(env.DB, "board_meta", JSON.stringify(await request.json()));
        return jsonResp({ success: true }, corsHeaders);
      }
    }

    if (url.pathname === "/api/channel" && request.method === "GET") {
      if (botToken) {
        try { await registerTgWebhook(botToken, url.origin); } catch (e) {}
      }
      const cfg = await getChannelConfig(env);
      const knownChannels = await getKnownChannels(env.DB);
      return jsonResp({ ...cfg, known_channels: knownChannels }, corsHeaders);
    }

    if (url.pathname === "/api/channel" && request.method === "POST") {
      const body = await request.json();
      const normalizedId = normalizeChannelId(body.channel_id);
      const cleanCfg = {
        channel_id: normalizedId,
        channel_url: String(body.channel_url || "").trim(),
        sub_text: String(body.sub_text || "").trim(),
        accept_channel_files: body.accept_channel_files !== false,
      };

      let checkStatus = { ok: true, message: "Проверка подписки отключена (канал не указан)" };
      if (normalizedId && botToken) {
        try {
          const meData = await (await fetch(`https://api.telegram.org/bot${botToken}/getMe`)).json();
          const botId = meData.result?.id;
          const chatData = await (await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(normalizedId)}`)).json();

          if (!chatData.ok) {
            checkStatus = {
              ok: false,
              message: `⚠️ Бот пока не видит канал (${normalizedId}). Добавьте бота администратором в этот канал и нажмите «Сохранить» снова.`,
            };
          } else {
            await rememberKnownChannel(env.DB, chatData.result);
            const memberData = await (
              await fetch(`https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(normalizedId)}&user_id=${botId}`)
            ).json();
            const st = memberData.result?.status;
            if (st === "administrator" || st === "creator") {
              checkStatus = {
                ok: true,
                message: `✅ Отлично! Бот является админом в канале «${chatData.result.title || normalizedId}» и готов проверять подписку.`,
              };
            } else {
              checkStatus = {
                ok: false,
                message: `⚠️ Канал «${chatData.result.title || normalizedId}» найден, но бот не назначен администратором! Дайте боту права админа.`,
              };
            }
          }
        } catch (e) {
          checkStatus = { ok: false, message: "⚠️ Не удалось проверить права бота в канале." };
        }
      }

      await db.setSetting(env.DB, "channel_config", JSON.stringify(cleanCfg));
      const knownChannels = await getKnownChannels(env.DB);
      return jsonResp({ success: true, config: cleanCfg, check: checkStatus, known_channels: knownChannels }, corsHeaders);
    }

    // --- API КОНСУЛЬТАЦИЙ ---
    if (url.pathname === "/api/consult" && request.method === "GET") {
      const cfg = await getConsultConfig(env.DB);
      const tzSec = BOT_CONFIG.timezoneOffsetHours * 3600;
      const nowSec = Math.floor(Date.now() / 1000);
      const startOfTodayUtc = (Math.floor((nowSec + tzSec) / 86400) * 86400) - tzSec;
      const slots = await db.getConsultSlotsFrom(env.DB, startOfTodayUtc);
      return jsonResp({ config: cfg, slots }, corsHeaders);
    }

    if (url.pathname === "/api/consult/config" && request.method === "POST") {
      const body = await request.json();
      const prev = await getConsultConfig(env.DB);
      const updated = {
        ...prev,
        require_phone: Boolean(body.require_phone),
        remind_minutes: Math.max(0, Number(body.remind_minutes) || 0),
        confirm_text: String(body.confirm_text || prev.confirm_text).trim(),
        remind_text: String(body.remind_text || prev.remind_text).trim(),
        no_slots_text: String(body.no_slots_text || prev.no_slots_text).trim(),
        phone_prompt_text: String(body.phone_prompt_text || prev.phone_prompt_text).trim(),
      };
      await db.setSetting(env.DB, "consult_config", JSON.stringify(updated));
      return jsonResp({ success: true, config: updated }, corsHeaders);
    }

    if (url.pathname === "/api/consult/slots") {
      if (request.method === "POST") {
        const body = await request.json();
        const dates = Array.isArray(body.dates) ? body.dates : (body.slot_date ? [body.slot_date] : []);
        const times = Array.isArray(body.times) ? body.times : (body.slot_time ? [body.slot_time] : []);
        let added = 0;

        for (const dRaw of dates) {
          const dStr = String(dRaw || "").trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dStr)) continue;
          for (const tRaw of times) {
            const tStr = normalizeTimeStr(tRaw);
            if (!tStr) continue;
            const ts = mskDateTimeToUnix(dStr, tStr);
            if (ts > 0 && (await db.insertConsultSlot(env.DB, dStr, tStr, ts))) added++;
          }
        }
        return jsonResp({ success: true, added }, corsHeaders);
      }

      if (request.method === "DELETE") {
        const id = Number(url.searchParams.get("id") || 0);
        const mode = url.searchParams.get("mode") || "";
        if (mode === "free_all") await db.deleteAllFreeConsultSlots(env.DB);
        else if (id > 0) await db.deleteConsultSlot(env.DB, id);
        return jsonResp({ success: true }, corsHeaders);
      }
    }

    if (url.pathname === "/api/consult/cancel-booking" && request.method === "POST") {
      const { slot_id, notify_client } = await request.json();
      const slot = await db.getConsultSlotById(env.DB, Number(slot_id));
      if (!slot || !slot.booked_by) return jsonResp({ success: false, error: "Запись не найдена" }, corsHeaders, 404);

      const clientChatId = slot.booked_by;
      await db.freeConsultSlot(env.DB, slot.id);

      if (notify_client && botToken) {
        const now = Math.floor(Date.now() / 1000);
        await sendTelegram(botToken, "sendMessage", {
          chat_id: clientChatId,
          text: `ℹ️ <b>Запись на консультацию отменена</b>\n\nВаша запись на <b>${formatDateRu(slot.slot_date)} в ${slot.slot_time} МСК</b> была отменена администратором.`,
          parse_mode: "HTML",
        });
        await db.addMessage(env.DB, clientChatId, "admin", `[Админ отменил консультацию: ${formatDateRu(slot.slot_date)} в ${slot.slot_time}]`, null, now);
      }
      return jsonResp({ success: true }, corsHeaders);
    }

    // --- API ВОРОНКИ ---
    if (url.pathname === "/api/funnel") {
      if (request.method === "GET") return jsonResp(await db.getStepsWithStats(env.DB), corsHeaders);
      if (request.method === "POST") {
        const id = await db.createStep(env.DB, await request.json());
        return jsonResp({ success: true, id }, corsHeaders);
      }
      if (request.method === "PUT") {
        await db.updateStep(env.DB, await request.json());
        return jsonResp({ success: true }, corsHeaders);
      }
      if (request.method === "DELETE") {
        await db.deleteStep(env.DB, Number(url.searchParams.get("id")));
        return jsonResp({ success: true }, corsHeaders);
      }
    }

    if (url.pathname === "/api/funnel/pos" && request.method === "POST") {
      const { id, pos_x, pos_y } = await request.json();
      await db.updateStepPosition(env.DB, id, Math.round(pos_x), Math.round(pos_y));
      return jsonResp({ success: true }, corsHeaders);
    }

    return new Response(`BotPult v${BOT_CONFIG.version} Worker is running!`, { headers: corsHeaders });
  },

  // --- 4. МИНУТНЫЙ ПЛАНИРОВЩИК АВТОВОРОНОК И НАПОМИНАНИЙ ---
  async scheduled(event, env, ctx) {
    await ensureSchemaUpToDate(env.DB);
    if (!(await isLicenseActivated(env.DB))) return;

    const botToken = await getBotToken(env);
    if (!botToken) return;

    const now = Math.floor(Date.now() / 1000);

    // А) Напоминания о консультациях
    const consultCfg = await getConsultConfig(env.DB);
    if (consultCfg.remind_minutes > 0) {
      const dueSlots = await db.getDueConsultReminders(env.DB, now, now + consultCfg.remind_minutes * 60);
      const adminChatId = Number(await db.getSetting(env.DB, "admin_test_chat_id")) || 0;

      for (const slot of dueSlots) {
        await db.markConsultSlotReminded(env.DB, slot.id);
        const text = formatConsultTemplate(consultCfg.remind_text, {
          date: formatDateRu(slot.slot_date),
          time: slot.slot_time,
          remindMinutes: consultCfg.remind_minutes,
          phone: slot.client_phone,
        });

        await sendTelegram(botToken, "sendMessage", {
          chat_id: slot.booked_by,
          text,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "❌ Отменить запись", callback_data: `consult:cancel_ask:${slot.id}` }]],
          },
        });
        await db.addMessage(env.DB, slot.booked_by, "admin", `[Напоминание о консультации: ${formatDateRu(slot.slot_date)} в ${slot.slot_time}]`, null, now);

        if (adminChatId && adminChatId !== Number(slot.booked_by)) {
          const clientTag = slot.client_username ? ` (@${escapeHtmlSimple(slot.client_username)})` : "";
          const phoneLine = slot.client_phone ? `\n📱 Телефон: <code>${escapeHtmlSimple(slot.client_phone)}</code>` : "";
          await sendTelegram(botToken, "sendMessage", {
            chat_id: adminChatId,
            text: `⏰ <b>Напоминание: скоро консультация!</b>\n\n👤 Клиент: <b>${escapeHtmlSimple(slot.client_name)}</b>${clientTag}${phoneLine}\n📅 Дата: <b>${formatDateRu(slot.slot_date)}</b>\n🕒 Время: <b>${slot.slot_time} МСК</b> (через ${formatRemindHuman(consultCfg.remind_minutes)})`,
            parse_mode: "HTML",
          });
        }
      }
    }

    // Б) Автоворонки и дожимы
    const allSteps = await db.getSteps(env.DB);
    const stepsById = new Map(allSteps.map(s => [s.id, s]));
    const timedSteps = allSteps.filter(s => ["relative", "msk_time", "not_clicked", "after_step"].includes(s.trigger_type));
    const stepsWithFallback = allSteps.filter(s => {
      if (!s.fallback_cfg) return false;
      try {
        const fb = JSON.parse(s.fallback_cfg);
        return fb && Number(fb.target_id) > 0;
      } catch (e) { return false; }
    });

    if (timedSteps.length === 0 && stepsWithFallback.length === 0) return;

    const users = await db.getUsers(env.DB);
    const logsMap = await db.getLogsMap(env.DB);
    const tzSec = BOT_CONFIG.timezoneOffsetHours * 3600;
    const nowLocal = new Date((now + tzSec) * 1000);
    const nowLocalDayNum = Math.floor((now + tzSec) / 86400);
    const nowLocalMinutesOfDay = nowLocal.getUTCHours() * 60 + nowLocal.getUTCMinutes();

    for (const user of users) {
      if (user.funnel_paused === 1 || user.banned === 1) continue;
      const joinLocalDayNum = Math.floor((user.joined_at + tzSec) / 86400);

      for (const srcStep of stepsWithFallback) {
        let fb = null;
        try { fb = JSON.parse(srcStep.fallback_cfg); } catch (e) {}
        if (!fb || !fb.target_id) continue;

        const targetStepId = Number(fb.target_id);
        const targetStep = stepsById.get(targetStepId);
        if (!targetStep) continue;

        const sourceSentAt = logsMap.get(`${user.chat_id}_${srcStep.id}`);
        if (sourceSentAt && !logsMap.has(`${user.chat_id}_-${srcStep.id}`) && !logsMap.has(`${user.chat_id}_${targetStepId}`)) {
          const offsetSec = ((Number(fb.days) || 0) * 86400) + ((Number(fb.hours) || 0) * 3600) + ((Number(fb.minutes) || 0) * 60);
          if (now >= sourceSentAt + offsetSec) {
            await deliverStep(env, botToken, user.chat_id, targetStep, now, false, false);
            logsMap.set(`${user.chat_id}_${targetStepId}`, now);
          }
        }
      }

      for (const step of timedSteps) {
        if (logsMap.has(`${user.chat_id}_${step.id}`)) continue;
        let shouldSend = false;

        if (step.trigger_type === "relative") {
          const offsetSec = (step.delay_days * 86400) + (step.delay_hours * 3600) + (step.delay_minutes * 60);
          if (now >= user.joined_at + offsetSec) shouldSend = true;
        } else if (step.trigger_type === "msk_time" && step.msk_time) {
          const [hh, mm] = step.msk_time.split(":").map(Number);
          const targetMin = hh * 60 + mm;
          if (
            (nowLocalDayNum - joinLocalDayNum) === step.delay_days &&
            nowLocalMinutesOfDay >= targetMin &&
            (nowLocalMinutesOfDay - targetMin) <= 30 &&
            now > user.joined_at
          ) {
            shouldSend = true;
          }
        } else if (step.trigger_type === "not_clicked" && step.trigger_value) {
          const srcId = Number(step.trigger_value);
          const srcSentAt = logsMap.get(`${user.chat_id}_${srcId}`);
          if (srcSentAt && !logsMap.has(`${user.chat_id}_-${srcId}`)) {
            const offsetSec = (step.delay_days * 86400) + (step.delay_hours * 3600) + (step.delay_minutes * 60);
            if (now >= srcSentAt + offsetSec) shouldSend = true;
          }
        } else if (step.trigger_type === "after_step" && step.trigger_value) {
          const srcSentAt = logsMap.get(`${user.chat_id}_${Number(step.trigger_value)}`);
          if (srcSentAt) {
            if (step.msk_time) {
              const [hh, mm] = step.msk_time.split(":").map(Number);
              const targetMin = hh * 60 + mm;
              const srcDayNum = Math.floor((srcSentAt + tzSec) / 86400);
              if (
                (nowLocalDayNum - srcDayNum) === step.delay_days &&
                nowLocalMinutesOfDay >= targetMin &&
                (nowLocalMinutesOfDay - targetMin) <= 30 &&
                now >= srcSentAt
              ) {
                shouldSend = true;
              }
            } else {
              const offsetSec = (step.delay_days * 86400) + (step.delay_hours * 3600) + (step.delay_minutes * 60);
              if (now >= srcSentAt + offsetSec) shouldSend = true;
            }
          }
        }

        if (shouldSend) {
          await deliverStep(env, botToken, user.chat_id, step, now, false, false);
          logsMap.set(`${user.chat_id}_${step.id}`, now);
        }
      }
    }
  },
};

function escapeHtmlSimple(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// === ЛИЦЕНЗИРОВАНИЕ И ПРОВЕРКА ОБНОВЛЕНИЙ ===
async function getLicenseState(D1) {
  const raw = await db.getSetting(D1, "license_state");
  if (!raw) return { activated: false };
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.activated ? parsed : { activated: false };
  } catch (e) {
    return { activated: false };
  }
}

async function isLicenseActivated(D1) {
  const st = await getLicenseState(D1);
  return Boolean(st.activated);
}

function maskLicenseKey(key) {
  const clean = String(key || "").trim().toUpperCase();
  const parts = clean.split("-");
  if (parts.length >= 3) {
    return `${parts[0]}-${parts[1]}-••••-${parts[parts.length - 1].slice(-4)}`;
  }
  if (clean.length <= 8) return clean.slice(0, 4) + "••••";
  return `${clean.slice(0, 6)}••••${clean.slice(-4)}`;
}

async function computeHmacSignatures(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sigBuf);
  const hexUpper = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const b64Clean = btoa(String.fromCharCode(...bytes)).replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const base36Upper = BigInt("0x" + hexUpper.slice(0, 16)).toString(36).toUpperCase();
  return [hexUpper, b64Clean, base36Upper];
}

async function verifyRedCode(rawCode, secret) {
  const cleanSecret = String(secret || "").trim();
  const code = String(rawCode || "").trim().toUpperCase();
  if (!cleanSecret || !code.startsWith("RED-")) return false;

  const parts = code.split("-");
  if (parts.length < 3) return false;

  const sigPart = parts[parts.length - 1].replace(/[^A-Z0-9]/g, "");
  if (sigPart.length < 6) return false;

  const payloadCore = parts.slice(1, -1).join("-");
  if (!payloadCore) return false;

  const candidates = [
    ...(await computeHmacSignatures(`BOTPULT_RED:${payloadCore}`, cleanSecret)),
    ...(await computeHmacSignatures(payloadCore, cleanSecret)),
    ...(await computeHmacSignatures(`RED-${payloadCore}`, cleanSecret)),
  ];

  return candidates.some(c => c.startsWith(sigPart));
}

function isNewerVersion(remoteVer, localVer) {
  const parse = v => String(v || "0.0.0").replace(/^v/i, "").split(".").map(n => parseInt(n, 10) || 0);
  const r = parse(remoteVer);
  const l = parse(localVer);
  const len = Math.max(r.length, l.length);
  for (let i = 0; i < len; i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

// === ЛОГИКА МОДУЛЯ ЗАПИСИ НА КОНСУЛЬТАЦИЮ ===
function normalizeTimeStr(raw) {
  const m = String(raw || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return "";
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function mskDateTimeToUnix(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  if (!y || !m || !d) return 0;
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm, 0) / 1000) - BOT_CONFIG.timezoneOffsetHours * 3600;
}

function formatDateRu(dateStr) {
  const [y, m, d] = String(dateStr || "").split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const months = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const weekdays = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${d} ${months[m - 1]} (${weekdays[dt.getUTCDay()]})`;
}

function formatRemindHuman(mins) {
  const m = Number(mins) || 0;
  if (m <= 0) return "";
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), remM = m % 60;
  const parts = [];
  if (d > 0) parts.push(`${d} д.`);
  if (h > 0) parts.push(`${h} ч.`);
  if (remM > 0) parts.push(`${remM} мин.`);
  return parts.join(" ");
}

function formatConsultTemplate(tpl, vars) {
  return String(tpl || "")
    .replace(/\{date\}/g, vars.date || "")
    .replace(/\{time\}/g, vars.time || "")
    .replace(/\{remind\}/g, formatRemindHuman(vars.remindMinutes))
    .replace(/\{phone\}/g, vars.phone || "");
}

async function getConsultConfig(D1) {
  const raw = await db.getSetting(D1, "consult_config");
  const defaults = {
    require_phone: false,
    remind_minutes: 60,
    confirm_text: "✅ <b>Вы успешно записаны на консультацию!</b>\n\n📅 Дата: <b>{date}</b>\n🕒 Время: <b>{time} МСК</b>\n\nМы пришлём вам напоминание за {remind} до начала.",
    remind_text: "⏰ <b>Напоминание о консультации!</b>\n\nЧерез {remind} (<b>{date} в {time} МСК</b>) у вас запланирована консультация.",
    no_slots_text: "😔 К сожалению, сейчас все свободные окошки на консультацию заняты. Напишите нам ответным сообщением, и мы подберём время индивидуально!",
    phone_prompt_text: "📱 Для подтверждения записи на <b>{date} в {time} МСК</b> отправьте ваш номер телефона (нажмите кнопку ниже или введите цифрами):",
  };
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; } catch (e) { return defaults; }
}

async function notifyAdminAboutConsult(env, botToken, text) {
  const adminChatId = Number(await db.getSetting(env.DB, "admin_test_chat_id")) || 0;
  if (!adminChatId || !botToken) return;
  try {
    await sendTelegram(botToken, "sendMessage", { chat_id: adminChatId, text, parse_mode: "HTML" });
  } catch (e) {}
}

async function sendOrEditTg(botToken, chatId, editMsgId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (editMsgId) {
    payload.message_id = editMsgId;
    return sendTelegram(botToken, "editMessageText", payload);
  }
  return sendTelegram(botToken, "sendMessage", payload);
}

async function renderConsultDatesView(env, botToken, chatId, now, editMsgId = null) {
  const cfg = await getConsultConfig(env.DB);
  const existing = await db.getActiveUserConsult(env.DB, chatId, now);

  if (existing) {
    const phoneLine = existing.client_phone ? `\n📱 Телефон: <code>${escapeHtmlSimple(existing.client_phone)}</code>` : "";
    const text = `📅 <b>У вас уже есть активная запись на консультацию:</b>\n\nДата: <b>${formatDateRu(existing.slot_date)}</b>\nВремя: <b>${existing.slot_time} МСК</b>${phoneLine}\n\nЧтобы выбрать другое время, сначала отмените текущую запись.`;
    await sendOrEditTg(botToken, chatId, editMsgId, text, {
      inline_keyboard: [[{ text: "❌ Отменить запись", callback_data: `consult:cancel_ask:${existing.id}` }]],
    });
    return;
  }

  const freeSlots = await db.getFreeConsultSlots(env.DB, now + 300);
  if (freeSlots.length === 0) {
    await sendOrEditTg(botToken, chatId, editMsgId, cfg.no_slots_text);
    return;
  }

  const byDate = new Map();
  for (const s of freeSlots) byDate.set(s.slot_date, (byDate.get(s.slot_date) || 0) + 1);

  const keyboard = Array.from(byDate.entries()).map(([dateStr, count]) => [
    { text: `📅 ${formatDateRu(dateStr)} • ${count} своб.`, callback_data: `consult:date:${dateStr}` },
  ]);

  await sendOrEditTg(botToken, chatId, editMsgId, "📅 <b>Запись на консультацию</b>\n\nВыберите удобную дату из доступных ниже:", {
    inline_keyboard: keyboard,
  });
}

async function renderConsultTimesView(env, botToken, chatId, dateStr, now, editMsgId) {
  const slots = await db.getFreeConsultSlotsByDate(env.DB, dateStr, now + 300);
  if (slots.length === 0) {
    await renderConsultDatesView(env, botToken, chatId, now, editMsgId);
    return;
  }

  const keyboard = [];
  let row = [];
  for (const s of slots) {
    row.push({ text: `🕒 ${s.slot_time}`, callback_data: `consult:pick:${s.id}` });
    if (row.length === 3) { keyboard.push(row); row = []; }
  }
  if (row.length > 0) keyboard.push(row);
  keyboard.push([{ text: "« Назад к выбору даты", callback_data: "consult:dates" }]);

  await sendOrEditTg(botToken, chatId, editMsgId, `📅 Дата: <b>${formatDateRu(dateStr)}</b>\n\nВыберите свободное время (по МСК):`, {
    inline_keyboard: keyboard,
  });
}

async function finalizeConsultBooking(env, botToken, chatId, userObj, slot, phone, now, editMsgId = null) {
  const cfg = await getConsultConfig(env.DB);
  const clientName = userObj?.first_name || "Подписчик";
  const clientUsername = userObj?.username || "";

  if (!(await db.bookConsultSlotAtomic(env.DB, slot.id, chatId, clientName, clientUsername, phone, now))) {
    return false;
  }

  const confirmText = formatConsultTemplate(cfg.confirm_text, {
    date: formatDateRu(slot.slot_date),
    time: slot.slot_time,
    remindMinutes: cfg.remind_minutes,
    phone,
  });

  await sendOrEditTg(botToken, chatId, editMsgId, confirmText, {
    inline_keyboard: [[{ text: "❌ Отменить запись", callback_data: `consult:cancel_ask:${slot.id}` }]],
  });

  const logPhone = phone ? ` (тел: ${phone})` : "";
  await db.addMessage(env.DB, chatId, "user", `[Записался на консультацию: ${formatDateRu(slot.slot_date)} в ${slot.slot_time} МСК${logPhone}]`, null, now);
  await db.touchUserActivity(env.DB, chatId, now, true);

  const userTag = clientUsername ? ` (@${escapeHtmlSimple(clientUsername)})` : "";
  const phoneLine = phone ? `\n📱 Телефон: <code>${escapeHtmlSimple(phone)}</code>` : "";
  await notifyAdminAboutConsult(
    env,
    botToken,
    `🔥 <b>Новая запись на консультацию!</b>\n\n👤 Клиент: <b>${escapeHtmlSimple(clientName)}</b>${userTag}${phoneLine}\n📅 Дата: <b>${formatDateRu(slot.slot_date)}</b>\n🕒 Время: <b>${slot.slot_time} МСК</b>`
  );
  return true;
}

async function handleConsultCallback(env, botToken, cb, now) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const parts = (cb.data || "").split(":");
  const action = parts[1] || "";

  if (action === "open") {
    const sourceStepId = Number(parts[2] || 0);
    const btnIdx = parts.length >= 4 && /^\d+$/.test(parts[3]) ? Number(parts[3]) : -1;
    const tagToAdd = parts.length >= 5 ? parts.slice(4).join(":").trim() : "";

    if (sourceStepId > 0) {
      await db.addLog(env.DB, chatId, -sourceStepId, now);
      if (btnIdx >= 0) await db.incrementButtonClick(env.DB, sourceStepId, btnIdx);
    }
    if (tagToAdd) await db.addUserTag(env.DB, chatId, tagToAdd);

    await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id });
    await db.addMessage(env.DB, chatId, "user", "[Открыл запись на консультацию]", null, now);
    await renderConsultDatesView(env, botToken, chatId, now, null);
    return;
  }

  if (action === "dates") {
    await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id });
    await renderConsultDatesView(env, botToken, chatId, now, msgId);
    return;
  }

  if (action === "date") {
    await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id });
    await renderConsultTimesView(env, botToken, chatId, parts[2] || "", now, msgId);
    return;
  }

  if (action === "pick") {
    const slotId = Number(parts[2] || 0);
    if (await db.getActiveUserConsult(env.DB, chatId, now)) {
      await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id, text: "У вас уже есть активная запись!", show_alert: true });
      await renderConsultDatesView(env, botToken, chatId, now, msgId);
      return;
    }

    const slot = await db.getConsultSlotById(env.DB, slotId);
    if (!slot || slot.booked_by || slot.slot_ts <= now) {
      await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id, text: "❌ Это время только что заняли! Выберите другое.", show_alert: true });
      if (slot?.slot_date) await renderConsultTimesView(env, botToken, chatId, slot.slot_date, now, msgId);
      else await renderConsultDatesView(env, botToken, chatId, now, msgId);
      return;
    }

    const cfg = await getConsultConfig(env.DB);
    if (cfg.require_phone) {
      await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id });
      await db.setUserState(env.DB, chatId, JSON.stringify({ state: "await_consult_phone", slot_id: slot.id, exp: now + 900 }));
      await sendOrEditTg(botToken, chatId, msgId, `⏳ Выбрано время: <b>${formatDateRu(slot.slot_date)} в ${slot.slot_time} МСК</b>`);

      const promptText = formatConsultTemplate(cfg.phone_prompt_text, {
        date: formatDateRu(slot.slot_date),
        time: slot.slot_time,
        remindMinutes: cfg.remind_minutes,
      });

      await sendTelegram(botToken, "sendMessage", {
        chat_id: chatId,
        text: promptText,
        parse_mode: "HTML",
        reply_markup: {
          keyboard: [[{ text: "📱 Отправить мой номер", request_contact: true }], [{ text: "❌ Отмена" }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });
      return;
    }

    const userObj = await db.getUserById(env.DB, chatId);
    const ok = await finalizeConsultBooking(env, botToken, chatId, userObj || cb.from, slot, "", now, msgId);
    if (!ok) {
      await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id, text: "❌ Это время только что заняли! Выберите другое.", show_alert: true });
      await renderConsultTimesView(env, botToken, chatId, slot.slot_date, now, msgId);
    } else {
      await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id, text: "✅ Вы успешно записаны!" });
    }
    return;
  }

  if (action === "cancel_ask") {
    const slot = await db.getConsultSlotById(env.DB, Number(parts[2] || 0));
    if (!slot || Number(slot.booked_by) !== Number(chatId)) {
      await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id, text: "Запись уже отменена или не найдена.", show_alert: true });
      return;
    }

    await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id });
    await sendOrEditTg(
      botToken,
      chatId,
      msgId,
      `⚠️ <b>Вы уверены, что хотите отменить запись?</b>\n\n📅 Дата: <b>${formatDateRu(slot.slot_date)}</b>\n🕒 Время: <b>${slot.slot_time} МСК</b>`,
      {
        inline_keyboard: [
          [{ text: "✅ Да, отменить запись", callback_data: `consult:cancel_yes:${slot.id}` }],
          [{ text: "🔙 Нет, оставить запись", callback_data: `consult:cancel_no:${slot.id}` }],
        ],
      }
    );
    return;
  }

  if (action === "cancel_no") {
    const slot = await db.getConsultSlotById(env.DB, Number(parts[2] || 0));
    await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id, text: "Запись сохранена 👍" });

    if (slot && Number(slot.booked_by) === Number(chatId)) {
      const cfg = await getConsultConfig(env.DB);
      const confirmText = formatConsultTemplate(cfg.confirm_text, {
        date: formatDateRu(slot.slot_date),
        time: slot.slot_time,
        remindMinutes: cfg.remind_minutes,
        phone: slot.client_phone,
      });
      await sendOrEditTg(botToken, chatId, msgId, confirmText, {
        inline_keyboard: [[{ text: "❌ Отменить запись", callback_data: `consult:cancel_ask:${slot.id}` }]],
      });
    }
    return;
  }

  if (action === "cancel_yes") {
    const slot = await db.getConsultSlotById(env.DB, Number(parts[2] || 0));
    if (!slot || Number(slot.booked_by) !== Number(chatId)) {
      await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id, text: "Запись уже отменена." });
      return;
    }

    await db.freeConsultSlot(env.DB, slot.id);
    await db.setUserState(
      env.DB,
      chatId,
      JSON.stringify({ state: "await_cancel_reason", slot_date: slot.slot_date, slot_time: slot.slot_time, msg_id: msgId, exp: now + 900 })
    );

    await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id, text: "Запись отменена" });
    await sendOrEditTg(
      botToken,
      chatId,
      msgId,
      `✅ <b>Запись на ${formatDateRu(slot.slot_date)} в ${slot.slot_time} МСК отменена.</b>\n\nЕсли не сложно, напишите одним сообщением причину отмены (необязательно) или нажмите «Пропустить»:`,
      { inline_keyboard: [[{ text: "Пропустить", callback_data: "consult:skip_reason" }]] }
    );

    await db.addMessage(env.DB, chatId, "user", `[Отменил запись на консультацию: ${formatDateRu(slot.slot_date)} в ${slot.slot_time} МСК]`, null, now);
    await db.touchUserActivity(env.DB, chatId, now, true);

    const userTag = slot.client_username ? ` (@${escapeHtmlSimple(slot.client_username)})` : "";
    await notifyAdminAboutConsult(
      env,
      botToken,
      `❌ <b>Клиент отменил запись на консультацию</b>\n\n👤 Клиент: <b>${escapeHtmlSimple(slot.client_name)}</b>${userTag}\n📅 Освободилось: <b>${formatDateRu(slot.slot_date)} в ${slot.slot_time} МСК</b>`
    );
    return;
  }

  if (action === "skip_reason") {
    const rawState = await db.getUserState(env.DB, chatId);
    let st = null;
    try { st = JSON.parse(rawState || "null"); } catch (e) {}
    await db.setUserState(env.DB, chatId, "");

    await sendTelegram(botToken, "answerCallbackQuery", { callback_query_id: cb.id });
    const label = st?.slot_date ? ` на ${formatDateRu(st.slot_date)} в ${st.slot_time} МСК` : "";
    await sendOrEditTg(botToken, chatId, msgId, `✅ <b>Запись${label} отменена.</b>\n\nБудем рады видеть вас в другое время!`);
  }
}

async function handleUserConsultStateInput(env, botToken, msg, rawText, now) {
  const chatId = msg.chat.id;
  const rawState = await db.getUserState(env.DB, chatId);
  if (!rawState) return false;

  let st = null;
  try { st = JSON.parse(rawState); } catch (e) {}
  if (!st || !st.state) return false;

  if (st.exp && now > st.exp) {
    await db.setUserState(env.DB, chatId, "");
    return false;
  }

  if (st.state === "await_consult_phone") {
    if (rawText === "❌ Отмена" || rawText.toLowerCase() === "отмена") {
      await db.setUserState(env.DB, chatId, "");
      await sendTelegram(botToken, "sendMessage", {
        chat_id: chatId,
        text: "Запись на консультацию отменена.",
        reply_markup: { remove_keyboard: true },
      });
      return true;
    }

    const phoneRaw = msg.contact ? msg.contact.phone_number : rawText;
    if (String(phoneRaw || "").replace(/\D/g, "").length < 6) {
      await sendTelegram(botToken, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Пожалуйста, отправьте корректный номер телефона (минимум 6 цифр) или нажмите кнопку <b>«📱 Отправить мой номер»</b> ниже:",
        parse_mode: "HTML",
      });
      return true;
    }

    await db.setUserState(env.DB, chatId, "");
    const cleanPhone = String(phoneRaw).trim().slice(0, 32);
    const slot = await db.getConsultSlotById(env.DB, Number(st.slot_id));

    if (!slot || slot.booked_by || slot.slot_ts <= now) {
      await sendTelegram(botToken, "sendMessage", {
        chat_id: chatId,
        text: "😔 Пока вы вводили номер, это время уже заняли. Выберите другое окошко:",
        reply_markup: { remove_keyboard: true },
      });
      await renderConsultDatesView(env, botToken, chatId, now, null);
      return true;
    }

    await sendTelegram(botToken, "sendMessage", {
      chat_id: chatId,
      text: "📱 Номер получен, оформляю запись...",
      reply_markup: { remove_keyboard: true },
    });

    const userObj = await db.getUserById(env.DB, chatId);
    if (!(await finalizeConsultBooking(env, botToken, chatId, userObj || msg.from, slot, cleanPhone, now, null))) {
      await renderConsultDatesView(env, botToken, chatId, now, null);
    }
    return true;
  }

  if (st.state === "await_cancel_reason") {
    await db.setUserState(env.DB, chatId, "");
    if (st.msg_id) {
      const label = st.slot_date ? ` на ${formatDateRu(st.slot_date)} в ${st.slot_time} МСК` : "";
      try { await sendOrEditTg(botToken, chatId, Number(st.msg_id), `✅ <b>Запись${label} отменена.</b>`); } catch (e) {}
    }

    await sendTelegram(botToken, "sendMessage", {
      chat_id: chatId,
      text: "Спасибо за обратную связь! Будем рады видеть вас в другое время.",
    });

    const userObj = await db.getUserById(env.DB, chatId);
    const name = userObj?.first_name || msg.from?.first_name || "Клиент";
    const uTag = (userObj?.username || msg.from?.username) ? ` (@${escapeHtmlSimple(userObj?.username || msg.from?.username)})` : "";
    await notifyAdminAboutConsult(
      env,
      botToken,
      `💬 <b>Причина отмены консультации</b>\n\n👤 От: <b>${escapeHtmlSimple(name)}</b>${uTag}\n📝 Причина: <i>${escapeHtmlSimple(rawText)}</i>`
    );
    return true;
  }

  return false;
}

// === АВТООПРЕДЕЛЕНИЕ КАНАЛОВ И НОРМАЛИЗАЦИЯ ID ===
function normalizeChannelId(raw) {
  const val = String(raw || "").trim();
  if (!val) return "";
  const pubMatch = val.match(/^https?:\/\/t\.me\/([a-zA-Z0-9_]{4,})$/i);
  if (pubMatch) return `@${pubMatch[1]}`;
  const privPostMatch = val.match(/^https?:\/\/t\.me\/c\/(\d+)/i);
  if (privPostMatch) return `-100${privPostMatch[1]}`;
  if (/^\d{6,15}$/.test(val)) return `-100${val}`;
  return val;
}

async function getKnownChannels(D1) {
  const raw = await db.getSetting(D1, "known_channels");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

async function rememberKnownChannel(D1, chat) {
  if (!chat || !chat.id) return;
  const list = await getKnownChannels(D1);
  const idStr = String(chat.id);
  const entry = { id: idStr, title: chat.title || chat.username || idStr, username: chat.username ? `@${chat.username}` : "" };
  const existingIdx = list.findIndex(c => String(c.id) === idStr);
  if (existingIdx !== -1) list[existingIdx] = entry;
  else list.unshift(entry);
  await db.setSetting(D1, "known_channels", JSON.stringify(list.slice(0, 30)));
}

async function forgetKnownChannel(D1, chatId) {
  const list = await getKnownChannels(D1);
  await db.setSetting(D1, "known_channels", JSON.stringify(list.filter(c => String(c.id) !== String(chatId))));
}

async function getBoardMeta(D1) {
  const raw = await db.getSetting(D1, "board_meta");
  let meta = { start_x: 40, start_y: 120, utm_slugs: [], default_step_id: null, utm_links: {} };
  if (raw) {
    try { meta = { ...meta, ...JSON.parse(raw) }; } catch (e) {}
  }
  if (!Array.isArray(meta.utm_slugs)) meta.utm_slugs = [];
  if (!meta.utm_links || typeof meta.utm_links !== "object") meta.utm_links = {};
  return meta;
}

// === ЗАЩИТА ОТ ПЕРЕБОРА И КРИПТОГРАФИЯ СЕССИЙ ===
async function checkAuthRateLimit(env) {
  const rateRaw = await db.getSetting(env.DB, "auth_ratelimit");
  let rate = { count: 0, locked_until: 0 };
  if (rateRaw) {
    try { rate = { ...rate, ...JSON.parse(rateRaw) }; } catch (e) {}
  }
  const nowMs = Date.now();
  if (rate.locked_until && nowMs < rate.locked_until) {
    return { locked: true, error: `Слишком много попыток. Повторите через ${Math.ceil((rate.locked_until - nowMs) / 1000)} сек.`, rate };
  }
  return { locked: false, rate };
}

async function registerAuthFailure(env, rate, baseMessage) {
  const nextCount = (rate.count || 0) + 1;
  const lockedUntil = nextCount >= 5 ? Date.now() + 5 * 60 * 1000 : 0;
  await db.setSetting(env.DB, "auth_ratelimit", JSON.stringify({ count: lockedUntil ? 0 : nextCount, locked_until: lockedUntil }));
  return lockedUntil ? "Превышено число попыток. Доступ заблокирован на 5 минут." : `${baseMessage} (осталось попыток: ${5 - nextCount})`;
}

async function resetAuthRateLimit(env) {
  await db.setSetting(env.DB, "auth_ratelimit", JSON.stringify({ count: 0, locked_until: 0 }));
}

async function getBotToken(env) {
  return (await db.getSetting(env.DB, "bot_token")) || env.BOT_TOKEN || "";
}

async function getAuthConfig(env) {
  const raw = await db.getSetting(env.DB, "auth_config");
  const defaults = { login: BOT_CONFIG.defaultLogin, password: BOT_CONFIG.defaultPassword, is_default: true };
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; } catch (e) { return defaults; }
}

async function signHmac(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function createSessionToken(authCfg) {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  const payload = btoa(JSON.stringify({ login: authCfg.login, exp }));
  return `${payload}.${await signHmac(payload, `${authCfg.login}:${authCfg.password}`)}`;
}

async function verifySessionToken(token, authCfg) {
  if (!token || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  try {
    const data = JSON.parse(atob(payload));
    if (!data.exp || Math.floor(Date.now() / 1000) > data.exp || data.login !== authCfg.login) return false;
    return sig === (await signHmac(payload, `${authCfg.login}:${authCfg.password}`));
  } catch (e) { return false; }
}

// === ЛОГИКА ДОСТАВКИ, АЛЬБОМОВ И ПРОВЕРКИ ПОДПИСКИ ===
function isMainSubscriptionChannel(chat, configuredChannelId) {
  if (!chat || !configuredChannelId) return false;
  const target = String(configuredChannelId).trim().toLowerCase();
  if (!target) return false;
  return String(chat.id) === target || Boolean(chat.username && `@${chat.username.toLowerCase()}` === target);
}

function extractAttachments(cfg) {
  if (Array.isArray(cfg.attachments) && cfg.attachments.length > 0) {
    return cfg.attachments.filter(a => a && a.file_id).map(a => ({ type: a.type || "document", file_id: String(a.file_id).trim() }));
  }
  if (cfg.media_type === "multi" && cfg.file_id) {
    try {
      const parsed = typeof cfg.file_id === "string" ? JSON.parse(cfg.file_id) : cfg.file_id;
      if (Array.isArray(parsed)) {
        return parsed.filter(a => a && a.file_id).map(a => ({ type: a.type || "document", file_id: String(a.file_id).trim() }));
      }
    } catch (e) {}
  }
  if (cfg.file_id) return [{ type: cfg.media_type || "document", file_id: String(cfg.file_id).trim() }];
  return [];
}

function serializeStoredFiles(attachments) {
  if (!attachments || attachments.length === 0) return null;
  if (attachments.length === 1) return `${attachments[0].type}:${attachments[0].file_id}`;
  return "multi:" + JSON.stringify(attachments);
}

async function getChannelConfig(env) {
  const raw = await db.getSetting(env.DB, "channel_config");
  const defaults = {
    channel_id: "",
    channel_url: "",
    sub_text: "🔒 <b>Доступ закрыт</b>\n\nЧтобы получить этот материал, подпишись на наш канал и нажми кнопку проверки ниже:",
    accept_channel_files: true,
  };
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; } catch (e) { return defaults; }
}

async function checkUserSubscription(env, botToken, chatId) {
  const cfg = await getChannelConfig(env);
  const channelId = normalizeChannelId(cfg.channel_id);
  if (!channelId) return true;
  try {
    const data = await (await fetch(`https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(channelId)}&user_id=${chatId}`)).json();
    if (!data.ok) return true;
    const status = data.result?.status;
    return ["creator", "administrator", "member"].includes(status) || (status === "restricted" && data.result?.is_member);
  } catch (e) { return true; }
}

async function sendSubscriptionGate(env, botToken, chatId, checkTarget, now) {
  const cfg = await getChannelConfig(env);
  const buttons = [];
  if (cfg.channel_url) buttons.push([{ text: "📢 Перейти и подписаться", url: cfg.channel_url }]);
  buttons.push([{ text: "✅ Я подписался", callback_data: `checksub_${checkTarget}` }]);

  await sendTelegram(botToken, "sendMessage", {
    chat_id: chatId,
    text: cfg.sub_text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
  await db.addMessage(env.DB, chatId, "admin", "[Запрос подписки на канал]", null, now);
}

async function deliverStep(env, botToken, chatId, step, now, isButtonTriggered, skipSubCheck) {
  if (step.require_sub && !skipSubCheck && !(await checkUserSubscription(env, botToken, chatId))) {
    await sendSubscriptionGate(env, botToken, chatId, `step_${step.id}`, now);
    return;
  }

  let parsedButtons = [];
  try { parsedButtons = typeof step.buttons === "string" ? JSON.parse(step.buttons) : (step.buttons || []); } catch (e) {}
  const attachments = extractAttachments(step);

  await sendRichMessage(botToken, chatId, { text: step.text, attachments, buttons: parsedButtons, sourceStepId: step.id });

  const prefix = isButtonTriggered ? `[Воронка по кнопке: ${step.title}]` : `[Воронка: ${step.title}]`;
  await db.addMessage(env.DB, chatId, "admin", `${prefix} ${step.text || ""}`, serializeStoredFiles(attachments), now);
  await db.addLog(env.DB, chatId, step.id, now);

  const allSteps = await db.getSteps(env.DB);
  const instantNextSteps = allSteps.filter(s =>
    s.trigger_type === "after_step" &&
    String(s.trigger_value) === String(step.id) &&
    !s.msk_time &&
    !(Number(s.delay_days) || Number(s.delay_hours) || Number(s.delay_minutes))
  );

  for (const nextStep of instantNextSteps) {
    if (Number(nextStep.id) === Number(step.id)) continue;
    await new Promise(r => setTimeout(r, 350));
    await deliverStep(env, botToken, chatId, nextStep, now, false, false);
  }
}

async function sendSingleMediaItem(token, chatId, item, caption = "", replyMarkup = null) {
  const payload = { chat_id: chatId };
  if (caption) { payload.caption = caption; payload.parse_mode = "HTML"; }
  if (replyMarkup) payload.reply_markup = replyMarkup;

  let method = "sendDocument";
  if (item.type === "video") { method = "sendVideo"; payload.video = item.file_id; }
  else if (item.type === "photo") { method = "sendPhoto"; payload.photo = item.file_id; }
  else { payload.document = item.file_id; }

  const res = await sendTelegram(token, method, payload);
  if (!res.ok && res.status === 400 && payload.parse_mode) {
    delete payload.parse_mode;
    return sendTelegram(token, method, payload);
  }
  return res;
}

async function sendRichMessage(token, chatId, cfg) {
  let buttonsList = [];
  try { buttonsList = typeof cfg.buttons === "string" ? JSON.parse(cfg.buttons) : (cfg.buttons || []); } catch (e) {}

  const sourceId = cfg.sourceStepId || 0;
  let replyMarkup = null;
  if (Array.isArray(buttonsList) && buttonsList.length > 0) {
    const keyboard = [];
    for (let idx = 0; idx < buttonsList.length; idx++) {
      const b = buttonsList[idx];
      if (!b.text) continue;
      const cleanTag = b.tag ? String(b.tag).slice(0, 20) : "";
      if (b.type === "url" && b.value) {
        keyboard.push([{ text: b.text, url: b.value }]);
      } else if (b.type === "consult") {
        keyboard.push([{ text: b.text, callback_data: `consult:open:${sourceId}:${idx}:${cleanTag}` }]);
      } else if (b.type === "step" && b.value) {
        keyboard.push([{ text: b.text, callback_data: `s:${b.value}:${sourceId}:${idx}:${cleanTag}` }]);
      }
    }
    if (keyboard.length > 0) replyMarkup = { inline_keyboard: keyboard };
  }

  const attachments = extractAttachments(cfg);
  const text = cfg.text || "";

  if (attachments.length === 0) {
    const payload = { chat_id: chatId, text: text || " ", parse_mode: "HTML" };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const res = await sendTelegram(token, "sendMessage", payload);
    if (!res.ok && res.status === 400) {
      delete payload.parse_mode;
      return sendTelegram(token, "sendMessage", payload);
    }
    return res;
  }

  if (attachments.length === 1) {
    if (text.length > 1024) {
      await sendSingleMediaItem(token, chatId, attachments[0]);
      const payload = { chat_id: chatId, text, parse_mode: "HTML" };
      if (replyMarkup) payload.reply_markup = replyMarkup;
      return sendTelegram(token, "sendMessage", payload);
    }
    return sendSingleMediaItem(token, chatId, attachments[0], text, replyMarkup);
  }

  const canSendAlbum = !replyMarkup && attachments.length <= 10 && text.length <= 1024 && attachments.every(a => a.type === "photo" || a.type === "video");
  if (canSendAlbum) {
    const media = attachments.map((a, idx) => ({
      type: a.type,
      media: a.file_id,
      ...(idx === 0 && text ? { caption: text, parse_mode: "HTML" } : {}),
    }));
    const res = await sendTelegram(token, "sendMediaGroup", { chat_id: chatId, media });
    if (!res.ok && res.status === 400 && text) {
      delete media[0].parse_mode;
      return sendTelegram(token, "sendMediaGroup", { chat_id: chatId, media });
    }
    return res;
  }

  if (text.length <= 1024) {
    for (let i = 0; i < attachments.length - 1; i++) {
      await sendSingleMediaItem(token, chatId, attachments[i]);
      await new Promise(r => setTimeout(r, 80));
    }
    return sendSingleMediaItem(token, chatId, attachments[attachments.length - 1], text, replyMarkup);
  }

  for (const att of attachments) {
    await sendSingleMediaItem(token, chatId, att);
    await new Promise(r => setTimeout(r, 80));
  }
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return sendTelegram(token, "sendMessage", payload);
}

async function sendTelegram(token, method, payload) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// === СЛОЙ РАБОТЫ С БАЗОЙ ДАННЫХ (D1 ADAPTER) ===
const db = {
  async getUsers(D1) {
    const { results } = await D1.prepare("SELECT * FROM users ORDER BY CASE WHEN last_message_at > 0 THEN last_message_at ELSE joined_at END DESC").all();
    return results || [];
  },
  async getUserById(D1, chatId) {
    return D1.prepare("SELECT * FROM users WHERE chat_id = ?").bind(chatId).first();
  },
  async isUserBanned(D1, chatId) {
    const row = await D1.prepare("SELECT banned FROM users WHERE chat_id = ?").bind(chatId).first();
    return row ? row.banned === 1 : false;
  },
  async getUserState(D1, chatId) {
    const row = await D1.prepare("SELECT user_state FROM users WHERE chat_id = ?").bind(chatId).first();
    return row ? (row.user_state || "") : "";
  },
  async setUserState(D1, chatId, stateStr) {
    await D1.prepare("UPDATE users SET user_state = ? WHERE chat_id = ?").bind(stateStr || "", chatId).run();
  },
  async upsertUser(D1, chatId, username, firstName, source, now) {
    await D1.prepare(
      "INSERT OR IGNORE INTO users (chat_id, username, first_name, joined_at, source, tags, funnel_paused, last_message_at, unread, banned, user_state) VALUES (?, ?, ?, ?, ?, '[]', 0, ?, 1, 0, '')"
    ).bind(chatId, username, firstName, now, source || "", now).run();

    if (source) {
      await D1.prepare("UPDATE users SET username = ?, first_name = ?, source = ?, last_message_at = ?, unread = unread + 1 WHERE chat_id = ?")
        .bind(username, firstName, source, now, chatId).run();
    } else {
      await D1.prepare("UPDATE users SET username = ?, first_name = ?, last_message_at = ?, unread = unread + 1 WHERE chat_id = ?")
        .bind(username, firstName, now, chatId).run();
    }
  },
  async touchUserActivity(D1, chatId, now, incrementUnread) {
    const sql = incrementUnread
      ? "UPDATE users SET last_message_at = ?, unread = unread + 1 WHERE chat_id = ?"
      : "UPDATE users SET last_message_at = ? WHERE chat_id = ?";
    await D1.prepare(sql).bind(now, chatId).run();
  },
  async markUserRead(D1, chatId) {
    await D1.prepare("UPDATE users SET unread = 0 WHERE chat_id = ?").bind(chatId).run();
  },
  async setUserPaused(D1, chatId, paused) {
    await D1.prepare("UPDATE users SET funnel_paused = ? WHERE chat_id = ?").bind(paused, chatId).run();
  },
  async setUserBanned(D1, chatId, banned) {
    await D1.prepare("UPDATE users SET banned = ? WHERE chat_id = ?").bind(banned, chatId).run();
  },
  async deleteUserCompletely(D1, chatId) {
    await D1.prepare("UPDATE consult_slots SET booked_by = NULL, client_name = '', client_username = '', client_phone = '', booked_at = 0, reminded = 0 WHERE booked_by = ?").bind(chatId).run();
    await D1.prepare("DELETE FROM messages WHERE chat_id = ?").bind(chatId).run();
    await D1.prepare("DELETE FROM funnel_logs WHERE chat_id = ?").bind(chatId).run();
    await D1.prepare("DELETE FROM users WHERE chat_id = ?").bind(chatId).run();
  },
  async addUserTag(D1, chatId, tag) {
    const user = await D1.prepare("SELECT tags FROM users WHERE chat_id = ?").bind(chatId).first();
    if (!user) return;
    let arr = [];
    try { arr = JSON.parse(user.tags || "[]"); } catch (e) {}
    if (!arr.includes(tag)) {
      arr.push(tag);
      await D1.prepare("UPDATE users SET tags = ? WHERE chat_id = ?").bind(JSON.stringify(arr), chatId).run();
    }
  },
  async getMessages(D1, chatId) {
    const { results } = await D1.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC").bind(chatId).all();
    return results || [];
  },
  async addMessage(D1, chatId, sender, text, fileId, now) {
    await D1.prepare("INSERT INTO messages (chat_id, sender, text, file_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(chatId, sender, text, fileId, now).run();
  },
  async getSetting(D1, key) {
    const row = await D1.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
    return row ? row.value : null;
  },
  async setSetting(D1, key, value) {
    await D1.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
  },
  async getConsultSlotsFrom(D1, minTs) {
    const { results } = await D1.prepare("SELECT * FROM consult_slots WHERE slot_ts >= ? ORDER BY slot_date ASC, slot_time ASC").bind(minTs).all();
    return results || [];
  },
  async getConsultSlotById(D1, id) {
    return D1.prepare("SELECT * FROM consult_slots WHERE id = ?").bind(id).first();
  },
  async getActiveUserConsult(D1, chatId, now) {
    return D1.prepare("SELECT * FROM consult_slots WHERE booked_by = ? AND slot_ts > ? ORDER BY slot_ts ASC LIMIT 1").bind(chatId, now).first();
  },
  async getFreeConsultSlots(D1, minTs) {
    const { results } = await D1.prepare("SELECT * FROM consult_slots WHERE booked_by IS NULL AND slot_ts > ? ORDER BY slot_date ASC, slot_time ASC").bind(minTs).all();
    return results || [];
  },
  async getFreeConsultSlotsByDate(D1, dateStr, minTs) {
    const { results } = await D1.prepare("SELECT * FROM consult_slots WHERE slot_date = ? AND booked_by IS NULL AND slot_ts > ? ORDER BY slot_time ASC").bind(dateStr, minTs).all();
    return results || [];
  },
  async insertConsultSlot(D1, dateStr, timeStr, slotTs) {
    const res = await D1.prepare("INSERT OR IGNORE INTO consult_slots (slot_date, slot_time, slot_ts) VALUES (?, ?, ?)").bind(dateStr, timeStr, slotTs).run();
    return (res.meta?.changes || 0) > 0;
  },
  async bookConsultSlotAtomic(D1, slotId, chatId, clientName, clientUsername, clientPhone, now) {
    const res = await D1.prepare(
      "UPDATE consult_slots SET booked_by = ?, client_name = ?, client_username = ?, client_phone = ?, booked_at = ?, reminded = 0 WHERE id = ? AND booked_by IS NULL"
    ).bind(chatId, clientName, clientUsername, clientPhone || "", now, slotId).run();
    return (res.meta?.changes || 0) > 0;
  },
  async freeConsultSlot(D1, slotId) {
    await D1.prepare("UPDATE consult_slots SET booked_by = NULL, client_name = '', client_username = '', client_phone = '', booked_at = 0, reminded = 0 WHERE id = ?").bind(slotId).run();
  },
  async deleteConsultSlot(D1, slotId) {
    await D1.prepare("DELETE FROM consult_slots WHERE id = ?").bind(slotId).run();
  },
  async deleteAllFreeConsultSlots(D1) {
    await D1.prepare("DELETE FROM consult_slots WHERE booked_by IS NULL").run();
  },
  async getDueConsultReminders(D1, now, maxSlotTs) {
    const { results } = await D1.prepare("SELECT * FROM consult_slots WHERE booked_by IS NOT NULL AND reminded = 0 AND slot_ts > ? AND slot_ts <= ?").bind(now, maxSlotTs).all();
    return results || [];
  },
  async markConsultSlotReminded(D1, slotId) {
    await D1.prepare("UPDATE consult_slots SET reminded = 1 WHERE id = ?").bind(slotId).run();
  },
  async getSteps(D1) {
    const { results } = await D1.prepare("SELECT * FROM funnel_steps ORDER BY id ASC").all();
    return results || [];
  },
  async getStepsWithStats(D1) {
    const steps = await this.getSteps(D1);
    const { results: logRows } = await D1.prepare("SELECT step_id, COUNT(DISTINCT chat_id) as cnt FROM funnel_logs WHERE step_id > 0 GROUP BY step_id").all();
    const viewsMap = new Map((logRows || []).map(r => [Number(r.step_id), Number(r.cnt)]));
    return steps.map(s => ({ ...s, views_count: viewsMap.get(Number(s.id)) || 0 }));
  },
  async incrementButtonClick(D1, stepId, btnIdx) {
    const step = await this.getStepById(D1, stepId);
    if (!step) return;
    let btns = [];
    try { btns = JSON.parse(step.buttons || "[]"); } catch (e) {}
    if (btns[btnIdx]) {
      btns[btnIdx].clicks = (Number(btns[btnIdx].clicks) || 0) + 1;
      await D1.prepare("UPDATE funnel_steps SET buttons = ? WHERE id = ?").bind(JSON.stringify(btns), stepId).run();
    }
  },
  async getStepById(D1, id) {
    return D1.prepare("SELECT * FROM funnel_steps WHERE id = ?").bind(id).first();
  },
  async createStep(D1, b) {
    const res = await D1.prepare(
      `INSERT INTO funnel_steps 
      (title, trigger_type, trigger_value, delay_days, delay_hours, delay_minutes, msk_time, text, file_id, media_type, buttons, require_sub, delete_prev, fallback_cfg, pos_x, pos_y) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      b.title || "Новый шаг", b.trigger_type || "button", b.trigger_value || "",
      Number(b.delay_days) || 0, Number(b.delay_hours) || 0, Number(b.delay_minutes) || 0,
      b.msk_time || "", b.text || "", b.file_id || null, b.media_type || null,
      JSON.stringify(b.buttons || []), b.require_sub ? 1 : 0, b.delete_prev ? 1 : 0,
      b.fallback_cfg || "", Number(b.pos_x) || 380, Number(b.pos_y) || 100
    ).run();
    return res.meta?.last_row_id;
  },
  async updateStep(D1, b) {
    await D1.prepare(
      `UPDATE funnel_steps SET 
      title = ?, trigger_type = ?, trigger_value = ?, delay_days = ?, delay_hours = ?, delay_minutes = ?, 
      msk_time = ?, text = ?, file_id = ?, media_type = ?, buttons = ?, require_sub = ?, delete_prev = ?, fallback_cfg = ? 
      WHERE id = ?`
    ).bind(
      b.title || "Шаг", b.trigger_type || "button", b.trigger_value || "",
      Number(b.delay_days) || 0, Number(b.delay_hours) || 0, Number(b.delay_minutes) || 0,
      b.msk_time || "", b.text || "", b.file_id || null, b.media_type || null,
      JSON.stringify(b.buttons || []), b.require_sub ? 1 : 0, b.delete_prev ? 1 : 0,
      b.fallback_cfg || "", Number(b.id)
    ).run();
  },
  async updateStepPosition(D1, id, posX, posY) {
    await D1.prepare("UPDATE funnel_steps SET pos_x = ?, pos_y = ? WHERE id = ?").bind(posX, posY, id).run();
  },
  async deleteStep(D1, id) {
    await D1.prepare("DELETE FROM funnel_steps WHERE id = ?").bind(id).run();
    await D1.prepare("DELETE FROM funnel_logs WHERE step_id = ? OR step_id = ?").bind(id, -id).run();

    const meta = await getBoardMeta(D1);
    let metaChanged = false;
    if (Number(meta.default_step_id) === Number(id)) { meta.default_step_id = null; metaChanged = true; }
    for (const [slug, targetId] of Object.entries(meta.utm_links || {})) {
      if (Number(targetId) === Number(id)) { delete meta.utm_links[slug]; metaChanged = true; }
    }
    if (metaChanged) await this.setSetting(D1, "board_meta", JSON.stringify(meta));

    for (const s of await this.getSteps(D1)) {
      let changed = false;
      if ((s.trigger_type === "after_step" || s.trigger_type === "not_clicked") && String(s.trigger_value) === String(id)) {
        s.trigger_type = "button";
        s.trigger_value = "";
        changed = true;
      }
      if (s.fallback_cfg) {
        try {
          const fb = JSON.parse(s.fallback_cfg);
          if (fb && Number(fb.target_id) === Number(id)) { s.fallback_cfg = ""; changed = true; }
        } catch (e) {}
      }
      let btns = [];
      try { btns = JSON.parse(s.buttons || "[]"); } catch (e) {}
      if (Array.isArray(btns)) {
        btns.forEach(b => {
          if (b.type === "step" && String(b.value) === String(id)) { b.value = ""; changed = true; }
        });
      }
      if (changed) {
        await D1.prepare("UPDATE funnel_steps SET trigger_type = ?, trigger_value = ?, fallback_cfg = ?, buttons = ? WHERE id = ?")
          .bind(s.trigger_type, s.trigger_value, s.fallback_cfg || "", JSON.stringify(btns), s.id).run();
      }
    }
  },
  async getLogsMap(D1) {
    const { results } = await D1.prepare("SELECT chat_id, step_id, sent_at FROM funnel_logs").all();
    return new Map((results || []).map(l => [`${l.chat_id}_${l.step_id}`, l.sent_at]));
  },
  async addLog(D1, chatId, stepId, now) {
    await D1.prepare("INSERT OR IGNORE INTO funnel_logs (chat_id, step_id, sent_at) VALUES (?, ?, ?)").bind(chatId, stepId, now).run();
  },
};