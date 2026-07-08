// ============================================================
// 버스알림판 - Vercel 서버리스 함수 (서울 icn1 리전)
// /api/* 요청을 data.go.kr / openapi.gbis.go.kr로 중계
// /api/diag?serviceKey=키 → 서버별 연결 상태 진단
// ============================================================

const BROWSER_HEADERS = {
  'Accept': 'application/json, application/xml, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'Referer': 'https://www.gbis.go.kr/'
};

// v2(apis.data.go.kr) 경로 → 레거시(openapi.gbis.go.kr) 경로 매핑
const LEGACY_PATH = {
  '/busstationservice/v2/getBusStationListv2': '/busstationservice',
  '/busstationservice/v2/getBusStationViaRouteListv2': '/busstationservice/route',
  '/busarrivalservice/v2/getBusArrivalItemv2': '/busarrivalservice',
  '/busrouteservice/v2/getBusRouteStationListv2': '/busrouteservice/station',
  '/busrouteservice/v2/getBusRouteInfoItemv2': '/busrouteservice/info'
};

// 간단한 XML → JSON 변환 (GBIS 레거시 응답용)
function xmlToJson(str) {
  str = str.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  function parse(s) {
    const result = {};
    const re = /<(\w+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let m, found = false;
    while ((m = re.exec(s))) {
      found = true;
      const key = m[1];
      const inner = m[2].trim();
      const value = /<\w+(?:\s[^>]*)?>/.test(inner) ? parse(inner) : inner;
      if (key in result) {
        if (!Array.isArray(result[key])) result[key] = [result[key]];
        result[key].push(value);
      } else {
        result[key] = value;
      }
    }
    return found ? result : s.trim();
  }
  return parse(str);
}

function isJsonLike(text) {
  const t = (text || '').trim();
  return t.startsWith('{') || t.startsWith('[');
}

async function tryUpstream(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const r = await fetch(url, { headers: BROWSER_HEADERS, signal: ctrl.signal });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: String(e && e.name === 'AbortError' ? '연결 시간 초과' : e) };
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname; // 예: /api/busstationservice/v2/...
  const search = url.search;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  // ---------- 진단 ----------
  if (pathname === '/api/diag') {
    const key = url.searchParams.get('serviceKey') || '';
    const q = 'serviceKey=' + encodeURIComponent(key);
    const [a, b] = await Promise.all([
      tryUpstream('https://apis.data.go.kr/6410000/busstationservice/v2/getBusStationListv2?format=json&keyword=%EC%A0%95%EC%9E%90&' + q),
      tryUpstream('https://openapi.gbis.go.kr/ws/rest/busstationservice?keyword=%EC%A0%95%EC%9E%90&' + q)
    ]);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(
      '=== 진단 결과 (Vercel 서울 리전) ===\n\n' +
      '[1] apis.data.go.kr (공공데이터포털)\n' +
      '상태: HTTP ' + a.status + '\n' +
      '응답: ' + a.body.slice(0, 250) + '\n\n' +
      '[2] openapi.gbis.go.kr (경기버스정보)\n' +
      '상태: HTTP ' + b.status + '\n' +
      '응답: ' + b.body.slice(0, 250) + '\n'
    );
  }

  // ---------- API 프록시 ----------
  const apiPath = pathname.slice(4); // '/api' 제거
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // 1차: apis.data.go.kr (v2, JSON)
  const primary = await tryUpstream('https://apis.data.go.kr/6410000' + apiPath + search);
  if (primary.ok && isJsonLike(primary.body)) {
    return res.status(200).send(primary.body);
  }

  // 2차: openapi.gbis.go.kr (레거시, XML → JSON 변환)
  const legacyPath = LEGACY_PATH[apiPath];
  if (legacyPath) {
    const p2 = new URLSearchParams(search);
    p2.delete('format');
    const legacy = await tryUpstream('https://openapi.gbis.go.kr/ws/rest' + legacyPath + '?' + p2.toString());
    if (legacy.ok) {
      if (isJsonLike(legacy.body)) return res.status(200).send(legacy.body);
      try {
        return res.status(200).send(JSON.stringify(xmlToJson(legacy.body)));
      } catch (e) { /* 아래 에러 응답으로 */ }
    }
    return res.status(502).send(JSON.stringify({
      error: '두 서버 모두 실패',
      primary: { status: primary.status, body: primary.body.slice(0, 150) },
      legacy: { status: legacy.status, body: legacy.body.slice(0, 150) }
    }));
  }

  return res.status(primary.status || 502).send(primary.body || '{"error":"upstream 실패"}');
}
