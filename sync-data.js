// Скрипт выгрузки данных из TrendAgent API
// Запуск: node sync-data.js

const axios = require('axios');
const fs = require('fs');

require('dotenv').config();
const PHONE = process.env.TA_PHONE || '';
const PASSWORD = process.env.TA_PASSWORD || '';
const MOSCOW_CITY_ID = '5a5cb42159042faa9a218d04';
const MIN_PRICE = 25000000;
const PAGE_SIZE = 20; // API лимит

async function getToken() {
  const { data } = await axios.post('https://sso-api.trendagent.ru/v1/login', {
    phone: PHONE, password: PASSWORD,
  }, { headers: { Origin: 'https://spb.trendagent.ru' } });
  return data.auth_token;
}

async function fetchAllApartments(token) {
  const h = { Authorization: `Bearer ${token}`, Origin: 'https://spb.trendagent.ru' };
  const allItems = [];
  let offset = 0;
  let total = null;

  while (true) {
    // Токен живёт 5 минут — обновляем каждые 50 запросов
    if (offset > 0 && offset % (PAGE_SIZE * 50) === 0) {
      console.log('Refreshing token...');
      token = await getToken();
      h.Authorization = `Bearer ${token}`;
    }

    const { data } = await axios.get('https://api.trendagent.ru/v4_29/apartments/search/', {
      headers: h,
      params: {
        show_type: 'list',
        'premiseType[]': 'apartment',
        city: MOSCOW_CITY_ID,
        price_from: MIN_PRICE,
        sort: 'price',
        sort_order: 'asc',
        limit: PAGE_SIZE,
        offset,
      },
      validateStatus: () => true,
    });

    if (!data.data?.list?.length) break;

    if (total === null) {
      total = data.data.apartmentsCount;
      console.log(`Total: ${total} apartments, ${data.data.blocksCount} complexes`);
    }

    allItems.push(...data.data.list);
    offset += PAGE_SIZE;
    process.stdout.write(`\rFetched: ${allItems.length}/${total}`);

    if (allItems.length >= total || data.data.list.length < PAGE_SIZE) break;

    // Без лимита — качаем всё
  }

  console.log(`\nDone: ${allItems.length} apartments fetched.`);
  return allItems;
}

function groupByComplex(items) {
  const blocks = {};

  for (const item of items) {
    const key = item.block_guid || item.block_name;
    if (!blocks[key]) {
      blocks[key] = {
        id: item.block_id,
        name: item.block_name,
        builder: item.builder?.name,
        district: item.district?.name,
        subway: item.subway?.name,
        subway_color: item.subway?.line?.color,
        city: item.city?.name,
        apartments: [],
      };
    }

    blocks[key].apartments.push({
      rooms: item.room?.name_short || item.room?.name,
      area: item.area_given,
      kitchen: item.area_kitchen,
      floor: item.floor,
      floors: item.floors,
      price: item.price,
      finishing: item.finishing?.name,
      deadline: item.deadline ? item.deadline.split('T')[0] : null,
      reward: item.reward?.label,
      plan_img: item.plan ? `https://selcdn.trendagent.ru/images/${item.plan.path}${item.plan.file_name}` : null,
    });
  }

  // Считаем сводку по каждому ЖК
  return Object.values(blocks).map(b => {
    const prices = b.apartments.filter(a => a.price > 1).map(a => a.price);
    const areas = b.apartments.map(a => a.area).filter(Boolean);
    const rooms = [...new Set(b.apartments.map(a => a.rooms).filter(Boolean))];
    const deadlines = [...new Set(b.apartments.map(a => a.deadline).filter(Boolean))];

    return {
      ...b,
      summary: {
        count: b.apartments.length,
        price_min: prices.length ? Math.min(...prices) : null,
        price_max: prices.length ? Math.max(...prices) : null,
        area_min: areas.length ? Math.min(...areas) : null,
        area_max: areas.length ? Math.max(...areas) : null,
        rooms: rooms.sort(),
        deadlines: deadlines.sort(),
      },
    };
  }).sort((a, b) => (a.summary.price_min || 0) - (b.summary.price_min || 0));
}

(async () => {
  try {
    const token = await getToken();
    const items = await fetchAllApartments(token);
    const complexes = groupByComplex(items);

    console.log(`\nGrouped into ${complexes.length} complexes`);

    // Сохраняем полные данные
    fs.writeFileSync(
      './data/complexes.json',
      JSON.stringify(complexes, null, 2)
    );

    // Сохраняем компактную версию для system prompt (без отдельных квартир)
    const compact = complexes.map(c => ({
      name: c.name,
      builder: c.builder,
      district: c.district,
      subway: c.subway,
      rooms: c.summary.rooms.join(', '),
      area: `${c.summary.area_min}-${c.summary.area_max} м²`,
      price: c.summary.price_min > 1
        ? `от ${(c.summary.price_min / 1e6).toFixed(1)} до ${(c.summary.price_max / 1e6).toFixed(1)} млн ₽`
        : 'по запросу',
      deadline: c.summary.deadlines[0] || 'уточняйте',
      finishing: [...new Set(c.apartments.map(a => a.finishing).filter(Boolean))].join(', '),
      count: c.summary.count,
    }));

    fs.writeFileSync('./data/complexes-compact.json', JSON.stringify(compact, null, 2));

    console.log(`Saved: data/complexes.json (${complexes.length} complexes, full)`);
    console.log(`Saved: data/complexes-compact.json (compact for AI prompt)`);
  } catch (err) {
    console.error('Error:', err.message);
  }
})();
