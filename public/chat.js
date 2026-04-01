/* ===================== STATE ===================== */
let sessionId = null;
let isLoading = false;
let activeObject = null;
let botMessageCount = 0;
let gateUnlocked = localStorage.getItem('gateUnlocked') === 'true';
const GATE_THRESHOLD = 4; // показываем блюр после N ответов бота

const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const chatSuggestions = document.getElementById('chatSuggestions');
const objectCard = document.getElementById('objectCard');
const blurGate = document.getElementById('blurGate');
const tabBar = document.getElementById('tabBar');
const mapBadge = document.getElementById('mapBadge');

/* ===================== MAP ===================== */
const map = L.map('map', {
  center: [55.7558, 37.6173],
  zoom: 11,
  zoomControl: true,
});

L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  attribution: '',
}).addTo(map);

let mapMarkers = [];
let currentMapObjects = [];
const shownNames = new Set();

function updateMap(objects) {
  if (!objects || !objects.length) return;

  // Фильтруем дубли — не добавляем ЖК которые уже на карте
  const newObjects = objects.filter(obj => !shownNames.has(obj.name));
  if (!newObjects.length) return;

  newObjects.forEach(obj => shownNames.add(obj.name));
  currentMapObjects = [...currentMapObjects, ...newObjects];

  const bounds = [];

  newObjects.forEach(obj => {
    const el = document.createElement('div');
    el.className = 'custom-marker';
    el.innerHTML = `<span class="marker-label">${obj.price}</span><span class="marker-dot"></span>`;

    const icon = L.divIcon({ html: el, className: '', iconAnchor: [6, 38] });
    const marker = L.marker([obj.lat, obj.lng], { icon }).addTo(map);

    marker.on('click', () => {
      // Сброс
      document.querySelectorAll('.custom-marker').forEach(m => m.classList.remove('active'));
      el.classList.add('active');

      document.getElementById('objectCardTag').textContent = `${obj.district} · м. ${obj.subway}`;
      document.getElementById('objectCardName').textContent = obj.name;
      document.getElementById('objectCardDesc').textContent = `Застройщик: ${obj.builder}`;
      document.getElementById('objectCardPrice').textContent = obj.price;
      const imgEl = document.getElementById('objectCardImg');
      imgEl.innerHTML = '';
      if (obj.img) {
        imgEl.style.background = `url(${obj.img}) center/cover no-repeat`;
      } else {
        const colors = ['#667eea,#764ba2', '#f093fb,#f5576c', '#4facfe,#00f2fe', '#43e97b,#38f9d7', '#fa709a,#fee140', '#a18cd1,#fbc2eb'];
        const hash = obj.name.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const grad = colors[hash % colors.length];
        imgEl.style.background = `linear-gradient(135deg, ${grad.split(',')[0]}, ${grad.split(',')[1]})`;
      }
      document.getElementById('objectCardBtn').dataset.name = obj.name;

      objectCard.classList.add('visible');
      map.panTo([obj.lat, obj.lng], { animate: true, duration: 0.5 });
    });

    mapMarkers.push(marker);
    bounds.push([obj.lat, obj.lng]);
  });

  if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  } else if (bounds.length === 1) {
    map.setView(bounds[0], 13);
  }
}

function closeObjectCard() {
  objectCard.classList.remove('visible');
  document.querySelectorAll('.custom-marker').forEach(m => m.classList.remove('active'));
}

function askAboutObject() {
  const name = document.getElementById('objectCardBtn').dataset.name;
  closeObjectCard();
  chatInput.value = `Расскажите подробнее про ${name}`;
  sendMessage();
}

/* ===================== SESSION ===================== */
async function initSession() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    sessionId = data.sessionId;
  } catch {
    sessionId = 'local-' + Math.random().toString(36).slice(2, 10);
  }
}

/* ===================== CHAT ===================== */
function getTime() {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatBotText(text) {
  // Экранируем HTML
  let safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // **bold** → <strong>
  safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Переносы строк
  safe = safe.replace(/\n/g, '<br>');
  return safe;
}

function appendMsg(type, text) {
  const msg = document.createElement('div');
  msg.className = `msg msg--${type}`;

  const bubble = document.createElement('div');
  bubble.className = 'msg__bubble';
  if (type === 'bot') {
    bubble.innerHTML = formatBotText(text);
  } else {
    bubble.textContent = text;
  }

  const time = document.createElement('span');
  time.className = 'msg__time';
  time.textContent = getTime();

  if (type === 'bot') {
    const av = document.createElement('div');
    av.className = 'msg__av';
    av.textContent = 'А';
    msg.appendChild(av);
    msg.appendChild(bubble);
    msg.appendChild(time);
  } else {
    msg.appendChild(time);
    msg.appendChild(bubble);
  }

  chatMessages.appendChild(msg);
  scrollBottom();
}

function showTyping() {
  const t = document.createElement('div');
  t.className = 'typing';
  t.id = 'typing';
  t.innerHTML = `
    <div class="msg__av">А</div>
    <div class="typing__bubble">
      <span class="typing__dot"></span>
      <span class="typing__dot"></span>
      <span class="typing__dot"></span>
    </div>`;
  chatMessages.appendChild(t);
  scrollBottom();
}

function removeTyping() {
  document.getElementById('typing')?.remove();
}

function showLeadConfirm() {
  const el = document.createElement('div');
  el.className = 'lead-confirm';
  el.innerHTML = '✓ &nbsp;Заявка принята — менеджер свяжется с вами в ближайшее время';
  chatMessages.appendChild(el);
  scrollBottom();
}

function scrollBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function suggest(text) {
  chatSuggestions.style.display = 'none';
  chatInput.value = text;
  sendMessage();
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || isLoading) return;

  chatSuggestions.style.display = 'none';
  appendMsg('user', text);
  chatInput.value = '';
  chatInput.style.height = 'auto';

  isLoading = true;
  chatSend.disabled = true;
  showTyping();

  await new Promise(r => setTimeout(r, 350));

  try {
    if (!sessionId) await initSession();

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId }),
    });

    const data = await res.json();
    removeTyping();

    appendMsg('bot', res.ok ? data.message : (data.error || 'Ошибка. Попробуйте ещё раз.'));

    if (res.ok) {
      botMessageCount++;
      checkBlurGate();
    }

    if (data.leadCollected) {
      gateUnlocked = true;
      localStorage.setItem('gateUnlocked', 'true');
      showLeadConfirm();
    }

    // Обновляем карту реальными ЖК из TrendAgent
    if (data.mapObjects && data.mapObjects.length > 0) {
      updateMap(data.mapObjects);
      notifyMapTab();
    }

  } catch {
    removeTyping();
    appendMsg('bot', 'Не удалось подключиться. Проверьте соединение.');
  }

  isLoading = false;
  chatSend.disabled = false;
  chatInput.focus();
}


/* ===================== MOBILE TABS ===================== */
function switchTab(tab) {
  const chatPanel = document.querySelector('.panel--chat');
  const mapPanel = document.querySelector('.panel--map');
  const buttons = document.querySelectorAll('.tab-bar__btn');

  buttons.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));

  if (tab === 'chat') {
    chatPanel.classList.remove('tab-hidden');
    mapPanel.classList.remove('tab-active');
    mapBadge.classList.remove('visible');
  } else {
    chatPanel.classList.add('tab-hidden');
    mapPanel.classList.add('tab-active');
    mapBadge.classList.remove('visible');
    // Leaflet нужен resize после показа
    setTimeout(() => map.invalidateSize(), 100);
  }
}

function notifyMapTab() {
  // Показываем бейдж только на мобиле и только если мы на табе "Чат"
  if (window.innerWidth > 900) return;
  const chatPanel = document.querySelector('.panel--chat');
  if (!chatPanel.classList.contains('tab-hidden')) {
    mapBadge.classList.add('visible');
  }
}

/* ===================== BLUR GATE ===================== */
function checkBlurGate() {
  if (gateUnlocked) return;
  if (botMessageCount >= GATE_THRESHOLD) {
    showBlurGate();
  }
}

function showBlurGate() {
  document.querySelector('.app').classList.add('blurred');
  blurGate.classList.add('visible');
  // Фокус на поле телефона
  setTimeout(() => document.getElementById('gatePhone').focus(), 400);
}

function submitBlurGate(e) {
  e.preventDefault();
  const phone = document.getElementById('gatePhone').value.trim();
  if (!phone) return;

  const name = document.getElementById('gateName').value.trim() || 'не указано';

  // Разблокируем
  gateUnlocked = true;
  localStorage.setItem('gateUnlocked', 'true');
  document.querySelector('.app').classList.remove('blurred');
  blurGate.classList.remove('visible');

  // Отправляем лид на сервер
  fetch('/api/gate-lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, contact: phone, sessionId }),
  }).catch(() => {});

  showLeadConfirm();
  chatInput.focus();
}

/* ===================== WELCOME ===================== */
function welcome() {
  setTimeout(() => {
    appendMsg('bot', 'Привет! Я Алина — ваш эксперт по новостройкам.\n\nРасскажите, что ищете: сколько комнат, бюджет, район? Покажу подходящие варианты прямо на карте.');
  }, 400);
}

/* ===================== INIT ===================== */
initSession();
welcome();
