require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'anthropic/claude-sonnet-4-6';
const metroCoords = require('./metro-coords');

// Фото ЖК
let blockPhotos = {};
try {
  blockPhotos = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/block-photos.json'), 'utf-8'));
  const count = Object.values(blockPhotos).filter(Boolean).length;
  console.log(`🖼️  Загружено ${count} фото ЖК`);
} catch {
  console.warn('⚠️  data/block-photos.json не найден');
}

// ===================== TRENDAGENT LIVE API =====================
const TA_PHONE = process.env.TA_PHONE || '';
const TA_PASSWORD = process.env.TA_PASSWORD || '';
const MOSCOW_CITY_ID = '5a5cb42159042faa9a218d04';

let taToken = null;
let taTokenExpiry = 0;

async function getTaToken() {
  if (taToken && Date.now() < taTokenExpiry) return taToken;
  try {
    const { data } = await axios.post('https://sso-api.trendagent.ru/v1/login', {
      phone: TA_PHONE, password: TA_PASSWORD,
    }, { headers: { Origin: 'https://spb.trendagent.ru' }, timeout: 5000 });
    taToken = data.auth_token;
    taTokenExpiry = Date.now() + 4 * 60 * 1000; // обновляем за минуту до истечения
    return taToken;
  } catch (err) {
    console.error('[TrendAgent] Ошибка авторизации:', err.message);
    return null;
  }
}

function parseSearchParams(userMessage) {
  const msg = userMessage.toLowerCase();
  const params = {
    show_type: 'list',
    'premiseType[]': 'apartment',
    city: MOSCOW_CITY_ID,
    limit: 20,
    sort: 'price',
    sort_order: 'asc',
  };

  // Цена
  const priceFrom = msg.match(/от\s*(\d+)\s*млн/);
  const priceTo = msg.match(/до\s*(\d+)\s*млн/);
  const priceAround = msg.match(/(\d+)\s*млн/);

  if (priceFrom) {
    params.price_from = parseInt(priceFrom[1]) * 1e6;
  }

  if (priceTo) {
    params.price_to = parseInt(priceTo[1]) * 1e6;
    // "до 30 млн" — ищем от 15 до 30 (не от 0)
    if (!priceFrom) params.price_from = Math.round(params.price_to * 0.5);
  }

  if (!priceFrom && !priceTo && priceAround) {
    const p = parseInt(priceAround[1]) * 1e6;
    params.price_from = Math.round(p * 0.7);
    params.price_to = Math.round(p * 1.3);
  }

  // Дефолт: от 25 млн (наш сегмент)
  if (!params.price_from && !params.price_to) {
    params.price_from = 25000000;
  }

  return params;
}

function formatApartments(items) {
  // Группируем по ЖК, пропускаем "по запросу" (price <= 1)
  const blocks = {};
  for (const item of items) {
    if (item.price <= 1) continue;
    const key = item.block_name;
    if (!blocks[key]) {
      blocks[key] = {
        name: item.block_name,
        builder: item.builder?.name,
        district: item.district?.name,
        subway: item.subway?.name,
        apartments: [],
      };
    }
    blocks[key].apartments.push({
      rooms: item.room?.name_short || item.room?.name,
      area: item.area_given,
      floor: item.floor,
      floors: item.floors,
      price: item.price,
      finishing: item.finishing?.name,
      deadline: item.deadline ? item.deadline.split('T')[0].slice(0, 7) : null,
    });
  }

  return Object.values(blocks).map(b => {
    const prices = b.apartments.filter(a => a.price > 1).map(a => a.price);
    const minP = prices.length ? (Math.min(...prices) / 1e6).toFixed(1) : '?';
    const maxP = prices.length ? (Math.max(...prices) / 1e6).toFixed(1) : '?';
    const rooms = [...new Set(b.apartments.map(a => a.rooms).filter(Boolean))].join(', ');
    const areas = b.apartments.map(a => a.area).filter(Boolean);
    const areaRange = areas.length ? `${Math.min(...areas)}-${Math.max(...areas)}` : '?';
    const deadlines = [...new Set(b.apartments.map(a => a.deadline).filter(Boolean))];
    const finishings = [...new Set(b.apartments.map(a => a.finishing).filter(Boolean))];

    // Обогащённые данные из novostroy-m
    const localC = allComplexes.find(c => c.name === b.name);
    const novo = localC?.novostroy || {};
    const rating = novo.rating ? `★${novo.rating}` : '';
    const metro = novo.metroWalk ? `${novo.metroWalk} мин пешком` : '';
    const badges = (novo.badges || []).join(', ');

    let line = `${b.name} | ${b.builder} | ${b.district} | м.${b.subway}`;
    if (metro) line += ` (${metro})`;
    line += ` | ${rooms} | ${areaRange} м² | ${minP}-${maxP} млн ₽ | сдача: ${deadlines[0] || '?'}`;
    if (rating) line += ` | ${rating}`;
    if (badges) line += ` | ${badges}`;
    line += ` | ${b.apartments.length} кв.`;
    return line;
  }).join('\n');
}

async function searchTrendAgent(userMessage) {
  const token = await getTaToken();
  if (!token) return searchLocalFallback(userMessage);

  try {
    const params = parseSearchParams(userMessage);
    const { data } = await axios.get('https://api.trendagent.ru/v4_29/apartments/search/', {
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://spb.trendagent.ru' },
      params,
      timeout: 8000,
    });

    if (!data.data?.list?.length) return searchLocalFallback(userMessage);

    console.log(`[TrendAgent] Live: ${data.data.apartmentsCount} кв., ${data.data.blocksCount} ЖК`);
    lastSearchResults = data.data.list;
    return formatApartments(data.data.list);
  } catch (err) {
    console.error('[TrendAgent] API ошибка:', err.message);
    return searchLocalFallback(userMessage);
  }
}

// ===================== ЛОКАЛЬНАЯ БАЗА (FALLBACK) =====================
let allComplexes = [];
try {
  allComplexes = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/complexes.json'), 'utf-8'));
  console.log(`📦 Загружено ${allComplexes.length} ЖК из локальной базы (fallback)`);
} catch {
  try {
    allComplexes = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/complexes-compact.json'), 'utf-8'));
    console.log(`📦 Загружено ${allComplexes.length} ЖК (compact, fallback)`);
  } catch {
    console.warn('⚠️  Локальная база не найдена');
  }
}

function getMetroCoords(subwayName) {
  if (!subwayName) return null;
  // Убираем скобки с номером линии: "Новопеределкино (8Ал)" → "новопеределкино"
  const clean = subwayName.replace(/\s*\(.*\)/, '').toLowerCase().trim();
  return metroCoords[clean] || null;
}

let lastSearchResults = []; // сохраняем для карты

function buildMapObjects(items) {
  const blocks = {};
  for (const item of items) {
    const key = item.block_name || item.name;
    if (blocks[key]) continue;
    const subway = item.subway?.name || item.subway || '';
    const coords = getMetroCoords(subway);
    if (!coords) continue;
    // Небольшой случайный сдвиг чтобы маркеры не накладывались
    const jitter = () => (Math.random() - 0.5) * 0.008;
    const prices = item.price ? [item.price] : (item.apartments || []).filter(a => a.price > 1).map(a => a.price);
    const minPrice = prices.length ? Math.min(...prices) : 0;
    const photo = blockPhotos[key] || null;

    // Обогащение из novostroy-m (через локальную базу)
    const localComplex = allComplexes.find(c => c.name === key);
    const novo = localComplex?.novostroy || {};

    blocks[key] = {
      name: key,
      builder: item.builder?.name || item.builder || '',
      district: item.district?.name || item.district || '',
      subway: subway.replace(/\s*\(.*\)/, ''),
      metroWalk: novo.metroWalk || null,
      metroColor: novo.metroColor || null,
      price: minPrice > 1 ? `от ${(minPrice / 1e6).toFixed(1)} млн` : 'по запросу',
      rating: novo.rating || null,
      badges: novo.badges || [],
      img: photo,
      lat: coords[0] + jitter(),
      lng: coords[1] + jitter(),
    };
  }
  return Object.values(blocks);
}

function searchLocalFallback(userMessage) {
  if (!allComplexes.length) return 'База данных недоступна.';
  console.log('[TrendAgent] Используем локальный fallback');

  const msg = userMessage.toLowerCase();
  const priceMatch = msg.match(/(\d+)\s*млн/);
  const priceTarget = priceMatch ? parseInt(priceMatch[1]) * 1e6 : null;

  let filtered = allComplexes;

  if (priceTarget) {
    filtered = filtered.filter(c => {
      const s = c.summary || c;
      const min = s.price_min || 0;
      return min <= priceTarget * 1.3;
    });
  }

  if (filtered.length === 0) filtered = allComplexes.slice(0, 15);

  return filtered.slice(0, 15).map(c => {
    const s = c.summary || c;
    const priceMin = s.price_min ? (s.price_min / 1e6).toFixed(1) : '?';
    const priceMax = s.price_max ? (s.price_max / 1e6).toFixed(1) : '?';
    const rooms = Array.isArray(s.rooms) ? s.rooms.join(', ') : (s.rooms || '?');
    return `${c.name} | ${c.builder} | ${c.district} | м.${c.subway} | ${rooms} | ${priceMin}-${priceMax} млн ₽ | ${s.count || '?'} кв.`;
  }).join('\n');
}

// Сессии в памяти (для продакшна — Redis)
const sessions = {};
const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES_PER_SESSION) || 30;

// Очищаем старые сессии каждые 2 часа
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const id in sessions) {
    if (sessions[id].lastActive < cutoff) delete sessions[id];
  }
}, 30 * 60 * 1000);

const COMPANY = process.env.COMPANY_NAME || 'НовоСтрой';
const CITY = process.env.CITY || 'вашем городе';

const SYSTEM_PROMPT = `Ты — Алина, дружелюбный AI-консультант по новостройкам от компании «${COMPANY}». Ты помогаешь людям подобрать квартиру в новостройке в ${CITY}.

ТВОЯ ГЛАВНАЯ ЦЕЛЬ: помочь клиенту и в процессе разговора ненавязчиво получить его контактные данные (номер телефона, WhatsApp или Telegram), чтобы менеджер мог связаться и помочь подробнее.

КАК ВЕСТИ ДИАЛОГ:
1. Если клиент задаёт конкретный запрос (рассрочки, инвестиции, бюджет, район) — СРАЗУ предлагай 3-5 конкретных ЖК из базы ниже. Не уточняй, а действуй.
2. Если запрос слишком общий ("хочу квартиру") — задай 1-2 коротких вопроса и сразу предложи варианты.
3. Называй конкретные ЖК, цены, район, метро — клиент должен видеть реальные варианты с первого сообщения.
4. После первой подборки — предложи отправить подробности в WhatsApp или Telegram.
5. Если человек хочет узнать детали/планировки — скажи что пришлёшь в личку.
6. Когда получишь контакт — тепло поблагодари и скажи что менеджер свяжется в течение 15-30 минут.

ВАЖНО: НЕ задавай больше 1-2 уточняющих вопросов подряд. Клиент пришёл за вариантами — дай их сразу.

ПРАВИЛА:
- Общайся только на русском языке
- Будь живой, тёплой, не как робот
- СТРОГО ЗАПРЕЩЕНО использовать любые эмодзи, смайлы и символы типа 📲 👋 🏠 💰 и подобные. Только текст.
- Называй конкретные ЖК и диапазоны цен из базы — это повышает доверие
- Но для точной цены конкретной квартиры — говори «пришлю актуальный прайс в личку»
- Если спрашивают про ипотеку — скажи что у вас есть ипотечный брокер и он поможет
- Никогда не говори что ты AI, если не спросят напрямую — ты консультант Алина
- Разговор должен быть лёгким, без давления
- Не выдумывай ЖК которых нет в базе

ФОРМАТИРОВАНИЕ:
- Выделяй названия ЖК и ключевые цифры жирным: **Название ЖК**, **от 25 млн ₽**
- Каждый ЖК с новой строки, нумеруй 1. 2. 3.
- Между блоками делай пустую строку
- НЕ используй символы # или markdown заголовки
- Пиши компактно, по делу, без воды

ВАЖНО — КАК ЗАПРАШИВАТЬ КОНТАКТ:
Примеры фраз:
- "Чтобы я отправила вам актуальные планировки и цены — скиньте номер WhatsApp или Telegram 📲"
- "Хочу прислать вам подборку именно под ваш запрос — как вам удобнее: WhatsApp или Telegram?"
- "У нас как раз есть несколько отличных вариантов! Дайте номер телефона — менеджер пришлёт всё подробно"

КОГДА ПОЛУЧАЕШЬ КОНТАКТ:
В самом конце своего сообщения (после основного текста) добавь специальный блок:

[LEAD]
name: [имя клиента или "не указано"]
contact: [номер телефона/telegram/whatsapp — как есть]
summary: [1-2 предложения: что ищет, бюджет, пожелания]
[/LEAD]

Этот блок никогда не показывается клиенту — он только для системы.

ПОДХОДЯЩИЕ ЖК ИЗ БАЗЫ (отфильтрованы под запрос клиента):
Формат: Название | Застройщик | Район | Метро | Комнатность | Площадь | Цена | Сдача | Кол-во квартир
---COMPLEXES---
`;

function extractLead(text) {
  const match = text.match(/\[LEAD\]([\s\S]*?)\[\/LEAD\]/);
  if (!match) return null;
  const block = match[1];
  const name = (block.match(/name:\s*(.+)/) || [])[1]?.trim() || 'не указано';
  const contact = (block.match(/contact:\s*(.+)/) || [])[1]?.trim();
  const summary = (block.match(/summary:\s*(.+)/) || [])[1]?.trim();
  if (!contact || contact === 'не указано') return null;
  return { name, contact, summary };
}

function cleanText(text) {
  return text.replace(/\[LEAD\][\s\S]*?\[\/LEAD\]/g, '').trim();
}

async function sendToTelegram(lead, sessionId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[Telegram] Не настроены TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID');
    return;
  }

  const text =
    `🏠 *Новая заявка с сайта*\n\n` +
    `👤 Имя: ${lead.name}\n` +
    `📱 Контакт: \`${lead.contact}\`\n` +
    `📝 Запрос: ${lead.summary}\n\n` +
    `🆔 Сессия: \`${sessionId.slice(0, 8)}\``;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    });
    console.log('[Telegram] Заявка отправлена:', lead.contact);
  } catch (err) {
    console.error('[Telegram] Ошибка отправки:', err.response?.data || err.message);
  }
}

// POST /api/chat
app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message || !sessionId) {
    return res.status(400).json({ error: 'message и sessionId обязательны' });
  }

  if (!sessions[sessionId]) {
    sessions[sessionId] = { messages: [], leadSent: false, lastActive: Date.now() };
  }
  const session = sessions[sessionId];
  session.lastActive = Date.now();

  // Лимит сообщений на сессию
  if (session.messages.length >= MAX_MESSAGES * 2) {
    return res.json({ message: 'Вы достигли лимита сообщений. Обновите страницу для новой сессии.', leadCollected: session.leadSent, mapObjects: [] });
  }

  session.messages.push({ role: 'user', content: message });

  try {
    // Live-запрос к TrendAgent (fallback на локальную базу)
    const relevantComplexes = await searchTrendAgent(message);
    const dynamicPrompt = SYSTEM_PROMPT.replace('---COMPLEXES---', relevantComplexes);

    const openrouterMessages = [
      { role: 'system', content: dynamicPrompt },
      ...session.messages,
    ];

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: AI_MODEL,
        messages: openrouterMessages,
        max_tokens: 1024,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const raw = response.data.choices[0].message.content;
    session.messages.push({ role: 'assistant', content: raw });

    // Извлекаем и отправляем лид (только один раз за сессию)
    if (!session.leadSent) {
      const lead = extractLead(raw);
      if (lead) {
        session.leadSent = true;
        sendToTelegram(lead, sessionId); // не блокируем ответ
      }
    }

    const clean = cleanText(raw);

    // Строим объекты для карты ТОЛЬКО если AI упоминает конкретные ЖК в ответе
    const mentionedObjects = lastSearchResults.filter(item => {
      const name = (item.block_name || '').replace(/[«»"]/g, '');
      return name && clean.includes(name);
    });
    const mapObjects = mentionedObjects.length > 0 ? buildMapObjects(mentionedObjects) : [];

    res.json({ message: clean, leadCollected: session.leadSent, mapObjects });
  } catch (err) {
    console.error('[AI] Ошибка:', err.response?.data || err.message);
    res.status(500).json({ error: 'Ошибка AI. Попробуйте снова.' });
  }
});

// POST /api/gate-lead — лид из блюр-формы
app.post('/api/gate-lead', async (req, res) => {
  const { name, contact, sessionId } = req.body;
  if (!contact) {
    return res.status(400).json({ error: 'contact обязателен' });
  }

  const lead = {
    name: name || 'не указано',
    contact,
    summary: 'Оставил контакт через форму на сайте (блюр-гейт)',
  };

  const session = sessions[sessionId];
  if (session && !session.leadSent) {
    session.leadSent = true;
  }

  await sendToTelegram(lead, sessionId || 'gate');
  res.json({ ok: true });
});

// GET /api/session — генерация ID сессии
app.get('/api/session', (req, res) => {
  res.json({ sessionId: uuidv4() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
  if (!OPENROUTER_API_KEY) console.warn('⚠️  OPENROUTER_API_KEY не задан');
  if (!process.env.TELEGRAM_BOT_TOKEN) console.warn('⚠️  TELEGRAM_BOT_TOKEN не задан');
});
