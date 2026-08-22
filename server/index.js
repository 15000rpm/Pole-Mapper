import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as db from './db.js';
import { fetchGus, fetchDongs, reverseGeocode } from './vworld.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const LEVEL_DIRS = ['A', 'B', 'Pole'];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
for (const dir of LEVEL_DIRS) {
  fs.mkdirSync(path.join(UPLOAD_DIR, dir), { recursive: true });
}

const PORT = Number(process.env.PORT || 4000);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const level = req.body?.level || 'uncategorized';
      const dir = path.join(UPLOAD_DIR, level);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const id = req.body?.id || `pole-${Date.now()}`;
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${id}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/gus', async (_req, res) => {
  try {
    if (!(await db.isGusFresh(CACHE_TTL_MS))) {
      await db.replaceGus(await fetchGus());
    }
    res.json(await db.getGus());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/dongs', async (req, res) => {
  const { gu } = req.query;
  if (!gu) return res.status(400).json({ error: 'gu 파라미터가 필요합니다.' });
  try {
    if (!(await db.isDongsFresh(gu, CACHE_TTL_MS))) {
      const guRow = await db.getGuByName(gu);
      if (!guRow) return res.status(404).json({ error: `'${gu}' 구를 찾을 수 없습니다.` });
      await db.replaceDongs(gu, await fetchDongs(guRow.code));
    }
    res.json(await db.getDongs(gu));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/reverse-geocode', async (req, res) => {
  const numLat = Number(req.query.lat);
  const numLng = Number(req.query.lng);
  if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) {
    return res.status(400).json({ error: 'lat, lng 파라미터가 필요합니다.' });
  }
  try {
    res.json(await reverseGeocode(numLat, numLng));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/poles', async (req, res) => {
  const { gu = '', dong = '', start = '', end = '' } = req.query;
  try {
    res.json(await db.getAllPoles({ gu, dong, start, end }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/poles', upload.single('photo'), async (req, res) => {
  const { id, lat, lng, timestamp, level = '' } = req.body ?? {};
  let { gu = '', dong = '' } = req.body ?? {};
  if (lat === undefined || lng === undefined || !timestamp) {
    return res.status(400).json({ error: 'lat, lng, timestamp는 필수입니다.' });
  }
  const numLat = Number(lat);
  const numLng = Number(lng);
  try {
    if (await db.findDuplicatePole(numLat, numLng, timestamp)) {
      if (req.file) fs.rm(req.file.path, () => {});
      return res.status(409).json({ error: 'duplicate', message: '이미 등록된 전신주입니다.' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (!gu || !dong) {
    try {
      const geo = await reverseGeocode(numLat, numLng);
      if (!gu) gu = geo.gu;
      if (!dong) dong = geo.dong;
    } catch (e) {
      console.warn('지오코딩 실패:', e.message);
    }
  }
  const photoPath = req.file ? `${level || 'uncategorized'}/${req.file.filename}` : null;
  const pole = {
    id: id || `pole-${crypto.randomUUID()}`,
    lat: numLat,
    lng: numLng,
    gu,
    dong,
    timestamp,
    level,
    photo_path: photoPath,
  };
  try {
    await db.insertPole(pole);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.status(201).json({
    ...pole,
    photo_path: undefined,
    photoUrl: pole.photo_path ? `/uploads/${pole.photo_path}` : null,
  });
});

app.get('/api/all-dongs', async (_req, res) => {
  try {
    if (!(await db.isGusFresh(CACHE_TTL_MS))) {
      await db.replaceGus(await fetchGus());
    }
    const gus = await db.getGus();
    for (const gu of gus) {
      if (!(await db.isDongsFresh(gu.name, CACHE_TTL_MS))) {
        await db.replaceDongs(gu.name, await fetchDongs(gu.code));
      }
    }
    const allDongs = await db.getAllDongs();
    res.json(allDongs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/poles/:id', async (req, res) => {
  const existing = await db.getPole(req.params.id);
  if (!existing) return res.status(404).json({ error: '전신주를 찾을 수 없습니다.' });
  if (existing.photo_path) {
    fs.rm(path.join(UPLOAD_DIR, existing.photo_path), () => {});
  }
  try {
    await db.deletePole(existing.id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ removed: true });
});

const server = app.listen(PORT, () => {
  console.log(`Pole Mapper API server: http://localhost:${PORT}`);
});
server.on('error', (err) => {
  console.error('서버 시작 실패:', err);
  process.exit(1);
});
