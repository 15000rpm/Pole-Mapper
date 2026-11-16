import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const home = os.homedir()
const keyPath = process.env.VITE_HTTPS_KEY || path.join(home, '.vite-key.pem')
const certPath = process.env.VITE_HTTPS_CERT || path.join(home, '.vite-cert.pem')

function localIPv4s() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address)
}

// geolocation/카메라는 보안 컨텍스트에서만 동작하므로 HTTPS 인증서를 사용한다.
// 인증서가 없으면 openssl로 자체 서명 인증서를 한 번만 생성한다.
function ensureCertificates() {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return true

  const sans = ['DNS:localhost', 'IP:127.0.0.1', ...localIPv4s().map((ip) => `IP:${ip}`)]
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath,
        '-out', certPath,
        '-days', '3650',
        '-subj', '/CN=localhost',
        '-addext', `subjectAltName=${sans.join(',')}`,
      ],
      { stdio: 'ignore' },
    )
    console.log(`[vite] 자체 서명 인증서를 생성했습니다: ${keyPath}, ${certPath}`)
    return true
  } catch (err) {
    console.warn(
      `[vite] HTTPS 인증서를 찾을 수 없고 자동 생성도 실패했습니다 (${err.message}).\n` +
        '[vite] HTTP로 실행합니다. 모바일에서 GPS/카메라를 쓰려면 인증서가 필요합니다:\n' +
        `[vite]   openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 3650 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
    )
    return false
  }
}

const https = ensureCertificates()
  ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
  : undefined

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // 지도(ol)와 React는 서로 독립적으로 캐시되도록 청크를 나눈다.
    // 청크 하나가 500 kB를 넘지 않게 하기 위한 설정이기도 하다.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'ol', test: /node_modules[\\/]ol[\\/]/, priority: 20 },
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 15,
            },
          ],
        },
      },
    },
  },
  server: {
    host: true,
    https,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
})
