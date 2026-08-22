const VWORLD_ENDPOINT = 'https://api.vworld.kr/req/data';
const VWORLD_ADDRESS_ENDPOINT = 'https://api.vworld.kr/req/address';

function credentials() {
  return {
    key: process.env.VWORLD_API_KEY || process.env.VITE_VWORLD_API_KEY || '',
    domain: process.env.VWORLD_DOMAIN || 'localhost',
  };
}

async function fetchVworldFeatures(data, attrFilter) {
  const { key, domain } = credentials();
  if (!key) throw new Error('VWORLD_API_KEY 환경변수가 설정되지 않았습니다.');

  const size = 1000;
  const base = new URLSearchParams({
    service: 'data',
    request: 'GetFeature',
    data,
    format: 'json',
    geometry: 'false',
    size: String(size),
    key,
  });
  if (attrFilter) base.set('attrFilter', attrFilter);
  base.set('domain', domain);

  const features = [];
  let page = 1;
  let total = Infinity;

  while (features.length < total && page <= 20) {
    const params = new URLSearchParams(base);
    params.set('page', String(page));

    const res = await fetch(`${VWORLD_ENDPOINT}?${params}`);
    if (!res.ok) throw new Error(`VWorld 요청 실패 (HTTP ${res.status})`);
    const json = await res.json();

    const response = json.response;
    if (response?.status !== 'OK') {
      throw new Error(`VWorld 조회 실패: ${JSON.stringify(response ?? json)}`);
    }

    const result = response.result?.featureCollection?.features ?? [];
    features.push(...result);

    total = Number(response.record?.total ?? 0) || total;
    if (result.length === 0) break;
    page += 1;
  }
  return features;
}

export async function fetchGus() {
  const features = await fetchVworldFeatures('LT_C_ADSIGG_INFO', 'full_nm:like:서울');
  return features.map((f) => ({
    code: f.properties.sig_cd,
    name: f.properties.sig_kor_nm,
  }));
}

export async function fetchDongs(guCode) {
  const features = await fetchVworldFeatures('LT_C_ADEMD_INFO', `emd_cd:like:${guCode}`);
  return features.map((f) => f.properties.emd_kor_nm).filter(Boolean);
}

export async function reverseGeocode(lat, lng) {
  const { key, domain } = credentials();
  if (!key) throw new Error('VWORLD_API_KEY 환경변수가 설정되지 않았습니다.');

  const params = new URLSearchParams({
    service: 'address',
    request: 'getaddress',
    version: '2.0',
    crs: 'epsg:4326',
    point: `${lng},${lat}`,
    format: 'json',
    type: 'PARCEL',
    key,
    domain,
  });

  const res = await fetch(`${VWORLD_ADDRESS_ENDPOINT}?${params}`);
  if (!res.ok) throw new Error(`VWorld 지오코딩 실패 (HTTP ${res.status})`);
  const json = await res.json();
  const response = json.response;
  if (response?.status !== 'OK') return { gu: '', dong: '' };

  const first = Array.isArray(response.result) ? response.result[0] : response.result;
  const structure = first?.structure;
  if (!structure) return { gu: '', dong: '' };

  return {
    gu: structure.level2 || '',
    dong: structure.level3 || structure.level4L || '',
  };
}
