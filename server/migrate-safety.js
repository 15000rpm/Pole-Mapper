import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_URL = 'https://saftyovhcable.kr/addMarker.html';
const THUMB_BASE = 'https://saftyovhcable.kr/res/Thumb/';
const UPLOAD_DIR = join(__dirname, 'uploads');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

async function fetchPageCSV() {
  console.log('1) 페이지에서 CSV 데이터를 가져오는 중...');
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`페이지 요청 실패: ${res.status}`);
  const html = await res.text();

  const match = html.match(/<textarea[^>]*id="csvInput"[^>]*>([\s\S]*?)<\/textarea>/i);
  if (!match) throw new Error('csvInput textarea를 찾을 수 없습니다.');

  const csvText = match[1].trim();
  const lines = csvText.split('\n').map((l) => l.trim()).filter(Boolean);
  const header = lines[0];
  const dataLines = lines.slice(1);
  console.log(`   - 헤더: ${header}`);
  console.log(`   - 데이터 행 수: ${dataLines.length}`);
  return { header, dataLines };
}

function parseCSVLines(header, dataLines) {
  console.log('2) CSV 파싱 중...');
  const fields = header.split('|');
  const rows = [];
  for (const line of dataLines) {
    const cols = line.split('|');
    if (cols.length < fields.length) continue;
    const obj = {};
    for (let i = 0; i < fields.length; i++) {
      obj[fields[i]] = (cols[i] || '').trim();
    }
    rows.push(obj);
  }
  const valid = rows.filter(
    (r) => r.Path && r.Path.endsWith('.jpg') && parseFloat(r.GPS_lat) !== 0 && parseFloat(r.GPS_lon) !== 0
  );
  console.log(`   - 전체 파싱: ${rows.length}행, 유효(GPS+사진): ${valid.length}행`);
  return { rows, valid };
}

async function downloadThumbs(validRows) {
  console.log('3) Thumb 이미지 다운로드 중...');
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const BATCH = 10;

  for (let i = 0; i < validRows.length; i += BATCH) {
    const batch = validRows.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (row) => {
        const fileName = basename(row.Path);
        const dest = join(UPLOAD_DIR, fileName);
        if (existsSync(dest)) {
          skipped++;
          return;
        }
        const url = THUMB_BASE + encodeURIComponent(fileName);
        const resp = await fetch(url);
        if (!resp.ok) {
          console.warn(`   ⚠ 다운로드 실패: ${fileName} (${resp.status})`);
          failed++;
          return;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        writeFileSync(dest, buffer);
        downloaded++;
      })
    );
    results.forEach((r) => {
      if (r.status === 'rejected') {
        console.warn(`   ⚠ 에러:`, r.reason?.message);
        failed++;
      }
    });
    if ((i + BATCH) % 100 === 0 || i + BATCH >= validRows.length) {
      console.log(`   진행: ${Math.min(i + BATCH, validRows.length)}/${validRows.length} (다운:${downloaded} 스킵:${skipped} 실패:${failed})`);
    }
  }
  console.log(`   완료 - 다운:${downloaded} 스킵:${skipped} 실패:${failed}`);
}

async function insertToDB(validRows) {
  console.log('4) Supabase poles 테이블에 데이터 삽입 중...');
  const BATCH = 50;
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < validRows.length; i += BATCH) {
    const batch = validRows.slice(i, i + BATCH);
    const poles = batch.map((row) => ({
      id: row.Path.replace(/\.jpg$/i, ''),
      lat: parseFloat(row.GPS_lat),
      lng: parseFloat(row.GPS_lon),
      gu: row.Area || '',
      dong: row.Juso || '',
      timestamp: row.Date || '',
      level: row.Level || '',
      photo_path: basename(row.Path),
    }));

    const { data, error } = await supabase.from('poles').upsert(poles, { onConflict: 'id' });
    if (error) {
      console.error(`   ⚠ 배치 ${i}-${i + batch.length} 실패:`, error.message);
      failed += batch.length;
    } else {
      inserted += (data?.length || batch.length);
    }

    if ((i + BATCH) % 200 === 0 || i + BATCH >= validRows.length) {
      console.log(`   진행: ${Math.min(i + BATCH, validRows.length)}/${validRows.length}`);
    }
  }
  console.log(`   완료 - 삽입/업데이트: ${inserted}행, 실패: ${failed}행`);
}

// ── main ──
async function main() {
  console.log('=== saftyovhcable.kr 데이터 마이그레이션 ===\n');
  const { header, dataLines } = await fetchPageCSV();
  const { valid } = parseCSVLines(header, dataLines);

  await downloadThumbs(valid);
  await insertToDB(valid);

  console.log('\n=== 마이그레이션 완료 ===');
}

main().catch((e) => {
  console.error('치명적 에러:', e);
  process.exit(1);
});
