const axios = require('axios');
const fs = require('fs');

const PHOTOS_FILE = './data/block-photos.json';
const COMPLEXES_FILE = './data/complexes.json';

const photos = JSON.parse(fs.readFileSync(PHOTOS_FILE, 'utf-8'));
const complexes = JSON.parse(fs.readFileSync(COMPLEXES_FILE, 'utf-8'));
const needPhotos = complexes.filter(c => !photos[c.name]).map(c => c.name);

console.log(`Need photos for ${needPhotos.length} complexes`);

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'Accept': 'application/json',
  'Referer': 'https://www.novostroy-m.ru/baza',
  'X-Requested-With': 'XMLHttpRequest',
};

function normalize(name) {
  return name.toLowerCase()
    .replace(/[«»"'\.,:;!?()\-—–]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

(async () => {
  // Загружаем ВСЕ ЖК с novostroy-m (постранично)
  const allNovos = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    try {
      const { data } = await axios.get('https://www.novostroy-m.ru/api/novos/get-find-novos', {
        params: { typeVersion: 'beta', 'per-page': perPage, page },
        headers,
        timeout: 15000,
      });

      if (!data.data || !data.data.length) break;
      allNovos.push(...data.data);
      process.stdout.write(`\rLoaded ${allNovos.length}/${data.allCount} from novostroy-m...`);

      if (allNovos.length >= data.allCount) break;
      page++;
    } catch (err) {
      console.error(`\nError on page ${page}:`, err.message);
      break;
    }
  }

  console.log(`\nLoaded ${allNovos.length} complexes from novostroy-m`);

  // Строим индекс по нормализованному имени
  const novoIndex = {};
  for (const item of allNovos) {
    const name = item.title || item.name || '';
    if (!name) continue;
    const norm = normalize(name);
    if (!novoIndex[norm]) {
      novoIndex[norm] = item;
    }
    // Также по короткому имени (без "ЖК" префикса)
    const short = norm.replace(/^жк\s+/, '');
    if (short !== norm && !novoIndex[short]) {
      novoIndex[short] = item;
    }
  }

  console.log(`Index: ${Object.keys(novoIndex).length} entries\n`);

  // Сопоставляем наши ЖК
  let found = 0;
  for (const name of needPhotos) {
    const norm = normalize(name);

    // Точное совпадение
    let match = novoIndex[norm] || novoIndex[`жк ${norm}`];

    // Частичное: ищем первое вхождение
    if (!match) {
      for (const [key, val] of Object.entries(novoIndex)) {
        if (key.includes(norm) || norm.includes(key)) {
          match = val;
          break;
        }
      }
    }

    // Совпадение по первым 2+ словам
    if (!match) {
      const words = norm.split(' ').filter(w => w.length > 2);
      if (words.length >= 2) {
        const prefix = words.slice(0, 2).join(' ');
        for (const [key, val] of Object.entries(novoIndex)) {
          if (key.includes(prefix)) {
            match = val;
            break;
          }
        }
      }
    }

    if (match && match.picture && match.picture.length > 0) {
      const img = match.picture[0].img;
      const photoUrl = `https://filestock-m.ru/images/presets/msk/novos/860x450/${img}`;
      photos[name] = photoUrl;
      found++;
      console.log(`${name} → OK (${match.name})`);
    } else if (match) {
      console.log(`${name} → matched "${match.name}" but no picture`);
    } else {
      console.log(`${name} → not found`);
    }
  }

  fs.writeFileSync(PHOTOS_FILE, JSON.stringify(photos, null, 2));
  const total = Object.values(photos).filter(Boolean).length;
  console.log(`\nDone! ${found} new photos. Total: ${total}/${complexes.length}`);
})();
