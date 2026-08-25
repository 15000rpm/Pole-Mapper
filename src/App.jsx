import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import OLMap from 'ol/Map';
import View from 'ol/View';
import Overlay from 'ol/Overlay';
import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { Style, Circle as CircleStyle, Fill, Stroke, Text } from 'ol/style';
import { fromLonLat } from 'ol/proj';
import imageCompression from 'browser-image-compression';
import exifr from 'exifr';
import './App.css';

const VWORLD_API_KEY = import.meta.env.VITE_VWORLD_API_KEY;
const LEVEL_COLORS = { A: '#22c55e', B: '#f97316', Pole: '#a855f7' };
const LEVEL_LABELS = { A: 'A', B: 'B', Pole: 'P' };
const LEVEL_IGNORE = 'IGNORE';
const LEVEL_CANCEL = 'CANCEL';
const LEVEL_KEYS = { 1: 'A', 2: 'B', 3: 'Pole', 4: LEVEL_IGNORE };

function createTileSource(layer) {
  return new XYZ({
    url: `https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_API_KEY}/${layer}/{z}/{y}/{x}.png`,
    crossOrigin: null,
    maxZoom: 19,
    minZoom: 6,
  });
}

function App() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markerLayerRef = useRef(null);
  const lastPositionRef = useRef(null);
  const watchIdRef = useRef(null);
  const fallbackUsedRef = useRef(false);
  const currentLocationRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [poles, setPoles] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [gpsInfo, setGpsInfo] = useState(null);
  const [listOpen, setListOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const folderInputRef = useRef(null);
  const levelResolveRef = useRef(null);
  const [levelModal, setLevelModal] = useState(null);
  const [modalAddress, setModalAddress] = useState(undefined);
  const [modalBusy, setModalBusy] = useState(false);
  const previewUrlRef = useRef(null);
  const reverseGeocodeCacheRef = useRef(new Map());
  const [levelFilter, setLevelFilter] = useState('all');
  const [guFilter, setGuFilter] = useState('용산구');
  const [dongFilter, setDongFilter] = useState('all');
  const [timeFilterEnabled, setTimeFilterEnabled] = useState(false);
  const [timeFilterWeek, setTimeFilterWeek] = useState(0);
  const polesRef = useRef([]);
  const [allDongs, setAllDongs] = useState([]);
  const popupRef = useRef(null);
  const popupOverlayRef = useRef(null);
  const [popupPole, setPopupPole] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const guList = useMemo(() => {
    const set = new Set(allDongs.map((d) => d.gu_name));
    return [...set].sort();
  }, [allDongs]);

  const dongList = useMemo(() => {
    if (guFilter === 'all') return allDongs;
    return allDongs.filter((d) => d.gu_name === guFilter);
  }, [allDongs, guFilter]);

  const { minWeek, maxWeek } = useMemo(() => {
    if (poles.length === 0) return { minWeek: 0, maxWeek: 0 };
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const p of poles) {
      const t = Date.parse(p.timestamp);
      if (!Number.isNaN(t)) {
        if (t < minTs) minTs = t;
        if (t > maxTs) maxTs = t;
      }
    }
    if (!Number.isFinite(minTs)) return { minWeek: 0, maxWeek: 0 };
    const toWeek = (ts) => Math.floor((ts - minTs) / (7 * 86400000));
    return { minWeek: 0, maxWeek: Math.max(toWeek(maxTs), 0) };
  }, [poles]);

  const timeFilterCutoff = useMemo(() => {
    if (!timeFilterEnabled || poles.length === 0) return null;
    let minTs = Infinity;
    for (const p of poles) {
      const t = Date.parse(p.timestamp);
      if (!Number.isNaN(t) && t < minTs) minTs = t;
    }
    if (!Number.isFinite(minTs)) return null;
    const cutoffTs = minTs + (timeFilterWeek + 1) * 7 * 86400000;
    return new Date(cutoffTs).toISOString();
  }, [timeFilterEnabled, timeFilterWeek, poles]);

  const timeFilterLabel = useMemo(() => {
    if (!timeFilterEnabled || poles.length === 0) return '';
    let minTs = Infinity;
    for (const p of poles) {
      const t = Date.parse(p.timestamp);
      if (!Number.isNaN(t) && t < minTs) minTs = t;
    }
    if (!Number.isFinite(minTs)) return '';
    const cutoffTs = minTs + (timeFilterWeek + 1) * 7 * 86400000;
    const d = new Date(cutoffTs);
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${Math.ceil(d.getDate() / 7)}주차`;
  }, [timeFilterEnabled, timeFilterWeek, poles]);

  const filteredPoles = useMemo(() => {
    return poles.filter(
      (p) => (levelFilter === 'all' || p.level === levelFilter) &&
             (guFilter === 'all' || p.gu === guFilter) &&
             (dongFilter === 'all' || p.dong === dongFilter) &&
             (!timeFilterEnabled || p.timestamp <= timeFilterCutoff)
    );
  }, [poles, levelFilter, guFilter, dongFilter, timeFilterEnabled, timeFilterCutoff]);

  useEffect(() => {
    if (!gpsInfo) return;
    const timer = setTimeout(() => setGpsInfo(null), 3000);
    return () => clearTimeout(timer);
  }, [gpsInfo]);

  const syncMarkers = useCallback(() => {
    if (!markerLayerRef.current) return;
    const source = markerLayerRef.current.getSource();
    source.getFeatures().forEach((f) => {
      if (f.get('poleId') !== 'current-location') source.removeFeature(f);
    });
    const idSet = new Set();
    poles.forEach((pole) => {
      if (idSet.has(pole.id)) return;
      if (levelFilter !== 'all' && pole.level !== levelFilter) return;
      if (guFilter !== 'all' && pole.gu !== guFilter) return;
      if (dongFilter !== 'all' && pole.dong !== dongFilter) return;
      idSet.add(pole.id);
      const feature = new Feature({
        geometry: new Point(fromLonLat([pole.lng, pole.lat])),
        poleId: pole.id,
      });
      feature.setStyle(
        new Style({
          image: new CircleStyle({
            radius: 8,
            fill: new Fill({ color: LEVEL_COLORS[pole.level] || '#ef4444' }),
            stroke: new Stroke({ color: 'white', width: 2 }),
          }),
          text: new Text({
            text: LEVEL_LABELS[pole.level] || '전신주',
            offsetY: -20,
            font: 'bold 12px sans-serif',
            fill: new Fill({ color: '#1e293b' }),
            stroke: new Stroke({ color: 'white', width: 3 }),
          }),
        }),
      );
      source.addFeature(feature);
    });
  }, [poles, levelFilter, guFilter, dongFilter]);

  useEffect(() => {
    syncMarkers();
  }, [syncMarkers]);

  const handleDelete = useCallback(async (id) => {
    try {
      const res = await fetch(`/api/poles/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`삭제 실패 (HTTP ${res.status})`);
      setPoles((prev) => {
        const next = prev.filter((p) => p.id !== id);
        polesRef.current = next;
        return next;
      });
    } catch (err) {
      console.error('전신주 삭제 실패:', err);
      alert('전신주 삭제에 실패했습니다.');
    }
  }, []);

  const refreshPoles = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await fetch('/api/poles');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = await res.json();
      polesRef.current = next;
      setPoles(next);
    } catch (err) {
      console.error('전신주 목록 갱신 실패:', err);
      alert('목록 갱신에 실패했습니다.');
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  const flyTo = useCallback((lng, lat) => {
    if (!mapRef.current) return;
    mapRef.current.getView().animate({
      center: fromLonLat([lng, lat]),
      zoom: 18,
      duration: 500,
    });
  }, []);

  const flyToCurrentLocation = useCallback(() => {
    const pos = lastPositionRef.current;
    if (!pos || !mapRef.current) return;
    mapRef.current.getView().animate({
      center: fromLonLat([pos.lng, pos.lat]),
      zoom: 17,
      duration: 500,
    });
  }, []);

  const lookupAddress = useCallback(async (lat, lng) => {
    if (!(reverseGeocodeCacheRef.current instanceof Map)) {
      reverseGeocodeCacheRef.current = new Map();
    }
    const key = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
    if (reverseGeocodeCacheRef.current.has(key)) {
      return reverseGeocodeCacheRef.current.get(key);
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`/api/reverse-geocode?lat=${lat}&lng=${lng}`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geo = await res.json();
      const label = [geo.gu, geo.dong].filter(Boolean).join(' ') || null;
      reverseGeocodeCacheRef.current.set(key, label);
      return label;
    } catch (err) {
      console.error('역지오코딩 실패:', err);
      return null;
    }
  }, []);

  const claimPreviewUrl = useCallback((file, preloadedUrl) => {
    const url = preloadedUrl || URL.createObjectURL(file);
    if (previewUrlRef.current && previewUrlRef.current !== url) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = url;
    return url;
  }, []);

  const closeLevelModal = useCallback(() => {
    levelResolveRef.current = null;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setLevelModal(null);
    setModalAddress(undefined);
    setModalBusy(false);
  }, []);

  const requestLevel = useCallback((info) => {
    const previewUrl = claimPreviewUrl(info.file, info.previewUrl);
    setModalBusy(false);
    setLevelModal({
      file: info.file,
      previewUrl,
      lat: info.lat,
      lng: info.lng,
      timestamp: info.timestamp,
    });
    return new Promise((resolve) => {
      levelResolveRef.current = resolve;
    });
  }, [claimPreviewUrl]);

  const handleLevelSelect = useCallback(
    (level) => {
      if (modalBusy || !levelResolveRef.current) return;
      levelResolveRef.current(level);
      levelResolveRef.current = null;
      setModalBusy(true);
    },
    [modalBusy],
  );

  useEffect(() => {
    if (!levelModal) return;
    const onKeyDown = (e) => {
      const level = LEVEL_KEYS[e.key];
      if (level) {
        e.preventDefault();
        handleLevelSelect(level);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [levelModal, handleLevelSelect]);

  useEffect(() => {
    if (!levelModal) {
      setModalAddress(undefined);
      return;
    }
    let cancelled = false;
    setModalAddress(undefined);
    lookupAddress(levelModal.lat, levelModal.lng).then((address) => {
      if (!cancelled) setModalAddress(address);
    });
    return () => {
      cancelled = true;
    };
  }, [levelModal, lookupAddress]);

  const refreshGps = useCallback(() => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(lastPositionRef.current);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const position = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          lastPositionRef.current = position;
          resolve(position);
        },
        () => resolve(lastPositionRef.current),
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 },
      );
    });
  }, []);

  const handleCameraClick = () => {
    if (processing) return;
    refreshGps();
    document.getElementById('camera-input').click();
  };

  useEffect(() => {
    if (mapRef.current) return;

    let aborted = false;

    const initMap = (lng, lat) => {
      if (aborted || mapRef.current) return;

      try {
        const markerSource = new VectorSource();
        const markerLayer = new VectorLayer({ source: markerSource });
        markerLayerRef.current = markerLayer;

        const map = new OLMap({
          target: mapContainerRef.current,
          layers: [
            new TileLayer({ source: createTileSource('Base') }),
            new TileLayer({ source: createTileSource('Hybrid') }),
            markerLayer,
          ],
          view: new View({
            center: fromLonLat([lng, lat]),
            zoom: 17,
            maxZoom: 19,
            minZoom: 6,
          }),
        });

        mapRef.current = map;

        const popupOverlay = new Overlay({
          element: popupRef.current,
          autoPan: { animation: { duration: 200 } },
        });
        map.addOverlay(popupOverlay);
        popupOverlayRef.current = popupOverlay;

        map.on('singleclick', (evt) => {
          const feature = map.forEachFeatureAtPixel(evt.pixel, (f) => f);
          if (!feature || feature.get('poleId') === 'current-location') {
            setPopupPole(null);
            popupOverlay.setPosition(undefined);
            return;
          }
          const poleId = feature.get('poleId');
          const pole = polesRef.current.find((p) => p.id === poleId);
          if (!pole) return;
          setPopupPole(pole);
          popupOverlay.setPosition(evt.coordinate);
        });

        const currentFeature = new Feature({
          geometry: new Point(fromLonLat([lng, lat])),
          poleId: 'current-location',
        });
        currentFeature.setStyle(
          new Style({
            image: new CircleStyle({
              radius: 6,
              fill: new Fill({ color: '#3b82f6' }),
              stroke: new Stroke({ color: 'white', width: 2 }),
            }),
            text: new Text({ text: '' }),
          }),
        );
        markerSource.addFeature(currentFeature);
        currentLocationRef.current = currentFeature;
        Promise.allSettled([
          fetch('/api/poles').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
          fetch('/api/all-dongs').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        ])
          .then(([poleResult, dongResult]) => {
            if (aborted) return;
            if (poleResult.status === 'fulfilled') {
              polesRef.current = poleResult.value;
              setPoles(poleResult.value);
            }
            if (dongResult.status === 'fulfilled') {
              setAllDongs(dongResult.value);
            }
          })
          .catch((err) => {
            console.error('전신주 목록 불러오기 실패:', err);
          })
          .finally(() => {
            if (!aborted) setLoading(false);
          });
      } catch (e) {
        console.error('지도 초기화 실패:', e);
        setError('지도를 불러오지 못했습니다.');
        setLoading(false);
      }
    };

    const fallback = { lat: 37.5665, lng: 126.978 };
    lastPositionRef.current = fallback;
    initMap(fallback.lng, fallback.lat);

    if (navigator.geolocation) {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          const { latitude: lat, longitude: lng } = position.coords;
          lastPositionRef.current = { lat, lng };
          if (currentLocationRef.current) {
            currentLocationRef.current.getGeometry().setCoordinates(fromLonLat([lng, lat]));
          }
          if (fallbackUsedRef.current) {
            fallbackUsedRef.current = false;
            mapRef.current?.getView().animate({
              center: fromLonLat([lng, lat]),
              zoom: 17,
              duration: 500,
            });
          }
        },
        (err) => {
          console.error('watchPosition 실패:', err.code, err.message);
        },
        { enableHighAccuracy: true, maximumAge: 0 },
      );
    } else {
      fallbackUsedRef.current = true;
    }

    return () => {
      aborted = true;
      if (watchIdRef.current != null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.setTarget(undefined);
        mapRef.current = null;
      }
      markerLayerRef.current = null;
      currentLocationRef.current = null;
      fallbackUsedRef.current = false;
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };
  }, []);

  const handleCapture = async (e) => {
    const file = e.target.files?.[0];
    if (!file || processing) return;

    setProcessing(true);
    setGpsInfo(null);

    try {
      let lat;
      let lng;
      let exifTimestamp = null;
      let source = '';

      try {
        const buffer = await file.arrayBuffer();
        console.log('파일 타입:', file.type, '크기:', file.size, 'buffer 크기:', buffer.byteLength);
        const exifData = await exifr.parse(buffer);
        console.log('EXIF 전체 데이터:', exifData);
        if (exifData && exifData.latitude && exifData.longitude) {
          lat = exifData.latitude;
          lng = exifData.longitude;
          source = 'EXIF';
          lastPositionRef.current = { lat, lng };
        }
        if (exifData && exifData.DateTimeOriginal) {
          exifTimestamp = new Date(exifData.DateTimeOriginal).toISOString();
        } else if (exifData && exifData.DateTime) {
          exifTimestamp = new Date(exifData.DateTime).toISOString();
        }
      } catch (err) {
        console.error('EXIF 읽기 실패:', err);
      }

      if (lat === undefined) {
        const last = lastPositionRef.current;
        if (last) {
          lat = last.lat;
          lng = last.lng;
          source = '실시간 GPS';
        } else {
          throw new Error('No GPS available');
        }
      }

      setGpsInfo({ source, lat, lng });

      const level = await requestLevel({
        file,
        lat,
        lng,
        timestamp: exifTimestamp || new Date().toISOString(),
      });
      closeLevelModal();
      if (!level || level === LEVEL_IGNORE || level === LEVEL_CANCEL) {
        setProcessing(false);
        e.target.value = '';
        return;
      }

      const compressed = await imageCompression(file, {
        maxSizeMB: 0.5,
        maxWidthOrHeight: 800,
        useWebWorker: true,
      });

      const id = `pole-${crypto.randomUUID()}`;
      const formData = new FormData();
      formData.append('level', level);
      formData.append('photo', compressed, `${id}.jpg`);
      formData.append('id', id);
      formData.append('lat', lat);
      formData.append('lng', lng);
      formData.append('timestamp', exifTimestamp || new Date().toISOString());

      const res = await fetch('/api/poles', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          alert('이미 등록된 전신주입니다 (GPS 좌표 + 촬영 시간 중복).');
          setProcessing(false);
          e.target.value = '';
          return;
        }
        throw new Error(body.error || `등록 실패 (HTTP ${res.status})`);
      }
      const pole = await res.json();

      setPoles((prev) => {
        const next = [...prev, pole];
        polesRef.current = next;
        return next;
      });
    } catch (err) {
      console.error('전신주 등록 실패:', err);
      alert('전신주 등록에 실패했습니다. 위치 정보를 가져올 수 없습니다.');
    } finally {
      setProcessing(false);
      e.target.value = '';
    }
  };

  const handleFolderUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    const imageFiles = files.filter((f) =>
      f.type.startsWith('image/') || /\.(jpe?g|png|heic|webp|bmp|gif)$/i.test(f.name)
    );

    if (imageFiles.length === 0) {
      alert('이미지 파일이 없습니다.');
      e.target.value = '';
      return;
    }

    const preparePhoto = async (file) => {
      let lat;
      let lng;
      let exifTimestamp = null;
      try {
        const buffer = await file.arrayBuffer();
        const exifData = await exifr.parse(buffer);
        if (exifData && exifData.latitude && exifData.longitude) {
          lat = exifData.latitude;
          lng = exifData.longitude;
        }
        if (exifData && exifData.DateTimeOriginal) {
          exifTimestamp = new Date(exifData.DateTimeOriginal).toISOString();
        } else if (exifData && exifData.DateTime) {
          exifTimestamp = new Date(exifData.DateTime).toISOString();
        }
      } catch (err) {
        console.error('EXIF 읽기 실패:', file.name, err);
      }
      const previewUrl = URL.createObjectURL(file);
      try {
        await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('preview decode failed'));
          img.src = previewUrl;
        });
      } catch {
        // 디코딩 미지원 형식(예: HEIC)은 모달에서 브라우저가 다시 시도한다.
      }
      return {
        file,
        lat,
        lng,
        exifTimestamp,
        timestamp: exifTimestamp || new Date().toISOString(),
        previewUrl,
      };
    };

    setProcessing(true);
    setUploadProgress({ current: 0, total: imageFiles.length });

    let registered = 0;
    let ignoredCount = 0;
    let skipped = 0;
    let duplicated = 0;
    let cancelledRemaining = 0;

    let pendingPrepPromise = preparePhoto(imageFiles[0]);

    for (let i = 0; i < imageFiles.length; i++) {
      setUploadProgress({ current: i + 1, total: imageFiles.length });

      let prep = null;
      try {
        prep = await pendingPrepPromise;
      } catch (err) {
        console.error('사진 준비 실패:', imageFiles[i].name, err);
      }
      pendingPrepPromise =
        i + 1 < imageFiles.length ? preparePhoto(imageFiles[i + 1]) : null;

      if (!prep) {
        skipped++;
        continue;
      }
      if (prep.lat !== undefined) {
        lastPositionRef.current = { lat: prep.lat, lng: prep.lng };
      } else {
        const last = lastPositionRef.current;
        if (!last) {
          URL.revokeObjectURL(prep.previewUrl);
          skipped++;
          continue;
        }
        prep.lat = last.lat;
        prep.lng = last.lng;
      }

      const level = await requestLevel(prep);
      if (!level) {
        skipped++;
        continue;
      }
      if (level === LEVEL_IGNORE) {
        ignoredCount++;
        continue;
      }
      if (level === LEVEL_CANCEL) {
        cancelledRemaining = imageFiles.length - i;
        break;
      }

      try {
        const compressed = await imageCompression(prep.file, {
          maxSizeMB: 0.5,
          maxWidthOrHeight: 800,
          useWebWorker: true,
        });

        const id = `pole-${crypto.randomUUID()}-${i}`;
        const formData = new FormData();
        formData.append('level', level);
        formData.append('photo', compressed, `${id}.jpg`);
        formData.append('id', id);
        formData.append('lat', prep.lat);
        formData.append('lng', prep.lng);
        formData.append('timestamp', prep.timestamp);

        const res = await fetch('/api/poles', { method: 'POST', body: formData });
        if (!res.ok) {
          if (res.status === 409) {
            duplicated++;
            continue;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const pole = await res.json();

        setPoles((prev) => {
          const next = [...prev, pole];
          polesRef.current = next;
          return next;
        });
        registered++;
      } catch (err) {
        console.error('전신주 등록 실패:', prep.file.name, err);
        skipped++;
      }
    }

    if (pendingPrepPromise) {
      try {
        const leftover = await pendingPrepPromise;
        if (leftover?.previewUrl && leftover.previewUrl !== previewUrlRef.current) {
          URL.revokeObjectURL(leftover.previewUrl);
        }
      } catch {
        // 준비 자체가 실패한 경우 정리할 자원이 없다.
      }
    }
    closeLevelModal();

    setUploadProgress(null);
    setProcessing(false);
    const parts = [`등록: ${registered}장`];
    if (ignoredCount > 0) parts.push(`무시: ${ignoredCount}장`);
    if (duplicated > 0) parts.push(`중복: ${duplicated}장`);
    if (skipped > 0) parts.push(`건너뜀: ${skipped}장`);
    if (cancelledRemaining > 0) parts.push(`취소: ${cancelledRemaining}장`);
    alert(parts.join(' / '));
    e.target.value = '';
  };

  return (
    <main className="app">
      <div ref={mapContainerRef} className="map-container" />

      <div ref={popupRef} className="map-popup">
        {popupPole && (
          <>
            <button
              type="button"
              className="map-popup__close"
              onClick={() => {
                setPopupPole(null);
                popupOverlayRef.current?.setPosition(undefined);
              }}
            >
              ✕
            </button>
            <img src={popupPole.photoUrl} alt="전신주" className="map-popup__img" />
            <div className="map-popup__info">
              <span
                className="pole-item__level"
                style={{ backgroundColor: LEVEL_COLORS[popupPole.level] || '#94a3b8' }}
              >
                {LEVEL_LABELS[popupPole.level] || popupPole.level || '-'}
              </span>
              <span className="map-popup__addr">{popupPole.dong}</span>
            </div>
          </>
        )}
      </div>

      {(loading || processing) && !uploadProgress && (
        <div className="overlay">
          {loading ? '지도 불러오는 중...' : '전신주 등록 중...'}
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      <div className="capture-bar">
        <input
          type="file"
          accept="image/*"
          capture="environment"
          id="camera-input"
          className="camera-input"
          onChange={handleCapture}
        />
        <input
          type="file"
          accept="image/*"
          webkitdirectory=""
          id="folder-input"
          className="camera-input"
          ref={folderInputRef}
          onChange={handleFolderUpload}
        />
        <button
          type="button"
          className="capture-button"
          onClick={handleCameraClick}
        >
          📷 등록
        </button>
        <button
          type="button"
          className="locate-btn"
          onClick={flyToCurrentLocation}
        >
          📍
        </button>
      </div>

      {uploadProgress && (
        <div className="upload-progress">
          {uploadProgress.current}/{uploadProgress.total} 업로드 중...
        </div>
      )}

      {levelModal && (
        <div className="level-modal-backdrop" onClick={() => handleLevelSelect(null)}>
          <div
            className={`level-modal${modalBusy ? ' level-modal--busy' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="level-modal__close"
              aria-label="등록 작업 취소"
              title="작업 취소"
              disabled={modalBusy}
              onClick={() => handleLevelSelect(LEVEL_CANCEL)}
            >
              ✕
            </button>
            <img src={levelModal.previewUrl} alt="전신주 사진" className="level-modal__img" />
            <div className="level-modal__meta">
              <div className="level-modal__meta-row">
                📍 {modalAddress === undefined ? '주소 조회 중...' : modalAddress || '주소를 찾을 수 없음'}
              </div>
              {levelModal.timestamp && (
                <div className="level-modal__meta-row">
                  🕒 {new Date(levelModal.timestamp).toLocaleString('ko-KR')}
                </div>
              )}
            </div>
            <div className="level-modal__label">
              {modalBusy ? '처리 중...' : '전신주 등급을 선택하세요'}
            </div>
            <div className="level-modal__buttons">
              <button
                type="button"
                className="level-modal__btn level-modal__btn--A"
                disabled={modalBusy}
                onClick={() => handleLevelSelect('A')}
              >
                <span className="level-modal__key">1</span>
                A
                <span className="level-modal__desc">양호</span>
              </button>
              <button
                type="button"
                className="level-modal__btn level-modal__btn--B"
                disabled={modalBusy}
                onClick={() => handleLevelSelect('B')}
              >
                <span className="level-modal__key">2</span>
                B
                <span className="level-modal__desc">불량</span>
              </button>
              <button
                type="button"
                className="level-modal__btn level-modal__btn--Pole"
                disabled={modalBusy}
                onClick={() => handleLevelSelect('Pole')}
              >
                <span className="level-modal__key">3</span>
                Pole
                <span className="level-modal__desc">기준</span>
              </button>
              <button
                type="button"
                className="level-modal__btn level-modal__btn--Ignore"
                disabled={modalBusy}
                onClick={() => handleLevelSelect(LEVEL_IGNORE)}
              >
                <span className="level-modal__key">4</span>
                무시
                <span className="level-modal__desc">등록 안 함</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {poles.length > 0 && (
        <button
          type="button"
          onClick={() => setListOpen((o) => !o)}
          className="list-toggle"
        >
          📋 {poles.length}기
        </button>
      )}

      {gpsInfo && (
        <div
          className={
            gpsInfo.source === '폴백 (초기 위치)'
              ? 'gps-info gps-info--fallback'
              : 'gps-info gps-info--normal'
          }
        >
          <div className="gps-info__title">📍 {gpsInfo.source}</div>
          {gpsInfo.lat != null && (
            <div>{gpsInfo.lat.toFixed(5)}, {gpsInfo.lng.toFixed(5)}</div>
          )}
        </div>
      )}

      {listOpen && (
        <div
          className="backdrop"
          onClick={() => setListOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setListOpen(false);
          }}
          role="button"
          tabIndex={0}
        />
      )}

      <div
        className={listOpen ? 'pole-list pole-list--open' : 'pole-list pole-list--closed'}
      >
        <div className="pole-list__header">
          <span className="pole-list__title">
            전신주 목록 ({poles.length}기)
          </span>
          <div className="pole-list__header-actions">
            <button
              type="button"
              className={`pole-list__refresh${refreshing ? ' pole-list__refresh--loading' : ''}`}
              onClick={refreshPoles}
              disabled={refreshing}
            >
              <span className="pole-list__refresh-icon">🔄</span> 리프레시
            </button>
            <button
              type="button"
              className="pole-list__upload"
              onClick={() => document.getElementById('folder-input').click()}
            >
              📁 폴더 업로드
            </button>
            <button
              type="button"
              onClick={() => setListOpen(false)}
              className="pole-list__close"
            >
              ✕
            </button>
          </div>
        </div>

        {poles.length > 0 && (
          <div className="pole-list__time-filter">
            <div className="time-filter__header">
              <span className="time-filter__label">⏱ 촬영시간</span>
              <button
                type="button"
                className={`time-filter__toggle ${timeFilterEnabled ? 'time-filter__toggle--on' : ''}`}
                onClick={() => {
                  setTimeFilterEnabled((v) => !v);
                  if (!timeFilterEnabled) setTimeFilterWeek(maxWeek);
                }}
              >
                {timeFilterEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {timeFilterEnabled && (
              <>
                <input
                  type="range"
                  className="time-filter__slider"
                  min={minWeek}
                  max={maxWeek}
                  value={timeFilterWeek}
                  onChange={(e) => setTimeFilterWeek(Number(e.target.value))}
                />
                <div className="time-filter__info">
                  <span>{timeFilterLabel}</span>
                  <span className="time-filter__count">{filteredPoles.length}기</span>
                </div>
              </>
            )}
          </div>
        )}

        <div className="pole-list__filters">
          {[
            { value: 'all', label: '전체', color: '#94a3b8' },
            { value: 'A', label: 'A', color: LEVEL_COLORS.A },
            { value: 'B', label: 'B', color: LEVEL_COLORS.B },
            { value: 'Pole', label: 'Pole', color: LEVEL_COLORS.Pole },
          ].map((f) => (
            <button
              key={f.value}
              type="button"
              className={`pole-filter-btn ${levelFilter === f.value ? 'pole-filter-btn--active' : ''}`}
              style={levelFilter === f.value ? { backgroundColor: f.color, color: 'white' } : {}}
              onClick={() => setLevelFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
          <span className="pole-list__filter-count">{filteredPoles.length}기</span>
        </div>

        <div className="pole-list__area-filter">
          <select
            className="pole-area-select"
            value={guFilter}
            onChange={(e) => {
              setGuFilter(e.target.value);
              setDongFilter('all');
            }}
          >
            <option value="all">전체 구</option>
            {guList.map((gu) => {
              const count = poles.filter((p) => p.gu === gu).length;
              return (
                <option key={gu} value={gu}>{gu} ({count}기)</option>
              );
            })}
          </select>

          <select
            className="pole-area-select"
            value={dongFilter}
            onChange={(e) => setDongFilter(e.target.value)}
          >
            <option value="all">전체 동</option>
            {dongList.map((d) => {
              const count = poles.filter((p) => p.gu === guFilter && p.dong === d.dong).length;
              return (
                <option key={d.dong} value={d.dong}>{d.dong} ({count}기)</option>
              );
            })}
          </select>
        </div>

        <div className="pole-list__scroll">
          {[...filteredPoles].reverse().map((pole) => (
            <div
              key={pole.id}
              className="pole-item"
              onClick={() => {
                flyTo(pole.lng, pole.lat);
                setListOpen(false);
              }}
              onKeyDown={() => {
                flyTo(pole.lng, pole.lat);
                setListOpen(false);
              }}
              role="button"
              tabIndex={0}
            >
              <img src={pole.photoUrl} alt="전신주" className="pole-item__thumb" />
              <div className="pole-item__info">
                <div className="pole-item__coords">
                  <span
                    className="pole-item__level"
                    style={{ backgroundColor: LEVEL_COLORS[pole.level] || '#94a3b8' }}
                  >
                    {LEVEL_LABELS[pole.level] || pole.level || '-'}
                  </span>
                  {pole.lat.toFixed(5)}, {pole.lng.toFixed(5)}
                </div>
                <div className="pole-item__time">
                  {new Date(pole.timestamp).toLocaleString('ko-KR')}
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(pole.id);
                }}
                className="pole-item__delete"
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

export default App;
