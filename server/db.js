import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const nowIso = () => new Date().toISOString();

export async function isGusFresh(ttlMs) {
  const { data, error } = await supabase
    .from('gus')
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data?.updated_at && Date.now() - Date.parse(data.updated_at) < ttlMs;
}

export async function replaceGus(entries) {
  const now = nowIso();
  const rows = entries.map(({ code, name }) => ({ code, name, updated_at: now }));
  const { error: delErr } = await supabase.from('gus').delete().neq('code', '');
  if (delErr) throw delErr;
  const { error } = await supabase.from('gus').insert(rows);
  if (error) throw error;
}

export async function getGus() {
  const { data, error } = await supabase.from('gus').select('code, name').order('code');
  if (error) throw error;
  return data || [];
}

export async function getGuByName(name) {
  const { data, error } = await supabase
    .from('gus')
    .select('code, name')
    .eq('name', name)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function isDongsFresh(guName, ttlMs) {
  const { data, error } = await supabase
    .from('dongs')
    .select('updated_at')
    .eq('gu_name', guName)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data?.updated_at && Date.now() - Date.parse(data.updated_at) < ttlMs;
}

export async function replaceDongs(guName, dongList) {
  const now = nowIso();
  const rows = dongList.map((dong) => ({ gu_name: guName, dong, updated_at: now }));
  const { error: delErr } = await supabase.from('dongs').delete().eq('gu_name', guName);
  if (delErr) throw delErr;
  const { error } = await supabase.from('dongs').insert(rows);
  if (error) throw error;
}

export async function getDongs(guName) {
  const { data, error } = await supabase
    .from('dongs')
    .select('dong')
    .eq('gu_name', guName)
    .order('dong');
  if (error) throw error;
  return (data || []).map((r) => r.dong);
}

export async function insertPole(pole) {
  const { error } = await supabase.from('poles').insert(pole);
  if (error) throw error;
}

export async function findDuplicatePole(lat, lng, timestamp) {
  const tolerance = 0.0001;
  const { data, error } = await supabase
    .from('poles')
    .select('id')
    .gte('lat', lat - tolerance)
    .lte('lat', lat + tolerance)
    .gte('lng', lng - tolerance)
    .lte('lng', lng + tolerance)
    .eq('timestamp', timestamp)
    .limit(1);
  if (error) throw error;
  return data?.length > 0;
}

export async function getPole(id) {
  const { data, error } = await supabase
    .from('poles')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getAllPoles({ gu = '', dong = '', start = '', end = '' } = {}) {
  let query = supabase.from('poles').select('*').order('timestamp', { ascending: false });
  if (gu) query = query.eq('gu', gu);
  if (dong) query = query.eq('dong', dong);
  if (start) query = query.gte('timestamp', start);
  if (end) query = query.lte('timestamp', end);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((p) => ({
    ...p,
    photoUrl: p.photo_path ? `/uploads/${p.photo_path}` : null,
  }));
}

export async function deletePole(id) {
  const { error } = await supabase.from('poles').delete().eq('id', id);
  if (error) throw error;
}

export async function getAllDongs() {
  const { data, error } = await supabase
    .from('dongs')
    .select('gu_name, dong')
    .order('gu_name')
    .order('dong');
  if (error) throw error;
  return data || [];
}
