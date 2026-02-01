#!/usr/bin/env node
/**
 * weather.js - 天气查询工具 (Open-Meteo API, 完全免费无需 API key)
 * 
 * Usage:
 *   node tools/weather.js <city>
 *   node tools/weather.js <lat> <lon>
 *   node tools/weather.js Shanghai
 *   node tools/weather.js 31.23 121.47
 * 
 * Features:
 *   - 当前天气 + 未来3天预报
 *   - 自动地理编码（城市名 → 坐标）
 *   - 中文天气描述
 *   - AQI 空气质量（如果可用）
 */

const https = require('https');
const http = require('http');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'voltwake-weather/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

// WMO Weather Code → 中文描述
const WMO_CODES = {
  0: '☀️ 晴',
  1: '🌤️ 大部晴朗', 2: '⛅ 多云', 3: '☁️ 阴天',
  45: '🌫️ 雾', 48: '🌫️ 雾凇',
  51: '🌧️ 小毛毛雨', 53: '🌧️ 中毛毛雨', 55: '🌧️ 大毛毛雨',
  56: '🌧️❄️ 冻毛毛雨', 57: '🌧️❄️ 重冻毛毛雨',
  61: '🌧️ 小雨', 63: '🌧️ 中雨', 65: '🌧️ 大雨',
  66: '🌧️❄️ 小冻雨', 67: '🌧️❄️ 大冻雨',
  71: '🌨️ 小雪', 73: '🌨️ 中雪', 75: '🌨️ 大雪',
  77: '🌨️ 雪粒',
  80: '🌦️ 小阵雨', 81: '🌦️ 中阵雨', 82: '🌦️ 大阵雨',
  85: '🌨️ 小阵雪', 86: '🌨️ 大阵雪',
  95: '⛈️ 雷暴', 96: '⛈️ 雷暴+小冰雹', 99: '⛈️ 雷暴+大冰雹'
};

function describeWeather(code) {
  return WMO_CODES[code] || `未知(${code})`;
}

function windDirection(deg) {
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return dirs[Math.round(deg / 45) % 8];
}

async function geocode(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`;
  const data = await fetch(url);
  if (!data.results || data.results.length === 0) {
    throw new Error(`找不到城市: ${city}`);
  }
  const r = data.results[0];
  return { lat: r.latitude, lon: r.longitude, name: r.name, country: r.country, admin1: r.admin1 };
}

async function getWeather(lat, lon) {
  const params = [
    'current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl',
    'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
    'timezone=Asia/Shanghai',
    'forecast_days=4'
  ].join('&');
  
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&${params}`;
  return await fetch(url);
}

async function getAQI(lat, lon) {
  try {
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,us_aqi&timezone=Asia/Shanghai`;
    return await fetch(url);
  } catch {
    return null;
  }
}

function aqiLevel(aqi) {
  if (aqi <= 50) return '🟢 优';
  if (aqi <= 100) return '🟡 良';
  if (aqi <= 150) return '🟠 轻度污染';
  if (aqi <= 200) return '🔴 中度污染';
  if (aqi <= 300) return '🟣 重度污染';
  return '🟤 严重污染';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node tools/weather.js <city> | <lat> <lon>');
    console.log('Examples:');
    console.log('  node tools/weather.js Shanghai');
    console.log('  node tools/weather.js Beijing');
    console.log('  node tools/weather.js 31.23 121.47');
    process.exit(1);
  }

  let lat, lon, locationName;

  if (args.length >= 2 && !isNaN(args[0]) && !isNaN(args[1])) {
    lat = parseFloat(args[0]);
    lon = parseFloat(args[1]);
    locationName = `${lat}, ${lon}`;
  } else {
    const city = args.join(' ');
    const geo = await geocode(city);
    lat = geo.lat;
    lon = geo.lon;
    locationName = [geo.name, geo.admin1, geo.country].filter(Boolean).join(', ');
  }

  const [weather, aqi] = await Promise.all([
    getWeather(lat, lon),
    getAQI(lat, lon)
  ]);

  const c = weather.current;
  
  console.log(`\n📍 ${locationName}`);
  console.log('═'.repeat(40));
  
  // 当前天气
  console.log(`\n🌡️ 当前天气`);
  console.log(`  ${describeWeather(c.weather_code)}`);
  console.log(`  温度: ${c.temperature_2m}°C (体感 ${c.apparent_temperature}°C)`);
  console.log(`  湿度: ${c.relative_humidity_2m}%`);
  console.log(`  风: ${windDirection(c.wind_direction_10m)}风 ${c.wind_speed_10m} km/h`);
  console.log(`  气压: ${c.pressure_msl} hPa`);

  // AQI
  if (aqi && aqi.current) {
    const a = aqi.current;
    console.log(`\n🌬️ 空气质量`);
    console.log(`  AQI: ${a.us_aqi} ${aqiLevel(a.us_aqi)}`);
    console.log(`  PM2.5: ${a.pm2_5} μg/m³ | PM10: ${a.pm10} μg/m³`);
  }

  // 未来几天预报
  const d = weather.daily;
  console.log(`\n📅 未来预报`);
  for (let i = 0; i < d.time.length; i++) {
    const date = d.time[i];
    const dayLabel = i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : date;
    const precip = d.precipitation_sum[i] > 0 ? ` | 降水 ${d.precipitation_sum[i]}mm (${d.precipitation_probability_max[i]}%)` : '';
    console.log(`  ${dayLabel} (${date}): ${describeWeather(d.weather_code[i])} ${d.temperature_2m_min[i]}~${d.temperature_2m_max[i]}°C${precip}`);
  }

  console.log('');
}

main().catch(err => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});
