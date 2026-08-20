import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map from 'ol/Map';
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

const VWORLD_API_KEY = '2C00322C-5037-37EB-A547-7001C13840E9';
const LEVEL_COLORS = { A: '#22c55e', B: '#f97316', Pole: '#a855f7' };
const LEVEL_LABELS = { A: 'A', B: 'B', Pole: 'P' };

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
  const [levelFilter, setLevelFilter] = useState('all');
  const [guFilter, setGuFilter] = useState('용산구');
  const [dongFilter, setDongFilter] = useState('all');
  const polesRef = useRef([]);
  const [allDongs, setAllDongs] = useState([]);
  const popupRef = useRef(null);
  const popupOverlayRef = useRef(null);
  const [popupPole, setPopupPole] = useState(null);

  const guList = useMemo(() => {
    const set = new Set(allDongs.map((d) => d.gu_name));
    return [...set].sort();
  }, [allDongs]);

  const dongList = useMemo(() => {
    if (guFilter === 'all') return allDongs;
    return allDongs.filter((d) => d.gu_name === guFilter);
  }, [allDongs, guFilter]);

  const filteredPoles = useMemo(() => {
    return poles.filter(
      (p) => (levelFilter === 'all' || p.level === levelFilter) &&
             (guFilter === 'all' || p.dong.includes(guFilter)) &&
             (dongFilter === 'all' || p.dong.includes(dongFilter))
    );
  }, [poles, levelFilter, guFilter, dongFilter]);

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
    polesRef.current.forEach((pole) => {
      if (idSet.has(pole.id)) return;
      if (levelFilter !== 'all' && pole.level !== levelFilter) return;
      if (guFilter !== 'all' && !pole.dong.includes(guFilter)) return;
      if (dongFilter !== 'all' && !pole.dong.includes(dongFilter)) return;
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
  }, [levelFilter, guFilter, dongFilter]);

  useEffect(() => {
    syncMarkers();
  }, [syncMarkers]);

  const addMarker = useCallback((lng, lat, id, level) => {
    if (!markerLayerRef.current) return;

    const isCurrentLocation = id === 'current-location';
    const color = isCurrentLocation ? '#3b82f6' : (LEVEL_COLORS[level] || '#ef4444');
    const label = isCurrentLocation ? '' : (LEVEL_LABELS[level] || '전신주');
    const feature = new Feature({
      geometry: new Point(fromLonLat([lng, lat])),
      poleId: id,
    });
    feature.setStyle(
      new Style({
        image: new CircleStyle({
          radius: isCurrentLocation ? 6 : 8,
          fill: new Fill({ color }),
          stroke: new Stroke({ color: 'white', width: 2 }),
        }),
        text: new Text({
          text: label,
          offsetY: -20,
          font: 'bold 12px sans-serif',
          fill: new Fill({ color: '#1e293b' }),
          stroke: new Stroke({ color: 'white', width: 3 }),
        }),
      }),
    );
    markerLayerRef.current.getSource().addFeature(feature);
    if (isCurrentLocation) {
      currentLocationRef.current = feature;
    }
  }, []);

  const handleDelete = useCallback(async (id) => {
    try {
      const res = await fetch(`/api/poles/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`삭제 실패 (HTTP ${res.status})`);
      setPoles((prev) => {
        polesRef.current = prev.filter((p) => p.id !== id);
        return prev.filter((p) => p.id !== id);
      });
    } catch (err) {
      console.error('전신주 삭제 실패:', err);
      alert('전신주 삭제에 실패했습니다.');
    }
  }, []);

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

  useEffect(() => {
    if (mapRef.current) return;

    let aborted = false;

    const initMap = (lng, lat) => {
      if (aborted || mapRef.current) return;

      try {
        const markerSource = new VectorSource();
        const markerLayer = new VectorLayer({ source: markerSource });
        markerLayerRef.current = markerLayer;

        const map = new Map({
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

        addMarker(lng, lat, 'current-location');
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

    const handleSuccess = (position) => {
      if (aborted) return;
      const { latitude: lat, longitude: lng } = position.coords;
      lastPositionRef.current = { lat, lng };
      initMap(lng, lat);
    };

    const handleError = (err) => {
      if (aborted) return;
      console.error('getCurrentPosition 실패:', err?.code, err?.message);
      const fallback = { lat: 37.5665, lng: 126.978 };
      lastPositionRef.current = fallback;
      fallbackUsedRef.current = true;
      initMap(fallback.lng, fallback.lat);
    };

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(handleSuccess, handleError, {
        enableHighAccuracy: true,
      });

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
        { enableHighAccuracy: true, maximumAge: 10000 },
      );
    } else {
      handleError();
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
    };
  }, [addMarker]);

  const handleCapture = async (e) => {
    const file = e.target.files?.[0];
    if (!file || processing) return;

    setProcessing(true);
    setGpsInfo(null);

    try {
      let lat;
      let lng;
      let source = '';

      // 1차: 사진 EXIF에서 GPS 추출 (ArrayBuffer로 읽어 Android 호환성 확보)
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
        } else {
          console.log('EXIF에 GPS 데이터 없음');
        }
      } catch (err) {
        console.error('EXIF 읽기 실패:', err);
      }

      // 2차: 브라우저 GPS (EXIF에 GPS가 없는 경우)
      if (lat === undefined && navigator.geolocation) {
        try {
          console.log('브라우저 GPS 요청 중...');
          const pos = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              timeout: 15000,
              maximumAge: 30000,
            });
          });
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
          source = '브라우저 GPS';
          lastPositionRef.current = { lat, lng };
        } catch (err) {
          console.error('브라우저 GPS 실패:', err);
        }
      }

      // 3차: 마지막 알려진 위치 (watchPosition 또는 초기 위치)
      if (lat === undefined) {
        const last = lastPositionRef.current;
        if (last) {
          lat = last.lat;
          lng = last.lng;
          source = watchIdRef.current != null ? '실시간 GPS' : '폴백 (초기 위치)';
        } else {
          throw new Error('No GPS available');
        }
      }

      setGpsInfo({ source, lat, lng });

      const compressed = await imageCompression(file, {
        maxSizeMB: 0.5,
        maxWidthOrHeight: 800,
        useWebWorker: true,
      });

      const id = `pole-${Date.now()}`;
      const formData = new FormData();
      formData.append('photo', compressed, `${id}.jpg`);
      formData.append('id', id);
      formData.append('lat', lat);
      formData.append('lng', lng);
      formData.append('timestamp', new Date().toISOString());

      const res = await fetch('/api/poles', { method: 'POST', body: formData });
      if (!res.ok) throw new Error(`등록 실패 (HTTP ${res.status})`);
      const pole = await res.json();

      setPoles((prev) => {
        polesRef.current = [...prev, pole];
        return [...prev, pole];
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

    setProcessing(true);
    setUploadProgress({ current: 0, total: imageFiles.length });

    let registered = 0;
    let skipped = 0;

    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      setUploadProgress({ current: i + 1, total: imageFiles.length });

      try {
        let lat;
        let lng;

        try {
          const buffer = await file.arrayBuffer();
          const exifData = await exifr.parse(buffer);
          if (exifData && exifData.latitude && exifData.longitude) {
            lat = exifData.latitude;
            lng = exifData.longitude;
            lastPositionRef.current = { lat, lng };
          }
        } catch (err) {
          console.error('EXIF 읽기 실패:', file.name, err);
        }

        if (lat === undefined) {
          skipped++;
          continue;
        }

        const compressed = await imageCompression(file, {
          maxSizeMB: 0.5,
          maxWidthOrHeight: 800,
          useWebWorker: true,
        });

        const id = `pole-${Date.now()}-${i}`;
        const formData = new FormData();
        formData.append('photo', compressed, `${id}.jpg`);
        formData.append('id', id);
        formData.append('lat', lat);
        formData.append('lng', lng);
        formData.append('timestamp', new Date().toISOString());

        const res = await fetch('/api/poles', { method: 'POST', body: formData });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const pole = await res.json();

        setPoles((prev) => {
          polesRef.current = [...prev, pole];
          return [...prev, pole];
        });
        registered++;
      } catch (err) {
        console.error('전신주 등록 실패:', file.name, err);
        skipped++;
      }
    }

    setUploadProgress(null);
    setProcessing(false);
    alert(`등록 완료: ${registered}장${skipped > 0 ? ` / 건너뜀: ${skipped}장 (GPS 없음)` : ''}`);
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
        <label htmlFor="camera-input" className="capture-button">
          📷 등록
        </label>
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

      {poles.length > 0 && (
        <button
          type="button"
          onClick={() => setListOpen((o) => !o)}
          className="list-toggle"
        >
          📋 {filteredPoles.length}기
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
          <div>{gpsInfo.lat.toFixed(5)}, {gpsInfo.lng.toFixed(5)}</div>
        </div>
      )}

      {listOpen && (
        <div
          className="backdrop"
          onClick={() => setListOpen(false)}
          onKeyDown={() => setListOpen(false)}
          role="button"
          tabIndex={0}
        />
      )}

      <div
        className={listOpen ? 'pole-list pole-list--open' : 'pole-list pole-list--closed'}
      >
        <div className="pole-list__header">
          <span className="pole-list__title">
            전신주 목록 ({filteredPoles.length}기)
          </span>
          <div className="pole-list__header-actions">
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
              const count = poles.filter((p) => p.dong.includes(gu)).length;
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
              const count = poles.filter((p) => p.dong.includes(d.dong)).length;
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
